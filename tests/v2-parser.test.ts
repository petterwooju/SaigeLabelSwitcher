import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseV2SubvisionProject,
  parseV2VisionProject,
} from "../lib/input/v2.ts";
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "../lib/files/imageDimensions.ts";
import type { ProjectIR } from "../lib/model/project.ts";
import { writeV2SubvisionProject } from "../lib/output/v2.ts";

function clsProject(): Record<string, unknown> {
  return {
    project: {
      projectId: 10,
      projectName: "Synthetic CLS",
      projectType: "cls",
      description: "fixture",
      roiMode: "no",
      createdDate: 100,
      modifiedDate: 200,
      metadataList: [],
      classInfos: [
        { classId: 20, classNo: 0, className: "OK", classColor: "#00ff00" },
        { classId: 21, classNo: 1, className: "NG", classColor: "#ff0000", isNg: true },
      ],
      datasets: [
        { datasetId: 30, datasetName: "dataset", description: "", splitSets: [] },
      ],
      projectFiles: [
        {
          fileId: 40,
          filePath: "C:\\images\\ok.png",
          width: 32,
          height: 24,
          isLabeled: true,
          classId: 20,
          className: "OK",
          datasetId: 30,
          datasetName: "dataset",
          labelDataList: [],
          splitSets: [{ splitId: 50, splitName: "default", splitType: "train" }],
        },
        {
          fileId: 41,
          filePath: "C:\\images\\ng.png",
          width: 32,
          height: 24,
          isLabeled: true,
          classId: 21,
          className: "NG",
          datasetId: 30,
          datasetName: "dataset",
          labelDataList: [],
          splitSets: [{ splitId: 50, splitName: "default", splitType: "validation" }],
        },
      ],
    },
  };
}

function serializedRectangleRoiShape(
  left: number,
  top: number,
  right: number,
  bottom: number,
): string {
  const stageSize = { width: 1000, height: 800 };
  const rectangle = {
    x: left * stageSize.width,
    y: top * stageSize.height,
    width: (right - left) * stageSize.width,
    height: (bottom - top) * stageSize.height,
  };
  return JSON.stringify({
    attrs: { id: "base-layer", stageSize },
    className: "Layer",
    children: [
      {
        attrs: { isBackground: true, width: stageSize.width, height: stageSize.height },
        className: "Rect",
      },
      {
        attrs: { name: "roi-area", UIType: "roi", x: 0, y: 0, scaleX: 1, scaleY: 1 },
        className: "Group",
        children: [
          { attrs: { ...rectangle, fill: "white" }, className: "Rect" },
          { attrs: { ...rectangle, stroke: "white" }, className: "Rect" },
        ],
      },
    ],
  });
}

function clsProjectWithFirstLabel(
  geometry: Record<string, unknown> = {},
): Record<string, unknown> {
  const fixture = clsProject();
  const project = fixture.project as {
    projectFiles: Array<{ labelDataList: Array<Record<string, unknown>> }>;
  };
  project.projectFiles[0]!.labelDataList = [
    {
      labelId: 60,
      labelType: "man",
      classId: 20,
      className: "OK",
      ...geometry,
    },
  ];
  return fixture;
}

function detProject(imagePath = "images/frame.png"): Record<string, unknown> {
  return {
    project: {
      projectId: 11,
      projectName: "Synthetic DET",
      projectType: "det",
      roiMode: "no",
      classInfos: [
        { classId: 1, classNo: 0, className: "defect", classColor: "#ff0000" },
      ],
      datasets: [
        { datasetId: 3, datasetName: "dataset", description: "", splitSets: [] },
      ],
      projectFiles: [
        {
          fileId: 7,
          filePath: imagePath,
          width: 100,
          height: 80,
          isLabeled: true,
          datasetId: 3,
          datasetName: "dataset",
          splitSets: [{ splitId: 8, splitName: "default", splitType: "train" }],
          labelDataList: [
            {
              labelId: 9,
              labelType: "man",
              classId: 1,
              className: "defect",
              labelPosX: 10,
              labelPosY: 11,
              labelWidth: 20,
              labelHeight: 21,
            },
          ],
        },
      ],
    },
  };
}

test("parses a valid .subvisionproj into canonical classification IR", () => {
  const result = parseV2SubvisionProject({
    fileName: "fixture.subvisionproj",
    jsonText: JSON.stringify(clsProject()),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.source.format, "v2-subvisionproj");
  assert.equal(result.project.project.type, "classification");
  assert.deepEqual(
    result.project.classes.map((item) => [item.index, item.name]),
    [
      [0, "OK"],
      [1, "NG"],
    ],
  );
  assert.equal(result.project.files[0]?.normalizedPath, "C:/images/ok.png");
  assert.equal(result.project.files[0]?.canonicalSplit, "training");
  assert.equal(result.project.files[1]?.canonicalSplit, "validation");
  assert.equal(result.project.files[1]?.labels[0]?.kind, "classification");
  assert.equal(result.project.files[1]?.labels[0]?.classIndex, 1);
  assert.equal(result.project.files[0]?.image.kind, "external");
});

test("reads the legacy valid split token produced by older converter builds", () => {
  const fixture = clsProject();
  const project = fixture.project as {
    projectFiles: Array<{ splitSets: Array<{ splitType: string }> }>;
  };
  project.projectFiles[1]!.splitSets[0]!.splitType = "valid";

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.files[1]?.canonicalSplit, "validation");
});

test("parses a valid .visionproj using supplied entry names and bytes", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const result = parseV2VisionProject({
    fileName: "fixture.visionproj",
    projectJsonText: JSON.stringify(detProject()),
    projectJsonEntryName: "fixture.json",
    entries: [{ name: "fixture.json" }, { name: "images/frame.png", bytes }],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.project.type, "detection");
  assert.equal(result.compatibility.status, "blocked");
  assert.ok(
    result.diagnostics.some((item) => item.code === "V2_PROJECT_TYPE_UNSUPPORTED"),
  );
  assert.equal(result.project.files[0]?.image.kind, "archive");
  const image = result.project.files[0]?.image;
  assert.ok(image?.kind === "archive");
  assert.equal(image.entryName, "images/frame.png");
  assert.equal(image.bytes, bytes);
  assert.deepEqual(result.project.files[0]?.labels[0]?.geometry.box, {
    x: 10,
    y: 11,
    width: 20,
    height: 21,
  });
});

test("rejects malformed V2 JSON", () => {
  const result = parseV2SubvisionProject({ jsonText: "{not-json" });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "V2_INVALID_JSON"));
});

test("rejects archive and project image path traversal", () => {
  const result = parseV2VisionProject({
    projectJsonText: JSON.stringify(detProject("images/../outside.png")),
    projectJsonEntryName: "fixture.json",
    entries: [{ name: "fixture.json" }, { name: "images/../outside.png" }],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_ARCHIVE_ENTRY_UNSAFE" ||
        item.code === "V2_ARCHIVE_IMAGE_PATH_UNSAFE",
    ),
  );
});

test("rejects duplicate fileId values", () => {
  const fixture = clsProject();
  const project = fixture.project as { projectFiles: Array<Record<string, unknown>> };
  project.projectFiles[1] = { ...project.projectFiles[1], fileId: 40 };
  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "V2_DUPLICATE_FILE_ID"));
});

test("blocks a non-boolean isLabeled value instead of silently ignoring it", () => {
  const fixture = clsProject();
  const project = fixture.project as { projectFiles: Array<Record<string, unknown>> };
  project.projectFiles[0]!.isLabeled = "true";

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_IS_LABELED_INVALID" &&
        item.category === "validation" &&
        item.disposition === "block" &&
        item.path === "$.project.projectFiles[0].isLabeled",
    ),
  );
});

test("enforces safe and bounded V2 image dimensions", () => {
  const parseWithDimensions = (width: number, height: number) => {
    const fixture = clsProject();
    const project = fixture.project as {
      projectFiles: Array<Record<string, unknown>>;
    };
    project.projectFiles[0]!.width = width;
    project.projectFiles[0]!.height = height;
    return parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  };

  const valid = parseWithDimensions(
    MAX_IMAGE_DIMENSION,
    Math.floor(MAX_IMAGE_PIXELS / MAX_IMAGE_DIMENSION),
  );
  assert.equal(valid.ok, true);

  const unsafe = parseWithDimensions(Number.MAX_SAFE_INTEGER + 1, 1);
  assert.equal(unsafe.ok, false);
  assert.ok(
    unsafe.diagnostics.some(
      (item) =>
        item.code === "V2_WIDTH_INVALID" &&
        item.path === "$.project.projectFiles[0].width",
    ),
  );

  const oversizedAxis = parseWithDimensions(MAX_IMAGE_DIMENSION + 1, 1);
  assert.equal(oversizedAxis.ok, false);
  assert.ok(
    oversizedAxis.diagnostics.some(
      (item) =>
        item.code === "V2_IMAGE_DIMENSION_LIMIT_EXCEEDED" &&
        item.path === "$.project.projectFiles[0].width",
    ),
  );

  const oversizedPixels = parseWithDimensions(
    MAX_IMAGE_DIMENSION,
    Math.floor(MAX_IMAGE_PIXELS / MAX_IMAGE_DIMENSION) + 1,
  );
  assert.equal(oversizedPixels.ok, false);
  assert.ok(
    oversizedPixels.diagnostics.some(
      (item) =>
        item.code === "V2_IMAGE_PIXEL_LIMIT_EXCEEDED" &&
        item.path === "$.project.projectFiles[0]",
    ),
  );
});

test("retains an unknown V2 type but blocks V1 compatibility", () => {
  const fixture = clsProject();
  const project = fixture.project as Record<string, unknown>;
  project.projectType = "ocr";
  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.project.type, "unknown");
  assert.equal(result.compatibility.status, "blocked");
  assert.ok(
    result.diagnostics.some((item) => item.code === "V2_PROJECT_TYPE_UNSUPPORTED"),
  );
});

test("retains unmapped fields and reports them instead of silently dropping them", () => {
  const fixture = clsProject();
  const project = fixture.project as Record<string, unknown>;
  project.futureFeature = { enabled: true };
  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.project.raw.futureFeature, { enabled: true });
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "V2_UNMAPPED_FIELD" && item.path === "$.project.futureFeature",
    ),
  );
  assert.equal(result.compatibility.status, "confirmation-required");
});

test("allows native Classification labels with no geometry", () => {
  const result = parseV2SubvisionProject({
    jsonText: JSON.stringify(clsProjectWithFirstLabel()),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.files[0]?.labels[0]?.geometry, {});
  assert.equal(
    result.diagnostics.some(
      (item) => item.code === "V2_CLASSIFICATION_GEOMETRY_NOT_IN_V1",
    ),
    false,
  );
  assert.equal(
    result.diagnostics.some(
      (item) => item.code === "V2_CLASSIFICATION_FULL_IMAGE_GEOMETRY",
    ),
    false,
  );
});

test("preserves strictly full-image Classification box and single contour geometry", () => {
  const result = parseV2SubvisionProject({
    jsonText: JSON.stringify(
      clsProjectWithFirstLabel({
        labelPosX: 0,
        labelPosY: 0,
        labelWidth: 32,
        labelHeight: 24,
        labelContour: JSON.stringify([
          [
            [0, 0],
            [32, 0],
            [32, 24],
            [0, 24],
          ],
        ]),
      }),
    ),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.compatibility.status, "blocked");
  assert.deepEqual(result.project.files[0]?.labels[0]?.geometry.box, {
    x: 0,
    y: 0,
    width: 32,
    height: 24,
  });
  assert.equal(result.project.files[0]?.labels[0]?.geometry.contours?.length, 1);
  const preserved = result.diagnostics.filter(
    (item) => item.code === "V2_CLASSIFICATION_FULL_IMAGE_GEOMETRY",
  );
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0]?.disposition, "preserve");
  assert.equal(preserved[0]?.severity, "info");
});

test("blocks partial and out-of-bounds Classification geometry", () => {
  const partial = parseV2SubvisionProject({
    jsonText: JSON.stringify(
      clsProjectWithFirstLabel({
        labelPosX: 1,
        labelPosY: 1,
        labelWidth: 16,
        labelHeight: 12,
      }),
    ),
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.compatibility.status, "blocked");
  assert.ok(
    partial.diagnostics.some(
      (item) =>
        item.code === "V2_CLASSIFICATION_GEOMETRY_NOT_IN_V1" &&
        item.details?.reason === "not-full-image",
    ),
  );

  const outOfBounds = parseV2SubvisionProject({
    jsonText: JSON.stringify(
      clsProjectWithFirstLabel({
        labelPosX: -1,
        labelPosY: 0,
        labelWidth: 32,
        labelHeight: 24,
      }),
    ),
  });
  assert.equal(outOfBounds.ok, true);
  assert.equal(outOfBounds.compatibility.status, "blocked");
  assert.ok(
    outOfBounds.diagnostics.some(
      (item) => item.code === "V2_LABEL_OUT_OF_BOUNDS",
    ),
  );
});

test("blocks Classification bitmap geometry", () => {
  const result = parseV2SubvisionProject({
    jsonText: JSON.stringify(
      clsProjectWithFirstLabel({ labelBitmap: "encoded-mask" }),
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.compatibility.status, "blocked");
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_CLASSIFICATION_GEOMETRY_NOT_IN_V1" &&
        item.details?.reason === "bitmap",
    ),
  );
  if (result.ok) {
    assert.equal(
      result.project.files[0]?.labels[0]?.geometry.bitmap,
      "encoded-mask",
    );
  }
});

test("blocks Classification contours with multiple rings", () => {
  const result = parseV2SubvisionProject({
    jsonText: JSON.stringify(
      clsProjectWithFirstLabel({
        labelContour: JSON.stringify([
          [
            [0, 0],
            [32, 0],
            [32, 24],
            [0, 24],
          ],
          [
            [8, 6],
            [24, 6],
            [24, 18],
            [8, 18],
          ],
        ]),
      }),
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.compatibility.status, "blocked");
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_CLASSIFICATION_GEOMETRY_NOT_IN_V1" &&
        item.details?.reason === "multiple-rings",
    ),
  );
});

test("parses the native classification schema generated by the V2 writer", () => {
  const legacy = parseV2SubvisionProject({
    fileName: "legacy.subvisionproj",
    jsonText: JSON.stringify(clsProject()),
  });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;

  const v1LikeProject: ProjectIR = {
    ...legacy.project,
    source: {
      format: "v1-srproj",
      fileName: "legacy.srproj",
      rawProjectType: "Classification",
    },
    raw: {},
  };
  const written = writeV2SubvisionProject(v1LikeProject);
  assert.equal(written.ok, true);
  if (!written.ok) return;

  const generatedRoot = JSON.parse(written.jsonText) as {
    project: {
      projectFiles: Array<{
        classId?: number;
        className?: string;
        labelDataList: Array<Record<string, unknown>>;
      }>;
    };
  };
  assert.equal(generatedRoot.project.projectFiles[0]?.classId, undefined);
  assert.equal(generatedRoot.project.projectFiles[0]?.className, "OK");
  assert.equal(generatedRoot.project.projectFiles[0]?.labelDataList.length, 1);

  const reparsed = parseV2SubvisionProject({
    fileName: "generated.subvisionproj",
    jsonText: written.jsonText,
  });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.equal(reparsed.compatibility.status === "blocked", false);
  assert.equal(reparsed.project.files[0]?.classificationClassIndex, 0);
  assert.equal(reparsed.project.files[0]?.labels[0]?.kind, "classification");
  assert.equal(reparsed.project.files[0]?.labels[0]?.synthesized, false);
  assert.deepEqual(reparsed.project.files[0]?.labels[0]?.geometry, {});
  assert.equal(
    reparsed.diagnostics.some(
      (item) => item.code === "V2_CLASSIFICATION_OBJECT_LABELS",
    ),
    false,
  );
  assert.equal(
    reparsed.diagnostics.some(
      (item) => item.code === "V2_CLASSIFICATION_FULL_IMAGE_GEOMETRY",
    ),
    false,
  );
  assert.equal(
    reparsed.diagnostics.some((item) => item.code === "V2_UNMAPPED_FIELD"),
    false,
  );
});

test("accepts matching file and label classes but blocks a conflict", () => {
  const matching = clsProject();
  const matchingProject = matching.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  matchingProject.projectFiles[0]!.classNo = 0;
  matchingProject.projectFiles[0]!.labelDataList = [
    {
      labelId: 60,
      labelType: "man",
      labelPosX: 0,
      labelPosY: 0,
      labelWidth: 32,
      labelHeight: 24,
      classId: 20,
      classNo: 0,
      className: "OK",
      labelContour: "[[[0,0],[32,0],[32,24],[0,24]]]",
    },
  ];

  const matchingResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(matching),
  });
  assert.equal(matchingResult.ok, true);
  if (!matchingResult.ok) return;
  assert.notEqual(matchingResult.compatibility.status, "blocked");
  assert.equal(matchingResult.project.files[0]?.classificationClassIndex, 0);
  assert.equal(matchingResult.project.files[0]?.labels[0]?.synthesized, false);

  const conflicting = JSON.parse(JSON.stringify(matching)) as {
    project: { projectFiles: Array<Record<string, unknown>> };
  };
  conflicting.project.projectFiles[0]!.classId = 21;
  conflicting.project.projectFiles[0]!.classNo = 1;
  conflicting.project.projectFiles[0]!.className = "NG";
  const conflictResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(conflicting),
  });
  assert.equal(conflictResult.ok, true);
  assert.equal(conflictResult.compatibility.status, "blocked");
  assert.ok(
    conflictResult.diagnostics.some(
      (item) => item.code === "V2_CLASSIFICATION_CLASS_CONFLICT",
    ),
  );
});

test("validates every provided file-level class reference", () => {
  const conflicting = clsProject();
  const conflictingProject = conflicting.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  conflictingProject.projectFiles[0]!.classNo = 1;

  const conflictResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(conflicting),
  });
  assert.equal(conflictResult.ok, true);
  assert.equal(conflictResult.compatibility.status, "blocked");
  assert.ok(
    conflictResult.diagnostics.some(
      (item) =>
        item.code === "V2_CLASS_REFERENCE_CONFLICT" &&
        item.path === "$.project.projectFiles[0]",
    ),
  );

  const invalid = clsProject();
  const invalidProject = invalid.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  invalidProject.projectFiles[0]!.classNo = 99;

  const invalidResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(invalid),
  });
  assert.equal(invalidResult.ok, true);
  assert.equal(invalidResult.compatibility.status, "blocked");
  assert.ok(
    invalidResult.diagnostics.some(
      (item) =>
        item.code === "V2_CLASS_NUMBER_REFERENCE_INVALID" &&
        item.path === "$.project.projectFiles[0].classNo",
    ),
  );

  const invalidId = clsProject();
  const invalidIdProject = invalidId.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  invalidIdProject.projectFiles[0]!.classId = 999;
  invalidIdProject.projectFiles[0]!.classNo = 0;

  const invalidIdResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(invalidId),
  });
  assert.equal(invalidIdResult.ok, true);
  assert.equal(invalidIdResult.compatibility.status, "blocked");
  assert.ok(
    invalidIdResult.diagnostics.some(
      (item) =>
        item.code === "V2_CLASS_ID_REFERENCE_INVALID" &&
        item.path === "$.project.projectFiles[0].classId",
    ),
  );
});

test("validates every provided label-level class reference", () => {
  const conflicting = clsProject();
  const conflictingProject = conflicting.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  conflictingProject.projectFiles[0]!.labelDataList = [
    {
      labelId: 60,
      labelType: "man",
      labelPosX: 0,
      labelPosY: 0,
      labelWidth: 32,
      labelHeight: 24,
      classId: 20,
      classNo: 1,
      className: "OK",
      labelContour: "[[[0,0],[32,0],[32,24],[0,24]]]",
    },
  ];

  const conflictResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(conflicting),
  });
  assert.equal(conflictResult.ok, true);
  assert.equal(conflictResult.compatibility.status, "blocked");
  assert.ok(
    conflictResult.diagnostics.some(
      (item) =>
        item.code === "V2_CLASS_REFERENCE_CONFLICT" &&
        item.path === "$.project.projectFiles[0].labelDataList[0]",
    ),
  );

  const invalid = clsProject();
  const invalidProject = invalid.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  invalidProject.projectFiles[0]!.labelDataList = [
    {
      labelId: 60,
      labelType: "man",
      labelPosX: 0,
      labelPosY: 0,
      labelWidth: 32,
      labelHeight: 24,
      classId: 20,
      classNo: 0,
      className: "missing",
      labelContour: "[[[0,0],[32,0],[32,24],[0,24]]]",
    },
  ];

  const invalidResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(invalid),
  });
  assert.equal(invalidResult.ok, true);
  assert.equal(invalidResult.compatibility.status, "blocked");
  assert.ok(
    invalidResult.diagnostics.some(
      (item) =>
        item.code === "V2_CLASS_NAME_REFERENCE_INVALID" &&
        item.path === "$.project.projectFiles[0].labelDataList[0].className",
    ),
  );
});

test("keeps an entirely unlabeled classification project parseable but blocks V1", () => {
  const fixture = clsProject();
  const project = fixture.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  for (const file of project.projectFiles) {
    delete file.classId;
    delete file.classNo;
    delete file.className;
    file.isLabeled = false;
    file.labelDataList = [];
  }

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.compatibility.status, "blocked");
  assert.equal(
    result.diagnostics.filter(
      (item) => item.code === "V2_CLASSIFICATION_CLASS_MISSING",
    ).length,
    2,
  );
  assert.ok(
    result.project.files.every(
      (file) =>
        file.classificationClassIndex === undefined &&
        file.labels.length === 0 &&
        file.raw.isLabeled === false,
    ),
  );
});

test("blocks V1 compatibility when only one classification file is unclassified", () => {
  const fixture = clsProject();
  const project = fixture.project as {
    projectFiles: Array<Record<string, unknown>>;
  };
  const unclassified = project.projectFiles[1]!;
  delete unclassified.classId;
  delete unclassified.classNo;
  delete unclassified.className;
  delete unclassified.isLabeled;
  unclassified.labelDataList = [];

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.compatibility.status, "blocked");
  assert.equal(result.project.files[0]?.classificationClassIndex, 0);
  assert.equal(result.project.files[1]?.classificationClassIndex, undefined);
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_CLASSIFICATION_CLASS_MISSING" &&
        item.path === "$.project.projectFiles[1]",
    ),
  );
});

test("maps native V2 ROI boundaries without treating right/bottom as extents", () => {
  const defaultRoi = clsProject();
  const defaultProject = defaultRoi.project as Record<string, unknown>;
  Object.assign(defaultProject, {
    roiMode: "simple",
    roiPosX: 0,
    roiPosY: 0,
    roiWidth: 1,
    roiHeight: 1,
    roiShapeType: "rectangle",
  });

  const defaultResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(defaultRoi),
  });
  assert.equal(defaultResult.ok, true);
  assert.notEqual(defaultResult.compatibility.status, "blocked");
  assert.ok(
    defaultResult.diagnostics.some(
      (item) => item.code === "V2_DEFAULT_FULL_IMAGE_ROI",
    ),
  );
  assert.equal(
    defaultResult.diagnostics.some(
      (item) => item.code === "V2_ROI_MAPPING_UNVERIFIED",
    ),
    false,
  );

  const customRoi = structuredClone(defaultRoi);
  const customProject = customRoi.project as Record<string, unknown>;
  customProject.roiWidth = 0.75;
  const customResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(customRoi),
  });
  assert.equal(customResult.ok, true);
  if (!customResult.ok) return;
  assert.notEqual(customResult.compatibility.status, "blocked");
  assert.deepEqual(customResult.project.project.roi, {
    mode: "simple",
    shape: "rectangle",
    left: 0,
    top: 0,
    right: 0.75,
    bottom: 1,
  });
  assert.ok(
    customResult.diagnostics.some(
      (item) => item.code === "V2_SIMPLE_RECTANGLE_ROI",
    ),
  );
});

test("accepts a verified native Konva rectangle and derived PNG bitmap", () => {
  const fixture = clsProject();
  const project = fixture.project as Record<string, unknown>;
  Object.assign(project, {
    roiMode: "simple",
    roiPosX: 0.1,
    roiPosY: 0.2,
    roiWidth: 0.8,
    roiHeight: 0.9,
    roiShape: serializedRectangleRoiShape(0.1, 0.2, 0.8, 0.9),
    roiBitmap:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.compatibility.status, "blocked");
  assert.deepEqual(result.project.project.roi, {
    mode: "simple",
    shape: "rectangle",
    left: 0.1,
    top: 0.2,
    right: 0.8,
    bottom: 0.9,
  });
  assert.ok(result.diagnostics.some((item) => item.code === "V2_ROI_SHAPE_REBUILT"));
  assert.ok(result.diagnostics.some((item) => item.code === "V2_ROI_BITMAP_REBUILT"));
  assert.equal(
    result.diagnostics.some(
      (item) =>
        item.code === "V2_UNMAPPED_FIELD" &&
        (item.path.endsWith(".roiShape") || item.path.endsWith(".roiBitmap")),
    ),
    false,
  );
});

test("blocks malformed, inconsistent, and out-of-range V2 ROI data", () => {
  const conflicting = clsProject();
  Object.assign(conflicting.project as Record<string, unknown>, {
    roiMode: "simple",
    roiPosX: 0.1,
    roiPosY: 0.2,
    roiWidth: 0.8,
    roiHeight: 0.9,
    roiShape: serializedRectangleRoiShape(0.25, 0.2, 0.8, 0.9),
  });
  const conflictResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(conflicting),
  });
  assert.equal(conflictResult.ok, true);
  assert.equal(conflictResult.compatibility.status, "blocked");
  assert.ok(
    conflictResult.diagnostics.some((item) => item.code === "V2_ROI_SHAPE_CONFLICT"),
  );

  const invalidBitmap = clsProject();
  Object.assign(invalidBitmap.project as Record<string, unknown>, {
    roiMode: "simple",
    roiPosX: 0.1,
    roiPosY: 0.2,
    roiWidth: 0.8,
    roiHeight: 0.9,
    roiShapeType: "rectangle",
    roiBitmap: "not-a-png",
  });
  const bitmapResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(invalidBitmap),
  });
  assert.equal(bitmapResult.ok, true);
  assert.equal(bitmapResult.compatibility.status, "blocked");
  assert.ok(
    bitmapResult.diagnostics.some((item) => item.code === "V2_ROI_BITMAP_INVALID"),
  );

  const invalidBounds = clsProject();
  Object.assign(invalidBounds.project as Record<string, unknown>, {
    roiMode: "simple",
    roiPosX: 0.8,
    roiPosY: 0.2,
    roiWidth: 0.1,
    roiHeight: 0.9,
    roiShapeType: "rectangle",
  });
  const boundsResult = parseV2SubvisionProject({
    jsonText: JSON.stringify(invalidBounds),
  });
  assert.equal(boundsResult.ok, true);
  assert.equal(boundsResult.compatibility.status, "blocked");
  assert.ok(
    boundsResult.diagnostics.some((item) => item.code === "V2_ROI_BOUNDS_INVALID"),
  );
});

test("blocks unsupported Konva group and rectangle transforms", async (t) => {
  const cases = [
    {
      name: "group offset",
      mutate(group: Record<string, unknown>) {
        const attrs = group.attrs as Record<string, unknown>;
        attrs.offsetX = 1;
      },
    },
    {
      name: "rectangle rotation",
      mutate(group: Record<string, unknown>) {
        const child = (group.children as Array<Record<string, unknown>>)[0]!;
        const attrs = child.attrs as Record<string, unknown>;
        attrs.rotation = 1;
      },
    },
    {
      name: "non-rectangle UI type",
      mutate(group: Record<string, unknown>) {
        const attrs = group.attrs as Record<string, unknown>;
        attrs.UIType = "ellipse-roi";
      },
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const fixture = clsProject();
      const shape = JSON.parse(
        serializedRectangleRoiShape(0.1, 0.2, 0.8, 0.9),
      ) as { children: Array<Record<string, unknown>> };
      const group = shape.children.find((node) => node.className === "Group")!;
      item.mutate(group);
      Object.assign(fixture.project as Record<string, unknown>, {
        roiMode: "simple",
        roiPosX: 0.1,
        roiPosY: 0.2,
        roiWidth: 0.8,
        roiHeight: 0.9,
        roiShape: JSON.stringify(shape),
      });

      const result = parseV2SubvisionProject({
        jsonText: JSON.stringify(fixture),
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.compatibility.status, "blocked");
      assert.ok(
        result.diagnostics.some((entry) => entry.code === "V2_ROI_SHAPE_INVALID"),
      );
    });
  }
});

test("recognizes common native audit fields without per-entity unknown warnings", () => {
  const fixture = clsProject();
  const project = fixture.project as {
    datasets: Array<Record<string, unknown>>;
    projectFiles: Array<Record<string, unknown>>;
  };
  Object.assign(project.datasets[0]!, {
    modifiedDate: 200,
    createdDate: 100,
    createdBy: "admin",
    projects: [],
    metadataList: [],
    splitSets: [{ splitId: 50, splitName: "default", createdDate: 100 }],
  });
  Object.assign(project.projectFiles[0]!, {
    projectId: 10,
    modifiedDate: 200,
    assignedDate: 100,
    registeredDate: 100,
    isGenerated: true,
    labelDataList: [
      {
        labelId: 60,
        labelType: "man",
        labeledDate: 200,
        contourId: "native-contour-id",
        className: "OK",
      },
    ],
  });

  const result = parseV2SubvisionProject({ jsonText: JSON.stringify(fixture) });
  assert.equal(result.ok, true);
  assert.equal(
    result.diagnostics.some((item) => item.code === "V2_UNMAPPED_FIELD"),
    false,
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "V2_GENERATED_FILE_FLAG_NOT_IN_V1",
    ),
  );
  const fileTimestampDiagnostics = result.diagnostics.filter(
    (item) => item.code === "V2_FILE_TIMESTAMP_NOT_IN_V1",
  );
  assert.equal(fileTimestampDiagnostics.length, 3);
  assert.deepEqual(
    fileTimestampDiagnostics
      .map((item) => item.details?.field)
      .sort(),
    ["assignedDate", "modifiedDate", "registeredDate"],
  );
  assert.ok(
    fileTimestampDiagnostics.every(
      (item) =>
        item.disposition === "drop" &&
        item.details?.affectedEntityCount === 1,
    ),
  );
  const labelTimestampDiagnostic = result.diagnostics.find(
    (item) => item.code === "V2_LABEL_TIMESTAMP_NOT_IN_V1",
  );
  assert.equal(labelTimestampDiagnostic?.disposition, "drop");
  assert.equal(labelTimestampDiagnostic?.details?.affectedEntityCount, 1);
  const contourDiagnostic = result.diagnostics.find(
    (item) => item.code === "V2_CONTOUR_ID_REBUILT",
  );
  assert.equal(contourDiagnostic?.disposition, "rebuild");
  assert.equal(contourDiagnostic?.details?.affectedEntityCount, 1);
  const splitNameDiagnostic = result.diagnostics.find(
    (item) => item.code === "V2_SPLIT_NAME_NOT_IN_V1",
  );
  assert.equal(splitNameDiagnostic?.disposition, "drop");
  assert.equal(splitNameDiagnostic?.details?.affectedEntityCount, 3);
  const splitIdDiagnostic = result.diagnostics.find(
    (item) => item.code === "V2_SPLIT_ID_REBUILT",
  );
  assert.equal(splitIdDiagnostic?.disposition, "rebuild");
  assert.equal(splitIdDiagnostic?.details?.affectedEntityCount, 3);
  if (result.ok) {
    assert.equal(result.project.files[0]?.raw.assignedDate, 100);
    assert.equal(result.project.files[0]?.labels[0]?.raw.contourId, "native-contour-id");
    assert.equal(result.project.files[0]?.splits[0]?.sourceId, 50);
    assert.equal(result.project.files[0]?.splits[0]?.sourceName, "default");
  }
  assert.notEqual(result.compatibility.status, "blocked");
});

test("parses the native V2 2.7.8 classification golden without blocking", () => {
  const jsonText = readFileSync(
    new URL(
      "./fixtures/native-v2-2.7.8-classification.subvisionproj",
      import.meta.url,
    ),
    "utf8",
  );
  const result = parseV2SubvisionProject({
    fileName: "golden.subvisionproj",
    jsonText,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.compatibility.status, "confirmation-required");
  assert.equal(result.project.files.length, 2);
  assert.equal(result.project.classes.length, 8);
  assert.deepEqual(
    result.project.files.map((file) => file.canonicalSplit),
    ["training", "validation"],
  );
  assert.equal(
    result.project.files.reduce((count, file) => count + file.labels.length, 0),
    2,
  );
  assert.equal(
    result.diagnostics.some((item) => item.disposition === "block"),
    false,
  );
  assert.equal(
    result.diagnostics.some((item) => item.code === "V2_UNMAPPED_FIELD"),
    false,
  );
  assert.equal(
    result.diagnostics.filter(
      (item) => item.code === "V2_FILE_TIMESTAMP_NOT_IN_V1",
    ).length,
    3,
  );
  for (const code of [
    "V2_LABEL_TIMESTAMP_NOT_IN_V1",
    "V2_CONTOUR_ID_REBUILT",
    "V2_SPLIT_NAME_NOT_IN_V1",
    "V2_SPLIT_ID_REBUILT",
  ]) {
    assert.equal(
      result.diagnostics.filter((item) => item.code === code).length,
      1,
      `${code} must be aggregated across the golden project`,
    );
  }
  const splitNameDiagnostic = result.diagnostics.find(
    (item) => item.code === "V2_SPLIT_NAME_NOT_IN_V1",
  );
  assert.equal(splitNameDiagnostic?.details?.affectedEntityCount, 3);
});
