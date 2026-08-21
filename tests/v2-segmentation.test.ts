import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { loadProject } from "../lib/input/loadProject.ts";
import {
  parseV2SubvisionProject,
  parseV2VisionProject,
} from "../lib/input/v2.ts";
import type {
  ProjectIR,
  ProjectParseResult,
} from "../lib/model/project.ts";
import { V2_PROJECT_LIMITS } from "../lib/security/resourceLimits.ts";

interface MutableSegmentationProject {
  readonly project: {
    readonly classInfos: Array<Record<string, unknown>>;
    readonly projectFiles: Array<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
}

const outerRing = [
  [2, 2],
  [12, 2],
  [12, 12],
  [2, 12],
];
const innerRing = [
  [4, 4],
  [4, 10],
  [10, 10],
  [10, 4],
];

function segmentationProject(
  filePath = String.raw`C:\images\defect.png`,
): MutableSegmentationProject {
  return {
    project: {
      projectId: 1,
      projectName: "Synthetic Segmentation",
      projectType: "seg",
      description: "",
      roiMode: "no",
      classInfos: [
        {
          classId: 0,
          classNo: 0,
          className: "OK",
          classColor: "#00ff00",
          description: "",
          isNg: false,
        },
        {
          classId: 17,
          classNo: 1,
          className: "Scratch",
          classColor: "#ff0000",
          description: "",
          isNg: true,
        },
      ],
      datasets: [
        {
          datasetId: 3,
          datasetName: "dataset",
          description: "",
          splitSets: [],
        },
      ],
      projectFiles: [
        {
          fileId: 7,
          filePath,
          width: 20,
          height: 20,
          isLabeled: true,
          classNo: 1,
          className: "Scratch",
          datasetId: 3,
          datasetName: "dataset",
          splitSets: [
            {
              splitId: 8,
              splitName: "default",
              splitType: "train",
            },
          ],
          labelDataList: [
            {
              labelId: 9,
              labelType: "man",
              labelPosX: 2,
              labelPosY: 2,
              labelWidth: 10,
              labelHeight: 10,
              labelContour: JSON.stringify([outerRing, innerRing]),
              contourSize: 64,
              contourId: "contour-1",
              classNo: 1,
              className: "Scratch",
            },
          ],
        },
      ],
    },
  };
}

function firstFile(fixture: MutableSegmentationProject): Record<string, unknown> {
  return fixture.project.projectFiles[0]!;
}

function parsedProject(result: ProjectParseResult): ProjectIR {
  assert.equal(
    result.ok,
    true,
    JSON.stringify(result.diagnostics, undefined, 2),
  );
  if (!result.ok) throw new Error("Expected a parsed project.");
  return result.project;
}

function asBrowserFile(bytes: Uint8Array, name: string): File {
  return new NodeFile(
    [bytes] as unknown as ConstructorParameters<typeof NodeFile>[0],
    name,
  ) as unknown as File;
}

function largeOuterRing(length: number): readonly (readonly [number, number])[] {
  return Array.from({ length }, (_, index) => {
    if (index === 0) return [0, 0] as const;
    if (index === 1) return [10, 0] as const;
    if (index === length - 1) return [0, 10] as const;
    return [10, 10] as const;
  });
}

test("fails fast when contour points are individually valid but exceed the project total", () => {
  const fixture = segmentationProject();
  const baseLabel = (firstFile(fixture).labelDataList as Array<Record<string, unknown>>)[0]!;
  firstFile(fixture).labelDataList = [
    {
      ...baseLabel,
      labelId: 10,
      labelPosX: 0,
      labelPosY: 0,
      labelWidth: 10,
      labelHeight: 10,
      labelContour: JSON.stringify([
        largeOuterRing(Math.floor(V2_PROJECT_LIMITS.maxContourPoints / 2) + 1),
      ]),
    },
    {
      ...baseLabel,
      labelId: 11,
      labelPosX: 0,
      labelPosY: 0,
      labelWidth: 10,
      labelHeight: 10,
      labelContour: JSON.stringify([
        largeOuterRing(Math.ceil(V2_PROJECT_LIMITS.maxContourPoints / 2)),
      ]),
    },
    {
      ...baseLabel,
      labelId: 12,
      labelContour: "not-json",
    },
  ];

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.filter((item) => item.code === "V2_CONTOUR_POINT_LIMIT_EXCEEDED").length,
    1,
  );
  assert.equal(
    result.diagnostics.some((item) => item.code === "V2_CONTOUR_INVALID_JSON"),
    false,
  );
});

test("parses native-style multi-ring Segmentation contours with signed ring roles", () => {
  const result = parseV2SubvisionProject({
    fileName: "fixture.subvisionproj",
    jsonText: JSON.stringify(segmentationProject()),
  });
  const project = parsedProject(result);

  assert.equal(project.project.type, "segmentation");
  assert.deepEqual(
    project.files[0]?.labels[0]?.geometry.contourRoles,
    ["outer", "inner"],
  );
  assert.equal(project.files[0]?.labels[0]?.geometry.contours?.length, 2);
  assert.deepEqual(project.files[0]?.labels[0]?.geometry.box, {
    x: 2,
    y: 2,
    width: 10,
    height: 10,
  });
  assert.equal(project.files[0]?.isNormal, false);
  assert.equal(result.compatibility.status === "blocked", false);
  assert.equal(
    result.diagnostics.some(
      (item) => item.code === "V2_MULTIRING_CONTOUR_UNSUPPORTED",
    ),
    false,
  );
  assert.equal(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_UNMAPPED_FIELD" &&
        item.path.endsWith(".contourSize"),
    ),
    false,
  );
  const contourSize = result.diagnostics.filter(
    (item) => item.code === "V2_CONTOUR_SIZE_REBUILT",
  );
  assert.equal(contourSize.length, 1);
  assert.equal(contourSize[0]?.severity, "info");
  assert.equal(contourSize[0]?.disposition, "rebuild");
  assert.equal(contourSize[0]?.details?.affectedEntityCount, 1);
});

test("parses the same Segmentation geometry from a full V2 archive input", () => {
  const fixture = segmentationProject("images/defect.png");
  const jsonText = JSON.stringify(fixture);
  const result = parseV2VisionProject({
    fileName: "fixture.visionproj",
    projectJsonText: jsonText,
    projectJsonEntryName: "fixture.json",
    entries: [
      { name: "fixture.json" },
      { name: "images/defect.png", bytes: new Uint8Array([1, 2, 3]) },
    ],
  });
  const project = parsedProject(result);

  assert.equal(project.files[0]?.image.kind, "archive");
  assert.deepEqual(
    project.files[0]?.labels[0]?.geometry.contourRoles,
    ["outer", "inner"],
  );
  assert.equal(result.compatibility.status === "blocked", false);
});

test("distinguishes normal, unlabeled, and ambiguous empty Segmentation files", () => {
  const normalFixture = segmentationProject();
  const normalFile = firstFile(normalFixture);
  normalFile.labelDataList = [];
  normalFile.isLabeled = true;
  normalFile.classNo = 0;
  normalFile.className = "OK";
  const normalResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(normalFixture),
  });
  const normalProject = parsedProject(normalResult);
  assert.equal(normalProject.files[0]?.isNormal, true);
  assert.equal(normalResult.compatibility.status === "blocked", false);

  const unlabeledFixture = segmentationProject();
  const unlabeledFile = firstFile(unlabeledFixture);
  unlabeledFile.labelDataList = [];
  unlabeledFile.isLabeled = false;
  delete unlabeledFile.classNo;
  delete unlabeledFile.className;
  const unlabeledResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(unlabeledFixture),
  });
  const unlabeledProject = parsedProject(unlabeledResult);
  assert.equal(unlabeledProject.files[0]?.isLabeled, false);
  assert.equal(unlabeledProject.files[0]?.isNormal, undefined);
  assert.equal(unlabeledResult.compatibility.status === "blocked", false);

  const ambiguousFixture = segmentationProject();
  const ambiguousFile = firstFile(ambiguousFixture);
  ambiguousFile.labelDataList = [];
  ambiguousFile.isLabeled = true;
  delete ambiguousFile.classNo;
  delete ambiguousFile.className;
  const ambiguousResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(ambiguousFixture),
  });
  parsedProject(ambiguousResult);
  assert.equal(ambiguousResult.compatibility.status, "blocked");
  assert.ok(
    ambiguousResult.diagnostics.some(
      (item) =>
        item.code === "V2_SEGMENTATION_EMPTY_LABEL_STATE_AMBIGUOUS" &&
        item.disposition === "block",
    ),
  );
});

test("normalizes geometry-less structural OK markers with one aggregate diagnostic", () => {
  const fixture = segmentationProject();
  const first = firstFile(fixture);
  first.isLabeled = true;
  first.classNo = 0;
  first.className = "OK";
  first.labelDataList = [
    { labelId: 90, labelType: "man", classNo: 0, className: "OK" },
  ];
  const second = structuredClone(first);
  second.fileId = 8;
  second.filePath = String.raw`C:\images\normal-2.png`;
  (fixture.project.projectFiles as Array<Record<string, unknown>>).push(second);

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  const project = parsedProject(result);
  assert.notEqual(result.compatibility.status, "blocked");
  assert.equal(project.files.length, 2);
  assert.ok(project.files.every((file) => file.isNormal === true));
  assert.ok(project.files.every((file) => file.labels.length === 0));
  const diagnostics = result.diagnostics.filter(
    (item) => item.code === "V2_SEGMENTATION_NORMAL_MARKERS_REBUILT",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.disposition, "rebuild");
  assert.equal(diagnostics[0]?.severity, "info");
  assert.equal(diagnostics[0]?.details?.affectedEntityCount, 2);
  assert.equal(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_LABEL_GEOMETRY_UNSUPPORTED" ||
        item.code === "V2_SEGMENTATION_NORMAL_CLASS_CONTOUR_CONFLICT",
    ),
    false,
  );
});

test("keeps unsafe geometry-less Segmentation label combinations blocked", async (t) => {
  const marker = {
    labelId: 90,
    labelType: "man",
    classNo: 0,
    className: "OK",
  };

  await t.test("OK label with geometry", () => {
    const fixture = segmentationProject();
    const file = firstFile(fixture);
    file.classNo = 0;
    file.className = "OK";
    const defect = (file.labelDataList as Array<Record<string, unknown>>)[0]!;
    file.labelDataList = [{ ...defect, classNo: 0, className: "OK" }];
    const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
    parsedProject(result);
    assert.equal(result.compatibility.status, "blocked");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "V2_SEGMENTATION_NORMAL_CLASS_CONTOUR_CONFLICT",
      ),
    );
  });

  await t.test("NG label without geometry", () => {
    const fixture = segmentationProject();
    const file = firstFile(fixture);
    file.classNo = 1;
    file.className = "Scratch";
    file.labelDataList = [
      { labelId: 91, labelType: "man", classNo: 1, className: "Scratch" },
    ];
    const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
    parsedProject(result);
    assert.equal(result.compatibility.status, "blocked");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "V2_LABEL_GEOMETRY_UNSUPPORTED",
      ),
    );
  });

  await t.test("mixed OK marker and NG contour", () => {
    const fixture = segmentationProject();
    const file = firstFile(fixture);
    const defect = (file.labelDataList as Array<Record<string, unknown>>)[0]!;
    file.labelDataList = [marker, defect];
    const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
    parsedProject(result);
    assert.equal(result.compatibility.status, "blocked");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "V2_SEGMENTATION_NORMAL_CLASS_CONTOUR_CONFLICT",
      ),
    );
  });

  await t.test("unlabeled file with OK marker", () => {
    const fixture = segmentationProject();
    const file = firstFile(fixture);
    file.isLabeled = false;
    file.classNo = 0;
    file.className = "OK";
    file.labelDataList = [marker];
    const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
    parsedProject(result);
    assert.equal(result.compatibility.status, "blocked");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "V2_SEGMENTATION_LABEL_STATE_CONFLICT",
      ),
    );
  });

  await t.test("file-level defect class with OK marker", () => {
    const fixture = segmentationProject();
    const file = firstFile(fixture);
    file.classNo = 1;
    file.className = "Scratch";
    file.labelDataList = [marker];
    const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
    parsedProject(result);
    assert.equal(result.compatibility.status, "blocked");
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === "V2_SEGMENTATION_NORMAL_CLASS_CONTOUR_CONFLICT",
      ),
    );
  });
});

test("allows multiple defect classes even when file.className is only a summary", () => {
  const fixture = segmentationProject();
  fixture.project.classInfos.push({
    classId: 18,
    classNo: 2,
    className: "Dent",
    classColor: "#0000ff",
    description: "",
    isNg: true,
  });
  const file = firstFile(fixture);
  const labels = file.labelDataList as Array<Record<string, unknown>>;
  labels.push({
    ...labels[0],
    labelId: 10,
    contourId: "contour-2",
    classNo: 2,
    className: "Dent",
  });

  const result = parseV2SubvisionProject({
    jsonText: JSON.stringify(fixture),
  });
  const project = parsedProject(result);
  assert.equal(project.files[0]?.labels.length, 2);
  assert.equal(project.files[0]?.isNormal, false);
  assert.equal(result.compatibility.status === "blocked", false);
});

test("blocks ambiguous ring winding and invalid structural OK classes", () => {
  const windingFixture = segmentationProject();
  const windingFile = firstFile(windingFixture);
  const windingLabels = windingFile.labelDataList as Array<Record<string, unknown>>;
  windingLabels[0]!.labelContour = JSON.stringify([
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  ]);
  const windingResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(windingFixture),
  });
  const windingProject = parsedProject(windingResult);
  assert.deepEqual(
    windingProject.files[0]?.labels[0]?.geometry.contourRoles,
    ["unknown"],
  );
  assert.equal(windingResult.compatibility.status, "blocked");
  assert.ok(
    windingResult.diagnostics.some(
      (item) => item.code === "V2_CONTOUR_RING_WINDING_AMBIGUOUS",
    ),
  );

  const classFixture = segmentationProject();
  classFixture.project.classInfos[0]!.isNg = true;
  const classResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(classFixture),
  });
  parsedProject(classResult);
  assert.equal(classResult.compatibility.status, "blocked");
  assert.ok(
    classResult.diagnostics.some(
      (item) => item.code === "V2_SEGMENTATION_CLASS_STRUCTURE_INVALID",
    ),
  );
});

test("validates derived Segmentation bounds and unlabeled class state", () => {
  const conflictingBounds = segmentationProject();
  const conflictingLabel = (
    firstFile(conflictingBounds).labelDataList as Array<Record<string, unknown>>
  )[0]!;
  conflictingLabel.labelWidth = 9;
  const conflictResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(conflictingBounds),
  });
  parsedProject(conflictResult);
  assert.equal(conflictResult.compatibility.status, "blocked");
  assert.ok(
    conflictResult.diagnostics.some(
      (item) => item.code === "V2_SEGMENTATION_BOUNDS_CONFLICT",
    ),
  );

  const incompleteBounds = segmentationProject();
  const incompleteLabel = (
    firstFile(incompleteBounds).labelDataList as Array<Record<string, unknown>>
  )[0]!;
  delete incompleteLabel.labelHeight;
  const incompleteResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(incompleteBounds),
  });
  assert.equal(incompleteResult.ok, false);
  assert.ok(
    incompleteResult.diagnostics.some(
      (item) => item.code === "V2_SEGMENTATION_BOUNDS_INVALID",
    ),
  );

  const unlabeledWithClass = segmentationProject();
  const unlabeledFile = firstFile(unlabeledWithClass);
  unlabeledFile.labelDataList = [];
  unlabeledFile.isLabeled = false;
  const unlabeledResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(unlabeledWithClass),
  });
  parsedProject(unlabeledResult);
  assert.equal(unlabeledResult.compatibility.status, "blocked");
  assert.ok(
    unlabeledResult.diagnostics.some(
      (item) => item.code === "V2_SEGMENTATION_UNLABELED_CLASS_CONFLICT",
    ),
  );
});

const realSampleDirectory =
  process.env.SAIGEVISION_TEST_SAMPLE_DIR ??
  String.raw`E:\02-2.SaigeVision_测试样本`;
const realSubvisionPath = join(realSampleDirectory, "seg-2.subvisionproj");
const realVisionPath = join(realSampleDirectory, "seg-2.visionproj");
const hasRealPair = existsSync(realSubvisionPath) && existsSync(realVisionPath);

test(
  "parses the native seg-2 subvision/vision pair without compatibility blocks",
  { skip: !hasRealPair },
  async () => {
    const subResult = parseV2SubvisionProject({
      fileName: basename(realSubvisionPath),
      jsonText: readFileSync(realSubvisionPath, "utf8"),
    });
    const subProject = parsedProject(subResult);

    const loaded = await loadProject(
      asBrowserFile(
        new Uint8Array(readFileSync(realVisionPath)),
        basename(realVisionPath),
      ),
    );
    try {
      const visionResult = loaded.parseResult;
      const visionProject = parsedProject(visionResult);

      for (const result of [subResult, visionResult]) {
        assert.equal(result.compatibility.status === "blocked", false);
        assert.equal(
          result.diagnostics.some((item) => item.disposition === "block"),
          false,
        );
        assert.equal(
          result.diagnostics.some(
            (item) => item.code === "V2_MULTIRING_CONTOUR_UNSUPPORTED",
          ),
          false,
        );
        assert.equal(
          result.diagnostics.some(
            (item) =>
              item.code === "V2_UNMAPPED_FIELD" &&
              item.path.endsWith(".contourSize"),
          ),
          false,
        );
        const contourSizeDiagnostic = result.diagnostics.find(
          (item) => item.code === "V2_CONTOUR_SIZE_REBUILT",
        );
        assert.equal(contourSizeDiagnostic?.disposition, "rebuild");
        assert.equal(contourSizeDiagnostic?.severity, "info");
        assert.equal(contourSizeDiagnostic?.details?.affectedEntityCount, 60);
      }

      for (const project of [subProject, visionProject]) {
        const labels = project.files.flatMap((file) => file.labels);
        assert.equal(project.project.type, "segmentation");
        assert.equal(project.classes.length, 7);
        assert.equal(project.classes[0]?.name, "OK");
        assert.equal(project.files.length, 60);
        assert.equal(labels.length, 60);
        assert.equal(
          labels.filter((label) => label.geometry.contours?.length === 1).length,
          43,
        );
        assert.equal(
          labels.filter((label) => label.geometry.contours?.length === 2).length,
          17,
        );
        assert.ok(project.files.every((file) => file.isNormal === false));
        assert.ok(
          labels.every(
            (label) =>
              label.geometry.contourRoles?.[0] === "outer" &&
              label.geometry.contourRoles
                .slice(1)
                .every((role) => role === "inner"),
          ),
        );
      }

      const semanticSignature = (project: ProjectIR) =>
        project.files
          .map((file) => ({
            fileName: file.fileName,
            isLabeled: file.isLabeled,
            isNormal: file.isNormal,
            labels: file.labels.map((label) => ({
              classIndex: label.classIndex,
              roles: label.geometry.contourRoles,
              ringSizes: label.geometry.contours?.map((ring) => ring.length),
            })),
          }))
          .sort((left, right) => left.fileName.localeCompare(right.fileName));
      assert.deepEqual(
        semanticSignature(visionProject),
        semanticSignature(subProject),
      );
      assert.ok(
        visionProject.files.every((file) => file.image.kind === "archive"),
      );
    } finally {
      await loaded.close();
    }
  },
);
