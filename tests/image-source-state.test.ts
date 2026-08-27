import assert from "node:assert/strict";
import test from "node:test";
import type {
  ImageMatchReport,
  ImagePathMatch,
  SelectedSourceFile,
} from "../lib/files/imageMatcher.ts";
import {
  MAX_RETAINED_IMAGE_MATCH_ISSUES,
  addedSelectionId,
  batchLabelFromPaths,
  removeSelectedSourceBatch,
  retainImageMatchIssues,
  statusAfterSuccessfulImageSelection,
  summarizeImageSourceBatches,
} from "../components/imageSourceState.ts";

function missingMatch(index: number): ImagePathMatch {
  return {
    projectPath: {
      index,
      originalPath: `images/missing-${index}.png`,
      normalizedPath: `images/missing-${index}.png`,
      fileName: `missing-${index}.png`,
    },
    status: "missing",
    candidates: [],
    candidateCount: 0,
    score: 0,
  };
}

function reportWithMissing(count: number): ImageMatchReport {
  return {
    matches: Array.from({ length: count }, (_, index) => missingMatch(index)),
    totalCount: count,
    matchedCount: 0,
    missingCount: count,
    ambiguousCount: 0,
    blankPathCount: 0,
    uniqueMatchedFiles: [],
    matchedBytes: 0,
    canPackage: false,
  };
}

function selectedFile(
  selectionId: string,
  ordinal: number,
  size: number,
): SelectedSourceFile {
  const path = `${selectionId}/image-${ordinal}.png`;
  return {
    id: `${selectionId}::${ordinal}`,
    selectionId,
    source: { kind: "blob", blob: new Blob([new Uint8Array(size)]), relativePath: path },
    relativePath: path,
    normalizedRelativePath: path,
    pathSegments: path.split("/"),
  };
}

test("retains a bounded issue sample while preserving the exact total", () => {
  const report = reportWithMissing(20_000);
  const summary = retainImageMatchIssues(report);

  assert.equal(summary.issueCount, 20_000);
  assert.equal(summary.issues.length, MAX_RETAINED_IMAGE_MATCH_ISSUES);
  assert.equal(summary.issues[0]?.originalPath, "images/missing-0.png");
  assert.equal(summary.issues.at(-1)?.originalPath, "images/missing-99.png");
  assert.equal(retainImageMatchIssues(report, 0).issues.length, 0);
});

test("tracks source batches and recalculates usage after one batch is removed", () => {
  const first = [selectedFile("folder-1", 0, 3), selectedFile("folder-1", 1, 5)];
  const second = [selectedFile("zip-1", 0, 7)];
  const all = [...first, ...second];

  assert.equal(addedSelectionId(first, all), "zip-1");
  assert.deepEqual(
    summarizeImageSourceBatches(all, [
      { id: "folder-1", kind: "directory", label: "images" },
      { id: "zip-1", kind: "zip", label: "images.zip" },
    ]),
    [
      { id: "folder-1", kind: "directory", label: "images", fileCount: 2, totalBytes: 8 },
      { id: "zip-1", kind: "zip", label: "images.zip", fileCount: 1, totalBytes: 7 },
    ],
  );

  const remaining = removeSelectedSourceBatch(all, "zip-1");
  assert.deepEqual(remaining.map((file) => file.selectionId), ["folder-1", "folder-1"]);
  assert.deepEqual(
    summarizeImageSourceBatches(remaining, [
      { id: "folder-1", kind: "directory", label: "images" },
      { id: "zip-1", kind: "zip", label: "images.zip" },
    ]),
    [{ id: "folder-1", kind: "directory", label: "images", fileCount: 2, totalBytes: 8 }],
  );
});

test("derives stable source labels and recovers only failed loaded projects", () => {
  assert.equal(
    batchLabelFromPaths(["camera-a/1.png", "camera-a/sub/2.png"], "fallback"),
    "camera-a",
  );
  assert.equal(batchLabelFromPaths(["1.png", "2.png"], "selected files"), "selected files");
  assert.equal(statusAfterSuccessfulImageSelection("error", true), "ready");
  assert.equal(statusAfterSuccessfulImageSelection("error", false), "error");
  assert.equal(statusAfterSuccessfulImageSelection("saving", true), "saving");
});
