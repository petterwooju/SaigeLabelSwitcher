import type { ProjectFileIR, ProjectIR } from "../model/project.ts";
import type {
  BinarySource,
  ResolvedProjectImage,
} from "../output/containers.ts";

/** Bounded header capture prevents a malformed image from growing memory use. */
export const MAX_IMAGE_HEADER_BYTES = 1024 * 1024;
/** Practical per-axis limit used before an image reaches a decoder/writer. */
export const MAX_IMAGE_DIMENSION = 100_000;
/** Protects against huge canvases even when each axis is individually valid. */
export const MAX_IMAGE_PIXELS = 1_000_000_000;

export type ImageDimensionFormat =
  | "png"
  | "jpeg"
  | "bmp"
  | "gif"
  | "webp"
  | "browser"
  | "unknown";

export type ImageDimensionIssueCode =
  | "IMAGE_SOURCE_MISSING"
  | "IMAGE_SOURCE_DUPLICATE"
  | "IMAGE_SOURCE_READ_FAILED"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "IMAGE_HEADER_INVALID"
  | "IMAGE_DIMENSIONS_INVALID"
  | "IMAGE_DIMENSIONS_TOO_LARGE"
  | "IMAGE_DIMENSIONS_MISMATCH"
  | "IMAGE_FORMAT_MISMATCH"
  | "IMAGE_BITMAP_DECODE_FAILED";

export interface ImageDimensionIssue {
  readonly fileIndex: number;
  readonly path: string;
  readonly code: ImageDimensionIssueCode;
  readonly message: string;
  readonly format?: ImageDimensionFormat;
  readonly detectedWidth?: number;
  readonly detectedHeight?: number;
}

export interface ImageDimensionProgress {
  /** Completed probes, including failed probes. */
  readonly completed: number;
  /** Files that lacked a valid dimension pair when enrichment started. */
  readonly total: number;
  readonly fileIndex: number;
  readonly path: string;
  readonly status: "enriched" | "verified" | "failed";
  readonly width?: number;
  readonly height?: number;
  readonly format?: ImageDimensionFormat;
  readonly issueCode?: ImageDimensionIssueCode;
}

export interface ImageDimensionEnrichmentResult {
  /** A new top-level IR. Input objects are never mutated. */
  readonly project: ProjectIR;
  readonly issues: readonly ImageDimensionIssue[];
  readonly updatedFileIndexes: readonly number[];
  /** True only when every output file has a valid, bounded dimension pair. */
  readonly complete: boolean;
}

type ProgressHandler = (progress: ImageDimensionProgress) => void;

export interface ImageVerificationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressHandler;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
  readonly format: ImageDimensionFormat;
}

interface HeaderDimensions extends Dimensions {
  readonly kind: "dimensions";
}

interface InvalidHeader {
  readonly kind: "invalid";
  readonly format: Exclude<ImageDimensionFormat, "browser" | "unknown">;
  readonly message: string;
}

interface UnknownHeader {
  readonly kind: "unknown";
}

type HeaderProbe = HeaderDimensions | InvalidHeader | UnknownHeader;

/**
 * Fill missing/invalid file dimensions from resolved image sources.
 *
 * Existing valid pairs are not read or decoded. If either axis is invalid,
 * both axes are replaced with the authoritative image dimensions. Processing
 * is sequential so progress order and peak memory use remain deterministic.
 */
export async function enrichProjectImageDimensions(
  project: ProjectIR,
  resolvedImages: readonly ResolvedProjectImage[],
  onProgress?: ProgressHandler,
): Promise<ImageDimensionEnrichmentResult> {
  const targets = project.files.filter(
    (file) => !isValidDimensionPair(file.width, file.height),
  );
  const targetIndexes = new Set(targets.map((file) => file.index));
  const sources = indexResolvedSources(resolvedImages, targetIndexes);
  const issues: ImageDimensionIssue[] = [];
  const updated = new Map<number, ProjectFileIR>();
  const updatedFileIndexes: number[] = [];
  let completed = 0;

  for (const file of targets) {
    const path = file.sourcePath;
    const resolved = sources.get(file.index);
    let issue: ImageDimensionIssue | undefined;
    let dimensions: Dimensions | undefined;

    if (resolved === "duplicate") {
      issue = createIssue(
        file,
        "IMAGE_SOURCE_DUPLICATE",
        "More than one resolved image source uses this file index.",
      );
    } else if (!resolved) {
      issue = createIssue(
        file,
        "IMAGE_SOURCE_MISSING",
        "No resolved image source is available for dimension detection.",
      );
    } else {
      const probe = await probeSourceDimensions(file, resolved.source);
      if ("issue" in probe) issue = probe.issue;
      else dimensions = probe.dimensions;
    }

    if (dimensions) {
      const dimensionIssue = validateDetectedDimensions(file, dimensions);
      if (dimensionIssue) {
        issue = dimensionIssue;
      } else {
        updated.set(file.index, {
          ...file,
          width: dimensions.width,
          height: dimensions.height,
        });
        updatedFileIndexes.push(file.index);
      }
    }

    completed += 1;
    if (issue) {
      issues.push(issue);
      onProgress?.({
        completed,
        total: targets.length,
        fileIndex: file.index,
        path,
        status: "failed",
        ...(issue.format ? { format: issue.format } : {}),
        issueCode: issue.code,
      });
    } else if (dimensions) {
      onProgress?.({
        completed,
        total: targets.length,
        fileIndex: file.index,
        path,
        status: "enriched",
        width: dimensions.width,
        height: dimensions.height,
        format: dimensions.format,
      });
    }
  }

  const files = project.files.map((file) => updated.get(file.index) ?? file);
  const enrichedProject: ProjectIR = { ...project, files };
  return {
    project: enrichedProject,
    issues,
    updatedFileIndexes,
    complete: files.every((file) => isValidDimensionPair(file.width, file.height)),
  };
}

/**
 * Verify every resolved image that will be packaged, not only files with
 * missing dimensions. Existing dimensions must match the detected header;
 * missing dimensions are enriched immutably.
 */
export async function verifyAndEnrichProjectImages(
  project: ProjectIR,
  resolvedImages: readonly ResolvedProjectImage[],
  options: ImageVerificationOptions = {},
): Promise<ImageDimensionEnrichmentResult> {
  const targets = [...project.files].sort((left, right) => left.index - right.index);
  const targetIndexes = new Set(targets.map((file) => file.index));
  const sources = indexResolvedSources(resolvedImages, targetIndexes);
  const issues: ImageDimensionIssue[] = [];
  const updated = new Map<number, ProjectFileIR>();
  const updatedFileIndexes: number[] = [];
  let completed = 0;

  for (const file of targets) {
    throwIfAborted(options.signal);
    const resolved = sources.get(file.index);
    let issue: ImageDimensionIssue | undefined;
    let detected: Dimensions | undefined;

    if (resolved === "duplicate") {
      issue = createIssue(
        file,
        "IMAGE_SOURCE_DUPLICATE",
        "More than one resolved image source uses this file index.",
      );
    } else if (!resolved) {
      issue = createIssue(
        file,
        "IMAGE_SOURCE_MISSING",
        "No resolved image source is available for verification.",
      );
    } else {
      const probe = await probeSourceDimensions(file, resolved.source, options.signal);
      if ("issue" in probe) issue = probe.issue;
      else detected = probe.dimensions;
      if (detected) {
        issue =
          validateDetectedDimensions(file, detected) ??
          validateDetectedFormat(file, resolved.source, detected) ??
          validateDeclaredDimensions(file, detected);
      }
    }

    if (detected && !issue && !isValidDimensionPair(file.width, file.height)) {
      updated.set(file.index, {
        ...file,
        width: detected.width,
        height: detected.height,
      });
      updatedFileIndexes.push(file.index);
    }

    completed += 1;
    if (issue) {
      issues.push(issue);
      options.onProgress?.({
        completed,
        total: targets.length,
        fileIndex: file.index,
        path: file.sourcePath,
        status: "failed",
        ...(issue.format ? { format: issue.format } : {}),
        issueCode: issue.code,
      });
    } else if (detected) {
      options.onProgress?.({
        completed,
        total: targets.length,
        fileIndex: file.index,
        path: file.sourcePath,
        status: isValidDimensionPair(file.width, file.height) ? "verified" : "enriched",
        width: detected.width,
        height: detected.height,
        format: detected.format,
      });
    }
  }

  const files = project.files.map((file) => updated.get(file.index) ?? file);
  return {
    project: { ...project, files },
    issues,
    updatedFileIndexes,
    complete:
      issues.length === 0 &&
      files.every((file) => isValidDimensionPair(file.width, file.height)),
  };
}

function indexResolvedSources(
  images: readonly ResolvedProjectImage[],
  targetIndexes: ReadonlySet<number>,
): ReadonlyMap<number, ResolvedProjectImage | "duplicate"> {
  const result = new Map<number, ResolvedProjectImage | "duplicate">();
  for (const image of images) {
    if (!targetIndexes.has(image.fileIndex)) continue;
    result.set(
      image.fileIndex,
      result.has(image.fileIndex) ? "duplicate" : image,
    );
  }
  return result;
}

async function probeSourceDimensions(
  file: ProjectFileIR,
  source: BinarySource,
  signal?: AbortSignal,
): Promise<
  | { readonly dimensions: Dimensions }
  | { readonly issue: ImageDimensionIssue }
> {
  let header: Uint8Array;
  try {
    header = await readHeaderBytes(source, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      issue: createIssue(
        file,
        "IMAGE_SOURCE_READ_FAILED",
        `Unable to read the image source: ${errorMessage(error)}`,
      ),
    };
  }

  const parsed = parseImageHeader(header);
  if (parsed.kind === "dimensions") return { dimensions: parsed };
  if (parsed.kind === "invalid") {
    return {
      issue: createIssue(
        file,
        "IMAGE_HEADER_INVALID",
        parsed.message,
        parsed.format,
      ),
    };
  }

  if (typeof globalThis.createImageBitmap !== "function") {
    return {
      issue: createIssue(
        file,
        "IMAGE_FORMAT_UNSUPPORTED",
        "The image is not PNG, JPEG, BMP, GIF, or WebP, and this environment has no bitmap decoder fallback.",
        "unknown",
      ),
    };
  }

  let blob: Blob;
  try {
    blob =
      source.kind === "blob"
        ? source.blob
        : await source.archive.readBlob(
            source.entryName,
            "application/octet-stream",
            undefined,
            signal,
          );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      issue: createIssue(
        file,
        "IMAGE_SOURCE_READ_FAILED",
        `Unable to read the image for bitmap decoding: ${errorMessage(error)}`,
        "unknown",
      ),
    };
  }

  try {
    const bitmap = await globalThis.createImageBitmap(blob);
    try {
      return {
        dimensions: {
          width: bitmap.width,
          height: bitmap.height,
          format: "browser",
        },
      };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    return {
      issue: createIssue(
        file,
        "IMAGE_BITMAP_DECODE_FAILED",
        `The browser could not decode this image: ${errorMessage(error)}`,
        "unknown",
      ),
    };
  }
}

async function readHeaderBytes(
  source: BinarySource,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (source.kind === "blob") {
    return new Uint8Array(
      await source.blob.slice(0, MAX_IMAGE_HEADER_BYTES).arrayBuffer(),
    );
  }

  return source.archive.readPrefix(source.entryName, MAX_IMAGE_HEADER_BYTES, signal);
}

function parseImageHeader(bytes: Uint8Array): HeaderProbe {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return parsePng(bytes);
  }
  if (hasBytes(bytes, [0xff, 0xd8])) return parseJpeg(bytes);
  if (hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")) {
    return parseGif(bytes);
  }
  if (hasAscii(bytes, 0, "BM")) return parseBmp(bytes);
  if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) {
    return parseWebp(bytes);
  }
  return { kind: "unknown" };
}

function parsePng(bytes: Uint8Array): HeaderProbe {
  if (
    bytes.length < 24 ||
    readUint32BE(bytes, 8) !== 13 ||
    !hasAscii(bytes, 12, "IHDR")
  ) {
    return invalidHeader("png", "PNG is missing a complete, canonical IHDR header.");
  }
  return dimensions("png", readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

function parseGif(bytes: Uint8Array): HeaderProbe {
  if (bytes.length < 10) {
    return invalidHeader("gif", "GIF logical-screen dimensions are truncated.");
  }
  return dimensions("gif", readUint16LE(bytes, 6), readUint16LE(bytes, 8));
}

function parseBmp(bytes: Uint8Array): HeaderProbe {
  if (bytes.length < 22) {
    return invalidHeader("bmp", "BMP DIB header is truncated.");
  }
  const dibSize = readUint32LE(bytes, 14);
  if (dibSize === 12) {
    return dimensions("bmp", readUint16LE(bytes, 18), readUint16LE(bytes, 20));
  }
  if (dibSize < 40 || bytes.length < 26) {
    return invalidHeader("bmp", `Unsupported or truncated BMP DIB header (${dibSize} bytes).`);
  }
  const width = readInt32LE(bytes, 18);
  const signedHeight = readInt32LE(bytes, 22);
  if (signedHeight === -0x80000000) {
    return invalidHeader("bmp", "BMP height cannot be represented safely.");
  }
  return dimensions("bmp", width, Math.abs(signedHeight));
}

function parseJpeg(bytes: Uint8Array): HeaderProbe {
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00) continue;
    if (marker === 0xd9 || marker === 0xda) {
      return invalidHeader("jpeg", "JPEG reached image data before a valid SOF dimension segment.");
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      return invalidHeader("jpeg", "JPEG segment length is truncated.");
    }
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2) {
      return invalidHeader("jpeg", "JPEG contains an invalid segment length.");
    }
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) {
        return invalidHeader("jpeg", "JPEG SOF dimension segment is truncated.");
      }
      return dimensions(
        "jpeg",
        readUint16BE(bytes, offset + 5),
        readUint16BE(bytes, offset + 3),
      );
    }
    const next = offset + segmentLength;
    if (next > bytes.length) {
      return invalidHeader(
        "jpeg",
        `JPEG dimensions were not found within the ${MAX_IMAGE_HEADER_BYTES}-byte header probe.`,
      );
    }
    offset = next;
  }
  return invalidHeader("jpeg", "JPEG does not contain a supported SOF dimension segment.");
}

function parseWebp(bytes: Uint8Array): HeaderProbe {
  if (bytes.length < 20) {
    return invalidHeader("webp", "WebP chunk header is truncated.");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = readUint32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (chunkType === "VP8X") {
      if (chunkSize < 10 || dataOffset + 10 > bytes.length) {
        return invalidHeader("webp", "WebP VP8X dimensions are truncated.");
      }
      return dimensions(
        "webp",
        readUint24LE(bytes, dataOffset + 4) + 1,
        readUint24LE(bytes, dataOffset + 7) + 1,
      );
    }
    if (chunkType === "VP8L") {
      if (chunkSize < 5 || dataOffset + 5 > bytes.length || bytes[dataOffset] !== 0x2f) {
        return invalidHeader("webp", "WebP VP8L dimensions are invalid or truncated.");
      }
      const b1 = bytes[dataOffset + 1];
      const b2 = bytes[dataOffset + 2];
      const b3 = bytes[dataOffset + 3];
      const b4 = bytes[dataOffset + 4];
      return dimensions(
        "webp",
        1 + b1 + ((b2 & 0x3f) << 8),
        1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      );
    }
    if (chunkType === "VP8 ") {
      if (
        chunkSize < 10 ||
        dataOffset + 10 > bytes.length ||
        !hasBytes(bytes, [0x9d, 0x01, 0x2a], dataOffset + 3)
      ) {
        return invalidHeader("webp", "WebP VP8 frame header is invalid or truncated.");
      }
      return dimensions(
        "webp",
        readUint16LE(bytes, dataOffset + 6) & 0x3fff,
        readUint16LE(bytes, dataOffset + 8) & 0x3fff,
      );
    }
    const paddedSize = chunkSize + (chunkSize & 1);
    const next = dataOffset + paddedSize;
    if (!Number.isSafeInteger(next) || next > bytes.length) {
      return invalidHeader(
        "webp",
        `WebP dimensions were not found within the ${MAX_IMAGE_HEADER_BYTES}-byte header probe.`,
      );
    }
    offset = next;
  }
  return invalidHeader("webp", "WebP does not contain a supported image dimension chunk.");
}

function validateDetectedDimensions(
  file: ProjectFileIR,
  detected: Dimensions,
): ImageDimensionIssue | undefined {
  const { width, height, format } = detected;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return createIssue(
      file,
      "IMAGE_DIMENSIONS_INVALID",
      `Detected image dimensions must be positive integers; received ${width} × ${height}.`,
      format,
      width,
      height,
    );
  }
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    return createIssue(
      file,
      "IMAGE_DIMENSIONS_TOO_LARGE",
      `Detected image dimensions ${width} × ${height} exceed the supported limit.`,
      format,
      width,
      height,
    );
  }
  return undefined;
}

function validateDeclaredDimensions(
  file: ProjectFileIR,
  detected: Dimensions,
): ImageDimensionIssue | undefined {
  if (
    isValidDimensionPair(file.width, file.height) &&
    (file.width !== detected.width || file.height !== detected.height)
  ) {
    return createIssue(
      file,
      "IMAGE_DIMENSIONS_MISMATCH",
      `Project dimensions ${file.width} × ${file.height} do not match the image header ${detected.width} × ${detected.height}.`,
      detected.format,
      detected.width,
      detected.height,
    );
  }
  return undefined;
}

function validateDetectedFormat(
  file: ProjectFileIR,
  source: BinarySource,
  detected: Dimensions,
): ImageDimensionIssue | undefined {
  if (detected.format === "browser") return undefined;
  const extensionFormat = formatFromExtension(file.fileName || file.sourcePath);
  let mimeFormat: ImageDimensionFormat | undefined;
  if (source.kind === "blob") {
    mimeFormat = formatFromMime(source.blob.type);
  }
  if (
    (extensionFormat !== undefined && extensionFormat !== detected.format) ||
    (mimeFormat !== undefined && mimeFormat !== detected.format)
  ) {
    return createIssue(
      file,
      "IMAGE_FORMAT_MISMATCH",
      `Image header format '${detected.format}' does not match the selected file name or MIME type.`,
      detected.format,
      detected.width,
      detected.height,
    );
  }
  return undefined;
}

function formatFromExtension(value: string): ImageDimensionFormat | undefined {
  const extension = /\.([^.\\/]+)$/u.exec(value)?.[1]?.toLocaleLowerCase("en-US");
  switch (extension) {
    case "png": return "png";
    case "jpg":
    case "jpeg": return "jpeg";
    case "bmp": return "bmp";
    case "gif": return "gif";
    case "webp": return "webp";
    default: return undefined;
  }
}

function formatFromMime(value: string): ImageDimensionFormat | undefined {
  switch (value.trim().toLocaleLowerCase("en-US")) {
    case "image/png": return "png";
    case "image/jpeg": return "jpeg";
    case "image/bmp": return "bmp";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return undefined;
  }
}

function isValidDimensionPair(
  width: number | undefined,
  height: number | undefined,
): boolean {
  return (
    width !== undefined &&
    height !== undefined &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function createIssue(
  file: ProjectFileIR,
  code: ImageDimensionIssueCode,
  message: string,
  format?: ImageDimensionFormat,
  detectedWidth?: number,
  detectedHeight?: number,
): ImageDimensionIssue {
  return {
    fileIndex: file.index,
    path: file.sourcePath,
    code,
    message,
    ...(format ? { format } : {}),
    ...(detectedWidth !== undefined ? { detectedWidth } : {}),
    ...(detectedHeight !== undefined ? { detectedHeight } : {}),
  };
}

function dimensions(
  format: Exclude<ImageDimensionFormat, "browser" | "unknown">,
  width: number,
  height: number,
): HeaderDimensions {
  return { kind: "dimensions", format, width, height };
}

function invalidHeader(
  format: InvalidHeader["format"],
  message: string,
): InvalidHeader {
  return { kind: "invalid", format, message };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function hasBytes(
  bytes: Uint8Array,
  expected: readonly number[],
  offset = 0,
): boolean {
  return (
    bytes.length >= offset + expected.length &&
    expected.every((value, index) => bytes[offset + index] === value)
  );
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  return ascii(bytes, offset, value.length) === value;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || bytes.length < offset + length) return "";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint16(offset, false);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint16(offset, true);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint32(offset, false);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getUint32(offset, true);
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return dataView(bytes).getInt32(offset, true);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}
