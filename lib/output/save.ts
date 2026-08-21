import { BlobWriter, ZipWriter } from "@zip.js/zip.js";

export type SaveMode = "direct" | "download";

export interface SaveFileType {
  description: string;
  mimeType: string;
  extensions: string[];
}

export interface SaveDestination {
  readonly fileName: string;
  readonly handle?: FileSystemSaveHandle;
}

export interface SaveResult {
  readonly fileName: string;
  readonly size: number;
  readonly mode: SaveMode;
}

export interface FileSystemSaveHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

export interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemSaveHandle>;
}

export class SaveCancelledError extends Error {
  constructor() {
    super("Save cancelled by the user.");
    this.name = "SaveCancelledError";
  }
}

export class BrowserCapabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserCapabilityError";
    this.code = code;
  }
}

export const MAX_BLOB_FALLBACK_BYTES = 500 * 1024 ** 2;
const ZIP_BASE_OVERHEAD_BYTES = 64 * 1024;
const ZIP_ENTRY_OVERHEAD_BYTES = 512;

export interface SaveDestinationOptions {
  /**
   * Skip the system picker and finish with the browser download path. This is
   * useful when asynchronous preparation could fail after Chromium has already
   * created an empty placeholder at the selected destination.
   */
  readonly preferDownload?: boolean;
}

/**
 * Call this synchronously from the user's click handler. Chromium requires the
 * save picker to open while transient user activation is still alive.
 */
export async function requestSaveDestination(
  fileName: string,
  type: SaveFileType,
  options: SaveDestinationOptions = {},
): Promise<SaveDestination> {
  if (options.preferDownload) return { fileName };
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return { fileName };

  try {
    const handle = await picker({
      suggestedName: fileName,
      types: [
        {
          description: type.description,
          accept: { [type.mimeType]: type.extensions },
        },
      ],
    });
    return { fileName, handle };
  } catch (error) {
    if (isAbortError(error)) throw new SaveCancelledError();
    if (isPickerCapabilityError(error)) return { fileName };
    throw error;
  }
}

export async function saveBlob(
  destination: SaveDestination,
  blob: Blob,
  signal?: AbortSignal,
): Promise<SaveResult> {
  throwIfAborted(signal);
  assertNonEmptyOutput(blob.size);
  if (destination.handle) {
    const writable = await destination.handle.createWritable();
    try {
      await blob.stream().pipeTo(writable, { signal });
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      throw error;
    }
    return {
      fileName: destination.fileName,
      size: blob.size,
      mode: "direct",
    };
  }

  ensureBlobFallbackIsSafe(blob.size);
  triggerBlobDownload(blob, destination.fileName);
  return {
    fileName: destination.fileName,
    size: blob.size,
    mode: "download",
  };
}

export async function saveText(
  destination: SaveDestination,
  text: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<SaveResult> {
  return saveBlob(destination, new Blob([text], { type: mimeType }), signal);
}

export interface ZipDestination {
  readonly writer: ZipWriter<unknown>;
  finalize(): Promise<SaveResult>;
  abort(reason?: unknown): Promise<void>;
}

export async function createZipDestination(
  destination: SaveDestination,
  estimatedBytes: number,
  estimatedEntries = 1,
  signal?: AbortSignal,
): Promise<ZipDestination> {
  throwIfAborted(signal);
  const zip64 = requiresZip64(estimatedBytes, estimatedEntries);
  if (destination.handle) {
    const writable = await destination.handle.createWritable();
    const sinkWriter = writable.getWriter();
    let writtenBytes = 0;
    const countingSink = new WritableStream<Uint8Array>({
      async write(chunk) {
        writtenBytes += chunk.byteLength;
        await sinkWriter.write(chunk);
      },
      async close() {
        await sinkWriter.close();
      },
      async abort(reason) {
        await sinkWriter.abort(reason);
      },
    });
    const writer = new ZipWriter(countingSink, {
      zip64,
      useWebWorkers: false,
    });
    let finalized = false;
    return {
      writer,
      async finalize() {
        throwIfAborted(signal);
        if (!finalized) {
          await writer.close();
          finalized = true;
        }
        assertNonEmptyOutput(writtenBytes);
        return {
          fileName: destination.fileName,
          size: writtenBytes,
          mode: "direct",
        };
      },
      async abort(reason) {
        if (finalized) return;
        finalized = true;
        await sinkWriter.abort(reason).catch(() => undefined);
      },
    };
  }

  ensureBlobFallbackIsSafe(estimatedBytes);
  const blobWriter = new BlobWriter("application/zip");
  const writer = new ZipWriter(blobWriter, {
    zip64,
    useWebWorkers: false,
  });
  let finalized = false;
  return {
    writer,
    async finalize() {
      throwIfAborted(signal);
      if (finalized) {
        throw new Error("ZIP output has already been finalized.");
      }
      await writer.close();
      finalized = true;
      const blob = await blobWriter.getData();
      assertNonEmptyOutput(blob.size);
      triggerBlobDownload(blob, destination.fileName);
      return {
        fileName: destination.fileName,
        size: blob.size,
        mode: "download",
      };
    },
    async abort() {
      finalized = true;
    },
  };
}

export function requiresZip64(estimatedBytes: number, estimatedEntries: number): boolean {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
    throw new RangeError("Estimated ZIP byte count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(estimatedEntries) || estimatedEntries < 0) {
    throw new RangeError("Estimated ZIP entry count must be a non-negative safe integer.");
  }
  return estimatedBytes >= 0xffffffff || estimatedEntries >= 0xffff;
}

/**
 * Conservative upper-bound estimate for a stored ZIP. It includes local and
 * central-directory records, data descriptors, ZIP64 slack, entry names and a
 * fixed end-record margin. This estimate is used for memory and ZIP64 routing;
 * the actual result size is still measured while writing.
 */
export function estimateZipOutputBytes(
  uncompressedBytes: number,
  entryCount: number,
  totalEntryNameBytes = 0,
): number {
  for (const [label, value] of [
    ["uncompressed byte count", uncompressedBytes],
    ["entry count", entryCount],
    ["entry-name byte count", totalEntryNameBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`ZIP ${label} must be a non-negative safe integer.`);
    }
  }
  const estimate =
    uncompressedBytes +
    entryCount * ZIP_ENTRY_OVERHEAD_BYTES +
    totalEntryNameBytes * 2 +
    ZIP_BASE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(estimate) || estimate < uncompressedBytes) {
    throw new RangeError("Estimated ZIP output size exceeds the safe integer range.");
  }
  return estimate;
}

export function ensureBlobFallbackIsSafe(bytes: number): void {
  if (!isBlobFallbackSafe(bytes)) {
    throw new BrowserCapabilityError(
      "BLOB_FALLBACK_TOO_LARGE",
      "项目过大，当前浏览器无法安全地在内存中完成下载。请使用最新版桌面 Edge 或 Chrome。",
    );
  }
}

export function isBlobFallbackSafe(bytes: number): boolean {
  return (
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    bytes <= MAX_BLOB_FALLBACK_BYTES
  );
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function assertNonEmptyOutput(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new BrowserCapabilityError(
      "EMPTY_SAVE_RESULT",
      "生成的项目文件为空，已停止保存。",
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : Boolean(
          error &&
            typeof error === "object" &&
            "name" in error &&
            (error as { name?: unknown }).name === "AbortError",
        )
  );
}

function isPickerCapabilityError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === "SecurityError" || name === "NotAllowedError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
