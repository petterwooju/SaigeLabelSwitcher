import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";

import {
  addSourceSelectionUsage,
  EMPTY_SOURCE_SELECTION_USAGE,
  measureSourceSelectionUsage,
  SourceSelectionLimitError,
} from "../lib/files/sourceSelectionLimits.ts";
import {
  mergeSelectedFiles,
  selectedSourceUsage,
} from "../lib/files/imageMatcher.ts";

test("source usage is accumulated across repeated picker and archive selections", () => {
  const first = addSourceSelectionUsage(
    EMPTY_SOURCE_SELECTION_USAGE,
    measureSourceSelectionUsage([3, 5]),
    { maxSourceCount: 3, maxTotalBytes: 10, maxOpenArchives: 1 },
  );
  assert.deepEqual(first, {
    sourceCount: 2,
    totalBytes: 8,
    openArchiveCount: 0,
  });

  const combined = addSourceSelectionUsage(
    first,
    measureSourceSelectionUsage([2], 1),
    { maxSourceCount: 3, maxTotalBytes: 10, maxOpenArchives: 1 },
  );
  assert.deepEqual(combined, {
    sourceCount: 3,
    totalBytes: 10,
    openArchiveCount: 1,
  });
});

test("global source usage rejects cumulative file, byte and open-archive limits", () => {
  const current = {
    sourceCount: 2,
    totalBytes: 8,
    openArchiveCount: 1,
  };
  const limits = { maxSourceCount: 2, maxTotalBytes: 8, maxOpenArchives: 1 };

  assert.throws(
    () => addSourceSelectionUsage(current, measureSourceSelectionUsage([0]), limits),
    (error: unknown) =>
      error instanceof SourceSelectionLimitError &&
      error.code === "IMAGE_SOURCE_FILE_LIMIT",
  );
  assert.throws(
    () =>
      addSourceSelectionUsage(
        current,
        { sourceCount: 0, totalBytes: 1, openArchiveCount: 0 },
        limits,
      ),
    (error: unknown) =>
      error instanceof SourceSelectionLimitError &&
      error.code === "IMAGE_SOURCE_SIZE_LIMIT",
  );
  assert.throws(
    () =>
      addSourceSelectionUsage(
        current,
        { sourceCount: 0, totalBytes: 0, openArchiveCount: 1 },
        limits,
      ),
    (error: unknown) =>
      error instanceof SourceSelectionLimitError &&
      error.code === "IMAGE_SOURCE_ARCHIVE_LIMIT",
  );
});

test("source usage rejects invalid numbers and safe-integer overflow", () => {
  for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => measureSourceSelectionUsage([invalid]),
      (error: unknown) =>
        error instanceof SourceSelectionLimitError &&
        error.code === "IMAGE_SOURCE_USAGE_INVALID",
    );
  }
  assert.throws(
    () =>
      addSourceSelectionUsage(
        {
          sourceCount: Number.MAX_SAFE_INTEGER,
          totalBytes: 0,
          openArchiveCount: 0,
        },
        { sourceCount: 1, totalBytes: 0, openArchiveCount: 0 },
        {
          maxSourceCount: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
          maxOpenArchives: Number.MAX_SAFE_INTEGER,
        },
      ),
    (error: unknown) =>
      error instanceof SourceSelectionLimitError &&
      error.code === "IMAGE_SOURCE_USAGE_INVALID",
  );
});

test("selected source measurement includes every retained browser source", () => {
  const files = mergeSelectedFiles([], [
    new NodeFile([new Uint8Array(3)], "a.png") as unknown as File,
    new NodeFile([new Uint8Array(5)], "b.png") as unknown as File,
  ]);
  assert.deepEqual(selectedSourceUsage(files, 2), {
    sourceCount: 2,
    totalBytes: 8,
    openArchiveCount: 2,
  });
});
