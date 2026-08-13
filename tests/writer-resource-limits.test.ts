import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "../lib/files/imageDimensions.ts";
import type {
  JsonObject,
  ProjectClassIR,
  ProjectFileIR,
  ProjectIR,
  ProjectLabelIR,
} from "../lib/model/project.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
} from "../lib/output/v2.ts";
import {
  ARCHIVE_ENTRY_SEGMENT_MAX_BYTES,
  BROWSER_ARCHIVE_LIMITS,
  EXTERNAL_PROJECT_PATH_MAX_BYTES,
  PROJECT_JSON_MAX_VALUES,
  PROJECT_STRUCTURE_MAX_DEPTH,
  PROJECT_TEXT_MAX_BYTES,
  V2_PROJECT_LIMITS,
} from "../lib/security/resourceLimits.ts";

function label(index = 0): ProjectLabelIR {
  return {
    index,
    kind: "classification",
    origin: "manual",
    classIndex: 0,
    geometry: {},
    synthesized: false,
    raw: {},
  };
}

function file(index = 0): ProjectFileIR {
  const path = `C:\\images\\${index}.png`;
  return {
    index,
    sourcePath: path,
    normalizedPath: path.replaceAll("\\", "/"),
    fileName: `${index}.png`,
    width: 32,
    height: 24,
    isLabeled: true,
    classificationClassIndex: 0,
    splits: [{ type: "training", rawType: "train", raw: {} }],
    canonicalSplit: "training",
    labels: [label()],
    image: { kind: "external", path },
    raw: {},
  };
}

function cls(index = 0): ProjectClassIR {
  return {
    index,
    sourceIndex: index,
    name: `class-${index}`,
    description: "",
    raw: {},
  };
}

function v1Project(): ProjectIR {
  return {
    schemaVersion: 1,
    source: {
      format: "v1-srproj",
      fileName: "fixture.srproj",
      rawProjectType: "Classification",
    },
    project: {
      name: "Writer limits",
      type: "classification",
      rawType: "Classification",
      description: "",
      raw: {},
    },
    classes: [cls()],
    datasets: [],
    files: [file()],
    raw: {},
  };
}

function code(result: { readonly diagnostics: readonly { readonly code: string }[] }, expected: string): boolean {
  return result.diagnostics.some((item) => item.code === expected);
}

test("V2 writers reject ProjectIR class, file, label, and split count overflows", () => {
  const base = v1Project();
  const cases: Array<[ProjectIR, string]> = [
    [
      {
        ...base,
        classes: Array.from(
          { length: V2_PROJECT_LIMITS.maxClasses + 1 },
          (_, index) => cls(index),
        ),
      },
      "V2_WRITE_CLASS_LIMIT_EXCEEDED",
    ],
    [
      {
        ...base,
        files: Array(V2_PROJECT_LIMITS.maxFiles + 1).fill(base.files[0]),
      },
      "V2_WRITE_FILE_LIMIT_EXCEEDED",
    ],
    [
      {
        ...base,
        files: [
          {
            ...base.files[0]!,
            labels: Array(V2_PROJECT_LIMITS.maxLabels + 1).fill(label()),
          },
        ],
      },
      "V2_WRITE_LABEL_LIMIT_EXCEEDED",
    ],
    [
      {
        ...base,
        files: [
          {
            ...base.files[0]!,
            splits: Array(V2_PROJECT_LIMITS.maxSplitMemberships + 1).fill(
              base.files[0]!.splits[0],
            ),
          },
        ],
      },
      "V2_WRITE_SPLIT_LIMIT_EXCEEDED",
    ],
  ];

  for (const [project, expectedCode] of cases) {
    const subvision = writeV2SubvisionProject(project);
    const vision = writeV2VisionProject(project);
    assert.equal(subvision.ok, false, expectedCode);
    assert.equal(vision.ok, false, expectedCode);
    assert.ok(code(subvision, expectedCode), expectedCode);
    assert.ok(code(vision, expectedCode), expectedCode);
  }
});

test("V2 writers enforce UTF-8 paths before normalization", () => {
  const base = v1Project();
  const exactPath = `C:\\${"a".repeat(EXTERNAL_PROJECT_PATH_MAX_BYTES - 3)}`;
  const exactFile = { ...base.files[0]!, sourcePath: exactPath, normalizedPath: exactPath, image: { kind: "external", path: exactPath } as const };
  assert.equal(writeV2SubvisionProject({ ...base, files: [exactFile] }).ok, true);

  const overlong = `${exactPath}a`;
  const result = writeV2SubvisionProject({
    ...base,
    files: [
      {
        ...exactFile,
        sourcePath: overlong,
        normalizedPath: overlong,
        image: { kind: "external", path: overlong },
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(code(result, "V2_WRITE_PATH_LIMIT_EXCEEDED"));

  const override = `C:\\${"界".repeat(Math.floor(EXTERNAL_PROJECT_PATH_MAX_BYTES / 3) + 1)}`;
  const overrideResult = writeV2SubvisionProject(base, {
    externalPaths: { 0: override },
  });
  assert.equal(overrideResult.ok, false);
  assert.ok(code(overrideResult, "V2_WRITE_PATH_LIMIT_EXCEEDED"));
});

test("vision output bounds root JSON and image names while preserving suffixes", () => {
  const base = v1Project();
  const longStem = "图".repeat(2_000);
  const longName = `${longStem}.png`;
  const longProjectName = "项目".repeat(2_000);
  const files = [0, 1].map((index): ProjectFileIR => ({
    ...file(index),
    sourcePath: `C:\\images\\${longName}`,
    normalizedPath: `C:/images/${longName}`,
    fileName: longName,
    image: { kind: "external", path: `C:\\images\\${longName}` },
  }));
  const result = writeV2VisionProject(
    {
      ...base,
      project: { ...base.project, name: longProjectName },
      files,
    },
    { projectJsonEntryName: `${longProjectName}.json` },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const encoder = new TextEncoder();
  assert.ok(result.projectJsonEntryName.endsWith(".json"));
  assert.ok(
    encoder.encode(result.projectJsonEntryName).byteLength <=
      ARCHIVE_ENTRY_SEGMENT_MAX_BYTES,
  );
  assert.ok(
    encoder.encode(result.projectJsonEntryName).byteLength <=
      BROWSER_ARCHIVE_LIMITS.maxEntryNameBytes,
  );
  assert.ok(result.imageEntries[0]?.entryName.endsWith(".png"));
  assert.ok(result.imageEntries[1]?.entryName.endsWith("_2.png"));
  for (const entry of result.imageEntries) {
    const segment = entry.entryName.split("/").at(-1) ?? "";
    assert.ok(
      encoder.encode(segment).byteLength <= ARCHIVE_ENTRY_SEGMENT_MAX_BYTES,
    );
    assert.ok(
      encoder.encode(entry.entryName).byteLength <=
        BROWSER_ARCHIVE_LIMITS.maxEntryNameBytes,
    );
  }
  assert.equal(
    new Set(result.imageEntries.map((entry) => entry.entryName)).size,
    2,
  );
});

test("V2 writers enforce safe integer, axis, and pixel dimension limits", () => {
  const base = v1Project();
  const withDimensions = (width: number, height: number): ProjectIR => ({
    ...base,
    files: [{ ...base.files[0]!, width, height }],
  });

  const valid = writeV2VisionProject(
    withDimensions(
      MAX_IMAGE_DIMENSION,
      Math.floor(MAX_IMAGE_PIXELS / MAX_IMAGE_DIMENSION),
    ),
  );
  assert.equal(valid.ok, true);

  for (const [project, expectedCode] of [
    [withDimensions(Number.MAX_SAFE_INTEGER + 1, 1), "V2_WRITE_IMAGE_DIMENSIONS_INVALID"],
    [withDimensions(1.5, 1), "V2_WRITE_IMAGE_DIMENSIONS_INVALID"],
    [withDimensions(MAX_IMAGE_DIMENSION + 1, 1), "V2_WRITE_IMAGE_DIMENSION_LIMIT_EXCEEDED"],
    [
      withDimensions(
        MAX_IMAGE_DIMENSION,
        Math.floor(MAX_IMAGE_PIXELS / MAX_IMAGE_DIMENSION) + 1,
      ),
      "V2_WRITE_IMAGE_PIXEL_LIMIT_EXCEEDED",
    ],
  ] as const) {
    const result = writeV2VisionProject(project);
    assert.equal(result.ok, false, expectedCode);
    assert.ok(code(result, expectedCode), expectedCode);
  }
});

function v2SameVersionProject(): ProjectIR {
  const base = v1Project();
  const raw: JsonObject = {
    project: {
      projectId: 1,
      projectName: "Writer limits",
      projectType: "cls",
      classInfos: [],
      datasets: [],
      projectFiles: [{ filePath: "C:\\images\\0.png" }],
    },
  };
  return {
    ...base,
    source: {
      format: "v2-subvisionproj",
      fileName: "fixture.subvisionproj",
      rawProjectType: "cls",
    },
    raw,
  };
}

function nestedRaw(depth: number): JsonObject {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 1; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    current.next = next;
    current = next;
  }
  return root as JsonObject;
}

test("same-version raw depth and cycles are blocked before recursive clone", () => {
  const base = v2SameVersionProject();
  const rawProject = base.raw.project as JsonObject;
  const exactRaw = {
    ...base.raw,
    project: { ...rawProject, future: nestedRaw(PROJECT_STRUCTURE_MAX_DEPTH - 2) },
  } as JsonObject;
  let exactResult: ReturnType<typeof writeV2SubvisionProject> | undefined;
  assert.doesNotThrow(() => {
    exactResult = writeV2SubvisionProject({ ...base, raw: exactRaw });
  });
  assert.equal(exactResult?.ok, true);

  const deepRaw = {
    ...base.raw,
    project: { ...rawProject, future: nestedRaw(PROJECT_STRUCTURE_MAX_DEPTH + 10_000) },
  } as JsonObject;
  let deepResult: ReturnType<typeof writeV2SubvisionProject> | undefined;
  assert.doesNotThrow(() => {
    deepResult = writeV2SubvisionProject({ ...base, raw: deepRaw });
  });
  assert.equal(deepResult?.ok, false);
  assert.ok(deepResult && code(deepResult, "V2_WRITE_RAW_DEPTH_LIMIT_EXCEEDED"));

  const cyclic = structuredClone(base.raw) as Record<string, unknown>;
  cyclic.self = cyclic;
  let cyclicResult: ReturnType<typeof writeV2SubvisionProject> | undefined;
  assert.doesNotThrow(() => {
    cyclicResult = writeV2SubvisionProject({
      ...base,
      raw: cyclic as JsonObject,
    });
  });
  assert.equal(cyclicResult?.ok, false);
  assert.ok(cyclicResult && code(cyclicResult, "V2_WRITE_RAW_CYCLE"));
});

test("same-version raw counts and final serialized text are bounded", () => {
  const base = v2SameVersionProject();
  const rawProject = base.raw.project as JsonObject;
  const rawFiles = {
    ...base.raw,
    project: {
      ...rawProject,
      projectFiles: Array(V2_PROJECT_LIMITS.maxFiles + 1).fill({
        filePath: "C:\\images\\0.png",
      }),
    },
  } as JsonObject;
  const fileResult = writeV2SubvisionProject({ ...base, raw: rawFiles });
  assert.equal(fileResult.ok, false);
  assert.ok(code(fileResult, "V2_WRITE_RAW_FILE_LIMIT_EXCEEDED"));

  const rawLabels = {
    ...base.raw,
    project: {
      ...rawProject,
      projectFiles: [
        {
          filePath: "C:\\images\\0.png",
          labelDataList: Array(V2_PROJECT_LIMITS.maxLabels + 1).fill(null),
        },
      ],
    },
  } as JsonObject;
  const labelResult = writeV2SubvisionProject({ ...base, raw: rawLabels });
  assert.equal(labelResult.ok, false);
  assert.ok(code(labelResult, "V2_WRITE_RAW_LABEL_LIMIT_EXCEEDED"));

  const valueFlood = {
    ...base.raw,
    payload: Array(PROJECT_JSON_MAX_VALUES).fill(null),
  } as JsonObject;
  const valueResult = writeV2SubvisionProject({ ...base, raw: valueFlood });
  assert.equal(valueResult.ok, false);
  assert.ok(code(valueResult, "V2_WRITE_RAW_VALUE_LIMIT_EXCEEDED"));

  const v1 = v1Project();
  const textResult = writeV2SubvisionProject({
    ...v1,
    project: {
      ...v1.project,
      description: "x".repeat(PROJECT_TEXT_MAX_BYTES),
    },
  });
  assert.equal(textResult.ok, false);
  assert.ok(code(textResult, "V2_WRITE_TEXT_LIMIT_EXCEEDED"));
});
