import assert from "node:assert/strict";
import test from "node:test";
import { TextReader, ZipWriter, BlobWriter } from "@zip.js/zip.js";
import { openValidatedZip } from "../lib/archive/zip.ts";
import { createProjectImageReferences, matchImageFiles, mergeSelectedFileInputs } from "../lib/files/imageMatcher.ts";
import { resolveProjectImages } from "../lib/files/resolveImages.ts";
import type { ProjectFileIR, ProjectIR } from "../lib/model/project.ts";

function project(file: ProjectFileIR): ProjectIR {
  return {
    schemaVersion: 1,
    source: { format: "v1-srproj", rawProjectType: "Classification" },
    project: {
      name: "fixture",
      type: "classification",
      rawType: "Classification",
      description: "",
      raw: {},
    },
    classes: [],
    datasets: [],
    files: [file],
    raw: {},
  };
}

function commonFile(): Omit<ProjectFileIR, "image"> {
  return {
    index: 0,
    sourcePath: "C:\\old\\class\\a.png",
    normalizedPath: "C:/old/class/a.png",
    fileName: "a.png",
    splits: [],
    canonicalSplit: "training",
    labels: [],
    raw: {},
  };
}

test("external image resolution uses a unique directory match", () => {
  const source = project({
    ...commonFile(),
    image: { kind: "external", path: "C:\\old\\class\\a.png" },
  });
  const picked = mergeSelectedFileInputs([], [
    { file: new File(["hello"], "a.png"), relativePath: "root/class/a.png" },
  ]);
  const report = matchImageFiles(
    createProjectImageReferences([source.files[0]!.sourcePath]),
    picked,
  );
  const resolved = resolveProjectImages(source, undefined, report);
  assert.equal(resolved.complete, true);
  assert.equal(resolved.totalBytes, 5);
  assert.equal(resolved.images[0]?.source.kind, "blob");
});

test("archive image resolution does not materialize the entry", async () => {
  const output = new BlobWriter("application/zip");
  const writer = new ZipWriter(output);
  await writer.add("images/a.png", new TextReader("image"), { level: 0 });
  await writer.close();
  const archive = await openValidatedZip(await output.getData());
  try {
    const source = project({
      ...commonFile(),
      image: { kind: "archive", entryName: "images/a.png" },
    });
    const resolved = resolveProjectImages(source, archive);
    assert.equal(resolved.complete, true);
    assert.equal(resolved.totalBytes, 5);
    assert.deepEqual(resolved.images[0]?.source, {
      kind: "archive",
      archive,
      entryName: "images/a.png",
      size: 5,
      relativePath: "a.png",
    });
  } finally {
    await archive.close();
  }
});

test("missing external selections remain blocking issues", () => {
  const source = project({
    ...commonFile(),
    image: { kind: "external", path: "C:\\old\\class\\a.png" },
  });
  const resolved = resolveProjectImages(source);
  assert.equal(resolved.complete, false);
  assert.equal(resolved.images.length, 0);
  assert.equal(resolved.issues[0]?.code, "EXTERNAL_IMAGE_NOT_SELECTED");
});
