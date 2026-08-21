import { PROJECT_FILE_MAX_COUNT } from "../security/resourceLimits.ts";

export const DEFAULT_SOURCE_SELECTION_MAX_FILES = PROJECT_FILE_MAX_COUNT;
export const DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES = 32 * 1024 ** 3;
export const DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES = 32;

export interface SourceSelectionUsage {
  readonly sourceCount: number;
  readonly totalBytes: number;
  readonly openArchiveCount: number;
}

export interface SourceSelectionLimits {
  readonly maxSourceCount?: number;
  readonly maxTotalBytes?: number;
  readonly maxOpenArchives?: number;
}

export const DEFAULT_SOURCE_SELECTION_LIMITS = Object.freeze({
  maxSourceCount: DEFAULT_SOURCE_SELECTION_MAX_FILES,
  maxTotalBytes: DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES,
  maxOpenArchives: DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES,
});

export const EMPTY_SOURCE_SELECTION_USAGE = Object.freeze({
  sourceCount: 0,
  totalBytes: 0,
  openArchiveCount: 0,
});

export type SourceSelectionLimitCode =
  | "IMAGE_SOURCE_FILE_LIMIT"
  | "IMAGE_SOURCE_SIZE_LIMIT"
  | "IMAGE_SOURCE_ARCHIVE_LIMIT"
  | "IMAGE_SOURCE_USAGE_INVALID";

export class SourceSelectionLimitError extends Error {
  readonly code: SourceSelectionLimitCode;

  constructor(code: SourceSelectionLimitCode, message: string) {
    super(message);
    this.name = "SourceSelectionLimitError";
    this.code = code;
  }
}

/** Measure one picker/archive selection without retaining the input iterable. */
export function measureSourceSelectionUsage(
  byteSizes: Iterable<number>,
  openArchiveCount = 0,
): SourceSelectionUsage {
  assertNonNegativeSafeInteger(openArchiveCount, "openArchiveCount");
  let sourceCount = 0;
  let totalBytes = 0;
  for (const byteSize of byteSizes) {
    assertNonNegativeSafeInteger(byteSize, "byteSize");
    sourceCount = safeAdd(sourceCount, 1, "sourceCount");
    totalBytes = safeAdd(totalBytes, byteSize, "totalBytes");
  }
  return { sourceCount, totalBytes, openArchiveCount };
}

/**
 * Combine the already-authorized sources with one new selection, then enforce
 * global limits. Callers can keep the returned usage and repeat this operation
 * for every later directory, multi-file, or image-ZIP selection.
 */
export function addSourceSelectionUsage(
  current: SourceSelectionUsage,
  addition: SourceSelectionUsage,
  limits: SourceSelectionLimits = DEFAULT_SOURCE_SELECTION_LIMITS,
): SourceSelectionUsage {
  validateUsage(current);
  validateUsage(addition);
  const combined = {
    sourceCount: safeAdd(current.sourceCount, addition.sourceCount, "sourceCount"),
    totalBytes: safeAdd(current.totalBytes, addition.totalBytes, "totalBytes"),
    openArchiveCount: safeAdd(
      current.openArchiveCount,
      addition.openArchiveCount,
      "openArchiveCount",
    ),
  };
  return assertSourceSelectionUsage(combined, limits);
}

export function assertSourceSelectionUsage(
  usage: SourceSelectionUsage,
  limits: SourceSelectionLimits = DEFAULT_SOURCE_SELECTION_LIMITS,
): SourceSelectionUsage {
  validateUsage(usage);
  const maxSourceCount = limitValue(
    limits.maxSourceCount,
    DEFAULT_SOURCE_SELECTION_MAX_FILES,
    "maxSourceCount",
  );
  const maxTotalBytes = limitValue(
    limits.maxTotalBytes,
    DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxOpenArchives = limitValue(
    limits.maxOpenArchives,
    DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES,
    "maxOpenArchives",
  );

  if (usage.sourceCount > maxSourceCount) {
    throw new SourceSelectionLimitError(
      "IMAGE_SOURCE_FILE_LIMIT",
      `Selected image sources exceed the global ${maxSourceCount}-file limit.`,
    );
  }
  if (usage.totalBytes > maxTotalBytes) {
    throw new SourceSelectionLimitError(
      "IMAGE_SOURCE_SIZE_LIMIT",
      `Selected image sources exceed the global ${maxTotalBytes}-byte limit.`,
    );
  }
  if (usage.openArchiveCount > maxOpenArchives) {
    throw new SourceSelectionLimitError(
      "IMAGE_SOURCE_ARCHIVE_LIMIT",
      `Selected image ZIPs exceed the global ${maxOpenArchives}-archive limit.`,
    );
  }
  return usage;
}

function validateUsage(usage: SourceSelectionUsage): void {
  assertNonNegativeSafeInteger(usage.sourceCount, "sourceCount");
  assertNonNegativeSafeInteger(usage.totalBytes, "totalBytes");
  assertNonNegativeSafeInteger(usage.openArchiveCount, "openArchiveCount");
}

function limitValue(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  assertNonNegativeSafeInteger(resolved, name);
  return resolved;
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;
  assertNonNegativeSafeInteger(result, name);
  return result;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SourceSelectionLimitError(
      "IMAGE_SOURCE_USAGE_INVALID",
      `${name} must be a non-negative safe integer.`,
    );
  }
}
