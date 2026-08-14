import assert from "node:assert/strict";
import test from "node:test";
import { parseV1Srproj } from "../lib/input/v1.ts";
import {
  parseV2SubvisionProject,
  parseV2VisionProject,
} from "../lib/input/v2.ts";
import {
  BROWSER_ARCHIVE_LIMITS,
  exceedsUtf8ByteLimit,
  PROJECT_DIAGNOSTIC_MAX_COUNT,
  PROJECT_JSON_MAX_VALUES,
  PROJECT_PATH_MAX_BYTES,
  PROJECT_STRUCTURE_MAX_DEPTH,
  PROJECT_TEXT_MAX_BYTES,
  V1_PROJECT_LIMITS,
  V2_PROJECT_LIMITS,
} from "../lib/security/resourceLimits.ts";

function v1Project(path = "C:/images/frame.png", rootExtra = ""): string {
  return [
    "<Project>",
    "<Version>0.9</Version>",
    "<Type>Classification</Type>",
    "<ClassGroup><NumberOfClasses>1</NumberOfClasses>",
    "<Class><Name>OK</Name><Color>-16711936</Color></Class></ClassGroup>",
    "<ImageGroup><NumberOfImages>1</NumberOfImages><Image>",
    `<Path>${path}</Path><SplitState>Training</SplitState>`,
    "<ClassIndexOfLabel>0</ClassIndexOfLabel></Image></ImageGroup>",
    rootExtra,
    "</Project>",
  ].join("");
}

function v2Project(path = "C:/images/frame.png"): Record<string, unknown> {
  return {
    project: {
      projectId: 1,
      projectName: "limits",
      projectType: "cls",
      roiMode: "no",
      classInfos: [
        { classId: 2, classNo: 0, className: "OK", classColor: "#00ff00" },
      ],
      datasets: [{ datasetId: 3, datasetName: "dataset", splitSets: [] }],
      projectFiles: [
        {
          fileId: 4,
          filePath: path,
          width: 32,
          height: 24,
          isLabeled: true,
          className: "OK",
          datasetName: "dataset",
          labelDataList: [],
          splitSets: [{ splitId: 5, splitName: "default", splitType: "train" }],
        },
      ],
    },
  };
}

function hasCode(
  result: { readonly diagnostics: readonly { readonly code: string }[] },
  code: string,
): boolean {
  return result.diagnostics.some((item) => item.code === code);
}

test("parser entry points enforce the shared 16 MiB UTF-8 text limit", () => {
  assert.equal(exceedsUtf8ByteLimit("a", 1), false);
  assert.equal(exceedsUtf8ByteLimit("é", 1), true);
  assert.equal(exceedsUtf8ByteLimit("😀", 3), true);
  assert.equal(exceedsUtf8ByteLimit("\ud800", 2), true);

  const v1 = v1Project();
  const oversizedXml = v1 + " ".repeat(PROJECT_TEXT_MAX_BYTES - v1.length + 1);
  const v1Result = parseV1Srproj({ xmlText: oversizedXml });
  assert.equal(v1Result.ok, false);
  assert.ok(hasCode(v1Result, "V1_TEXT_LIMIT_EXCEEDED"));

  const v2 = JSON.stringify(v2Project());
  const oversizedJson = v2 + " ".repeat(PROJECT_TEXT_MAX_BYTES - v2.length + 1);
  const v2Result = parseV2SubvisionProject({ jsonText: oversizedJson });
  assert.equal(v2Result.ok, false);
  assert.ok(hasCode(v2Result, "V2_TEXT_LIMIT_EXCEEDED"));
});

test("JSON depth preflight is string-aware and covers encoded contours", () => {
  const exact = "[".repeat(PROJECT_STRUCTURE_MAX_DEPTH) + "0" + "]".repeat(PROJECT_STRUCTURE_MAX_DEPTH);
  const exactResult = parseV2SubvisionProject({ jsonText: exact });
  assert.equal(hasCode(exactResult, "V2_JSON_DEPTH_LIMIT_EXCEEDED"), false);

  const tooDeep = `[${exact}]`;
  const deepResult = parseV2SubvisionProject({ jsonText: tooDeep });
  assert.equal(deepResult.ok, false);
  assert.ok(hasCode(deepResult, "V2_JSON_DEPTH_LIMIT_EXCEEDED"));

  const stringFixture = v2Project() as {
    project: { note?: string };
  };
  stringFixture.project.note = `${"[".repeat(PROJECT_STRUCTURE_MAX_DEPTH + 20)}\\"{}`;
  const stringResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(stringFixture),
  });
  assert.equal(hasCode(stringResult, "V2_JSON_DEPTH_LIMIT_EXCEEDED"), false);

  const contourFixture = v2Project() as {
    project: { projectFiles: Array<Record<string, unknown>> };
  };
  contourFixture.project.projectFiles[0]!.labelDataList = [
    {
      labelId: 6,
      labelType: "man",
      className: "OK",
      labelContour: tooDeep,
    },
  ];
  const contourResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(contourFixture),
  });
  assert.equal(contourResult.ok, false);
  assert.ok(hasCode(contourResult, "V2_JSON_DEPTH_LIMIT_EXCEEDED"));
});

test("XML parser enforces depth for both open and self-closing elements", () => {
  const nested = (openCount: number) =>
    `${"<x>".repeat(openCount)}<leaf/>${"</x>".repeat(openCount)}`;
  const exactResult = parseV1Srproj({
    xmlText: v1Project("C:/images/frame.png", nested(PROJECT_STRUCTURE_MAX_DEPTH - 2)),
  });
  assert.equal(hasCode(exactResult, "V1_XML_DEPTH_LIMIT_EXCEEDED"), false);

  const deepResult = parseV1Srproj({
    xmlText: v1Project("C:/images/frame.png", nested(PROJECT_STRUCTURE_MAX_DEPTH - 1)),
  });
  assert.equal(deepResult.ok, false);
  assert.ok(hasCode(deepResult, "V1_XML_DEPTH_LIMIT_EXCEEDED"));
});

test("V1 parser enforces node, attribute, class, file, and UTF-8 path limits", () => {
  const nodeFlood = "<x/>".repeat(V1_PROJECT_LIMITS.maxNodes);
  const nodeResult = parseV1Srproj({ xmlText: v1Project("C:/a.png", nodeFlood) });
  assert.equal(nodeResult.ok, false);
  assert.ok(hasCode(nodeResult, "V1_XML_NODE_LIMIT_EXCEEDED"));

  const attributes = Array.from(
    { length: V1_PROJECT_LIMITS.maxAttributesPerElement + 1 },
    (_, index) => `a${index}="x"`,
  ).join(" ");
  const attributeResult = parseV1Srproj({
    xmlText: v1Project("C:/a.png", `<x ${attributes}/>`),
  });
  assert.equal(attributeResult.ok, false);
  assert.ok(hasCode(attributeResult, "V1_XML_ELEMENT_ATTRIBUTE_LIMIT_EXCEEDED"));

  const contourPoints = '<Point X="1" Y="2"/>'.repeat(2_050);
  const segmentationXml = v1Project("C:/a.png")
    .replace("<Type>Classification</Type>", "<Type>Segmentation</Type>")
    .replace(
      "<ClassIndexOfLabel>0</ClassIndexOfLabel>",
      `<LabelGroup><IsNormal>false</IsNormal><NumberOfLabels>1</NumberOfLabels><Label><ClassIndex>0</ClassIndex><Type>Contours</Type><ContourGroup><Contour Type="Outer">${contourPoints}</Contour></ContourGroup></Label></LabelGroup>`,
    );
  const contourResult = parseV1Srproj({
    xmlText: segmentationXml,
  });
  assert.equal(contourResult.ok, true);
  assert.equal(hasCode(contourResult, "V1_PROJECT_TYPE_UNSUPPORTED"), false);
  assert.equal(
    hasCode(contourResult, "V1_XML_ATTRIBUTE_LIMIT_EXCEEDED"),
    false,
  );
  assert.equal(
    hasCode(contourResult, "V1_XML_ELEMENT_ATTRIBUTE_LIMIT_EXCEEDED"),
    false,
  );

  const classResult = parseV1Srproj({
    xmlText: v1Project().replace(
      "<NumberOfClasses>1</NumberOfClasses>",
      `<NumberOfClasses>${V1_PROJECT_LIMITS.maxClasses + 1}</NumberOfClasses>`,
    ),
  });
  assert.equal(classResult.ok, false);
  assert.ok(hasCode(classResult, "V1_CLASS_LIMIT_EXCEEDED"));

  const fileResult = parseV1Srproj({
    xmlText: v1Project().replace(
      "<NumberOfImages>1</NumberOfImages>",
      `<NumberOfImages>${V1_PROJECT_LIMITS.maxFiles + 1}</NumberOfImages>`,
    ),
  });
  assert.equal(fileResult.ok, false);
  assert.ok(hasCode(fileResult, "V1_FILE_LIMIT_EXCEEDED"));

  const exactPath = `C:/${"a".repeat(PROJECT_PATH_MAX_BYTES - 3)}`;
  assert.equal(parseV1Srproj({ xmlText: v1Project(exactPath) }).ok, true);
  const pathResult = parseV1Srproj({ xmlText: v1Project(`${exactPath}a`) });
  assert.equal(pathResult.ok, false);
  assert.ok(hasCode(pathResult, "V1_PATH_LIMIT_EXCEEDED"));
});

test("V2 parser enforces entity totals and UTF-8 paths before semantic loops", () => {
  const cases = [
    ["classInfos", V2_PROJECT_LIMITS.maxClasses + 1, "V2_CLASS_LIMIT_EXCEEDED"],
    ["datasets", V2_PROJECT_LIMITS.maxDatasets + 1, "V2_DATASET_LIMIT_EXCEEDED"],
    ["projectFiles", V2_PROJECT_LIMITS.maxFiles + 1, "V2_FILE_LIMIT_EXCEEDED"],
  ] as const;
  for (const [field, count, code] of cases) {
    const fixture = { project: { classInfos: [], datasets: [], projectFiles: [] } } as {
      project: Record<string, unknown>;
    };
    fixture.project[field] = Array.from({ length: count }, () => ({}));
    const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
    assert.equal(result.ok, false);
    assert.ok(hasCode(result, code), code);
  }

  const labelFixture = {
    project: {
      classInfos: [],
      datasets: [],
      projectFiles: [
        { labelDataList: Array(V2_PROJECT_LIMITS.maxLabels).fill(null) },
        { labelDataList: [null] },
      ],
    },
  };
  const labelResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(labelFixture),
  });
  assert.equal(labelResult.ok, false);
  assert.ok(hasCode(labelResult, "V2_LABEL_LIMIT_EXCEEDED"));

  const splitFixture = {
    project: {
      classInfos: [],
      datasets: [],
      projectFiles: [
        { splitSets: Array(V2_PROJECT_LIMITS.maxSplitMemberships).fill(null) },
        { splitSets: [null] },
      ],
    },
  };
  const splitResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(splitFixture),
  });
  assert.equal(splitResult.ok, false);
  assert.ok(hasCode(splitResult, "V2_SPLIT_LIMIT_EXCEEDED"));

  const exactPath = `C:/${"a".repeat(PROJECT_PATH_MAX_BYTES - 3)}`;
  assert.equal(
    parseV2SubvisionProject({ jsonText: JSON.stringify(v2Project(exactPath)) }).ok,
    true,
  );
  const pathResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(v2Project(`${exactPath}a`)),
  });
  assert.equal(pathResult.ok, false);
  assert.ok(hasCode(pathResult, "V2_PATH_LIMIT_EXCEEDED"));
});

test("V2 parser caps total JSON values and direct archive entry lists", () => {
  const valueFlood = {
    project: { classInfos: [], datasets: [], projectFiles: [] },
    payload: Array(PROJECT_JSON_MAX_VALUES).fill(null),
  };
  const valueResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(valueFlood),
  });
  assert.equal(valueResult.ok, false);
  assert.ok(hasCode(valueResult, "V2_JSON_VALUE_LIMIT_EXCEEDED"));

  const archiveResult = parseV2VisionProject({
    projectJsonText: "{}",
    projectJsonEntryName: "project.json",
    entries: Array.from(
      { length: BROWSER_ARCHIVE_LIMITS.maxEntries + 1 },
      (_, index) => ({ name: `images/${index}.png` }),
    ),
  });
  assert.equal(archiveResult.ok, false);
  assert.ok(hasCode(archiveResult, "V2_ARCHIVE_ENTRY_LIMIT_EXCEEDED"));
});

test("diagnostic floods are capped with a blocking security sentinel", () => {
  const fixture = v2Project() as Record<string, unknown>;
  for (let index = 0; index < PROJECT_DIAGNOSTIC_MAX_COUNT + 100; index += 1) {
    fixture[`unknown_${index}`] = true;
  }
  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length, PROJECT_DIAGNOSTIC_MAX_COUNT);
  assert.equal(
    result.diagnostics.at(-1)?.code,
    "PROJECT_DIAGNOSTIC_LIMIT_EXCEEDED",
  );
  const sentinel = result.diagnostics.at(-1);
  assert.equal(sentinel?.category, "security");
  assert.equal(sentinel?.severity, "error");
  assert.equal(sentinel?.disposition, "block");
});
