import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";
import { resolveProjectImages } from "../lib/files/resolveImages.ts";
import { loadProject } from "../lib/input/loadProject.ts";
import { parseV1Srproj } from "../lib/input/v1.ts";
import { parseV2SubvisionProject } from "../lib/input/v2.ts";
import type { JsonObject, PointIR, ProjectFileIR, ProjectIR } from "../lib/model/project.ts";
import { writeSrproj } from "../lib/output/srproj.ts";
import { writeSvpaArchive, writeVisionArchive } from "../lib/output/containers.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
} from "../lib/output/v2.ts";
import { V2_PROJECT_LIMITS } from "../lib/security/resourceLimits.ts";

const OUTER_V1: readonly PointIR[] = [
  { x: 1, y: 1 },
  { x: 1, y: 9 },
  { x: 9, y: 9 },
  { x: 9, y: 1 },
];
const INNER_V1: readonly PointIR[] = [
  { x: 3, y: 3 },
  { x: 7, y: 3 },
  { x: 7, y: 7 },
  { x: 3, y: 7 },
];

class MemorySaveHandle {
  private readonly chunks: ArrayBuffer[] = [];

  async createWritable(): Promise<WritableStream<Uint8Array>> {
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        this.chunks.push(copy.buffer);
      },
    });
  }

  blob(): Blob {
    return new Blob(this.chunks, { type: "application/zip" });
  }
}

function browserFile(blob: Blob, name: string): File {
  return new NodeFile(
    [blob] as unknown as ConstructorParameters<typeof NodeFile>[0],
    name,
  ) as unknown as File;
}

function segmentationProject(normal = false): ProjectIR {
  const file: ProjectFileIR = {
    index: 0,
    sourcePath: "C:\\images\\texture.png",
    normalizedPath: "C:/images/texture.png",
    fileName: "texture.png",
    width: 10,
    height: 10,
    isLabeled: true,
    isNormal: normal,
    splits: [{ type: "training", rawType: "Training", raw: {} }],
    canonicalSplit: "training",
    labels: normal
      ? []
      : [
          {
            index: 0,
            kind: "contour",
            origin: "manual",
            classIndex: 0,
            geometry: {
              contours: [OUTER_V1, INNER_V1],
              contourRoles: ["outer", "inner"],
            },
            synthesized: false,
            raw: {},
          },
        ],
    image: { kind: "external", path: "C:\\images\\texture.png" },
    raw: {},
  };
  return {
    schemaVersion: 1,
    source: {
      format: "v1-srproj",
      fileName: "texture.srproj",
      rawProjectType: "Segmentation",
    },
    project: {
      name: "Texture Segmentation",
      type: "segmentation",
      rawType: "Segmentation",
      description: "",
      modifiedAt: 1_700_000_000_000,
      raw: {},
    },
    classes: [
      {
        index: 0,
        sourceIndex: 0,
        name: "Defect A",
        color: "#CC3F31",
        description: "",
        raw: {},
      },
      {
        index: 1,
        sourceIndex: 1,
        name: "Defect B",
        color: "#878DEE",
        description: "",
        raw: {},
      },
    ],
    datasets: [],
    files: [file],
    raw: {},
  };
}

function projectWithContourPointCount(pointCount: number): ProjectIR {
  const source = segmentationProject();
  const ring = Array.from({ length: pointCount }, (_, index): PointIR => {
    if (index === 0) return { x: 0, y: 0 };
    if (index === 1) return { x: 10, y: 0 };
    if (index === pointCount - 1) return { x: 0, y: 10 };
    return { x: 10, y: 10 };
  });
  const label = source.files[0]!.labels[0]!;
  return {
    ...source,
    files: [{
      ...source.files[0]!,
      labels: [{
        ...label,
        geometry: { contours: [ring], contourRoles: ["outer"] },
      }],
    }],
  };
}

test("writers reject project-wide contour totals above the shared limit", () => {
  const source = projectWithContourPointCount(V2_PROJECT_LIMITS.maxContourPoints + 1);
  const v2 = writeV2SubvisionProject(source);
  assert.equal(v2.ok, false);
  assert.equal(
    v2.diagnostics.some((item) => item.code === "V2_WRITE_CONTOUR_POINT_LIMIT_EXCEEDED"),
    true,
  );
  assert.throws(
    () => writeSrproj(source),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SRPROJ_CONTOUR_POINT_LIMIT_EXCEEDED",
  );
});

test("srproj writer enforces the target XML node budget below the raw point cap", () => {
  const source = projectWithContourPointCount(V2_PROJECT_LIMITS.maxContourPoints - 4);
  assert.throws(
    () => writeSrproj(source),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SRPROJ_XML_NODE_LIMIT_EXCEEDED",
  );
});

function area(ring: readonly (readonly [number, number])[]): number {
  let doubled = 0;
  for (const [index, point] of ring.entries()) {
    const next = ring[(index + 1) % ring.length]!;
    doubled += point[0] * next[1] - next[0] * point[1];
  }
  return doubled / 2;
}

test("V1 polygon segmentation writes the native V2 schema with hole winding", () => {
  const result = writeV2SubvisionProject(segmentationProject());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const root = result.json.project as JsonObject;
  assert.equal(root.projectType, "seg");
  assert.equal(root.roiMode, "no");
  assert.equal((root.classInfos as readonly JsonObject[]).length, 3);
  assert.deepEqual(
    Object.keys((root.classInfos as readonly JsonObject[])[0]!),
    ["classId", "className", "classNo", "description", "classColor", "isNg"],
  );
  assert.equal((root.classInfos as readonly JsonObject[])[0]!.className, "OK");
  assert.equal((root.classInfos as readonly JsonObject[])[0]!.classId, 0);

  const file = (root.projectFiles as readonly JsonObject[])[0]!;
  const label = (file.labelDataList as readonly JsonObject[])[0]!;
  assert.deepEqual(Object.keys(label), [
    "labelId",
    "labelType",
    "labelPosX",
    "labelPosY",
    "labelWidth",
    "labelHeight",
    "labeledDate",
    "labelContour",
    "contourSize",
    "contourId",
    "className",
  ]);
  assert.equal(label.labelPosX, 1);
  assert.equal(label.labelPosY, 1);
  assert.equal(label.labelWidth, 8);
  assert.equal(label.labelHeight, 8);
  assert.equal(label.contourSize, 48);
  const rings = JSON.parse(label.labelContour as string) as Array<Array<[number, number]>>;
  assert.equal(area(rings[0]!), 64);
  assert.equal(area(rings[1]!), -16);
});

test("V1 segmentation preserves a custom rectangle ROI in native V2 fields", () => {
  const source = segmentationProject();
  const expectedRoi = {
    mode: "simple" as const,
    shape: "rectangle" as const,
    left: 0.1,
    top: 0.2,
    right: 0.8,
    bottom: 0.9,
  };
  const written = writeV2SubvisionProject({
    ...source,
    project: { ...source.project, roi: expectedRoi },
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;

  const root = written.json.project as JsonObject;
  assert.equal(root.roiMode, "simple");
  assert.equal(root.roiPosX, expectedRoi.left);
  assert.equal(root.roiPosY, expectedRoi.top);
  assert.equal(root.roiWidth, expectedRoi.right);
  assert.equal(root.roiHeight, expectedRoi.bottom);
  assert.equal(root.roiShapeType, "rectangle");
  assert.equal(typeof root.roiShape, "string");
  assert.equal(root.roiBitmap, undefined);

  const reparsed = parseV2SubvisionProject({ jsonText: written.jsonText });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.deepEqual(reparsed.project.project.roi, expectedRoi);
  assert.equal(
    reparsed.diagnostics.some((item) => item.code === "V2_ROI_SHAPE_CONFLICT"),
    false,
  );
});

test("V1 Segmentation Validation writes the native V2 val split token", () => {
  const source = segmentationProject();
  const validationProject: ProjectIR = {
    ...source,
    files: source.files.map((file) => ({
      ...file,
      splits: [{ type: "validation", rawType: "Validation", raw: {} }],
      canonicalSplit: "validation",
    })),
  };

  const written = writeV2SubvisionProject(validationProject);
  assert.equal(written.ok, true);
  if (!written.ok) return;

  const projectJson = written.json.project as JsonObject;
  const fileJson = (projectJson.projectFiles as JsonObject[])[0]!;
  assert.deepEqual(fileJson.splitSets, [
    {
      splitId: Number(projectJson.projectId) + 2,
      splitName: "srproj",
      splitType: "val",
    },
  ]);

  const reparsed = parseV2SubvisionProject({ jsonText: written.jsonText });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.equal(reparsed.project.files[0]?.canonicalSplit, "validation");
});

test("segmentation converts V1 to V2 and back without losing ring roles", () => {
  const v2 = writeV2SubvisionProject(segmentationProject());
  assert.equal(v2.ok, true);
  if (!v2.ok) return;

  const parsedV2 = parseV2SubvisionProject({ jsonText: v2.jsonText });
  assert.equal(parsedV2.ok, true);
  if (!parsedV2.ok) return;
  assert.notEqual(parsedV2.compatibility.status, "blocked");
  assert.deepEqual(
    parsedV2.project.files[0]!.labels[0]!.geometry.contourRoles,
    ["outer", "inner"],
  );

  const xml = writeSrproj(parsedV2.project, { allowConfirmedLoss: true });
  assert.match(xml, /<Type>Segmentation<\/Type>/u);
  assert.match(xml, /<NumberOfClasses>2<\/NumberOfClasses>/u);
  assert.match(xml, /<Contour Type="Outer">/u);
  assert.match(xml, /<Contour Type="Inner">/u);

  const reparsedV1 = parseV1Srproj({ xmlText: xml });
  assert.equal(reparsedV1.ok, true);
  if (!reparsedV1.ok) return;
  assert.equal(reparsedV1.project.classes.length, 2);
  assert.equal(reparsedV1.project.files[0]!.labels.length, 1);
  assert.deepEqual(
    reparsedV1.project.files[0]!.labels[0]!.geometry.contourRoles,
    ["outer", "inner"],
  );
});

test("normal segmentation images map to the structural V2 OK class", () => {
  const result = writeV2SubvisionProject(segmentationProject(true));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const root = result.json.project as JsonObject;
  const file = (root.projectFiles as readonly JsonObject[])[0]!;
  assert.equal(file.isLabeled, true);
  assert.equal(file.className, "OK");
  assert.deepEqual(file.labelDataList, []);
});

test("normal-only Segmentation removes and rebuilds the structural OK class", () => {
  const source = segmentationProject(true);
  const normalOnly: ProjectIR = { ...source, classes: [] };
  const firstV2 = writeV2SubvisionProject(normalOnly);
  assert.equal(firstV2.ok, true);
  if (!firstV2.ok) return;

  const parsedV2 = parseV2SubvisionProject({ jsonText: firstV2.jsonText });
  assert.equal(parsedV2.ok, true);
  if (!parsedV2.ok) return;
  assert.equal(parsedV2.project.classes.length, 1);
  assert.equal(parsedV2.project.files[0]?.isNormal, true);

  const xml = writeSrproj(parsedV2.project, { allowConfirmedLoss: true });
  assert.match(xml, /<NumberOfClasses>0<\/NumberOfClasses>/u);
  assert.doesNotMatch(xml, /<Name>OK<\/Name>/u);
  const parsedV1 = parseV1Srproj({ xmlText: xml });
  assert.equal(parsedV1.ok, true);
  if (!parsedV1.ok) return;
  assert.equal(parsedV1.project.classes.length, 0);
  assert.equal(parsedV1.project.files[0]?.isNormal, true);
  assert.equal(writeV2SubvisionProject(parsedV1.project).ok, true);
});

test("Segmentation writer uses native bbox rounding and rejects inner-first rings", () => {
  const source = segmentationProject();
  const fractional: ProjectIR = {
    ...source,
    files: source.files.map((file) => ({
      ...file,
      width: 20,
      height: 20,
      labels: file.labels.map((label) => ({
        ...label,
        geometry: {
          contours: [[
            { x: 0.6, y: 0.6 },
            { x: 0.6, y: 9.6 },
            { x: 10.1, y: 9.6 },
            { x: 10.1, y: 0.6 },
          ]],
          contourRoles: ["outer"],
        },
      })),
    })),
  };
  const written = writeV2SubvisionProject(fractional);
  assert.equal(written.ok, true);
  if (written.ok) {
    const project = written.json.project as JsonObject;
    const file = (project.projectFiles as readonly JsonObject[])[0]!;
    const label = (file.labelDataList as readonly JsonObject[])[0]!;
    assert.equal(label.labelPosX, 1);
    assert.equal(label.labelWidth, 10);
    assert.equal(label.labelPosY, 1);
    assert.equal(label.labelHeight, 9);
  }

  const innerFirst: ProjectIR = {
    ...source,
    files: source.files.map((file) => ({
      ...file,
      labels: file.labels.map((label) => ({
        ...label,
        geometry: {
          contours: [INNER_V1, OUTER_V1],
          contourRoles: ["inner", "outer"],
        },
      })),
    })),
  };
  const blocked = writeV2SubvisionProject(innerFirst);
  assert.equal(blocked.ok, false);
  assert.ok(
    blocked.diagnostics.some(
      (item) => item.code === "V2_WRITE_SEGMENTATION_RING_ORDER_INVALID",
    ),
  );
  assert.throws(
    () => writeSrproj(innerFirst),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SRPROJ_SEGMENTATION_RING_ORDER_INVALID",
  );
});

test("Segmentation vision and SVPA containers reload with polygon semantics", async () => {
  const source = segmentationProject();
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const visionHandle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle: visionHandle },
    built,
    images: [
      {
        fileIndex: 0,
        originalPath: source.files[0]!.sourcePath,
        source: {
          kind: "blob",
          blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])]),
          relativePath: source.files[0]!.fileName,
        },
      },
    ],
  });

  const vision = await loadProject(browserFile(visionHandle.blob(), built.fileName));
  try {
    assert.equal(vision.format, "v2-visionproj");
    assert.ok(vision.project);
    assert.ok(vision.archive);
    assert.equal(vision.project.project.type, "segmentation");
    assert.deepEqual(
      vision.project.files[0]!.labels[0]!.geometry.contourRoles,
      ["outer", "inner"],
    );

    const resolved = resolveProjectImages(vision.project, vision.archive);
    assert.equal(resolved.complete, true);
    const xml = writeSrproj(vision.project, {
      pathForFile: (file) => file.sourcePath,
      allowConfirmedLoss: true,
    });
    const svpaHandle = new MemorySaveHandle();
    await writeSvpaArchive({
      destination: { fileName: "segmentation-svpa.zip", handle: svpaHandle },
      project: vision.project,
      srprojXml: xml,
      images: resolved.images,
      helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
    });

    const v1 = await loadProject(
      browserFile(svpaHandle.blob(), "segmentation-svpa.zip"),
    );
    try {
      assert.equal(v1.format, "v1-svpa");
      assert.ok(v1.project);
      assert.equal(v1.project.project.type, "segmentation");
      assert.equal(v1.project.classes.length, 2);
      assert.deepEqual(
        v1.project.files[0]!.labels[0]!.geometry.contourRoles,
        ["outer", "inner"],
      );
    } finally {
      await v1.close();
    }
  } finally {
    await vision.close();
  }
});
