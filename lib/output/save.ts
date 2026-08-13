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

const MAX_BLOB_FALLBACK_BYTES = 500 * 1024 ** 2;

/**
 * Call this synchronously from the user's click handler. Chromium requires the
 * save picker to open while transient user activation is still alive.
 */
export async function requestSaveDestination(
  fileName: string,
  type: SaveFileType,
): Promise<SaveDestination> {
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
    throw error;
  }
}

export async function saveBlob(
  destination: SaveDestination,
  blob: Blob,
): Promise<SaveResult> {
  if (destination.handle) {
    const writable = await destination.handle.createWritable();
    const writer = writable.getWriter();
    try {
      await writer.write(new Uint8Array(await blob.arrayBuffer()));
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
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
): Promise<SaveResult> {
  return saveBlob(destination, new Blob([text], { type: mimeType }));
}

export interface ZipDestination {
  readonly writer: ZipWriter<unknown>;
  finalize(): Promise<SaveResult>;
  abort(reason?: unknown): Promise<void>;
}

export async function createZipDestination(
  destination: SaveDestination,
  estimatedBytes: number,
): Promise<ZipDestination> {
  if (destination.handle) {
    const writable = await destination.handle.createWritable();
    const writer = new ZipWriter(writable, {
      zip64: estimatedBytes >= 0xffffffff,
      useWebWorkers: false,
    });
    let finalized = false;
    return {
      writer,
      async finalize() {
        if (!finalized) {
          await writer.close();
          finalized = true;
        }
        return {
          fileName: destination.fileName,
          size: estimatedBytes,
          mode: "direct",
        };
      },
      async abort(reason) {
        if (finalized) return;
        finalized = true;
        await writable.abort(reason).catch(() => undefined);
      },
    };
  }

  ensureBlobFallbackIsSafe(estimatedBytes);
  const blobWriter = new BlobWriter("application/zip");
  const writer = new ZipWriter(blobWriter, {
    zip64: estimatedBytes >= 0xffffffff,
    useWebWorkers: false,
  });
  let finalized = false;
  return {
    writer,
    async finalize() {
      if (finalized) {
        throw new Error("ZIP output has already been finalized.");
      }
      await writer.close();
      finalized = true;
      const blob = await blobWriter.getData();
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

export function ensureBlobFallbackIsSafe(bytes: number): void {
  if (bytes > MAX_BLOB_FALLBACK_BYTES) {
    throw new BrowserCapabilityError(
      "BLOB_FALLBACK_TOO_LARGE",
      "项目过大，当前浏览器无法安全地在内存中完成下载。请使用最新版桌面 Edge 或 Chrome。",
    );
  }
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
