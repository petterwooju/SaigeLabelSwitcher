import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserCapabilityError,
  ensureBlobFallbackIsSafe,
} from "../lib/output/save.ts";

test("small Blob fallback remains available", () => {
  assert.doesNotThrow(() => ensureBlobFallbackIsSafe(499 * 1024 ** 2));
});

test("large Blob fallback is blocked before allocation", () => {
  assert.throws(
    () => ensureBlobFallbackIsSafe(501 * 1024 ** 2),
    (error: unknown) =>
      error instanceof BrowserCapabilityError &&
      error.code === "BLOB_FALLBACK_TOO_LARGE",
  );
});
