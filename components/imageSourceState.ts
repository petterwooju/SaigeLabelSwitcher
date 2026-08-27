import type {
  ImageMatchReport,
  SelectedSourceFile,
} from "../lib/files/imageMatcher.ts";

/**
 * Keep the image-matching summary useful without retaining one extra UI object
 * for every missing image in a very large project. The exact total continues
 * to come from ImageMatchReport's counters.
 */
export const MAX_RETAINED_IMAGE_MATCH_ISSUES = 100;

export interface RetainedImageMatchIssue {
  readonly originalPath: string;
  readonly status: "missing" | "ambiguous";
}

export interface RetainedImageMatchIssueSummary {
  readonly issues: readonly RetainedImageMatchIssue[];
  readonly issueCount: number;
}

export type ImageSourceBatchKind = "directory" | "files" | "zip";

export interface ImageSourceBatchMetadata {
  readonly id: string;
  readonly kind: ImageSourceBatchKind;
  readonly label: string;
}

export interface ImageSourceBatchUsage extends ImageSourceBatchMetadata {
  readonly fileCount: number;
  readonly totalBytes: number;
}

export function retainImageMatchIssues(
  report: ImageMatchReport,
  limit = MAX_RETAINED_IMAGE_MATCH_ISSUES,
): RetainedImageMatchIssueSummary {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const issues: RetainedImageMatchIssue[] = [];
  for (const match of report.matches) {
    if (
      match.status !== "missing" &&
      match.status !== "ambiguous" &&
      match.status !== "blank"
    ) continue;
    if (issues.length >= safeLimit) break;
    issues.push({
      originalPath: match.projectPath.originalPath,
      status: match.status === "ambiguous" ? "ambiguous" : "missing",
    });
  }
  return {
    issues,
    issueCount:
      report.missingCount + report.ambiguousCount + report.blankPathCount,
  };
}

export function addedSelectionId(
  previous: readonly SelectedSourceFile[],
  next: readonly SelectedSourceFile[],
): string | null {
  const previousIds = new Set(previous.map((file) => file.selectionId));
  return next.find((file) => !previousIds.has(file.selectionId))?.selectionId ?? null;
}

export function removeSelectedSourceBatch(
  files: readonly SelectedSourceFile[],
  selectionId: string,
): SelectedSourceFile[] {
  return files.filter((file) => file.selectionId !== selectionId);
}

export function summarizeImageSourceBatches(
  files: readonly SelectedSourceFile[],
  metadata: readonly ImageSourceBatchMetadata[],
): ImageSourceBatchUsage[] {
  const usage = new Map<string, { fileCount: number; totalBytes: number }>();
  for (const file of files) {
    const current = usage.get(file.selectionId) ?? { fileCount: 0, totalBytes: 0 };
    current.fileCount += 1;
    current.totalBytes += file.source.kind === "blob" ? file.source.blob.size : file.source.size;
    usage.set(file.selectionId, current);
  }

  return metadata.flatMap((batch) => {
    const batchUsage = usage.get(batch.id);
    return batchUsage ? [{ ...batch, ...batchUsage }] : [];
  });
}

export function batchLabelFromPaths(
  paths: readonly string[],
  fallback: string,
): string {
  if (paths.length === 0) return fallback;
  const roots = new Set(
    paths.map((path) => path.replaceAll("\\", "/").split("/").filter(Boolean)[0]),
  );
  if (roots.size === 1) {
    const root = roots.values().next().value;
    if (root) return root;
  }
  return fallback;
}

export function statusAfterSuccessfulImageSelection<T extends string>(
  status: T,
  canRecover: boolean,
): T | "ready" {
  return status === "error" && canRecover ? "ready" : status;
}
