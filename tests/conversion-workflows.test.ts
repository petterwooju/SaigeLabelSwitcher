import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";

import {
  createProjectImageReferences,
  matchImageFiles,
  mergeSelectedFileInputs,
} from "../lib/files/imageMatcher.ts";
import {
  projectImagePaths,
  resolveProjectImages,
} from "../lib/files/resolveImages.ts";
import { loadProject, type LoadedProject } from "../lib/input/loadProject.ts";
import { parseV1Srproj } from "../lib/input/v1.ts";
import { parseV2SubvisionProject } from "../lib/input/v2.ts";
import type { ProjectIR } from "../lib/model/project.ts";
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

const fixtureXml = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version>
  <Type>Classification</Type>
  <ModifiedDate>2024-01-02 03:04:05</ModifiedDate>
  <ClassGroup>
    <NumberOfClasses>2</NumberOfClasses>
    <Class><Name>OK</Name><Color>-16711936</Color></Class>
    <Class><Name>NG</Name><Color>-65536</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>2</NumberOfImages>
    <Image>
      <Path>C:\source\ok.png</Path><Width>4</Width><Height>3</Height>
      <SplitState>Training</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>
    <Image>
      <Path>C:\source\ng.png</Path><Width>4</Width><Height>3</Height>
      <SplitState>Validation</SplitState><ClassIndexOfLabel>1</ClassIndexOfLabel>
    </Image>
  </ImageGroup>
</Project>`;

const imageBytes = [
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]),
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02, 0x03]),
] as const;

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

function parseFixture(): ProjectIR {
  const parsed = parseV1Srproj({
    xmlText: fixtureXml,
    fileName: "workflow.srproj",
  });
  if (!parsed.ok) {
    throw new Error(`V1 fixture failed to parse: ${JSON.stringify(parsed.diagnostics)}`);
  }
  return parsed.project;
}

function classificationSemantics(project: ProjectIR): unknown {
  return {
    type: project.project.type,
    classes: [...project.classes]
      .sort((left, right) => left.index - right.index)
      .map((item) => ({
        index: item.index,
        name: item.name,
        color: item.color?.toLocaleLowerCase(),
      })),
    files: [...project.files]
      .sort((left, right) => left.index - right.index)
      .map((item) => ({
        index: item.index,
        width: item.width,
        height: item.height,
        split: item.canonicalSplit,
        classIndex: item.classificationClassIndex,
        labelKinds: item.labels.map((label) => label.kind),
        labelClasses: item.labels.map((label) => label.classIndex),
      })),
  };
}

function selectedImagesFor(project: ProjectIR): ResolvedProjectImage[] {
  const selected = mergeSelectedFileInputs(
    [],
    [...project.files]
      .sort((left, right) => left.index - right.index)
      .map((file, position) => ({
        file: browserFile([imageBytes[position] ?? new Uint8Array()], file.fileName),
        relativePath: `selected/source/${file.fileName}`,
      })),
  );
  const report = matchImageFiles(
    createProjectImageReferences(projectImagePaths(project)),
    selected,
  );
  assert.equal(report.canPackage, true);
  const resolved = resolveProjectImages(project, undefined, report);
  assert.equal(resolved.complete, true);
  assert.equal(resolved.issues.length, 0);
  return [...resolved.images];
}

async function buildAndLoadVision(source: ProjectIR): Promise<LoadedProject> {
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("V2 vision writer unexpectedly blocked fixture.");
  const handle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: selectedImagesFor(source),
  });
  return loadProject(browserFile([handle.blob()], built.fileName));
}

test("V1 srproj -> V2 subvision -> V2 parser preserves Classification semantics", () => {
  const source = parseFixture();
  const written = writeV2SubvisionProject(source);
  assert.equal(written.ok, true);
  if (!written.ok) return;

  const reparsed = parseV2SubvisionProject({
    jsonText: written.jsonText,
    fileName: written.fileName,
  });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.notEqual(reparsed.compatibility.status, "blocked");
  assert.deepEqual(
    classificationSemantics(reparsed.project),
    classificationSemantics(source),
  );
  assert.deepEqual(
    reparsed.project.files.map((file) => file.sourcePath),
    source.files.map((file) => file.sourcePath),
  );
});

test("V1 srproj + selected images -> vision container -> loadProject", async () => {
  const source = parseFixture();
  const loaded = await buildAndLoadVision(source);
  try {
    assert.equal(loaded.format, "v2-visionproj");
    assert.equal(loaded.parseResult.ok, true);
    assert.ok(loaded.project);
    assert.ok(loaded.archive);
    assert.deepEqual(
      classificationSemantics(loaded.project),
      classificationSemantics(source),
    );
    assert.ok(
      loaded.project.files.every(
        (file) => file.image.kind === "archive" && file.image.bytes === undefined,
      ),
    );
    assert.deepEqual(
      new Uint8Array(
        await (
          await loaded.archive.readBlob(loaded.project.files[0]!.image.kind === "archive"
            ? loaded.project.files[0]!.image.entryName
            : "")
        ).arrayBuffer(),
      ),
      imageBytes[0],
    );
  } finally {
    await loaded.close();
  }
});

test("V2 vision -> SVPA -> loadProject yields V1 archive-backed IR", async () => {
  const original = parseFixture();
  const vision = await buildAndLoadVision(original);
  try {
    assert.ok(vision.project);
    assert.ok(vision.archive);
    const embedded = resolveProjectImages(vision.project, vision.archive);
    assert.equal(embedded.complete, true);

    const targetPaths = new Map(
      vision.project.files.map((file) => [
        file.index,
        `C:\\converted\\${file.fileName}`,
      ]),
    );
    const packagedProject: ProjectIR = {
      ...vision.project,
      files: vision.project.files.map((file) => ({
        ...file,
        sourcePath: targetPaths.get(file.index) ?? file.sourcePath,
        normalizedPath: (targetPaths.get(file.index) ?? file.normalizedPath).replaceAll("\\", "/"),
      })),
    };
    const srprojXml = writeSrproj(packagedProject, {
      pathForFile: (file) => targetPaths.get(file.index) ?? "",
    });
    const images = embedded.images.map((image) => ({
      ...image,
      originalPath: targetPaths.get(image.fileIndex) ?? "",
    }));
    const handle = new MemorySaveHandle();
    await writeSvpaArchive({
      destination: { fileName: "from-vision.zip", handle },
      project: packagedProject,
      srprojXml,
      images,
      helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
    });

    const v1 = await loadProject(browserFile([handle.blob()], "from-vision.zip"));
    try {
      assert.equal(v1.format, "v1-svpa");
      assert.equal(v1.parseResult.ok, true);
      assert.ok(v1.project);
      assert.deepEqual(
        classificationSemantics(v1.project),
        classificationSemantics(vision.project),
      );
      assert.ok(v1.project.files.every((file) => file.image.kind === "archive"));
      assert.deepEqual(
        v1.project.files.map((file) => file.sourcePath),
        v1.project.files.map((file) => targetPaths.get(file.index)?.replaceAll("\\", "/")),
      );
    } finally {
      await v1.close();
    }
  } finally {
    await vision.close();
  }
});

test("V2 subvision + selected images -> SVPA -> loadProject", async () => {
  const original = parseFixture();
  const written = writeV2SubvisionProject(original);
  assert.equal(written.ok, true);
  if (!written.ok) return;

  const subvision = await loadProject(
    browserFile([written.jsonText], written.fileName),
  );
  try {
    assert.equal(subvision.format, "v2-subvisionproj");
    assert.ok(subvision.project);
    const images = selectedImagesFor(subvision.project).map((image) => {
      const file = subvision.project!.files.find(
        (candidate) => candidate.index === image.fileIndex,
      );
      const outputPath =
        file?.image.kind === "external" ? file.image.path : file?.sourcePath ?? "";
      return { ...image, originalPath: outputPath };
    });
    const srprojXml = writeSrproj(subvision.project);
    const handle = new MemorySaveHandle();
    await writeSvpaArchive({
      destination: { fileName: "from-subvision.zip", handle },
      project: subvision.project,
      srprojXml,
      images,
      helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
    });

    const v1 = await loadProject(browserFile([handle.blob()], "from-subvision.zip"));
    try {
      assert.equal(v1.format, "v1-svpa");
      assert.equal(v1.parseResult.ok, true);
      assert.ok(v1.project);
      assert.deepEqual(
        classificationSemantics(v1.project),
        classificationSemantics(subvision.project),
      );
      assert.equal(v1.svpaManifest?.Entries.length, 2);
      assert.ok(v1.project.files.every((file) => file.image.kind === "archive"));
    } finally {
      await v1.close();
    }
  } finally {
    await subvision.close();
  }
});
