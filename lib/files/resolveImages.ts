import type { OpenArchive } from "../archive/zip.ts";
import type { ProjectIR } from "../model/project.ts";
import type { BinarySource, ResolvedProjectImage } from "../output/containers.ts";
import type { ImageMatchReport } from "./imageMatcher.ts";

export interface ImageResolutionIssue {
  readonly fileIndex: number;
  readonly path: string;
  readonly code:
    | "ARCHIVE_NOT_OPEN"
    | "ARCHIVE_ENTRY_MISSING"
    | "EXTERNAL_IMAGE_NOT_SELECTED"
    | "EXTERNAL_IMAGE_AMBIGUOUS";
}

export interface ResolvedImageSet {
  readonly images: readonly ResolvedProjectImage[];
  readonly issues: readonly ImageResolutionIssue[];
  readonly totalBytes: number;
  readonly complete: boolean;
}

/**
 * Resolve every canonical project file to a readable browser source. Archive
 * sources are streamed from the validated input ZIP; external paths must have
 * a unique match from a user-authorized directory.
 */
export function resolveProjectImages(
  project: ProjectIR,
  archive?: OpenArchive,
  matchReport?: ImageMatchReport,
): ResolvedImageSet {
  const archiveInfo = new Map(
    archive?.entries.map((entry) => [archiveKey(entry.name), entry]) ?? [],
  );
  const matchByIndex = new Map(
    matchReport?.matches.map((match) => [match.projectPath.index, match]) ?? [],
  );
  const images: ResolvedProjectImage[] = [];
  const issues: ImageResolutionIssue[] = [];
  let totalBytes = 0;

  for (const file of [...project.files].sort(
    (left, right) => left.index - right.index,
  )) {
    let source: BinarySource | undefined;
    if (file.image.kind === "archive") {
      if (!archive) {
        issues.push({
          fileIndex: file.index,
          path: file.sourcePath,
          code: "ARCHIVE_NOT_OPEN",
        });
        continue;
      }
      const info = archiveInfo.get(archiveKey(file.image.entryName));
      if (!info || !archive.has(file.image.entryName)) {
        issues.push({
          fileIndex: file.index,
          path: file.sourcePath,
          code: "ARCHIVE_ENTRY_MISSING",
        });
        continue;
      }
      source = {
        kind: "archive",
        archive,
        entryName: info.name,
        size: info.uncompressedSize,
        relativePath: stripTopImageFolder(info.name),
      };
    } else {
      const match = matchByIndex.get(file.index);
      if (match?.status === "ambiguous") {
        issues.push({
          fileIndex: file.index,
          path: file.sourcePath,
          code: "EXTERNAL_IMAGE_AMBIGUOUS",
        });
        continue;
      }
      if (match?.status !== "matched" || !match.selectedFile) {
        issues.push({
          fileIndex: file.index,
          path: file.sourcePath,
          code: "EXTERNAL_IMAGE_NOT_SELECTED",
        });
        continue;
      }
      source = match.selectedFile.source;
    }

    const bytes = source.kind === "blob" ? source.blob.size : source.size;
    const nextTotal = totalBytes + bytes;
    if (!Number.isSafeInteger(nextTotal)) {
      throw new RangeError("Project image byte count exceeds the safe integer range.");
    }
    totalBytes = nextTotal;
    images.push({ fileIndex: file.index, originalPath: file.sourcePath, source });
  }

  return {
    images,
    issues,
    totalBytes,
    complete: issues.length === 0 && images.length === project.files.length,
  };
}

export function projectHasEmbeddedImages(project: ProjectIR): boolean {
  return (
    project.files.length > 0 &&
    project.files.every((file) => file.image.kind === "archive")
  );
}

export function projectImagePaths(project: ProjectIR): string[] {
  return [...project.files]
    .sort((left, right) => left.index - right.index)
    .map((file) => file.sourcePath);
}

function archiveKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\\/gu, "/")
    .toLocaleLowerCase("en-US");
}

function stripTopImageFolder(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const slash = normalized.indexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
