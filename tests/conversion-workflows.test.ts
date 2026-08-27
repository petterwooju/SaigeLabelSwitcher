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
import { verifyAndEnrichProjectImages } from "../lib/files/imageDimensions.ts";
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

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x07, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ]);
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

async function assertBlobMismatchRepairsToSvpa(
  source: ProjectIR,
  outputName: string,
): Promise<void> {
  const bytes = jpeg(12, 9);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const file = source.files[0]!;
  const verified = await verifyAndEnrichProjectImages(
    source,
    [{
      fileIndex: file.index,
      originalPath: file.sourcePath,
      source: {
        kind: "blob",
        blob: new Blob([copy.buffer], { type: "image/bmp" }),
        relativePath: "selected/source/108.bmp",
      },
    }],
    { repairMismatchedExtensions: true },
  );
  assert.equal(verified.complete, true);
  assert.equal(
    verified.extensionRepairs[0]?.outputRelativePath,
    "selected/source/108.jpg",
  );
  const srprojXml = writeSrproj(verified.project, {
    allowConfirmedLoss: true,
  });
  assert.match(srprojXml, /<Path>[^<]*108\.bmp<\/Path>/u);
  const handle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName: outputName, handle },
    project: verified.project,
    srprojXml,
    images: verified.resolvedImages,
    helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
  });
  const loaded = await loadProject(browserFile([handle.blob()], outputName));
  try {
    assert.equal(loaded.format, "v1-svpa");
    assert.ok(loaded.project);
    assert.ok(loaded.archive);
    assert.match(loaded.svpaManifest?.Entries[0]?.OriginalPath ?? "", /108\.bmp$/u);
    assert.match(loaded.svpaManifest?.Entries[0]?.RelativePath ?? "", /108\.jpg$/u);
    const image = loaded.project.files[0]?.image;
    assert.equal(image?.kind, "archive");
    if (image?.kind !== "archive") return;
    assert.deepEqual(
      new Uint8Array(await (await loaded.archive.readBlob(image.entryName)).arrayBuffer()),
      bytes,
    );
    const resolved = resolveProjectImages(loaded.project, loaded.archive);
    const reverified = await verifyAndEnrichProjectImages(
      loaded.project,
      resolved.images,
    );
    assert.equal(reverified.complete, true);
    assert.deepEqual(reverified.issues, []);
  } finally {
    await loaded.close();
  }
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

test("V1 srproj -> vision repairs a verified image extension without re-encoding", async () => {
  const fixture = parseFixture();
  const originalPath = String.raw`C:\source\108.bmp`;
  const source: ProjectIR = {
    ...fixture,
    files: [{
      ...fixture.files[0]!,
      sourcePath: originalPath,
      normalizedPath: "C:/source/108.bmp",
      fileName: "108.bmp",
      width: 12,
      height: 9,
      image: { kind: "external", path: originalPath },
    }],
  };
  const bytes = jpeg(12, 9);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const selected: ResolvedProjectImage[] = [{
    fileIndex: source.files[0]!.index,
    originalPath,
    source: {
      kind: "blob",
      blob: new Blob([blobBytes.buffer], { type: "image/bmp" }),
      relativePath: "selected/source/108.bmp",
    },
  }];
  const verified = await verifyAndEnrichProjectImages(source, selected, {
    repairMismatchedExtensions: true,
  });
  assert.equal(verified.complete, true);
  assert.deepEqual(verified.extensionRepairs.map((item) => item.outputRelativePath), [
    "selected/source/108.jpg",
  ]);

  const built = writeV2VisionProject(verified.project, {
    imageOutputPaths: Object.fromEntries(
      verified.extensionRepairs.map((item) => [item.fileIndex, item.outputRelativePath]),
    ),
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.imageEntries[0]?.entryName, "images/selected/source/108.jpg");
  assert.equal(built.imageEntries[0]?.source, source.files[0]?.image);

  const handle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: verified.resolvedImages,
  });
  const loaded = await loadProject(browserFile([handle.blob()], built.fileName));
  try {
    assert.equal(loaded.format, "v2-visionproj");
    assert.ok(loaded.project);
    assert.ok(loaded.archive);
    assert.equal(loaded.project.files[0]?.sourcePath, "images/selected/source/108.jpg");
    const resolved = resolveProjectImages(loaded.project, loaded.archive);
    const reverified = await verifyAndEnrichProjectImages(
      loaded.project,
      resolved.images,
    );
    assert.equal(reverified.complete, true);
    assert.deepEqual(reverified.issues, []);
    const image = loaded.project.files[0]?.image;
    assert.equal(image?.kind, "archive");
    if (image?.kind !== "archive") return;
    assert.deepEqual(
      new Uint8Array(await (await loaded.archive.readBlob(image.entryName)).arrayBuffer()),
      bytes,
    );
  } finally {
    await loaded.close();
  }
});

test("V1 srproj -> vision adds a verified missing image extension and round-trips", async () => {
  const fixture = parseFixture();
  const originalPath = String.raw`C:\source\108`;
  const source: ProjectIR = {
    ...fixture,
    files: [{
      ...fixture.files[0]!,
      sourcePath: originalPath,
      normalizedPath: "C:/source/108",
      fileName: "108",
      width: 12,
      height: 9,
      image: { kind: "external", path: originalPath },
    }],
  };
  const bytes = jpeg(12, 9);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const verified = await verifyAndEnrichProjectImages(
    source,
    [{
      fileIndex: source.files[0]!.index,
      originalPath,
      source: {
        kind: "blob",
        blob: new Blob([blobBytes.buffer], { type: "image/jpeg" }),
        relativePath: "selected/source/108",
      },
    }],
    { repairMismatchedExtensions: true },
  );
  assert.equal(verified.complete, true);
  assert.equal(
    verified.extensionRepairs[0]?.outputRelativePath,
    "selected/source/108.jpg",
  );

  const built = writeV2VisionProject(verified.project, {
    imageOutputPaths: Object.fromEntries(
      verified.extensionRepairs.map((item) => [item.fileIndex, item.outputRelativePath]),
    ),
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const handle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: verified.resolvedImages,
  });

  const loaded = await loadProject(browserFile([handle.blob()], built.fileName));
  try {
    assert.equal(loaded.parseResult.ok, true);
    assert.equal(loaded.project?.files[0]?.sourcePath, "images/selected/source/108.jpg");
    assert.ok(loaded.project && loaded.archive);
    const resolved = resolveProjectImages(loaded.project, loaded.archive);
    const reverified = await verifyAndEnrichProjectImages(
      loaded.project,
      resolved.images,
    );
    assert.equal(reverified.complete, true);
  } finally {
    await loaded.close();
  }
});

test("V1 srproj and V2 subvision repair mismatched extensions in SVPA output", async () => {
  const fixture = parseFixture();
  const originalPath = String.raw`C:\source\108.bmp`;
  const v1Source: ProjectIR = {
    ...fixture,
    files: [{
      ...fixture.files[0]!,
      sourcePath: originalPath,
      normalizedPath: "C:/source/108.bmp",
      fileName: "108.bmp",
      width: 12,
      height: 9,
      image: { kind: "external", path: originalPath },
    }],
  };
  await assertBlobMismatchRepairsToSvpa(v1Source, "from-v1.svpa.zip");

  const written = writeV2SubvisionProject(v1Source, {
    allowConfirmedLoss: true,
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  const subvision = await loadProject(
    browserFile([written.jsonText], written.fileName),
  );
  try {
    assert.equal(subvision.format, "v2-subvisionproj");
    assert.ok(subvision.project);
    await assertBlobMismatchRepairsToSvpa(
      subvision.project,
      "from-subvision.svpa.zip",
    );
  } finally {
    await subvision.close();
  }
});

test("V1 SVPA -> vision repairs an archive image extension and remains readable", async () => {
  const fixture = parseFixture();
  const originalPath = String.raw`C:\source\108.bmp`;
  const source: ProjectIR = {
    ...fixture,
    files: [{
      ...fixture.files[0]!,
      sourcePath: originalPath,
      normalizedPath: "C:/source/108.bmp",
      fileName: "108.bmp",
      width: 12,
      height: 9,
      image: { kind: "external", path: originalPath },
    }],
  };
  const bytes = jpeg(12, 9);
  const byteCopy = new Uint8Array(bytes.byteLength);
  byteCopy.set(bytes);
  const srprojXml = writeSrproj(source, { allowConfirmedLoss: true });
  const svpaHandle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName: "source.svpa.zip", handle: svpaHandle },
    project: source,
    srprojXml,
    images: [{
      fileIndex: source.files[0]!.index,
      originalPath,
      source: {
        kind: "blob",
        blob: new Blob([byteCopy.buffer], { type: "image/bmp" }),
        relativePath: "source/108.bmp",
      },
    }],
    helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
  });

  const svpa = await loadProject(
    browserFile([svpaHandle.blob()], "source.svpa.zip"),
  );
  try {
    assert.equal(svpa.format, "v1-svpa");
    assert.ok(svpa.project);
    assert.ok(svpa.archive);
    const resolved = resolveProjectImages(svpa.project, svpa.archive);
    assert.equal(resolved.complete, true);
    assert.match(resolved.images[0]?.source.relativePath ?? "", /108\.bmp$/u);
    const verified = await verifyAndEnrichProjectImages(
      svpa.project,
      resolved.images,
      { repairMismatchedExtensions: true },
    );
    assert.equal(verified.complete, true);
    assert.equal(verified.extensionRepairs[0]?.outputRelativePath, "source/108.jpg");
    const built = writeV2VisionProject(verified.project, {
      allowConfirmedLoss: true,
      imageOutputPaths: Object.fromEntries(
        verified.extensionRepairs.map((item) => [
          item.fileIndex,
          item.outputRelativePath,
        ]),
      ),
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.imageEntries[0]?.entryName, "images/source/108.jpg");
    const visionHandle = new MemorySaveHandle();
    await writeVisionArchive({
      destination: { fileName: built.fileName, handle: visionHandle },
      built,
      images: verified.resolvedImages,
    });
    const vision = await loadProject(
      browserFile([visionHandle.blob()], built.fileName),
    );
    try {
      assert.equal(vision.format, "v2-visionproj");
      assert.ok(vision.project);
      assert.ok(vision.archive);
      assert.equal(vision.project.files[0]?.sourcePath, "images/source/108.jpg");
      const reResolved = resolveProjectImages(vision.project, vision.archive);
      const reverified = await verifyAndEnrichProjectImages(
        vision.project,
        reResolved.images,
      );
      assert.equal(reverified.complete, true);
      assert.deepEqual(reverified.issues, []);
    } finally {
      await vision.close();
    }
  } finally {
    await svpa.close();
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
      allowConfirmedLoss: true,
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

test("V2 vision -> SVPA repairs a verified JPEG stored with a BMP name", async () => {
  const fixture = parseFixture();
  const originalPath = String.raw`C:\source\108.bmp`;
  const source: ProjectIR = {
    ...fixture,
    files: [{
      ...fixture.files[0]!,
      sourcePath: originalPath,
      normalizedPath: "C:/source/108.bmp",
      fileName: "108.bmp",
      width: 514,
      height: 1306,
      image: { kind: "external", path: originalPath },
    }],
  };
  const bytes = jpeg(514, 1306);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const built = writeV2VisionProject(source, { allowConfirmedLoss: true });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const visionHandle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle: visionHandle },
    built,
    images: [{
      fileIndex: source.files[0]!.index,
      originalPath,
      source: {
        kind: "blob",
        blob: new Blob([blobBytes.buffer], { type: "image/bmp" }),
        relativePath: "source/108.bmp",
      },
    }],
  });
  const vision = await loadProject(browserFile([visionHandle.blob()], built.fileName));
  try {
    assert.equal(vision.format, "v2-visionproj");
    assert.ok(vision.project);
    assert.ok(vision.archive);
    const embedded = resolveProjectImages(vision.project, vision.archive);
    assert.equal(embedded.complete, true);
    assert.equal(embedded.images[0]?.source.kind, "archive");
    const strict = await verifyAndEnrichProjectImages(
      vision.project,
      embedded.images,
    );
    assert.equal(strict.complete, false);
    assert.equal(strict.issues[0]?.code, "IMAGE_FORMAT_MISMATCH");
    const verified = await verifyAndEnrichProjectImages(
      vision.project,
      embedded.images,
      { repairMismatchedExtensions: true },
    );
    assert.equal(verified.complete, true);
    assert.equal(verified.extensionRepairs.length, 1);

    const handle = new MemorySaveHandle();
    const srprojXml = writeSrproj(verified.project, {
      pathForFile: (file) => file.sourcePath,
      allowConfirmedLoss: true,
    });
    assert.match(srprojXml, /<Path>images\/108\.bmp<\/Path>/u);
    await writeSvpaArchive({
      destination: { fileName: "repaired.svpa.zip", handle },
      project: verified.project,
      srprojXml,
      images: verified.resolvedImages,
      helper: new Blob([new Uint8Array([0x4d, 0x5a])]),
    });

    const loaded = await loadProject(browserFile([handle.blob()], "repaired.svpa.zip"));
    try {
      assert.equal(loaded.format, "v1-svpa");
      assert.equal(loaded.parseResult.ok, true);
      assert.equal(loaded.svpaManifest?.Entries.length, 1);
      assert.equal(loaded.svpaManifest?.Entries[0]?.OriginalPath, "images/108.bmp");
      assert.match(loaded.svpaManifest?.Entries[0]?.RelativePath ?? "", /108\.jpg$/u);
      const image = loaded.project?.files[0]?.image;
      assert.equal(image?.kind, "archive");
      if (image?.kind !== "archive" || !loaded.archive || !loaded.project) return;
      assert.match(image.entryName, /108\.jpg$/u);
      assert.deepEqual(
        new Uint8Array(await (await loaded.archive.readBlob(image.entryName)).arrayBuffer()),
        bytes,
      );
      const reResolved = resolveProjectImages(loaded.project, loaded.archive);
      const reverified = await verifyAndEnrichProjectImages(
        loaded.project,
        reResolved.images,
      );
      assert.equal(reverified.complete, true);
      assert.deepEqual(reverified.issues, []);

      const rebuilt = writeV2VisionProject(reverified.project, {
        allowConfirmedLoss: true,
        imageOutputPaths: Object.fromEntries(
          reverified.resolvedImages.flatMap((resolvedImage) => {
            const outputPath = resolvedImage.source.relativePath;
            return outputPath
              ? [[resolvedImage.fileIndex, outputPath] as const]
              : [];
          }),
        ),
      });
      assert.equal(rebuilt.ok, true);
      if (!rebuilt.ok) return;
      assert.match(rebuilt.imageEntries[0]?.entryName ?? "", /108\.jpg$/u);
      const rebuiltHandle = new MemorySaveHandle();
      await writeVisionArchive({
        destination: { fileName: rebuilt.fileName, handle: rebuiltHandle },
        built: rebuilt,
        images: reverified.resolvedImages,
      });
      const rebuiltVision = await loadProject(
        browserFile([rebuiltHandle.blob()], rebuilt.fileName),
      );
      try {
        assert.equal(rebuiltVision.format, "v2-visionproj");
        assert.ok(rebuiltVision.project);
        assert.ok(rebuiltVision.archive);
        assert.match(rebuiltVision.project.files[0]?.sourcePath ?? "", /108\.jpg$/u);
        const rebuiltResolved = resolveProjectImages(
          rebuiltVision.project,
          rebuiltVision.archive,
        );
        const rebuiltVerified = await verifyAndEnrichProjectImages(
          rebuiltVision.project,
          rebuiltResolved.images,
        );
        assert.equal(rebuiltVerified.complete, true);
        assert.deepEqual(rebuiltVerified.issues, []);
      } finally {
        await rebuiltVision.close();
      }
    } finally {
      await loaded.close();
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
    const srprojXml = writeSrproj(subvision.project, {
      allowConfirmedLoss: true,
    });
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
