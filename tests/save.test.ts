import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserCapabilityError,
  createZipDestination,
  ensureBlobFallbackIsSafe,
  isBlobFallbackSafe,
  requiresZip64,
  requestSaveDestination,
  saveBlob,
} from "../lib/output/save.ts";
import { TextReader } from "@zip.js/zip.js";

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

test("Blob fallback boundary can be checked without throwing", () => {
  assert.equal(isBlobFallbackSafe(0), true);
  assert.equal(isBlobFallbackSafe(500 * 1024 ** 2), true);
  assert.equal(isBlobFallbackSafe(500 * 1024 ** 2 + 1), false);
  assert.equal(isBlobFallbackSafe(-1), false);
  assert.equal(isBlobFallbackSafe(Number.POSITIVE_INFINITY), false);
});

test("direct Blob save streams without materializing arrayBuffer", async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
    },
  });
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  Object.defineProperty(blob, "arrayBuffer", {
    value: () => Promise.reject(new Error("arrayBuffer must not be used")),
  });
  const result = await saveBlob(
    {
      fileName: "stream.bin",
      handle: { createWritable: async () => writable },
    },
    blob,
  );
  assert.equal(result.mode, "direct");
  assert.deepEqual(Array.from(chunks[0] ?? []), [1, 2, 3]);
});

test("direct Blob save cooperatively aborts and cancels its source", async () => {
  const controller = new AbortController();
  let sourceCancelled = false;
  const fakeBlob = {
    size: 1024,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1]));
        },
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          sourceCancelled = true;
        },
      });
    },
  } as Blob;
  const saving = saveBlob(
    {
      fileName: "cancel.bin",
      handle: {
        createWritable: async () => new WritableStream<Uint8Array>(),
      },
    },
    fakeBlob,
    controller.signal,
  );
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(saving, (error) => error instanceof Error && error.name === "AbortError");
  assert.equal(sourceCancelled, true);
});

test("ZIP64 selection covers byte and entry-count boundaries", () => {
  assert.equal(requiresZip64(0xffffffff - 1, 0xffff - 1), false);
  assert.equal(requiresZip64(0xffffffff, 1), true);
  assert.equal(requiresZip64(1, 0xffff), true);
  assert.throws(() => requiresZip64(-1, 1), RangeError);
  assert.throws(() => requiresZip64(1, Number.MAX_VALUE), RangeError);
});

test("save picker capability failures fall back to browser download", async () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      showSaveFilePicker: async () => {
        throw new DOMException("blocked by host", "SecurityError");
      },
    },
  });
  try {
    const destination = await requestSaveDestination("project.srproj", {
      description: "SaigeVision V1 project",
      mimeType: "application/xml",
      extensions: [".srproj"],
    });
    assert.deepEqual(destination, { fileName: "project.srproj" });
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("preferred browser download does not create a save-picker placeholder", async () => {
  const originalWindow = globalThis.window;
  let pickerCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      showSaveFilePicker: async () => {
        pickerCalls += 1;
        throw new Error("the picker must not open");
      },
    },
  });
  try {
    const destination = await requestSaveDestination(
      "project.zip",
      {
        description: "SaigeVision project package",
        mimeType: "application/zip",
        extensions: [".zip"],
      },
      { preferDownload: true },
    );
    assert.deepEqual(destination, { fileName: "project.zip" });
    assert.equal(pickerCalls, 0);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("direct ZIP save reports actual written bytes instead of its estimate", async () => {
  let written = 0;
  const output = await createZipDestination(
    {
      fileName: "actual.zip",
      handle: {
        createWritable: async () =>
          new WritableStream<Uint8Array>({
            write(chunk) {
              written += chunk.byteLength;
            },
          }),
      },
    },
    1,
    1,
  );
  await output.writer.add("value.txt", new TextReader("hello"));
  const result = await output.finalize();
  assert.ok(written > 1);
  assert.equal(result.size, written);
});
