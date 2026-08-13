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
    project: Record<string, unknown> & {
      projectId: number;
      projectType: string;
      classInfos: Array<Record<string, unknown>>;
      datasets: Array<Record<string, unknown>>;
      projectFiles: Array<Record<string, unknown>>;
    };
  };
  const projectJson = root.project;
  const classJson = projectJson.classInfos[0]!;
  const datasetJson = projectJson.datasets[0]!;
  const datasetSplit = (datasetJson.splitSets as Array<Record<string, unknown>>)[0]!;
  const fileJson = projectJson.projectFiles[0]!;
  const fileSplit = (fileJson.splitSets as Array<Record<string, unknown>>)[0]!;
  const labels = fileJson.labelDataList as Array<Record<string, unknown>>;
  const labelJson = labels[0]!;

  assert.deepEqual(Object.keys(projectJson), [
    "projectId",
    "projectName",
    "projectType",
    "description",
    "roiMode",
    "roiPosX",
    "roiPosY",
    "roiWidth",
    "roiHeight",
    "roiShapeType",
    "modifiedDate",
    "createdDate",
    "metadataList",
    "classInfos",
    "datasets",
    "projectFiles",
  ]);
  assert.deepEqual(Object.keys(classJson), [
    "classId",
    "className",
    "classNo",
    "description",
    "classColor",
    "isNg",
  ]);
  assert.deepEqual(Object.keys(datasetJson), [
    "datasetId",
    "datasetName",
    "description",
    "modifiedDate",
    "createdDate",
    "createdBy",
    "projects",
    "metadataList",
    "splitSets",
  ]);
  assert.deepEqual(Object.keys(datasetSplit), ["splitId", "splitName", "createdDate"]);
  assert.deepEqual(Object.keys(fileJson), [
    "projectId",
    "fileId",
    "filePath",
    "isLabeled",
    "modifiedDate",
    "assignedDate",
    "datasetName",
    "width",
    "height",
    "className",
    "labelDataList",
    "metadata",
    "registeredDate",
    "isGenerated",
    "splitSets",
  ]);
  assert.deepEqual(Object.keys(fileSplit), ["splitId", "splitName", "splitType"]);
  assert.deepEqual(Object.keys(labelJson), [
    "labelId",
    "labelType",
    "labeledDate",
    "contourId",
    "className",
  ]);

  assert.equal(projectJson.projectType, "cls");
  assert.equal(projectJson.roiMode, "simple");
  assert.equal(projectJson.roiPosX, 0);
  assert.equal(projectJson.roiPosY, 0);
  assert.equal(projectJson.roiWidth, 1);
  assert.equal(projectJson.roiHeight, 1);
  assert.equal(projectJson.roiShapeType, "rectangle");
  assert.equal(projectJson.modifiedDate, 1_700_000_000_000);
  assert.equal(projectJson.createdDate, 1_700_000_000_000);
  assert.equal(classJson.classId, projectJson.projectId + 10);
  assert.equal(datasetJson.datasetId, projectJson.projectId + 1);
  assert.equal(datasetSplit.splitName, "srproj");
  assert.equal(fileJson.fileId, projectJson.projectId + 1000);
  assert.equal(fileJson.filePath, "C:\\line-a\\frame.png");
  assert.equal(fileJson.className, "OK");
  assert.equal(fileJson.isGenerated, false);
  assert.deepEqual(fileJson.splitSets, [
    {
      splitId: projectJson.projectId + 2,
      splitName: "srproj",
      splitType: "train",
    },
  ]);
  assert.equal(labelJson.labelId, projectJson.projectId + 100_000);
  assert.equal(labelJson.labelType, "man");
  assert.equal(labelJson.labeledDate, 1_700_000_000_000);
  assert.equal(labelJson.className, "OK");
  assert.equal(typeof labelJson.contourId, "string");
});

test("V1 classification writer output reparses without unmapped fields", () => {
  const written = writeV2SubvisionProject(v1ClassificationProject());
  assert.equal(written.ok, true);
  if (!written.ok) return;

  const reparsed = parseV2SubvisionProject({ jsonText: written.jsonText });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.equal(
    reparsed.diagnostics.filter((item) => item.code === "V2_UNMAPPED_FIELD").length,
    0,
  );
  assert.notEqual(reparsed.compatibility.status, "blocked");
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

test("V1 ARGB class colors retain their RGB channels in the V2 class schema", () => {
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
  assert.equal(classes[0]?.classColor, "#112233");
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

test("V2 writers enforce parser compatibility unless loss was confirmed", () => {
  const blocked: ProjectIR = {
    ...v1ClassificationProject(),
    compatibility: {
      target: "v2",
      status: "blocked",
      preserveCount: 0,
      rebuildCount: 0,
      degradeCount: 0,
      dropCount: 0,
      blockCount: 1,
    },
  };
  const blockedResult = writeV2SubvisionProject(blocked);
  assert.equal(blockedResult.ok, false);
  assert.ok(
    blockedResult.diagnostics.some(
      (item) => item.code === "V2_WRITE_COMPATIBILITY_BLOCKED",
    ),
  );

  const needsConfirmation: ProjectIR = {
    ...v1ClassificationProject(),
    compatibility: {
      target: "v2",
      status: "confirmation-required",
      preserveCount: 0,
      rebuildCount: 0,
      degradeCount: 0,
      dropCount: 1,
      blockCount: 0,
    },
  };
  assert.equal(writeV2VisionProject(needsConfirmation).ok, false);
  assert.equal(
    writeV2VisionProject(needsConfirmation, { allowConfirmedLoss: true }).ok,
    true,
  );
});
