import assert from "node:assert/strict";
import test from "node:test";
import { openValidatedZip } from "../lib/archive/zip.ts";
import type { ProjectFileIR, ProjectIR } from "../lib/model/project.ts";
import {
  ContainerWriteError,
  writeSvpaArchive,
  writeVisionArchive,
} from "../lib/output/containers.ts";
import type { FileSystemSaveHandle } from "../lib/output/save.ts";
import { writeSrproj } from "../lib/output/srproj.ts";
import { writeV2VisionProject } from "../lib/output/v2.ts";

class MemorySaveHandle implements FileSystemSaveHandle {
  private chunks: ArrayBuffer[] = [];

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
