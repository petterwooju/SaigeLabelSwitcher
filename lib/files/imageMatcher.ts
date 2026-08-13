import type { PickedDirectoryFile } from "./directoryPicker.ts";
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
  file: File;
  relativePath: string;
  normalizedRelativePath: string;
  pathSegments: string[];
}

export interface SourceFileInput {
  file: File;
  relativePath: string;
}

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

export function mergeSelectedFileInputs(
  current: readonly SelectedSourceFile[],
  inputs: Iterable<SourceFileInput>,
): SelectedSourceFile[] {
  const merged = new Map(current.map((item) => [item.id, item]));

  for (const { file, relativePath: inputPath } of inputs) {
    const normalizedRelativePath = normalizePath(inputPath || file.name);
    const relativePath = normalizedRelativePath;
    const fileName = lastPathSegment(normalizedRelativePath);
    if (!fileName || shouldIgnoreSelectedFile(fileName)) continue;

    const id = [
      pathComparisonKey(normalizedRelativePath),
      file.size,
      file.lastModified,
    ].join("::");
    merged.set(id, {
      id,
      file,
      relativePath,
      normalizedRelativePath,
      pathSegments: comparisonPathSegments(normalizedRelativePath),
    });
  }

  return Array.from(merged.values()).sort((left, right) => {
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

  const matches = referenceSet.references.map<ImagePathMatch>((projectPath) => {
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
    matchedBytes: uniqueMatchedFiles.reduce((sum, item) => sum + item.file.size, 0),
    canPackage:
      totalCount > 0 &&
      matchedCount === totalCount &&
      missingCount === 0 &&
      ambiguousCount === 0 &&
      blankPathCount === 0,
  };
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
