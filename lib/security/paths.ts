/**
 * Path helpers shared by browser directory matching and archive readers.
 *
 * Project paths are user data, so normalising them must not imply that they
 * are safe archive entry names. Archive paths have a deliberately stricter
 * validator below.
 */

import {
  ARCHIVE_ENTRY_SEGMENT_MAX_BYTES,
  exceedsUtf8ByteLimit,
} from "./resourceLimits.ts";

const WINDOWS_DRIVE_PREFIX = /^[a-z]:/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .].*)?$/iu;

export type UnsafeZipEntryReason =
  | "empty"
  | "control-character"
  | "absolute"
  | "drive-path"
  | "traversal"
  | "invalid-character"
  | "reserved-name"
  | "segment-too-long";

export type ZipEntryPathValidation =
  | { safe: true; normalizedPath: string }
  | { safe: false; reason: UnsafeZipEntryReason };

/**
 * Convert Windows, POSIX and file-URL-like paths to a stable slash-separated
 * representation. This is for comparison only; it does not make a path safe.
 */
export function normalizePath(value: string): string {
  let normalized = stripMatchingQuotes(value.trim()).normalize("NFC");

  if (/^file:\/\//iu.test(normalized)) {
    normalized = normalized.replace(/^file:\/\//iu, "");
    // file:///C:/path becomes /C:/path after removing the scheme.
    if (/^\/[a-z]:[\\/]/iu.test(normalized)) {
      normalized = normalized.slice(1);
    }
  }

  normalized = normalized.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/u, "");
  }
  return normalized;
}

/** A locale-independent-enough comparison key for project and browser paths. */
export function pathComparisonKey(value: string): string {
  return normalizePath(value).toLocaleLowerCase("en-US").normalize("NFC");
}

export function splitPathSegments(value: string): string[] {
  return normalizePath(value)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

export function comparisonPathSegments(value: string): string[] {
  return splitPathSegments(value).map((segment) =>
    segment.toLocaleLowerCase("en-US").normalize("NFC"),
  );
}

export function lastPathSegment(value: string): string {
  return splitPathSegments(value).at(-1) ?? "";
}

export function trailingPathSegmentScore(
  left: readonly string[],
  right: readonly string[],
): number {
  let score = 0;
  for (
    let leftIndex = left.length - 1, rightIndex = right.length - 1;
    leftIndex >= 0 && rightIndex >= 0;
    leftIndex -= 1, rightIndex -= 1
  ) {
    if (left[leftIndex] !== right[rightIndex]) break;
    score += 1;
  }
  return score;
}

/**
 * Validate a ZIP entry for safe, cross-platform extraction. Backslashes are
 * treated as separators so `..\\file` cannot bypass traversal checks.
 */
export function validateZipEntryPath(value: string): ZipEntryPathValidation {
  const normalized = value.normalize("NFC");
  if (!normalized || normalized.trim() === "") {
    return { safe: false, reason: "empty" };
  }
  if (hasControlCharacters(normalized)) {
    return { safe: false, reason: "control-character" };
  }

  const slashPath = normalized.replace(/\\/gu, "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//")) {
    return { safe: false, reason: "absolute" };
  }
  if (WINDOWS_DRIVE_PREFIX.test(slashPath)) {
    return { safe: false, reason: "drive-path" };
  }

  const segments = slashPath.split("/").filter(Boolean);
  if (segments.length === 0) return { safe: false, reason: "empty" };
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { safe: false, reason: "traversal" };
  }
  if (
    segments.some(
      (segment) =>
        WINDOWS_FORBIDDEN_CHARACTERS.test(segment) ||
        segment.endsWith(" ") ||
        segment.endsWith("."),
    )
  ) {
    return { safe: false, reason: "invalid-character" };
  }
  if (segments.some((segment) => WINDOWS_RESERVED_BASENAME.test(segment))) {
    return { safe: false, reason: "reserved-name" };
  }
  if (
    segments.some((segment) =>
      exceedsUtf8ByteLimit(segment, ARCHIVE_ENTRY_SEGMENT_MAX_BYTES),
    )
  ) {
    return { safe: false, reason: "segment-too-long" };
  }

  return { safe: true, normalizedPath: segments.join("/") };
}

export function isSafeZipEntryPath(value: string): boolean {
  return validateZipEntryPath(value).safe;
}

export function normalizeZipEntryPath(value: string): string {
  const result = validateZipEntryPath(value);
  if (!result.safe) {
    throw new Error(`Unsafe ZIP entry path (${result.reason}): ${value}`);
  }
  return result.normalizedPath;
}

/** Used to detect duplicate ZIP entries on case-insensitive filesystems. */
export function zipEntryComparisonKey(value: string): string {
  return normalizeZipEntryPath(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1).trim()
    : value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
