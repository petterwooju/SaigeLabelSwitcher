import assert from "node:assert/strict";
import test from "node:test";
import { parseV2SubvisionProject } from "../lib/input/v2.ts";
import type { JsonObject, ProjectFileIR, ProjectIR } from "../lib/model/project.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
} from "../lib/output/v2.ts";

function v1ClassificationProject(): ProjectIR {
  const files: ProjectFileIR[] = [
    classificationFile(0, "C:\\line-a\\frame.png", 0, "training"),
    classificationFile(1, "D:\\line-b\\frame.png", 1, "validation"),
  ];
  return {
    schemaVersion: 1,
    source: {
      format: "v1-srproj",
      fileName: "fixture.srproj",
      rawProjectType: "Classification",
    },
    project: {
      name: "Fixture CLS",
      type: "classification",
      rawType: "Classification",
      description: "converted",
      modifiedAt: 1_700_000_000_000,
      raw: {},
    },
    classes: [
      {
        index: 0,
        sourceIndex: 0,
        name: "OK",
        color: "#00ff00",
        description: "",
        raw: {},
      },
      {
        index: 1,
        sourceIndex: 1,
        name: "NG",
        color: "#ff0000",
        description: "",
        isNg: true,
        raw: {},
      },
    ],
    datasets: [],
    files,
    raw: {},
  };
}

function classificationFile(
  index: number,
  path: string,
  classIndex: number,
  split: "training" | "validation",
): ProjectFileIR {
  const fileName = path.replace(/\\/gu, "/").split("/").at(-1) ?? "image.png";
  return {
    index,
    sourcePath: path,
    normalizedPath: path.replace(/\\/gu, "/"),
    fileName,
    width: 32,
    height: 24,
    isLabeled: true,
    classificationClassIndex: classIndex,
    splits: [{ type: split, rawType: split, raw: {} }],
    canonicalSplit: split,
    labels: [
      {
        index: 0,
        kind: "classification",
        origin: "manual",
        classIndex,
        geometry: {},
        synthesized: false,
        raw: {},
      },
    ],
    image: { kind: "external", path },
    raw: {},
  };
}

function v2GoldenLike(): JsonObject {
  return {
    project: {
      projectId: 100,
      projectName: "Preserve Me",
      projectType: "cls",
      description: "golden-like",
      roiMode: "no",
      modifiedDate: 200,
      createdDate: 100,
      metadataList: [{ key: "future", value: "kept" }],
      classInfos: [
        {
          projectId: 100,
          classId: 110,
          classNo: 0,
          classSeq: 0,
          className: "OK",
          description: "class metadata",
          classColor: "#00FF00",
          isNg: false,
        },
      ],
      datasets: [
        {
          datasetId: 101,
          datasetName: "dataset",
          description: "",
          modifiedDate: 200,
          createdDate: 100,
          createdBy: "admin",
          projects: [],
          metadataList: [],
          splitSets: [{ splitId: 102, splitName: "default", createdDate: 100 }],
        },
      ],
      projectFiles: [
        {
          projectId: 100,
          fileId: 1000,
          filePath: "C:\\images\\ok.png",
          isLabeled: true,
          classId: 110,
          className: "OK",
          modifiedDate: 200,
          assignedDate: 100,
          datasetName: "dataset",
          width: 32,
          height: 24,
          labelDataList: [],
          metadata: [{ untouched: true }],
          registeredDate: 100,
          splitSets: [{ splitId: 102, splitName: "default", splitType: "train" }],
        },
      ],
      futureProjectField: { untouched: true },
    },
  };
}

test("V1 classification output uses deterministic IDs and the observed V2 schema", () => {
  const project = v1ClassificationProject();
  const first = writeV2SubvisionProject(project);
  const second = writeV2SubvisionProject(project);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.jsonText, second.jsonText);

  const root = first.json as unknown as {
    project: {
      projectId: number;
      projectType: string;
      classInfos: Array<Record<string, unknown>>;
      datasets: Array<Record<string, unknown>>;
      projectFiles: Array<Record<string, unknown>>;
    };
  };
  assert.equal(root.project.projectType, "cls");
  assert.equal(root.project.classInfos[0]?.classId, root.project.projectId + 10);
  assert.equal(root.project.datasets[0]?.datasetId, root.project.projectId + 1);
  assert.equal(root.project.projectFiles[0]?.fileId, root.project.projectId + 1000);
  assert.equal(root.project.projectFiles[0]?.filePath, "C:\\line-a\\frame.png");
  assert.deepEqual(root.project.projectFiles[0]?.splitSets, [
    {
      splitId: root.project.projectId + 2,
      splitName: "default",
      splitType: "train",
    },
  ]);
  const labels = root.project.projectFiles[0]?.labelDataList as Array<
    Record<string, unknown>
  >;
  assert.equal(labels[0]?.labelWidth, 32);
  assert.equal(labels[0]?.labelHeight, 24);
  assert.equal(labels[0]?.className, "OK");
  assert.equal(labels[0]?.labelContour, "[[[0,0],[32,0],[32,24],[0,24]]]");
});

test("subvision output rejects relative and traversal image paths", () => {
  const relative = writeV2SubvisionProject(v1ClassificationProject(), {
    externalPaths: { 0: "images/frame.png" },
  });
  assert.equal(relative.ok, false);
  assert.ok(
    relative.diagnostics.some(
      (item) => item.code === "V2_WRITE_EXTERNAL_PATH_RELATIVE",
    ),
  );

  const traversal = writeV2SubvisionProject(v1ClassificationProject(), {
    externalPaths: { 0: "C:\\images\\..\\secret\\frame.png" },
  });
  assert.equal(traversal.ok, false);
  assert.ok(
    traversal.diagnostics.some(
      (item) => item.code === "V2_WRITE_EXTERNAL_PATH_TRAVERSAL",
    ),
  );
});

test("subvision output rejects paths duplicated after Unicode and case normalization", () => {
  const result = writeV2SubvisionProject(v1ClassificationProject(), {
    externalPaths: {
      0: "C:\\Images\\caf\u00e9.png",
      1: "c:/images/cafe\u0301.png",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "V2_WRITE_EXTERNAL_PATH_DUPLICATE",
    ),
  );
});

test("subvision output dequotes absolute paths and round-trips them", () => {
  const written = writeV2SubvisionProject(v1ClassificationProject(), {
    externalPaths: { 0: '"C:\\quoted path\\frame.png"' },
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  const files = (written.json.project as JsonObject)
    .projectFiles as readonly JsonObject[];
  assert.equal(files[0]?.filePath, "C:\\quoted path\\frame.png");

  const reparsed = parseV2SubvisionProject({ jsonText: written.jsonText });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.equal(reparsed.project.files[0]?.normalizedPath, "C:/quoted path/frame.png");
  assert.equal(reparsed.project.files[0]?.image.kind, "external");
});

test("subvision output accepts UNC paths and round-trips them", () => {
  const uncPath = "\\\\server\\share\\line-a\\frame.png";
  const written = writeV2SubvisionProject(v1ClassificationProject(), {
    externalPaths: { 0: uncPath },
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  const files = (written.json.project as JsonObject)
    .projectFiles as readonly JsonObject[];
  assert.equal(files[0]?.filePath, uncPath);

  const reparsed = parseV2SubvisionProject({ jsonText: written.jsonText });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.equal(
    reparsed.project.files[0]?.normalizedPath,
    "//server/share/line-a/frame.png",
  );
});

test("V1 ARGB class colors retain their RGB channels in V2", () => {
  const source = v1ClassificationProject();
  const project: ProjectIR = {
    ...source,
    classes: source.classes.map((item) =>
      item.index === 0 ? { ...item, color: "#80112233" } : item,
    ),
  };
  const written = writeV2SubvisionProject(project);
  assert.equal(written.ok, true);
  if (!written.ok) return;
  const root = written.json.project as JsonObject;
  const classes = root.classInfos as readonly JsonObject[];
  const files = root.projectFiles as readonly JsonObject[];
  const labels = files[0]?.labelDataList as readonly JsonObject[];
  assert.equal(classes[0]?.classColor, "#112233");
  assert.equal(labels[0]?.classColor, "#112233");
});

test("vision output maps duplicate Windows basenames to unique images entries", () => {
  const result = writeV2VisionProject(v1ClassificationProject());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.imageEntries.map((item) => item.entryName),
    ["images/frame.png", "images/frame_2.png"],
  );
  assert.deepEqual(
    ((result.json.project as JsonObject).projectFiles as readonly JsonObject[]).map(
      (item) => item.filePath,
    ),
    ["images/frame.png", "images/frame_2.png"],
  );
  assert.equal(result.imageEntries[0]?.source.kind, "external");
});

test("V2 golden-like roundtrip preserves raw data and changes only filePath", () => {
  const golden = v2GoldenLike();
  const parsed = parseV2SubvisionProject({
    fileName: "golden.subvisionproj",
    jsonText: JSON.stringify(golden),
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const subvision = writeV2SubvisionProject(parsed.project);
  assert.equal(subvision.ok, true);
  if (!subvision.ok) return;
  assert.deepEqual(subvision.json, golden);

  const vision = writeV2VisionProject(parsed.project);
  assert.equal(vision.ok, true);
  if (!vision.ok) return;
  const expected = structuredClone(golden) as unknown as {
    project: { projectFiles: Array<Record<string, unknown>> };
  };
  expected.project.projectFiles[0]!.filePath = "images/ok.png";
  assert.deepEqual(vision.json, expected);
});

test("unknown project types are blocked explicitly", () => {
  const source = v1ClassificationProject();
  const project: ProjectIR = {
    ...source,
    project: {
      ...source.project,
      type: "unknown",
      rawType: "ocr",
    },
  };
  const result = writeV2SubvisionProject(project);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "V2_WRITE_PROJECT_TYPE_UNSUPPORTED",
    ),
  );
});

test("DET and SEG output remain blocked without verified goldens", () => {
  for (const type of ["detection", "segmentation"] as const) {
    const source = v1ClassificationProject();
    const result = writeV2VisionProject({
      ...source,
      project: { ...source.project, type, rawType: type },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some((item) => item.code === "V2_WRITE_GOLDEN_REQUIRED"),
    );
  }
});
