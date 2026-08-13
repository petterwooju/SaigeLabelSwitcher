import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";
import {
  type DirectoryHandleLike,
  DirectoryReadError,
  pickDirectoryFiles,
  readDirectoryFiles,
  readWebkitDirectoryFiles,
} from "../lib/files/directoryPicker.ts";

function fileHandle(name: string, size = 1) {
  return {
    kind: "file" as const,
    name,
    async getFile() {
      return new NodeFile([new Uint8Array(size)], name) as unknown as File;
    },
  };
}

function directory(
  name: string,
  children: Array<ReturnType<typeof fileHandle> | DirectoryHandleLike>,
): DirectoryHandleLike {
  return {
    kind: "directory",
    name,
    async *values() {
      yield* children;
    },
  };
}

test("directory reader enforces file count and byte limits", async () => {
  const root = directory("images", [fileHandle("a.png", 2), fileHandle("b.png", 2)]);
  await assert.rejects(
    readDirectoryFiles(root, { maxFiles: 1 }),
    (error) =>
      error instanceof DirectoryReadError && error.code === "DIRECTORY_FILE_LIMIT",
  );
  await assert.rejects(
    readDirectoryFiles(root, { maxTotalBytes: 3 }),
    (error) =>
      error instanceof DirectoryReadError && error.code === "DIRECTORY_SIZE_LIMIT",
  );
});

test("directory reader filters before materializing and enforces depth", async () => {
  let ignoredRead = false;
  const ignored = {
    kind: "file" as const,
    name: "notes.txt",
    async getFile() {
      ignoredRead = true;
      return new NodeFile(["notes"], "notes.txt") as unknown as File;
    },
  };
  const root = directory("images", [
    ignored,
    directory("class", [fileHandle("a.png")]),
  ]);
  const result = await readDirectoryFiles(root, {
    includeFile: (name) => name.endsWith(".png"),
  });
  assert.equal(ignoredRead, false);
  assert.deepEqual(result.map((item) => item.relativePath), ["images/class/a.png"]);
  await assert.rejects(
    readDirectoryFiles(root, { maxDepth: 0 }),
    (error) =>
      error instanceof DirectoryReadError && error.code === "DIRECTORY_DEPTH_LIMIT",
  );
});

test("directory reader observes an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readDirectoryFiles(directory("images", [fileHandle("a.png")]), {
      signal: controller.signal,
    }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("directory picker forwards filtering and signal options", async () => {
  let ignoredRead = false;
  const root = directory("images", [
    {
      kind: "file" as const,
      name: "notes.txt",
      async getFile() {
        ignoredRead = true;
        return new NodeFile(["notes"], "notes.txt") as unknown as File;
      },
    },
    fileHandle("a.png"),
  ]);
  const picked = await pickDirectoryFiles(
    { async showDirectoryPicker() { return root; } },
    { mode: "read" },
    { includeFile: (name) => name.endsWith(".png") },
  );
  assert.equal(ignoredRead, false);
  assert.deepEqual(picked.map((item) => item.relativePath), ["images/a.png"]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pickDirectoryFiles(
      { async showDirectoryPicker() { return root; } },
      { mode: "read" },
      { signal: controller.signal },
    ),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("webkit and ordinary file fallbacks filter and enforce the same limits", () => {
  const png = new NodeFile([new Uint8Array(2)], "a.png") as unknown as File;
  const ignored = new NodeFile(["notes"], "notes.txt") as unknown as File;
  const picked = readWebkitDirectoryFiles([ignored, png], {
    includeFile: (name) => name.endsWith(".png"),
    maxFiles: 1,
    maxTotalBytes: 2,
  });
  assert.deepEqual(picked.map((item) => item.relativePath), ["a.png"]);

  assert.throws(
    () => readWebkitDirectoryFiles([png, png], { maxFiles: 1 }),
    (error) =>
      error instanceof DirectoryReadError && error.code === "DIRECTORY_FILE_LIMIT",
  );
  assert.throws(
    () => readWebkitDirectoryFiles([png], { maxTotalBytes: 1 }),
    (error) =>
      error instanceof DirectoryReadError && error.code === "DIRECTORY_SIZE_LIMIT",
  );
});
