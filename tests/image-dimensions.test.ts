import assert from "node:assert/strict";
import test from "node:test";
import {
  BlobWriter,
  Uint8ArrayReader,
  ZipWriter,
} from "@zip.js/zip.js";

import { openValidatedZip, type OpenArchive } from "../lib/archive/zip.ts";
import {
  MAX_IMAGE_DIMENSION,
  enrichProjectImageDimensions,
  verifyAndEnrichProjectImages,
  type ImageDimensionProgress,
} from "../lib/files/imageDimensions.ts";
import type { ProjectFileIR, ProjectIR } from "../lib/model/project.ts";
import type { ResolvedProjectImage } from "../lib/output/containers.ts";

function project(files: readonly ProjectFileIR[]): ProjectIR {
  return {
    schemaVersion: 1,
    source: { format: "v1-srproj", rawProjectType: "Classification" },
    project: {
      name: "dimensions",
      type: "classification",
      rawType: "Classification",
      description: "",
      raw: {},
    },
    classes: [],
    datasets: [],
    files,
    raw: {},
  };
}

function file(
  index: number,
  dimensions: { readonly width?: number; readonly height?: number } = {},
): ProjectFileIR {
  const path = `C:\\images\\image_${index}.bin`;
  return {
    index,
    sourcePath: path,
    normalizedPath: path.replaceAll("\\", "/"),
    fileName: `image_${index}.bin`,
    ...dimensions,
    splits: [],
    canonicalSplit: "training",
    labels: [],
    image: { kind: "external", path },
    raw: {},
  };
}

function resolved(fileIndex: number, bytes: Uint8Array): ResolvedProjectImage {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return {
    fileIndex,
    originalPath: `C:\\images\\image_${fileIndex}.bin`,
    source: { kind: "blob", blob: new Blob([copy.buffer]) },
  };
}

function imageBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  setAscii(bytes, 12, "IHDR");
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
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

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  setAscii(bytes, 0, "GIF89a");
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  setAscii(bytes, 0, "BM");
  const view = new DataView(bytes.buffer);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = webpChunk("VP8X", 10);
  setUint24LE(bytes, 24, width - 1);
  setUint24LE(bytes, 27, height - 1);
  return bytes;
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = webpChunk("VP8L", 5);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  bytes[20] = 0x2f;
  bytes[21] = widthMinusOne & 0xff;
  bytes[22] =
    ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6);
  bytes[23] = (heightMinusOne >> 2) & 0xff;
  bytes[24] = (heightMinusOne >> 10) & 0x0f;
  return bytes;
}

function webpVp8(width: number, height: number): Uint8Array {
  const bytes = webpChunk("VP8 ", 10);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function webpChunk(type: string, size: number): Uint8Array {
  const bytes = new Uint8Array(20 + size);
  setAscii(bytes, 0, "RIFF");
  new DataView(bytes.buffer).setUint32(4, 12 + size, true);
  setAscii(bytes, 8, "WEBP");
  setAscii(bytes, 12, type);
  new DataView(bytes.buffer).setUint32(16, size, true);
  return bytes;
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function setUint24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

test("enriches PNG, JPEG, BMP, GIF, and all WebP header variants immutably", async () => {
  const fixtures = [
    { bytes: png(321, 123), width: 321, height: 123, format: "png" },
    { bytes: jpeg(640, 480), width: 640, height: 480, format: "jpeg" },
    { bytes: bmp(800, -600), width: 800, height: 600, format: "bmp" },
    { bytes: gif(90, 45), width: 90, height: 45, format: "gif" },
    { bytes: webpVp8x(777, 333), width: 777, height: 333, format: "webp" },
    { bytes: webpVp8l(511, 257), width: 511, height: 257, format: "webp" },
    { bytes: webpVp8(1280, 720), width: 1280, height: 720, format: "webp" },
  ] as const;
  const files = fixtures.map((_, index) =>
    file(index, index === 1 ? { width: 1.5, height: 480 } : {}),
  );
  const input = project(files);
  const progress: ImageDimensionProgress[] = [];
  const result = await enrichProjectImageDimensions(
    input,
    fixtures.map((item, index) => resolved(index, item.bytes)),
    (item) => progress.push(item),
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.updatedFileIndexes, [0, 1, 2, 3, 4, 5, 6]);
  assert.notEqual(result.project, input);
  assert.notEqual(result.project.files, input.files);
  assert.ok(input.files.every((item) => item.width === undefined || item.width === 1.5));
  assert.deepEqual(
    result.project.files.map(({ width, height }) => ({ width, height })),
    fixtures.map(({ width, height }) => ({ width, height })),
  );
  assert.deepEqual(
    progress.map(({ completed, total, status, format }) => ({
      completed,
      total,
      status,
      format,
    })),
    fixtures.map((item, index) => ({
      completed: index + 1,
      total: fixtures.length,
      status: "enriched",
      format: item.format,
    })),
  );
});

test("does not read files whose existing dimensions are valid", async () => {
  const unreadableBlob = {
    size: 1,
    type: "image/png",
    slice() {
      throw new Error("valid dimensions must not read the source");
    },
  } as unknown as Blob;
  const unchanged = file(0, { width: 12, height: 9 });
  const input = project([unchanged]);
  let progressCalls = 0;
  const result = await enrichProjectImageDimensions(
    input,
    [
      {
        fileIndex: 0,
        originalPath: unchanged.sourcePath,
        source: { kind: "blob", blob: unreadableBlob },
      },
    ],
    () => {
      progressCalls += 1;
    },
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.updatedFileIndexes, []);
  assert.deepEqual(result.issues, []);
  assert.equal(progressCalls, 0);
  assert.notEqual(result.project, input);
  assert.equal(result.project.files[0], unchanged);
});

test("verifies existing dimensions and rejects mismatched format and size", async () => {
  const matching = file(0, { width: 12, height: 9 });
  const wrongSize = file(1, { width: 11, height: 9 });
  const wrongFormat = {
    ...file(2, { width: 12, height: 9 }),
    fileName: "wrong.png",
    sourcePath: "C:/images/wrong.png",
  };
  const jpegBytes = jpeg(12, 9);
  const result = await verifyAndEnrichProjectImages(
    project([matching, wrongSize, wrongFormat]),
    [
      { fileIndex: 0, originalPath: matching.sourcePath, source: { kind: "blob", blob: imageBlob(png(12, 9), "image/png") } },
      { fileIndex: 1, originalPath: wrongSize.sourcePath, source: { kind: "blob", blob: imageBlob(png(12, 9), "image/png") } },
      { fileIndex: 2, originalPath: wrongFormat.sourcePath, source: { kind: "blob", blob: imageBlob(jpegBytes, "image/jpeg") } },
    ],
  );
  assert.equal(result.complete, false);
  assert.ok(result.issues.some((item) => item.code === "IMAGE_DIMENSIONS_MISMATCH"));
  assert.ok(result.issues.some((item) => item.code === "IMAGE_FORMAT_MISMATCH"));
  assert.equal(result.issues.some((item) => item.fileIndex === 0), false);
});

test("full verification enriches missing dimensions and honors abort", async () => {
  const missing = file(0);
  const result = await verifyAndEnrichProjectImages(project([missing]), [
    { fileIndex: 0, originalPath: missing.sourcePath, source: { kind: "blob", blob: imageBlob(png(7, 5), "image/png") } },
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.project.files[0]?.width, 7);
  assert.equal(result.project.files[0]?.height, 5);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    verifyAndEnrichProjectImages(project([missing]), [], { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("streams an archive entry and retains only its dimensions", async () => {
  const output = new BlobWriter("application/zip");
  const writer = new ZipWriter(output, { useWebWorkers: false });
  const bytes = png(42, 24);
  await writer.add("images/archive.png", new Uint8ArrayReader(bytes), { level: 0 });
  await writer.close();
  const archive = await openValidatedZip(await output.getData());

  try {
    const sourceFile = file(0);
    const result = await enrichProjectImageDimensions(project([sourceFile]), [
      {
        fileIndex: 0,
        originalPath: sourceFile.sourcePath,
        source: {
          kind: "archive",
          archive,
          entryName: "images/archive.png",
          size: bytes.byteLength,
        },
      },
    ]);
    assert.equal(result.complete, true);
    assert.equal(result.project.files[0]?.width, 42);
    assert.equal(result.project.files[0]?.height, 24);
  } finally {
    await archive.close();
  }
});

test("returns structured issues for missing, duplicate, malformed, invalid, and oversized inputs", async () => {
  const files = Array.from({ length: 6 }, (_, index) => file(index));
  const malformedPng = png(10, 10).slice(0, 12);
  const zeroPng = png(0, 5);
  const hugePng = png(MAX_IMAGE_DIMENSION + 1, 1);
  const failedArchive = {
    async pipeTo() {
      throw new Error("archive closed");
    },
  } as unknown as OpenArchive;
  const unknown = new Uint8Array([1, 2, 3, 4, 5]);
  const sources: ResolvedProjectImage[] = [
    resolved(1, png(2, 2)),
    resolved(1, png(2, 2)),
    resolved(2, malformedPng),
    resolved(3, zeroPng),
    resolved(4, hugePng),
    {
      fileIndex: 5,
      originalPath: files[5]!.sourcePath,
      source: {
        kind: "archive",
        archive: failedArchive,
        entryName: "images/fail.png",
        size: 24,
      },
    },
  ];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: undefined,
  });
  try {
    // Use the unknown bytes for index 0 only after asserting missing separately.
    const result = await enrichProjectImageDimensions(project(files), sources);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.issues.map(({ fileIndex, code }) => ({ fileIndex, code })),
      [
        { fileIndex: 0, code: "IMAGE_SOURCE_MISSING" },
        { fileIndex: 1, code: "IMAGE_SOURCE_DUPLICATE" },
        { fileIndex: 2, code: "IMAGE_HEADER_INVALID" },
        { fileIndex: 3, code: "IMAGE_DIMENSIONS_INVALID" },
        { fileIndex: 4, code: "IMAGE_DIMENSIONS_TOO_LARGE" },
        { fileIndex: 5, code: "IMAGE_SOURCE_READ_FAILED" },
      ],
    );
    assert.equal(result.issues[3]?.detectedWidth, 0);
    assert.equal(result.issues[4]?.detectedWidth, MAX_IMAGE_DIMENSION + 1);

    const unsupported = await enrichProjectImageDimensions(
      project([file(0)]),
      [resolved(0, unknown)],
    );
    assert.equal(unsupported.issues[0]?.code, "IMAGE_FORMAT_UNSUPPORTED");
    assert.equal(unsupported.issues[0]?.format, "unknown");
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "createImageBitmap", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
  }
});

test("uses createImageBitmap only as an unknown-format fallback and closes it", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  let calls = 0;
  let closes = 0;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => {
      calls += 1;
      return {
        width: 17,
        height: 19,
        close() {
          closes += 1;
        },
      } as ImageBitmap;
    },
  });
  try {
    const result = await enrichProjectImageDimensions(
      project([file(0)]),
      [resolved(0, new Uint8Array([1, 2, 3, 4]))],
    );
    assert.equal(result.complete, true);
    assert.equal(result.project.files[0]?.width, 17);
    assert.equal(result.project.files[0]?.height, 19);
    assert.deepEqual(result.updatedFileIndexes, [0]);
    assert.equal(calls, 1);
    assert.equal(closes, 1);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "createImageBitmap", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
  }
});
