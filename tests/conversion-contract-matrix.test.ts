import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";

import { resolveProjectImages } from "../lib/files/resolveImages.ts";
import { loadProject, type LoadedProject } from "../lib/input/loadProject.ts";
import { parseV1Srproj } from "../lib/input/v1.ts";
import type {
  ProjectFileIR,
  ProjectIR,
  ProjectLabelIR,
} from "../lib/model/project.ts";
import {
  writeSvpaArchive,
  writeVisionArchive,
  type ResolvedProjectImage,
} from "../lib/output/containers.ts";
import type { FileSystemSaveHandle } from "../lib/output/save.ts";
import { writeSrproj } from "../lib/output/srproj.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
} from "../lib/output/v2.ts";

const MASKING = String.raw`  <MaskingParameter>
    <Type>Simple</Type>
    <RoiRectangle X="0.1" Y="0.2" Width="0.7" Height="0.65" Shape="Rectangle" />
    <RoiSetting>
      <Intensity Min="0" Max="255" />
      <Expansion Value="0" />
      <Inversion Value="False" />
      <Offset Left="100" Right="100" Top="100" Bottom="100" />
    </RoiSetting>
    <BlindGroup><NumberOfBlinds>0</NumberOfBlinds></BlindGroup>
  </MaskingParameter>`;

const CLASSIFICATION_XML = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version><Type>Classification</Type>
  <ClassGroup>
    <NumberOfClasses>2</NumberOfClasses>
    <Class><Name>Good</Name><Color>-16711936</Color></Class>
    <Class><Name>Defect</Name><Color>-65536</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>3</NumberOfImages>
    <Image>
      <Path>C:\contract\classification\train\frame.png</Path>
      <Width>32</Width><Height>24</Height>
      <SplitState>Training</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>
    <Image>
      <Path>D:\contract\classification\validation\frame.png</Path>
      <Width>32</Width><Height>24</Height>
      <SplitState>Validation</SplitState><ClassIndexOfLabel>1</ClassIndexOfLabel>
    </Image>
    <Image>
      <Path>E:\contract\classification\unassigned\frame.png</Path>
      <Width>32</Width><Height>24</Height>
      <SplitState>Not Split</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>
  </ImageGroup>
${MASKING}
</Project>`;

const SEGMENTATION_XML = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version><Type>Segmentation</Type>
  <ClassGroup>
    <NumberOfClasses>2</NumberOfClasses>
    <Class><Name>Scratch</Name><Color>-65536</Color></Class>
    <Class><Name>Dent</Name><Color>-16776961</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>3</NumberOfImages>
    <Image>
      <Path>C:\contract\segmentation\train\frame.png</Path>
      <Width>32</Width><Height>24</Height><SplitState>Training</SplitState>
      <LabelGroup>
        <IsNormal>false</IsNormal><NumberOfLabels>1</NumberOfLabels>
        <Label>
          <ClassIndex>0</ClassIndex><Type>Contours</Type>
          <ContourGroup><Contour Type="Outer">
            <Point X="2" Y="2"/><Point X="18" Y="2"/>
            <Point X="18" Y="14"/><Point X="2" Y="14"/>
          </Contour></ContourGroup>
        </Label>
      </LabelGroup>
    </Image>
    <Image>
      <Path>D:\contract\segmentation\validation\frame.png</Path>
      <Width>32</Width><Height>24</Height><SplitState>Validation</SplitState>
      <LabelGroup><IsNormal>true</IsNormal><NumberOfLabels>0</NumberOfLabels></LabelGroup>
    </Image>
    <Image>
      <Path>E:\contract\segmentation\unassigned\frame.png</Path>
      <Width>32</Width><Height>24</Height><SplitState>Not Split</SplitState>
      <LabelGroup><IsNormal>false</IsNormal><NumberOfLabels>0</NumberOfLabels></LabelGroup>
    </Image>
  </ImageGroup>
${MASKING}
</Project>`;

interface MatrixFixture {
  readonly name: "classification" | "segmentation";
  readonly xml: string;
}

const FIXTURES: readonly MatrixFixture[] = [
  { name: "classification", xml: CLASSIFICATION_XML },
  { name: "segmentation", xml: SEGMENTATION_XML },
];

class MemorySaveHandle implements FileSystemSaveHandle {
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

  blob(type = "application/zip"): Blob {
    return new Blob(this.chunks, { type });
  }
}

function browserFile(parts: BlobPart[], name: string): File {
  return new NodeFile(
    parts as unknown as ConstructorParameters<typeof NodeFile>[0],
    name,
  ) as unknown as File;
}

function parseFixture(fixture: MatrixFixture): ProjectIR {
  const result = parseV1Srproj({
    xmlText: fixture.xml,
    fileName: `${fixture.name}.srproj`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, undefined, 2));
  if (!result.ok) throw new Error("Expected the V1 contract fixture to parse.");
  assert.notEqual(result.compatibility.status, "blocked");
  assert.deepEqual(
    result.project.files.map((file) => file.canonicalSplit),
    ["training", "validation", "unassigned"],
  );
  assert.equal(
    new Set(result.project.files.map((file) => file.fileName)).size,
    1,
    "The fixture must retain duplicate basenames across different paths.",
  );
  return result.project;
}

function imagesFor(project: ProjectIR): ResolvedProjectImage[] {
  return [...project.files]
    .sort((left, right) => left.index - right.index)
    .map((file) => ({
      fileIndex: file.index,
      originalPath: file.sourcePath,
      source: {
        kind: "blob" as const,
        blob: new Blob([
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, file.index + 1]),
        ]),
        relativePath: `source-${file.index}/frame.png`,
      },
    }));
}

function requireLoadedProject(loaded: LoadedProject): ProjectIR {
  assert.equal(
    loaded.parseResult.ok,
    true,
    JSON.stringify(loaded.parseResult.diagnostics, undefined, 2),
  );
  assert.ok(loaded.project);
  assert.notEqual(loaded.parseResult.compatibility.status, "blocked");
  return loaded.project;
}

function isStructuralSegmentationOk(
  project: ProjectIR,
  classIndex: number,
): boolean {
  const cls = project.classes.find((candidate) => candidate.index === classIndex);
  return Boolean(
    project.project.type === "segmentation" &&
      cls?.isNg === false &&
      cls.name.trim().normalize("NFKC").toLocaleLowerCase("en-US") === "ok",
  );
}

function classNameFor(
  project: ProjectIR,
  classIndex: number | undefined,
): string | null {
  if (classIndex === undefined) return null;
  return project.classes.find((candidate) => candidate.index === classIndex)?.name ?? null;
}

function labelSignature(project: ProjectIR, label: ProjectLabelIR): unknown {
  const contours = (label.geometry.contours ?? [])
    .map((ring, index) => ({
      role: label.geometry.contourRoles?.[index] ?? "unknown",
      points: canonicalRing(ring),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"),
    );
  return {
    kind: label.kind,
    className: classNameFor(project, label.classIndex),
    contours,
  };
}

function canonicalRing(
  source: readonly { readonly x: number; readonly y: number }[],
): readonly { readonly x: number; readonly y: number }[] {
  const ring =
    source.length > 1 &&
    source[0]?.x === source.at(-1)?.x &&
    source[0]?.y === source.at(-1)?.y
      ? source.slice(0, -1)
      : [...source];
  if (ring.length < 2) return ring;
  const candidates: Array<readonly { readonly x: number; readonly y: number }[]> = [];
  for (const orientation of [ring, [...ring].reverse()] as const) {
    for (let offset = 0; offset < orientation.length; offset += 1) {
      candidates.push([
        ...orientation.slice(offset),
        ...orientation.slice(0, offset),
      ]);
    }
  }
  return candidates.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"),
  )[0]!;
}

function segmentationState(file: ProjectFileIR): string {
  if (file.isNormal === true) return "normal";
  if (file.isLabeled === false && file.labels.length === 0) return "unlabeled";
  if (file.labels.length > 0) return "defect";
  return "ambiguous";
}

function canonicalSemantics(project: ProjectIR): unknown {
  const classes = [...project.classes]
    .filter((cls) => !isStructuralSegmentationOk(project, cls.index))
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map((cls) => ({
      name: cls.name,
      color: cls.color?.toLocaleLowerCase("en-US") ?? null,
    }));
  return {
    type: project.project.type,
    roi: project.project.roi ?? null,
    classes,
    files: [...project.files]
      .sort((left, right) => left.index - right.index)
      .map((file) => ({
        width: file.width,
        height: file.height,
        split: file.canonicalSplit,
        ...(project.project.type === "classification"
          ? {
              className: classNameFor(
                project,
                file.classificationClassIndex ?? file.labels[0]?.classIndex,
              ),
            }
          : {
              state: segmentationState(file),
              labels: file.labels.map((label) => labelSignature(project, label)),
            }),
      })),
  };
}

function assertCanonicalSemantics(actual: ProjectIR, expected: ProjectIR): void {
  assert.deepEqual(canonicalSemantics(actual), canonicalSemantics(expected));
}

async function loadSubvisionFromV1(source: ProjectIR): Promise<LoadedProject> {
  const written = writeV2SubvisionProject(source, { allowConfirmedLoss: true });
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics, undefined, 2));
  if (!written.ok) throw new Error("Expected subvision writer success.");
  return loadProject(browserFile([written.jsonText], written.fileName));
}

async function loadVisionFromV1(source: ProjectIR): Promise<LoadedProject> {
  const built = writeV2VisionProject(source, { allowConfirmedLoss: true });
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics, undefined, 2));
  if (!built.ok) throw new Error("Expected vision writer success.");
  assert.equal(new Set(built.imageEntries.map((entry) => entry.entryName)).size, 3);
  assert.deepEqual(
    built.imageEntries.map((entry) => entry.entryName),
    ["images/frame.png", "images/frame_2.png", "images/frame_3.png"],
  );
  const handle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: imagesFor(source),
  });
  return loadProject(browserFile([handle.blob()], built.fileName));
}

async function writeAndLoadSvpa(
  project: ProjectIR,
  srprojXml: string,
  images: readonly ResolvedProjectImage[],
  fileName: string,
): Promise<LoadedProject> {
  const handle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName, handle },
    project,
    srprojXml,
    images,
    helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
  });
  return loadProject(browserFile([handle.blob()], fileName));
}

function withDurableVisionPaths(
  project: ProjectIR,
  fixtureName: string,
): {
  readonly project: ProjectIR;
  readonly paths: ReadonlyMap<number, string>;
} {
  const paths = new Map(
    project.files.map((file) => [
      file.index,
      `C:\\contract\\${fixtureName}\\vision-${file.index}\\frame.png`,
    ]),
  );
  return {
    paths,
    project: {
      ...project,
      files: project.files.map((file) => {
        const sourcePath = paths.get(file.index)!;
        return {
          ...file,
          sourcePath,
          normalizedPath: sourcePath.replaceAll("\\", "/"),
          fileName: "frame.png",
        };
      }),
    },
  };
}

for (const fixture of FIXTURES) {
  test(`${fixture.name} conversion contract matrix`, async (t) => {
    await t.test("V1 -> subvision -> loadProject", async () => {
      const source = parseFixture(fixture);
      const loaded = await loadSubvisionFromV1(source);
      try {
        assert.equal(loaded.format, "v2-subvisionproj");
        assertCanonicalSemantics(requireLoadedProject(loaded), source);
      } finally {
        await loaded.close();
      }
    });

    await t.test("V1 -> vision -> loadProject", async () => {
      const source = parseFixture(fixture);
      const loaded = await loadVisionFromV1(source);
      try {
        assert.equal(loaded.format, "v2-visionproj");
        const project = requireLoadedProject(loaded);
        assertCanonicalSemantics(project, source);
        assert.ok(project.files.every((file) => file.image.kind === "archive"));
      } finally {
        await loaded.close();
      }
    });

    await t.test("V1 -> SVPA -> loadProject", async () => {
      const source = parseFixture(fixture);
      const xml = writeSrproj(source, { allowConfirmedLoss: true });
      const loaded = await writeAndLoadSvpa(
        source,
        xml,
        imagesFor(source),
        `${fixture.name}-from-v1.zip`,
      );
      try {
        assert.equal(loaded.format, "v1-svpa");
        assertCanonicalSemantics(requireLoadedProject(loaded), source);
      } finally {
        await loaded.close();
      }
    });

    await t.test("V2 subvision -> srproj -> loadProject", async () => {
      const source = parseFixture(fixture);
      const subvision = await loadSubvisionFromV1(source);
      try {
        const v2 = requireLoadedProject(subvision);
        const xml = writeSrproj(v2, { allowConfirmedLoss: true });
        const loaded = await loadProject(
          browserFile([xml], `${fixture.name}-from-subvision.srproj`),
        );
        try {
          assert.equal(loaded.format, "v1-srproj");
          assertCanonicalSemantics(requireLoadedProject(loaded), source);
        } finally {
          await loaded.close();
        }
      } finally {
        await subvision.close();
      }
    });

    await t.test("V2 subvision -> SVPA -> loadProject", async () => {
      const source = parseFixture(fixture);
      const subvision = await loadSubvisionFromV1(source);
      try {
        const v2 = requireLoadedProject(subvision);
        const xml = writeSrproj(v2, { allowConfirmedLoss: true });
        const loaded = await writeAndLoadSvpa(
          v2,
          xml,
          imagesFor(v2),
          `${fixture.name}-from-subvision.zip`,
        );
        try {
          assert.equal(loaded.format, "v1-svpa");
          assertCanonicalSemantics(requireLoadedProject(loaded), source);
        } finally {
          await loaded.close();
        }
      } finally {
        await subvision.close();
      }
    });

    await t.test("V2 vision -> SVPA -> loadProject", async () => {
      const source = parseFixture(fixture);
      const vision = await loadVisionFromV1(source);
      try {
        const v2 = requireLoadedProject(vision);
        assert.ok(vision.archive);
        const embedded = resolveProjectImages(v2, vision.archive);
        assert.equal(embedded.complete, true);
        const durable = withDurableVisionPaths(v2, fixture.name);
        const xml = writeSrproj(durable.project, {
          allowConfirmedLoss: true,
          pathForFile: (file) => durable.paths.get(file.index) ?? "",
        });
        const images = embedded.images.map((image) => ({
          ...image,
          originalPath: durable.paths.get(image.fileIndex) ?? "",
        }));
        const loaded = await writeAndLoadSvpa(
          durable.project,
          xml,
          images,
          `${fixture.name}-from-vision.zip`,
        );
        try {
          assert.equal(loaded.format, "v1-svpa");
          assertCanonicalSemantics(requireLoadedProject(loaded), source);
        } finally {
          await loaded.close();
        }
      } finally {
        await vision.close();
      }
    });
  });
}
