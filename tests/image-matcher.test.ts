import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";

import {
  type DirectoryHandleLike,
  type FileHandleLike,
  readDirectoryFiles,
  readWebkitDirectoryFiles,
} from "../lib/files/directoryPicker.ts";
import {
  createProjectImageReferences,
  matchImageFiles,
  matchProjectFiles,
  mergeArchiveImageEntries,
  mergeSelectedFiles,
} from "../lib/files/imageMatcher.ts";
import { openValidatedZip } from "../lib/archive/zip.ts";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import {
  isSafeZipEntryPath,
  normalizePath,
  normalizeZipEntryPath,
  pathComparisonKey,
} from "../lib/security/paths.ts";

function selectedFile(relativePath: string, size = 4): globalThis.File {
  const fileName = relativePath.replaceAll("\\", "/").split("/").at(-1) || "image.bin";
  const file = new NodeFile([new Uint8Array(size)], fileName, {
    lastModified: 1,
  }) as unknown as globalThis.File;
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

test("normalizes Windows, file URL, Unicode and case for comparison", () => {
  assert.equal(normalizePath(' "file:///C:\\产线\\良品\\A.JPG" '), "C:/产线/良品/A.JPG");
  assert.equal(pathComparisonKey("资料/CAFE\u0301.PNG"), pathComparisonKey("资料/café.png"));
});

test("matches duplicate filenames by the longest unique path suffix", () => {
  const files = mergeSelectedFiles([], [
    selectedFile("数据集/良品/000.PNG", 5),
    selectedFile("数据集/划痕/000.png", 7),
  ]);
  const report = matchImageFiles(
    ["D:\\产线\\良品\\000.png", "E:\\样本\\划痕\\000.PNG"],
    files,
  );

  assert.equal(report.matchedCount, 2);
  assert.equal(report.ambiguousCount, 0);
  assert.equal(report.missingCount, 0);
  assert.equal(report.matchedBytes, 12);
  assert.equal(report.canPackage, true);
  assert.deepEqual(
    report.matches.map((match) => match.selectedFile?.relativePath),
    ["数据集/良品/000.PNG", "数据集/划痕/000.png"],
  );
});

test("reports a same-name tie as ambiguous", () => {
  const files = mergeSelectedFiles([], [
    selectedFile("第一组/000.png"),
    selectedFile("第二组/000.PNG"),
  ]);
  const report = matchImageFiles(["000.png"], files);

  assert.equal(report.ambiguousCount, 1);
  assert.equal(report.matches[0]?.candidates.length, 2);
  assert.equal(report.canPackage, false);
});

test("never reuses one bare selected file for distinct project paths", () => {
  const files = mergeSelectedFiles([], [selectedFile("000.png", 7)]);
  const report = matchImageFiles(
    ["C:\\images\\color\\000.png", "C:\\images\\crack\\000.png"],
    files,
  );

  assert.equal(report.matchedCount, 0);
  assert.equal(report.ambiguousCount, 2);
  assert.equal(report.canPackage, false);
});

test("keeps validated image ZIP entries lazy while matching their paths", async () => {
  const output = new BlobWriter("application/zip");
  const writer = new ZipWriter(output);
  await writer.add("images/color/000.png", new TextReader("color"), { level: 0 });
  await writer.add("images/crack/000.png", new TextReader("crack"), { level: 0 });
  await writer.close();
  const archive = await openValidatedZip(await output.getData());
  try {
    const files = mergeArchiveImageEntries(
      [],
      archive,
      archive.entries.map((entry) => ({
        entryName: entry.name,
        size: entry.uncompressedSize,
      })),
      "fixture.zip::1",
    );
    const report = matchImageFiles(
      ["C:\\images\\color\\000.png", "C:\\images\\crack\\000.png"],
      files,
    );
    assert.equal(report.matchedCount, 2);
    assert.equal(report.ambiguousCount, 0);
    assert.equal(report.canPackage, true);
    assert.equal(report.uniqueMatchedFiles[0]?.source.kind, "archive");
  } finally {
    await archive.close();
  }
});

test("reports missing and blank project paths without silently dropping them", () => {
  const references = createProjectImageReferences([
    "C:\\images\\exists.png",
    "C:\\images\\missing.png",
    "  ",
  ]);
  const files = mergeSelectedFiles([], [selectedFile("images/exists.png")]);
  const report = matchImageFiles(references, files);

  assert.equal(references.blankPathCount, 1);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.missingCount, 1);
  assert.equal(report.blankPathCount, 1);
  assert.equal(report.totalCount, 3);
  assert.equal(report.canPackage, false);
});

test("supports legacy projects that report omitted blank paths in their summary", () => {
  const references = createProjectImageReferences(["C:\\images\\exists.png"]);
  const files = mergeSelectedFiles([], [selectedFile("images/exists.png")]);
  const report = matchProjectFiles(
    {
      paths: references.references,
      summary: { blankPathCount: 1 },
    },
    files,
  );

  assert.equal(report.matchedCount, 1);
  assert.equal(report.blankPathCount, 1);
  assert.equal(report.totalCount, 2);
  assert.equal(report.canPackage, false);
});

test("deduplicates an identical browser selection and ignores OS metadata", () => {
  const image = selectedFile("root/图片.png", 9);
  const files = mergeSelectedFiles([], [
    image,
    image,
    selectedFile("root/Thumbs.db"),
    selectedFile("root/.DS_Store"),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.relativePath, "root/图片.png");
});

test("reads File System Access directories recursively", async () => {
  const image = selectedFile("ignored/by/handle.png");
  const fileHandle: FileHandleLike = {
    kind: "file",
    name: "图像.PNG",
    async getFile() {
      return image;
    },
  };
  const child: DirectoryHandleLike = {
    kind: "directory",
    name: "良品",
    async *values() {
      yield fileHandle;
    },
  };
  const root: DirectoryHandleLike = {
    kind: "directory",
    name: "数据集",
    async *values() {
      yield child;
    },
  };

  const files = await readDirectoryFiles(root);
  assert.deepEqual(files.map((item) => item.relativePath), ["数据集/良品/图像.PNG"]);
  assert.equal(files[0]?.file, image);
});

test("keeps webkitdirectory relative paths for fallback matching", () => {
  const files = readWebkitDirectoryFiles([
    selectedFile("项目/验证/中文 图.png"),
  ]);
  assert.equal(files[0]?.relativePath, "项目/验证/中文 图.png");
});

test("accepts safe Unicode ZIP entries and rejects traversal or absolute paths", () => {
  assert.equal(isSafeZipEntryPath("图像/良品/中文 图.PNG"), true);
  assert.equal(normalizeZipEntryPath("图像\\良品\\001.png"), "图像/良品/001.png");

  for (const unsafe of [
    "../outside.png",
    "images/../outside.png",
    "..\\outside.png",
    "/absolute/image.png",
    "C:\\absolute\\image.png",
    "images/./image.png",
    "images/file.png:stream",
    "images/NUL.txt",
    "images/bad\u0000name.png",
  ]) {
    assert.equal(isSafeZipEntryPath(unsafe), false, unsafe);
  }
});
