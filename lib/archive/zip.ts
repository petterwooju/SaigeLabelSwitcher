import {
  BlobReader,
  BlobWriter,
  TextWriter,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js";

export interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  maxTextBytes: number;
}

export interface ArchiveEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  zip64: boolean;
}

export interface OpenArchive {
  readonly entries: readonly ArchiveEntryInfo[];
  readonly totalUncompressedBytes: number;
  has(name: string): boolean;
  names(): string[];
  readText(name: string, maxBytes?: number): Promise<string>;
  readBlob(name: string, mimeType?: string): Promise<Blob>;
  pipeTo(
    name: string,
    writable: WritableStream<Uint8Array>,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
  maxEntries: 100_000,
  maxEntryBytes: 16 * 1024 ** 3,
  maxTotalBytes: 128 * 1024 ** 3,
  maxCompressionRatio: 1_000,
  maxTextBytes: 128 * 1024 ** 2,
};

export class ArchiveValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArchiveValidationError";
    this.code = code;
  }
}

export async function openValidatedZip(
  source: Blob,
  limits: Partial<ArchiveLimits> = {},
): Promise<OpenArchive> {
  if (source.size < 4) {
    throw new ArchiveValidationError("ZIP_TOO_SMALL", "ZIP 文件为空或不完整。");
  }

  const resolvedLimits: ArchiveLimits = {
    ...DEFAULT_ARCHIVE_LIMITS,
    ...limits,
  };
  const reader = new ZipReader(new BlobReader(source), {
    checkSignature: true,
    useWebWorkers: false,
  });

  try {
    const rawEntries = await reader.getEntries();
    if (rawEntries.length > resolvedLimits.maxEntries) {
      throw new ArchiveValidationError(
        "ZIP_TOO_MANY_ENTRIES",
        `ZIP 条目数超过安全上限（${resolvedLimits.maxEntries.toLocaleString()}）。`,
      );
    }

    const files = new Map<string, FileEntry>();
    const canonicalNames = new Map<string, string>();
    const infos: ArchiveEntryInfo[] = [];
    let totalUncompressedBytes = 0;

    for (const entry of rawEntries) {
      const name = normalizeArchiveEntryName(entry.filename);
      assertSafeArchiveEntryName(name);

      const canonical = canonicalArchiveName(name);
      const existing = canonicalNames.get(canonical);
      if (existing) {
        throw new ArchiveValidationError(
          "ZIP_DUPLICATE_ENTRY",
          `ZIP 中存在大小写或 Unicode 等价的重复路径：${redactPath(existing)} / ${redactPath(name)}`,
        );
      }
      canonicalNames.set(canonical, name);

      if (entry.encrypted) {
        throw new ArchiveValidationError(
          "ZIP_ENCRYPTED_ENTRY",
          `不支持加密条目：${redactPath(name)}`,
        );
      }
      if (isSymbolicLink(entry.unixMode)) {
        throw new ArchiveValidationError(
          "ZIP_SYMBOLIC_LINK",
          `不允许符号链接条目：${redactPath(name)}`,
        );
      }

      if (entry.directory) continue;

      if (entry.uncompressedSize > resolvedLimits.maxEntryBytes) {
        throw new ArchiveValidationError(
          "ZIP_ENTRY_TOO_LARGE",
          `ZIP 条目超过单文件安全上限：${redactPath(name)}`,
        );
      }
      totalUncompressedBytes = safeAdd(
        totalUncompressedBytes,
        entry.uncompressedSize,
        resolvedLimits.maxTotalBytes,
      );

      const ratio =
        entry.uncompressedSize === 0
          ? 1
          : entry.compressedSize === 0
            ? Number.POSITIVE_INFINITY
            : entry.uncompressedSize / entry.compressedSize;
      if (ratio > resolvedLimits.maxCompressionRatio) {
        throw new ArchiveValidationError(
          "ZIP_SUSPICIOUS_RATIO",
          `ZIP 条目压缩比异常：${redactPath(name)}`,
        );
      }

      files.set(canonical, entry);
      infos.push({
        name,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        zip64: entry.zip64,
      });
    }

    const getFile = (name: string): FileEntry => {
      const safeName = normalizeArchiveEntryName(name);
      assertSafeArchiveEntryName(safeName);
      const entry = files.get(canonicalArchiveName(safeName));
      if (!entry) {
        throw new ArchiveValidationError(
          "ZIP_ENTRY_NOT_FOUND",
          `ZIP 中未找到所需文件：${redactPath(safeName)}`,
        );
      }
      return entry;
    };

    let closed = false;
    const ensureOpen = () => {
      if (closed) {
        throw new ArchiveValidationError("ZIP_CLOSED", "ZIP 已关闭，无法继续读取。");
      }
    };

    return {
      entries: infos,
      totalUncompressedBytes,
      has(name) {
        if (closed) return false;
        try {
          const safeName = normalizeArchiveEntryName(name);
          assertSafeArchiveEntryName(safeName);
          return files.has(canonicalArchiveName(safeName));
        } catch {
          return false;
        }
      },
      names() {
        ensureOpen();
        return infos.map((entry) => entry.name);
      },
      async readText(name, maxBytes = resolvedLimits.maxTextBytes) {
        ensureOpen();
        const entry = getFile(name);
        if (entry.uncompressedSize > maxBytes) {
          throw new ArchiveValidationError(
            "ZIP_TEXT_TOO_LARGE",
            `文本条目超过读取上限：${redactPath(name)}`,
          );
        }
        return entry.getData(new TextWriter(), {
          checkSignature: true,
          useWebWorkers: false,
        });
      },
      async readBlob(name, mimeType = "application/octet-stream") {
        ensureOpen();
        return getFile(name).getData(new BlobWriter(mimeType), {
          checkSignature: true,
          useWebWorkers: false,
        });
      },
      async pipeTo(name, writable, onProgress) {
        ensureOpen();
        const entry = getFile(name);
        await entry.getData(writable, {
          checkSignature: true,
          useWebWorkers: false,
          onprogress: (loaded, total) => onProgress?.(loaded, total),
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        await reader.close();
      },
    };
  } catch (error) {
    await reader.close().catch(() => undefined);
    if (error instanceof ArchiveValidationError) throw error;
    throw new ArchiveValidationError(
      "ZIP_INVALID",
      error instanceof Error
        ? `无法安全读取 ZIP：${error.message}`
        : "无法安全读取 ZIP。",
    );
  }
}

export function normalizeArchiveEntryName(value: string): string {
  return value.normalize("NFC").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function assertSafeArchiveEntryName(value: string): void {
  if (!value || value.includes("\0")) {
    throw new ArchiveValidationError("ZIP_EMPTY_ENTRY", "ZIP 中存在空路径条目。");
  }
  if (/^(?:[a-zA-Z]:|\/)/.test(value)) {
    throw new ArchiveValidationError(
      "ZIP_ABSOLUTE_ENTRY",
      `ZIP 中存在绝对路径：${redactPath(value)}`,
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArchiveValidationError(
      "ZIP_PATH_TRAVERSAL",
      `ZIP 中存在不安全路径：${redactPath(value)}`,
    );
  }
}

export function canonicalArchiveName(value: string): string {
  return normalizeArchiveEntryName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

export function redactPath(value: string): string {
  const parts = normalizeArchiveEntryName(value).split("/").filter(Boolean);
  return parts.length <= 3 ? parts.join("/") : `…/${parts.slice(-3).join("/")}`;
}

function isSymbolicLink(unixMode: number | undefined): boolean {
  if (typeof unixMode !== "number") return false;
  return (unixMode & 0xf000) === 0xa000;
}

function safeAdd(current: number, next: number, maximum: number): number {
  const total = current + next;
  if (!Number.isSafeInteger(total) || total > maximum) {
    throw new ArchiveValidationError(
      "ZIP_TOTAL_TOO_LARGE",
      `ZIP 解压后总大小超过安全上限（${formatBytes(maximum)}）。`,
    );
  }
  return total;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.max(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), 0),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
