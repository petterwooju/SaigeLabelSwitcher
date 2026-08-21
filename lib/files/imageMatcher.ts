import type { PickedDirectoryFile } from "./directoryPicker.ts";
import type { OpenArchive } from "../archive/zip.ts";
import type { BinarySource } from "../output/containers.ts";
import {
  comparisonPathSegments,
  lastPathSegment,
  normalizePath,
  pathComparisonKey,
} from "../security/paths.ts";
import {
  measureSourceSelectionUsage,
  type SourceSelectionUsage,
} from "./sourceSelectionLimits.ts";

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

/** Prevent diagnostics from retaining a large same-name candidate cross-product. */
export const MAX_RETAINED_MATCH_CANDIDATES = 8;

interface CandidateSuffixNode {
  readonly children: Map<string, CandidateSuffixNode>;
  readonly retainedCandidates: SelectedSourceFile[];
  candidateCount: number;
}

export type ImageMatchStatus = "matched" | "missing" | "ambiguous" | "blank";

export interface ImagePathMatch {
  projectPath: ProjectImageReference;
  status: ImageMatchStatus;
  selectedFile?: SelectedSourceFile;
  /** A bounded diagnostic sample. Use candidateCount for the exact total. */
  candidates: readonly SelectedSourceFile[];
  candidateCount: number;
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
  const nonBlankKeys = new Set<string>();
  let blankPathCount = 0;
  let duplicateReferenceCount = 0;
  let index = 0;

  for (const originalValue of paths) {
    const originalPath = stripProjectPathQuotes(originalValue.trim());
    const normalizedPath = normalizePath(originalPath);
    const fileName = lastPathSegment(normalizedPath);
    if (!normalizedPath || !fileName) {
      blankPathCount += 1;
    } else {
      const key = pathComparisonKey(normalizedPath);
      if (nonBlankKeys.has(key)) duplicateReferenceCount += 1;
      else nonBlankKeys.add(key);
    }
    references.push({ index, originalPath, normalizedPath, fileName });
    index += 1;
  }

  return {
    references,
    blankPathCount,
    duplicateReferenceCount,
  };
}

export function mergeSelectedFiles(
  current: readonly SelectedSourceFile[],
  files: Iterable<File>,
): SelectedSourceFile[] {
  function* sourceInputs(): Iterable<SourceFileInput> {
    for (const file of files) {
      yield {
        file,
        relativePath:
          (file as File & { readonly webkitRelativePath?: string })
            .webkitRelativePath || file.name,
      };
    }
  }
  return mergeSelectedFileInputs(current, sourceInputs());
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
  return Array.from(files, (file) => ({
    file,
    comparisonKey: pathComparisonKey(file.relativePath),
  }))
    .sort((left, right) => {
      const keyOrder = left.comparisonKey.localeCompare(
        right.comparisonKey,
        "en-US",
      );
      return keyOrder || left.file.relativePath.localeCompare(right.file.relativePath);
    })
    .map(({ file }) => file);
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

  const byFileName = new Map<string, CandidateSuffixNode>();
  for (const selectedFile of selectedFiles) {
    const fileNameKey = pathComparisonKey(
      lastPathSegment(selectedFile.normalizedRelativePath),
    );
    if (!fileNameKey) continue;
    let node = byFileName.get(fileNameKey);
    if (!node) {
      node = createCandidateSuffixNode();
      byFileName.set(fileNameKey, node);
    }
    addCandidateToNode(node, selectedFile);
    for (
      let index = selectedFile.pathSegments.length - 2;
      index >= 0;
      index -= 1
    ) {
      node = candidateNodeChild(node, selectedFile.pathSegments[index]!);
      addCandidateToNode(node, selectedFile);
    }
  }

  const initialMatches = referenceSet.references.map<ImagePathMatch>((projectPath) => {
    if (!projectPath.normalizedPath || !projectPath.fileName) {
      return {
        projectPath,
        status: "blank",
        candidates: [],
        candidateCount: 0,
        score: 0,
      };
    }

    const root = byFileName.get(pathComparisonKey(projectPath.fileName));
    if (!root) {
      return {
        projectPath,
        status: "missing",
        candidates: [],
        candidateCount: 0,
        score: 0,
      };
    }

    const projectSegments = comparisonPathSegments(projectPath.normalizedPath);
    let bestNode = root;
    let bestScore = 1;
    for (let index = projectSegments.length - 2; index >= 0; index -= 1) {
      const nextNode = bestNode.children.get(projectSegments[index]!);
      if (!nextNode) break;
      bestNode = nextNode;
      bestScore += 1;
    }

    if (bestNode.candidateCount === 1) {
      return {
        projectPath,
        status: "matched",
        selectedFile: bestNode.retainedCandidates[0],
        candidates: bestNode.retainedCandidates,
        candidateCount: 1,
        score: bestScore,
      };
    }
    return {
      projectPath,
      status: "ambiguous",
      candidates: bestNode.retainedCandidates,
      candidateCount: bestNode.candidateCount,
      score: bestScore,
    };
  });

  // A bare file selection has no parent directory information. Never allow one
  // selected binary to satisfy multiple distinct project paths silently.
  const assignments = new Map<string, string | null>();
  for (const match of initialMatches) {
    if (match.status !== "matched" || !match.selectedFile) continue;
    const selectedId = match.selectedFile.id;
    const pathKey = pathComparisonKey(match.projectPath.normalizedPath);
    const assignedPath = assignments.get(selectedId);
    if (assignedPath === undefined) assignments.set(selectedId, pathKey);
    else if (assignedPath !== pathKey) assignments.set(selectedId, null);
  }
  const matches = initialMatches.map((match): ImagePathMatch => {
    if (!match.selectedFile || assignments.get(match.selectedFile.id) !== null) {
      return match;
    }
    return {
      projectPath: match.projectPath,
      status: "ambiguous",
      candidates: [match.selectedFile],
      candidateCount: 1,
      score: match.score,
    };
  });

  const uniqueMatchedFileMap = new Map<string, SelectedSourceFile>();
  let matchedCount = 0;
  let missingCount = 0;
  let ambiguousCount = 0;
  let representedBlankCount = 0;
  for (const match of matches) {
    if (match.status === "matched" && match.selectedFile) {
      matchedCount += 1;
      uniqueMatchedFileMap.set(match.selectedFile.id, match.selectedFile);
    } else if (match.status === "missing") missingCount += 1;
    else if (match.status === "ambiguous") ambiguousCount += 1;
    else if (match.status === "blank") representedBlankCount += 1;
  }
  const uniqueMatchedFiles = Array.from(uniqueMatchedFileMap.values());
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
    matchedBytes: selectedSourceUsage(uniqueMatchedFiles).totalBytes,
    canPackage:
      totalCount > 0 &&
      matchedCount === totalCount &&
      missingCount === 0 &&
      ambiguousCount === 0 &&
      blankPathCount === 0,
  };
}

/** Measure all currently retained image sources across repeated selections. */
export function selectedSourceUsage(
  selectedFiles: readonly SelectedSourceFile[],
  openArchiveCount = 0,
): SourceSelectionUsage {
  function* byteSizes(): Iterable<number> {
    for (const selectedFile of selectedFiles) {
      yield binarySourceSize(selectedFile.source);
    }
  }
  return measureSourceSelectionUsage(byteSizes(), openArchiveCount);
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

function createCandidateSuffixNode(): CandidateSuffixNode {
  return { children: new Map(), retainedCandidates: [], candidateCount: 0 };
}

function candidateNodeChild(
  node: CandidateSuffixNode,
  segment: string,
): CandidateSuffixNode {
  const existing = node.children.get(segment);
  if (existing) return existing;
  const child = createCandidateSuffixNode();
  node.children.set(segment, child);
  return child;
}

function addCandidateToNode(
  node: CandidateSuffixNode,
  candidate: SelectedSourceFile,
): void {
  node.candidateCount += 1;
  if (node.retainedCandidates.length < MAX_RETAINED_MATCH_CANDIDATES) {
    node.retainedCandidates.push(candidate);
  }
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
