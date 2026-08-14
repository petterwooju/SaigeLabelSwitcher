import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";
import { openValidatedZip, type OpenArchive } from "../lib/archive/zip.ts";
import { loadProject } from "../lib/input/loadProject.ts";
import type { ProjectFileIR, ProjectIR } from "../lib/model/project.ts";
import {
  assertContainerArchiveLimits,
  containerArchiveEntryCount,
  ContainerWriteError,
  writeSvpaArchive,
  writeVisionArchive,
} from "../lib/output/containers.ts";
import type { FileSystemSaveHandle } from "../lib/output/save.ts";
import { writeSrproj } from "../lib/output/srproj.ts";
import { writeV2VisionProject } from "../lib/output/v2.ts";
import { BROWSER_ARCHIVE_LIMITS } from "../lib/security/resourceLimits.ts";

class MemorySaveHandle implements FileSystemSaveHandle {
  private chunks: ArrayBuffer[] = [];
  writableCalls = 0;

  async createWritable(): Promise<WritableStream<Uint8Array>> {
    this.writableCalls += 1;
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

test("container resource preflight mirrors archive reader boundaries", () => {
  const limits = BROWSER_ARCHIVE_LIMITS;
  assert.equal(
    containerArchiveEntryCount("vision", limits.maxEntries - 1),
    limits.maxEntries,
  );
  assert.equal(
    containerArchiveEntryCount("svpa", limits.maxEntries - 4),
    limits.maxEntries,
  );
  for (const [format, imageEntries] of [
    ["vision", limits.maxEntries],
    ["svpa", limits.maxEntries - 3],
  ] as const) {
    assert.throws(
      () => containerArchiveEntryCount(format, imageEntries),
      (error: unknown) =>
        error instanceof ContainerWriteError &&
        error.code === "OUTPUT_ARCHIVE_ENTRY_LIMIT_EXCEEDED",
    );
  }

  assert.equal(
    assertContainerArchiveLimits(
      limits.maxEntries,
      new Array<number>(limits.maxEntries).fill(0),
    ),
    0,
  );
  assert.throws(
    () =>
      assertContainerArchiveLimits(
        limits.maxEntries + 1,
        new Array<number>(limits.maxEntries + 1).fill(0),
      ),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "OUTPUT_ARCHIVE_ENTRY_LIMIT_EXCEEDED",
  );

  assert.equal(
    assertContainerArchiveLimits(
      8,
      new Array<number>(8).fill(limits.maxEntryBytes),
    ),
    limits.maxTotalBytes,
  );
  assert.throws(
    () => assertContainerArchiveLimits(1, [limits.maxEntryBytes + 1]),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "OUTPUT_ARCHIVE_ENTRY_SIZE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      assertContainerArchiveLimits(9, [
        ...new Array<number>(8).fill(limits.maxEntryBytes),
        1,
      ]),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "OUTPUT_ARCHIVE_TOTAL_SIZE_LIMIT_EXCEEDED",
  );

  assert.equal(
    assertContainerArchiveLimits(
      1,
      [limits.maxTextBytes],
      [limits.maxTextBytes],
    ),
    limits.maxTextBytes,
  );
  assert.throws(
    () =>
      assertContainerArchiveLimits(
        1,
        [limits.maxTextBytes + 1],
        [limits.maxTextBytes + 1],
      ),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "OUTPUT_ARCHIVE_TEXT_ENTRY_LIMIT_EXCEEDED",
  );
});

function browserFile(blob: Blob, name: string): File {
  return new NodeFile(
    [blob] as unknown as ConstructorParameters<typeof NodeFile>[0],
    name,
  ) as unknown as File;
}

function project(): ProjectIR {
  const files: ProjectFileIR[] = [
    file(0, "C:\\a\\同名.png", 0),
    file(1, "D:\\b\\同名.png", 1),
  ];
  return {
    schemaVersion: 1,
    source: {
      format: "v1-srproj",
      fileName: "双向.srproj",
      rawProjectType: "Classification",
    },
    project: {
      name: "双向",
      type: "classification",
      rawType: "Classification",
      description: "",
      modifiedAt: 1_700_000_000_000,
      raw: {},
    },
    classes: [
      {
        index: 0,
        sourceIndex: 0,
        name: "OK",
        color: "#00FF00",
        description: "",
        raw: {},
      },
      {
        index: 1,
        sourceIndex: 1,
        name: "NG",
        color: "#FF0000",
        description: "",
        raw: {},
      },
    ],
    datasets: [],
    files,
    raw: {},
  };
}

function file(index: number, path: string, classIndex: number): ProjectFileIR {
  return {
    index,
    sourcePath: path,
    normalizedPath: path.replace(/\\/gu, "/"),
    fileName: "同名.png",
    width: 2,
    height: 2,
    isLabeled: true,
    classificationClassIndex: classIndex,
    splits: [{ type: "training", rawType: "Training", raw: {} }],
    canonicalSplit: "training",
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

test("vision container writes one root JSON and byte-identical images", async () => {
  const source = project();
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const handle = new MemorySaveHandle();
  const bytes = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: bytes.map((value, index) => ({
      fileIndex: index,
      originalPath: source.files[index]!.sourcePath,
      source: { kind: "blob", blob: new Blob([value]) },
    })),
  });

  const archive = await openValidatedZip(handle.blob());
  try {
    assert.deepEqual(archive.names().sort(), [
      built.projectJsonEntryName,
      "images/同名.png",
      "images/同名_2.png",
    ].sort());
    assert.deepEqual(
      new Uint8Array(await (await archive.readBlob("images/同名.png")).arrayBuffer()),
      bytes[0],
    );
    assert.deepEqual(
      new Uint8Array(await (await archive.readBlob("images/同名_2.png")).arrayBuffer()),
      bytes[1],
    );
  } finally {
    await archive.close();
  }
});

test("container writers reject oversized plans before opening the destination", async () => {
  const source = project();
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const visionHandle = new MemorySaveHandle();
  const tooManyVisionEntries = {
    ...built,
    imageEntries: new Array(BROWSER_ARCHIVE_LIMITS.maxEntries).fill(
      built.imageEntries[0]!,
    ),
  };
  await assert.rejects(
    writeVisionArchive({
      destination: { fileName: built.fileName, handle: visionHandle },
      built: tooManyVisionEntries,
      images: [],
    }),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "OUTPUT_ARCHIVE_ENTRY_LIMIT_EXCEEDED",
  );
  assert.equal(visionHandle.writableCalls, 0);

  const svpaHandle = new MemorySaveHandle();
  const fakeArchive = {} as OpenArchive;
  await assert.rejects(
    writeSvpaArchive({
      destination: { fileName: "oversized.zip", handle: svpaHandle },
      project: source,
      srprojXml: writeSrproj(source),
      helper: new Blob([new Uint8Array([77, 90])]),
      images: source.files.map((item, index) => ({
        fileIndex: item.index,
        originalPath: item.sourcePath,
        source: {
          kind: "archive" as const,
          archive: fakeArchive,
          entryName: `images/${index}.png`,
          size:
            index === 0
              ? BROWSER_ARCHIVE_LIMITS.maxEntryBytes + 1
              : 0,
        },
      })),
    }),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "OUTPUT_ARCHIVE_ENTRY_SIZE_LIMIT_EXCEEDED",
  );
  assert.equal(svpaHandle.writableCalls, 0);
});

test("SVPA container emits compatible manifest, project, images, readme and helper", async () => {
  const source = project();
  const handle = new MemorySaveHandle();
  const xml = writeSrproj(source);
  await writeSvpaArchive({
    destination: { fileName: "双向.svpa.zip", handle },
    project: source,
    srprojXml: xml,
    originalProjectDirectory: String.raw`C:\original\project`,
    helper: new Blob([new Uint8Array([77, 90])]),
    images: source.files.map((item, index) => ({
      fileIndex: item.index,
      originalPath: item.sourcePath,
      source: {
        kind: "blob",
        blob: new Blob([new Uint8Array([index + 1])]),
        relativePath: `root_${index}/同名.png`,
      },
    })),
  });

  const archive = await openValidatedZip(handle.blob());
  try {
    assert.equal(archive.has("项目/双向.srproj"), true);
    assert.equal(archive.has("使用说明.txt"), true);
    assert.equal(archive.has("一键修复并打开项目.exe"), true);
    const manifest = JSON.parse(await archive.readText("svpa_manifest.json"));
    assert.equal(manifest.Generator, "SaigeVision Project Converter");
    assert.equal(manifest.GeneratorVersion, "0.0.1");
    assert.equal(manifest.ProjectFile, "项目/双向.srproj");
    assert.equal(manifest.OriginalProjectDirectory, "C:\\original\\project");
    assert.equal(manifest.Entries.length, 2);
    assert.equal(manifest.Entries[0].OriginalPath, "C:\\a\\同名.png");
    assert.equal(manifest.Entries[0].RelativePath, "图像/root_0/同名.png");
    assert.equal(manifest.Entries[1].RelativePath, "图像/root_1/同名.png");
  } finally {
    await archive.close();
  }
});

test("SVPA with raw parent-relative V1 paths can be loaded back and repaired", async () => {
  const source = project();
  const relative: ProjectIR = {
    ...source,
    files: [file(0, "../images/a.png", 0)],
  };
  const handle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName: "relative.svpa.zip", handle },
    project: relative,
    srprojXml: writeSrproj(relative),
    helper: new Blob([new Uint8Array([77, 90])]),
    images: [{
      fileIndex: 0,
      originalPath: "../images/a.png",
      source: {
        kind: "blob",
        blob: new Blob([new Uint8Array([1, 2, 3])]),
        relativePath: "images/a.png",
      },
    }],
  });

  const loaded = await loadProject(browserFile(handle.blob(), "relative.svpa.zip"));
  try {
    assert.equal(loaded.parseResult.ok, true);
    assert.equal(loaded.project?.files[0]?.sourcePath, "../images/a.png");
    assert.equal(loaded.project?.files[0]?.image.kind, "archive");
  } finally {
    await loaded.close();
  }
});

test("SVPA sanitizes Windows reserved names in generated entries", async () => {
  const source = project();
  const reserved: ProjectIR = {
    ...source,
    project: { ...source.project, name: "NUL" },
    files: [file(0, "C:\\images\\CON.png", 0)],
  };
  const handle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName: "reserved.zip", handle },
    project: reserved,
    srprojXml: writeSrproj(reserved),
    helper: new Blob([new Uint8Array([77, 90])]),
    images: [
      {
        fileIndex: 0,
        originalPath: reserved.files[0]!.sourcePath,
        source: {
          kind: "blob",
          blob: new Blob([new Uint8Array([1])]),
          relativePath: "CON/CON.png",
        },
      },
    ],
  });
  const archive = await openValidatedZip(handle.blob());
  try {
    assert.equal(archive.has("项目/_NUL.srproj"), true);
    assert.equal(archive.has("图像/_CON/_CON.png"), true);
  } finally {
    await archive.close();
  }
});

test("SVPA bounds generated image entry paths while preserving the extension", async () => {
  const source = project();
  const oneFile: ProjectIR = {
    ...source,
    files: [file(0, `C:\\images\\${"图".repeat(300)}.png`, 0)],
  };
  const handle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName: "bounded.zip", handle },
    project: oneFile,
    srprojXml: writeSrproj(oneFile),
    helper: new Blob([new Uint8Array([77, 90])]),
    images: [
      {
        fileIndex: 0,
        originalPath: oneFile.files[0]!.sourcePath,
        source: {
          kind: "blob",
          blob: new Blob([new Uint8Array([1])]),
          relativePath: `${"目录/".repeat(30)}${"图".repeat(300)}.png`,
        },
      },
    ],
  });
  const archive = await openValidatedZip(handle.blob());
  try {
    const imageEntry = archive.names().find((name) => name.startsWith("图像/"));
    assert.ok(imageEntry);
    assert.ok(new TextEncoder().encode(imageEntry).byteLength <= 210);
    assert.match(imageEntry, /\.png$/u);
  } finally {
    await archive.close();
  }
});

test("SVPA deduplicates canonical OriginalPath entries and packages shared bytes once", async () => {
  const source = project();
  const duplicatePath = "C:\\共享\\同名.png";
  const duplicateProject: ProjectIR = {
    ...source,
    files: [
      file(0, duplicatePath, 0),
      file(1, "c:/共享/同名.PNG", 1),
    ],
  };
  const xml = writeSrproj(duplicateProject);
  const sharedBlob = new Blob([new Uint8Array([1, 2, 3, 4])]);
  const handle = new MemorySaveHandle();

  await writeSvpaArchive({
    destination: { fileName: "shared.svpa.zip", handle },
    project: duplicateProject,
    srprojXml: xml,
    helper: new Blob([new Uint8Array([77, 90])]),
    images: duplicateProject.files.map((item) => ({
      fileIndex: item.index,
      originalPath: item.sourcePath,
      source: {
        kind: "blob" as const,
        blob: sharedBlob,
        relativePath: "shared/同名.png",
      },
    })),
  });

  const archive = await openValidatedZip(handle.blob());
  try {
    const manifest = JSON.parse(await archive.readText("svpa_manifest.json"));
    assert.equal(manifest.Entries.length, 1);
    assert.equal(manifest.Entries[0].OriginalPath, duplicatePath);
    assert.equal(manifest.Entries[0].RelativePath, "图像/shared/同名.png");
    assert.deepEqual(
      archive.names().filter((name) => name.startsWith("图像/")),
      ["图像/shared/同名.png"],
    );
  } finally {
    await archive.close();
  }
});

test("SVPA accepts separate sources with identical bytes for one canonical OriginalPath", async () => {
  const source = project();
  const duplicateProject: ProjectIR = {
    ...source,
    files: [
      file(0, "C:\\共享\\same.png", 0),
      file(1, "c:/共享/SAME.PNG", 1),
    ],
  };

  await writeSvpaArchive({
    destination: { fileName: "same-bytes.zip", handle: new MemorySaveHandle() },
    project: duplicateProject,
    srprojXml: writeSrproj(duplicateProject),
    helper: new Blob([new Uint8Array([77, 90])]),
    images: duplicateProject.files.map((item) => ({
      fileIndex: item.index,
      originalPath: item.sourcePath,
      source: {
        kind: "blob" as const,
        blob: new Blob([new Uint8Array([9, 8, 7])]),
      },
    })),
  });
});

test("SVPA keeps distinct OriginalPath values even when they share one binary source", async () => {
  const source = project();
  const sharedBlob = new Blob([new Uint8Array([5, 4, 3])]);
  const handle = new MemorySaveHandle();
  await writeSvpaArchive({
    destination: { fileName: "distinct-paths.zip", handle },
    project: source,
    srprojXml: writeSrproj(source),
    helper: new Blob([new Uint8Array([77, 90])]),
    images: source.files.map((item) => ({
      fileIndex: item.index,
      originalPath: item.sourcePath,
      source: {
        kind: "blob" as const,
        blob: sharedBlob,
        relativePath: "shared/同名.png",
      },
    })),
  });

  const archive = await openValidatedZip(handle.blob());
  try {
    const manifest = JSON.parse(await archive.readText("svpa_manifest.json"));
    assert.equal(manifest.Entries.length, 2);
    assert.equal(
      new Set(manifest.Entries.map((entry: { RelativePath: string }) => entry.RelativePath)).size,
      2,
    );
    assert.equal(
      archive.names().filter((name) => name.startsWith("图像/")).length,
      2,
    );
  } finally {
    await archive.close();
  }
});

test("SVPA blocks conflicting binary sources for one canonical OriginalPath", async () => {
  const source = project();
  const duplicateProject: ProjectIR = {
    ...source,
    files: [
      file(0, "C:\\共享\\same.png", 0),
      file(1, "c:/共享/SAME.PNG", 1),
    ],
  };

  await assert.rejects(
    writeSvpaArchive({
      destination: { fileName: "conflict.zip", handle: new MemorySaveHandle() },
      project: duplicateProject,
      srprojXml: writeSrproj(duplicateProject),
      helper: new Blob([new Uint8Array([77, 90])]),
      images: duplicateProject.files.map((item, index) => ({
        fileIndex: item.index,
        originalPath: item.sourcePath,
        source: {
          kind: "blob" as const,
          blob: new Blob([new Uint8Array(index === 0 ? [1, 2, 3] : [1, 2, 4])]),
        },
      })),
    }),
    (error) =>
      error instanceof ContainerWriteError &&
      error.code === "SVPA_IMAGE_SOURCE_CONFLICT",
  );
});

test("SVPA validates the srproj Path multiset before creating output", async () => {
  const source = project();
  const handle = new MemorySaveHandle();
  const mismatchedXml = writeSrproj(source).replace(
    "C:\\a\\同名.png",
    "C:\\a\\other.png",
  );

  await assert.rejects(
    writeSvpaArchive({
      destination: { fileName: "mismatch.zip", handle },
      project: source,
      srprojXml: mismatchedXml,
      helper: new Blob([new Uint8Array([77, 90])]),
      images: source.files.map((item) => ({
        fileIndex: item.index,
        originalPath: item.sourcePath,
        source: { kind: "blob" as const, blob: new Blob([new Uint8Array([1])]) },
      })),
    }),
    (error) =>
      error instanceof ContainerWriteError &&
      error.code === "SVPA_SRPROJ_PATH_MISMATCH",
  );
  assert.equal(handle.blob().size, 0);
});

test("SVPA rejects unsafe XML declarations and empty image projects", async () => {
  const source = project();
  const xml = writeSrproj(source);
  const unsafeXml = xml.replace(
    "<Project>",
    '<!DOCTYPE Project [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Project>',
  );

  await assert.rejects(
    writeSvpaArchive({
      destination: { fileName: "unsafe.zip", handle: new MemorySaveHandle() },
      project: source,
      srprojXml: unsafeXml,
      helper: new Blob([new Uint8Array([77, 90])]),
      images: source.files.map((item) => ({
        fileIndex: item.index,
        originalPath: item.sourcePath,
        source: { kind: "blob" as const, blob: new Blob([new Uint8Array([1])]) },
      })),
    }),
    (error) =>
      error instanceof ContainerWriteError &&
      error.code === "SVPA_SRPROJ_XML_UNSAFE",
  );

  const emptyProject: ProjectIR = { ...source, files: [] };
  await assert.rejects(
    writeSvpaArchive({
      destination: { fileName: "empty.zip", handle: new MemorySaveHandle() },
      project: emptyProject,
      srprojXml: writeSrproj(emptyProject),
      helper: new Blob([new Uint8Array([77, 90])]),
      images: [],
    }),
    (error) =>
      error instanceof ContainerWriteError && error.code === "SVPA_EMPTY_PROJECT",
  );
});

test("container rejects duplicate and incomplete image mappings", async () => {
  const source = project();
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const duplicated = [
    {
      fileIndex: 0,
      originalPath: source.files[0]!.sourcePath,
      source: { kind: "blob" as const, blob: new Blob(["a"]) },
    },
    {
      fileIndex: 0,
      originalPath: source.files[0]!.sourcePath,
      source: { kind: "blob" as const, blob: new Blob(["b"]) },
    },
  ];
  await assert.rejects(
    writeVisionArchive({
      destination: { fileName: built.fileName, handle: new MemorySaveHandle() },
      built,
      images: duplicated,
    }),
    /重复映射/u,
  );
});

test("vision container rejects images assigned to the wrong project index", async () => {
  const source = project();
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const swapped = source.files.map((file, index) => ({
    fileIndex: index,
    originalPath: source.files[1 - index]!.sourcePath,
    source: { kind: "blob" as const, blob: new Blob([String(index)]) },
  }));
  await assert.rejects(
    writeVisionArchive({
      destination: { fileName: built.fileName, handle: new MemorySaveHandle() },
      built,
      images: swapped,
    }),
    (error: unknown) =>
      error instanceof ContainerWriteError &&
      error.code === "VISION_IMAGE_SOURCE_MISMATCH",
  );
});

test("container writers reject an already aborted operation before writing", async () => {
  const source = project();
  const built = writeV2VisionProject(source);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const handle = new MemorySaveHandle();
  await assert.rejects(
    writeVisionArchive({
      destination: { fileName: built.fileName, handle },
      built,
      images: [],
      signal: controller.signal,
    }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(handle.blob().size, 0);
});
