import type { PickedDirectoryFile } from "./directoryPicker.ts";
import type { OpenArchive } from "../archive/zip.ts";
import type { BinarySource } from "../output/containers.ts";
import {
  comparisonPathSegments,
  lastPathSegment,
  normalizePath,
  pathComparisonKey,
  trailingPathSegmentScore,
} from "../security/paths.ts";

export interface ProjectImageReference {
  index: number;
  originalPath: string;
  normalizedPath: string;
  fileName: string;
}

export interface SelectedSourceFile {
  id: string;
  /** Identifies the single browser/archive selection that supplied this file. */
  selectionId: string;
  /** Present for directly selected browser files. Archive entries stay lazy. */
  file?: File;
  source: BinarySource;
  relativePath: string;
  normalizedRelativePath: string;
  pathSegments: string[];
}

export interface SourceFileInput {
  file: File;
  relativePath: string;
}

export interface ArchiveSourceInput {
  readonly entryName: string;
  readonly relativePath?: string;
  readonly size: number;
}

const DIRECT_SELECTION_PREFIX = "direct-selection";

export type ImageMatchStatus = "matched" | "missing" | "ambiguous" | "blank";

export interface ImagePathMatch {
  projectPath: ProjectImageReference;
  status: ImageMatchStatus;
  selectedFile?: SelectedSourceFile;
  candidates: SelectedSourceFile[];
  score: number;
}

export interface ImageMatchReport {
  matches: ImagePathMatch[];
  totalCount: number;
  matchedCount: number;
  missingCount: number;
  ambiguousCount: number;
  blankPathCount: number;
  uniqueMatchedFiles: SelectedSourceFile[];
  matchedBytes: number;
  canPackage: boolean;
}

export interface ProjectImageReferenceSet {
  references: ProjectImageReference[];
  blankPathCount: number;
  duplicateReferenceCount: number;
}

export interface MatchableProject {
  paths: readonly ProjectImageReference[];
  summary?: {
    blankPathCount?: number;
    duplicateReferenceCount?: number;
  };
}

export function createProjectImageReferences(
  paths: Iterable<string>,
): ProjectImageReferenceSet {
  const references: ProjectImageReference[] = [];
  let blankPathCount = 0;

  Array.from(paths).forEach((originalValue, index) => {
    const originalPath = stripProjectPathQuotes(originalValue.trim());
    const normalizedPath = normalizePath(originalPath);
    const fileName = lastPathSegment(normalizedPath);
    if (!normalizedPath || !fileName) {
      blankPathCount += 1;
    }
    references.push({ index, originalPath, normalizedPath, fileName });
  });

  const nonBlankKeys = references
    .filter((reference) => reference.normalizedPath.length > 0)
    .map((reference) => pathComparisonKey(reference.normalizedPath));

  return {
    references,
    blankPathCount,
    duplicateReferenceCount: nonBlankKeys.length - new Set(nonBlankKeys).size,
  };
}

export function mergeSelectedFiles(
  current: readonly SelectedSourceFile[],
  files: Iterable<File>,
): SelectedSourceFile[] {
  return mergeSelectedFileInputs(
    current,
    Array.from(files, (file) => ({
      file,
      relativePath:
        (file as File & { readonly webkitRelativePath?: string })
          .webkitRelativePath || file.name,
    })),
  );
}

export function mergePickedDirectoryFiles(
  current: readonly SelectedSourceFile[],
  files: Iterable<PickedDirectoryFile>,
): SelectedSourceFile[] {
  return mergeSelectedFileInputs(current, files);
}

/** Add validated ZIP entries without inflating image bytes into memory. */
export function mergeArchiveImageEntries(
  current: readonly SelectedSourceFile[],
  archive: OpenArchive,
  entries: Iterable<ArchiveSourceInput>,
  selectionId: string,
): SelectedSourceFile[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const entry of entries) {
    const normalizedRelativePath = normalizePath(
      entry.relativePath || entry.entryName,
    );
    const fileName = lastPathSegment(normalizedRelativePath);
    if (!fileName || shouldIgnoreSelectedFile(fileName)) continue;
    const id = [
      "archive",
      selectionId,
      pathComparisonKey(normalizedRelativePath),
      entry.size,
    ].join("::");
    merged.set(id, {
      id,
      selectionId,
      source: {
        kind: "archive",
        archive,
        entryName: entry.entryName,
        size: entry.size,
        relativePath: normalizedRelativePath,
      },
      relativePath: normalizedRelativePath,
      normalizedRelativePath,
      pathSegments: comparisonPathSegments(normalizedRelativePath),
    });
  }
  return sortSelectedFiles(merged.values());
}

export function mergeSelectedFileInputs(
  current: readonly SelectedSourceFile[],
  inputs: Iterable<SourceFileInput>,
): SelectedSourceFile[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  const seenFiles = new Set<File>();
  let selectionId: string | undefined;
  let fileOrdinal = 0;

  for (const { file, relativePath: inputPath } of inputs) {
    const normalizedRelativePath = normalizePath(inputPath || file.name);
    const relativePath = normalizedRelativePath;
    const fileName = lastPathSegment(normalizedRelativePath);
    if (!fileName || shouldIgnoreSelectedFile(fileName)) continue;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);

    selectionId ??= nextDirectSelectionId(current);
    const id = [
      "blob",
      selectionId,
      fileOrdinal,
      pathComparisonKey(normalizedRelativePath),
      file.size,
      file.lastModified,
    ].join("::");
    fileOrdinal += 1;
    merged.set(id, {
      id,
      selectionId,
      file,
      source: { kind: "blob", blob: file, relativePath },
      relativePath,
      normalizedRelativePath,
      pathSegments: comparisonPathSegments(normalizedRelativePath),
    });
  }

  return sortSelectedFiles(merged.values());
}

function nextDirectSelectionId(
  current: readonly SelectedSourceFile[],
): string {
  const used = new Set(current.map((item) => item.selectionId));
  let sequence = 1;
  while (used.has(`${DIRECT_SELECTION_PREFIX}::${sequence}`)) {
    sequence += 1;
  }
  return `${DIRECT_SELECTION_PREFIX}::${sequence}`;
}

function sortSelectedFiles(
  files: Iterable<SelectedSourceFile>,
): SelectedSourceFile[] {
  return Array.from(files).sort((left, right) => {
    const keyOrder = pathComparisonKey(left.relativePath).localeCompare(
      pathComparisonKey(right.relativePath),
      "en-US",
    );
    return keyOrder || left.relativePath.localeCompare(right.relativePath);
  });
}

/**
 * Match by filename first, then choose the candidate with the longest equal
 * path suffix. A tied best score is intentionally ambiguous.
 */
export function matchImageFiles(
  projectPaths: Iterable<string> | ProjectImageReferenceSet,
  selectedFiles: readonly SelectedSourceFile[],
): ImageMatchReport {
  const referenceSet = isReferenceSet(projectPaths)
    ? projectPaths
    : createProjectImageReferences(projectPaths);

  const byFileName = new Map<string, SelectedSourceFile[]>();
  for (const selectedFile of selectedFiles) {
    const fileNameKey = pathComparisonKey(
      lastPathSegment(selectedFile.normalizedRelativePath),
    );
    const bucket = byFileName.get(fileNameKey) ?? [];
    bucket.push(selectedFile);
    byFileName.set(fileNameKey, bucket);
  }

  const initialMatches = referenceSet.references.map<ImagePathMatch>((projectPath) => {
    if (!projectPath.normalizedPath || !projectPath.fileName) {
      return { projectPath, status: "blank", candidates: [], score: 0 };
    }

    const candidates = byFileName.get(pathComparisonKey(projectPath.fileName)) ?? [];
    if (candidates.length === 0) {
      return { projectPath, status: "missing", candidates: [], score: 0 };
    }

    const projectSegments = comparisonPathSegments(projectPath.normalizedPath);
    const scored = candidates.map((candidate) => ({
      candidate,
      score: trailingPathSegmentScore(projectSegments, candidate.pathSegments),
    }));
    const bestScore = Math.max(...scored.map((item) => item.score));
    const bestCandidates = scored
      .filter((item) => item.score === bestScore)
      .map((item) => item.candidate);

    if (bestCandidates.length === 1) {
      return {
        projectPath,
        status: "matched",
        selectedFile: bestCandidates[0],
        candidates: bestCandidates,
        score: bestScore,
      };
    }
    return {
      projectPath,
      status: "ambiguous",
      candidates: bestCandidates,
      score: bestScore,
    };
  });

  // A bare file selection has no parent directory information. Never allow one
  // selected binary to satisfy multiple distinct project paths silently.
  const assignments = new Map<string, ImagePathMatch[]>();
  for (const match of initialMatches) {
    if (match.status !== "matched" || !match.selectedFile) continue;
    const bucket = assignments.get(match.selectedFile.id) ?? [];
    bucket.push(match);
    assignments.set(match.selectedFile.id, bucket);
  }
  const conflictingIds = new Set<string>();
  for (const [selectedId, bucket] of assignments) {
    const distinctPaths = new Set(
      bucket.map((match) => pathComparisonKey(match.projectPath.normalizedPath)),
    );
    if (distinctPaths.size > 1) conflictingIds.add(selectedId);
  }
  const matches = initialMatches.map((match): ImagePathMatch => {
    if (!match.selectedFile || !conflictingIds.has(match.selectedFile.id)) {
      return match;
    }
    return {
      projectPath: match.projectPath,
      status: "ambiguous",
      candidates: [match.selectedFile],
      score: match.score,
    };
  });

  const matched = matches.filter(
    (match): match is ImagePathMatch & { selectedFile: SelectedSourceFile } =>
      match.status === "matched" && match.selectedFile !== undefined,
  );
  const uniqueMatchedFiles = Array.from(
    new Map(matched.map((match) => [match.selectedFile.id, match.selectedFile])).values(),
  );
  const matchedCount = matched.length;
  const missingCount = countStatus(matches, "missing");
  const ambiguousCount = countStatus(matches, "ambiguous");
  const representedBlankCount = countStatus(matches, "blank");
  // Older parsers omitted blank paths from `paths` and reported only a count.
  // Honour both representations without counting an included blank twice.
  const blankPathCount = Math.max(
    representedBlankCount,
    referenceSet.blankPathCount,
  );
  const totalCount = matches.length + (blankPathCount - representedBlankCount);

  return {
    matches,
    totalCount,
    matchedCount,
    missingCount,
    ambiguousCount,
    blankPathCount,
    uniqueMatchedFiles,
    matchedBytes: uniqueMatchedFiles.reduce(
      (sum, item) => sum + binarySourceSize(item.source),
      0,
    ),
    canPackage:
      totalCount > 0 &&
      matchedCount === totalCount &&
      missingCount === 0 &&
      ambiguousCount === 0 &&
      blankPathCount === 0,
  };
}

function binarySourceSize(source: BinarySource): number {
  return source.kind === "blob" ? source.blob.size : source.size;
}

/** Compatibility entry point for the former `{ paths, summary }` parser API. */
export function matchProjectFiles(
  project: MatchableProject | null,
  selectedFiles: readonly SelectedSourceFile[],
): ImageMatchReport {
  if (!project) return emptyMatchReport();
  return matchImageFiles(
    {
      references: project.paths.map(normalizeProjectImageReference),
      blankPathCount: project.summary?.blankPathCount ?? 0,
      duplicateReferenceCount: project.summary?.duplicateReferenceCount ?? 0,
    },
    selectedFiles,
  );
}

function countStatus(
  matches: readonly ImagePathMatch[],
  status: ImageMatchStatus,
): number {
  return matches.reduce(
    (count, match) => count + (match.status === status ? 1 : 0),
    0,
  );
}

function isReferenceSet(
  value: Iterable<string> | ProjectImageReferenceSet,
): value is ProjectImageReferenceSet {
  return "references" in value && Array.isArray(value.references);
}

function shouldIgnoreSelectedFile(fileName: string): boolean {
  const key = fileName.toLocaleLowerCase("en-US");
  return key === "thumbs.db" || key === ".ds_store";
}

function stripProjectPathQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1).trim()
    : value;
}

function normalizeProjectImageReference(
  reference: ProjectImageReference,
): ProjectImageReference {
  const originalPath = stripProjectPathQuotes(reference.originalPath.trim());
  const normalizedPath = normalizePath(reference.normalizedPath || originalPath);
  return {
    index: reference.index,
    originalPath,
    normalizedPath,
    fileName: lastPathSegment(reference.fileName || normalizedPath),
  };
}

function emptyMatchReport(): ImageMatchReport {
  return {
    matches: [],
    totalCount: 0,
    matchedCount: 0,
    missingCount: 0,
    ambiguousCount: 0,
    blankPathCount: 0,
    uniqueMatchedFiles: [],
    matchedBytes: 0,
    canPackage: false,
  };
}
