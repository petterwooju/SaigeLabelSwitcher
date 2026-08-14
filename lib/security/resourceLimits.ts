import type {
  ProjectDiagnostic,
  ProjectFileIR,
  ProjectIR,
} from "../model/project.ts";

export const PROJECT_TEXT_MAX_BYTES = 16 * 1024 ** 2;
export const MATERIALIZED_BINARY_MAX_BYTES = 64 * 1024 ** 2;

export const PROJECT_STRUCTURE_MAX_DEPTH = 128;
export const PROJECT_PATH_MAX_BYTES = 4 * 1024;
/** External Windows/UNC/POSIX paths may be long but remain allocation-bounded. */
export const EXTERNAL_PROJECT_PATH_MAX_BYTES = 32 * 1024;
/** Cross-platform conservative limit for one generated archive path segment. */
export const ARCHIVE_ENTRY_SEGMENT_MAX_BYTES = 255;
export const PROJECT_DIAGNOSTIC_MAX_COUNT = 256;
export const PROJECT_JSON_MAX_VALUES = 1_000_000;

export const V1_PROJECT_LIMITS = Object.freeze({
  maxNodes: 250_000,
  // Segmentation contours store every point as <Point X="…" Y="…"/>.
  // Keep a document-wide ceiling for memory safety, while allowing normal
  // contour-heavy projects to exceed the much smaller per-element limit.
  maxAttributes: 524_288,
  maxAttributesPerElement: 64,
  maxClasses: 10_000,
  maxFiles: 20_000,
});

export const V2_PROJECT_LIMITS = Object.freeze({
  maxClasses: 10_000,
  maxFiles: 20_000,
  maxDatasets: 1_024,
  maxLabels: 250_000,
  maxSplitMemberships: 250_000,
  maxContourPoints: 250_000,
});

/** Count canonical polygon points without allowing a hostile project to
 * overflow the counter. A result above `maximum` is a blocking sentinel. */
export function countProjectContourPoints(
  project: ProjectIR,
  maximum = V2_PROJECT_LIMITS.maxContourPoints,
): number {
  return countContourPointsInFiles(project.files, maximum);
}

export function countContourPointsInFiles(
  files: readonly ProjectFileIR[],
  maximum = V2_PROJECT_LIMITS.maxContourPoints,
): number {
  let total = 0;
  for (const file of files) {
    for (const label of file.labels) {
      for (const ring of label.geometry?.contours ?? []) {
        total = Math.min(maximum + 1, total + ring.length);
        if (total > maximum) return total;
      }
    }
  }
  return total;
}

export const BROWSER_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxEntryBytes: 4 * 1024 ** 3,
  maxTotalBytes: 32 * 1024 ** 3,
  maxCompressionRatio: 200,
  maxTextBytes: PROJECT_TEXT_MAX_BYTES,
  maxBlobBytes: MATERIALIZED_BINARY_MAX_BYTES,
  maxEntryNameBytes: 4 * 1024,
  maxTotalEntryNameBytes: 8 * 1024 ** 2,
});

/**
 * Check a UTF-16 JavaScript string against a UTF-8 byte budget without
 * allocating an encoded copy. Unpaired surrogates match TextEncoder's
 * replacement-character behavior (three UTF-8 bytes).
 */
export function exceedsUtf8ByteLimit(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}

/** Keep malformed inputs from producing an unbounded diagnostic array. */
export function appendBoundedProjectDiagnostic(
  diagnostics: ProjectDiagnostic[],
  diagnostic: ProjectDiagnostic,
): boolean {
  if (diagnostics.length < PROJECT_DIAGNOSTIC_MAX_COUNT - 1) {
    diagnostics.push(diagnostic);
    return true;
  }
  if (!projectDiagnosticsAreTruncated(diagnostics)) {
    diagnostics.push({
      code: "PROJECT_DIAGNOSTIC_LIMIT_EXCEEDED",
      category: "security",
      severity: "error",
      disposition: "block",
      path: "$",
      message: `Further diagnostics were omitted after ${PROJECT_DIAGNOSTIC_MAX_COUNT - 1} entries.`,
      details: { retainedDiagnosticCount: PROJECT_DIAGNOSTIC_MAX_COUNT - 1 },
    });
  }
  return false;
}

export function projectDiagnosticsAreTruncated(
  diagnostics: readonly ProjectDiagnostic[],
): boolean {
  return diagnostics.at(-1)?.code === "PROJECT_DIAGNOSTIC_LIMIT_EXCEEDED";
}

export type JsonResourceInspection =
  | {
      readonly ok: true;
      readonly valueCount: number;
      readonly maximumDepth: number;
    }
  | {
      readonly ok: false;
      readonly reason: "cycle" | "depth" | "invalid" | "values";
      readonly valueCount: number;
      readonly maximumDepth: number;
    };

/**
 * Iteratively inspect a JSON-like value before recursive cloning/stringifying.
 * Shared subtrees are counted each time, matching JSON serialization, while an
 * ancestor set distinguishes them from actual cycles.
 */
export function inspectJsonResourceUsage(
  root: unknown,
  maximumDepth = PROJECT_STRUCTURE_MAX_DEPTH,
  maximumValues = PROJECT_JSON_MAX_VALUES,
): JsonResourceInspection {
  type Frame =
    | { readonly kind: "visit"; readonly value: unknown; readonly depth: number }
    | { readonly kind: "leave"; readonly value: object };
  const stack: Frame[] = [{ kind: "visit", value: root, depth: 1 }];
  const ancestors = new WeakSet<object>();
  let valueCount = 0;
  let observedDepth = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }

    valueCount += 1;
    if (valueCount > maximumValues) {
      return {
        ok: false,
        reason: "values",
        valueCount,
        maximumDepth: observedDepth,
      };
    }

    const value = frame.value;
    if (value === null || typeof value !== "object") continue;
    observedDepth = Math.max(observedDepth, frame.depth);
    if (frame.depth > maximumDepth) {
      return {
        ok: false,
        reason: "depth",
        valueCount,
        maximumDepth: observedDepth,
      };
    }
    if (ancestors.has(value)) {
      return {
        ok: false,
        reason: "cycle",
        valueCount,
        maximumDepth: observedDepth,
      };
    }

    ancestors.add(value);
    stack.push({ kind: "leave", value });
    let children: readonly unknown[];
    try {
      children = Array.isArray(value)
        ? value
        : Object.values(value as Readonly<Record<string, unknown>>);
    } catch {
      return {
        ok: false,
        reason: "invalid",
        valueCount,
        maximumDepth: observedDepth,
      };
    }
    if (children.length > maximumValues - valueCount) {
      return {
        ok: false,
        reason: "values",
        valueCount: maximumValues + 1,
        maximumDepth: observedDepth,
      };
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        kind: "visit",
        value: child,
        depth:
          child !== null && typeof child === "object"
            ? frame.depth + 1
            : frame.depth,
      });
    }
  }

  return { ok: true, valueCount, maximumDepth: observedDepth };
}
