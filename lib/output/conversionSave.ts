import type {
  ProjectDiagnostic,
  ProjectIR,
  ProjectSourceFormat,
} from "../model/project.ts";
import {
  prepareSvpaArchive,
  prepareVisionArchive,
  writePreparedSvpaArchive,
  writePreparedVisionArchive,
  type AppLanguage,
  type ContainerProgress,
  type PreparedSvpaArchive,
  type PreparedVisionArchive,
  type ResolvedProjectImage,
} from "./containers.ts";
import {
  saveBlob,
  type SaveDestination,
  type SaveResult,
} from "./save.ts";
import {
  writeSrprojAsync,
  writeV2SubvisionProjectAsync,
  writeV2VisionProjectAsync,
} from "./writeProjectAsync.ts";

export type ConversionSaveTarget =
  | "visionproj"
  | "subvisionproj"
  | "srproj"
  | "svpa-zip";

interface PreparedTextOutput {
  readonly kind: "text";
  readonly fileName: string;
  readonly blob: Blob;
  readonly estimatedBytes: number;
}

interface PreparedVisionOutput {
  readonly kind: "vision";
  readonly fileName: string;
  readonly archive: PreparedVisionArchive;
  readonly estimatedBytes: number;
}

interface PreparedSvpaOutput {
  readonly kind: "svpa";
  readonly fileName: string;
  readonly archive: PreparedSvpaArchive;
  readonly estimatedBytes: number;
}

export type PreparedConversionOutput =
  | PreparedTextOutput
  | PreparedVisionOutput
  | PreparedSvpaOutput;

export interface PrepareConversionOutputOptions {
  readonly target: ConversionSaveTarget;
  readonly fileName: string;
  readonly originalProject: ProjectIR;
  readonly workingProject: ProjectIR;
  readonly images?: readonly ResolvedProjectImage[];
  /** Verified output-relative paths for images written to a complete V2 archive. */
  readonly imageOutputPaths?: Readonly<Record<number, string>>;
  readonly sourceFormat: ProjectSourceFormat;
  readonly sourceProjectXmlText?: string;
  readonly originalProjectDirectory?: string;
  readonly language: AppLanguage;
  readonly allowConfirmedLoss: boolean;
  readonly signal?: AbortSignal;
}

export class WriterDiagnosticsError extends Error {
  readonly diagnostics: readonly ProjectDiagnostic[];

  constructor(diagnostics: readonly ProjectDiagnostic[]) {
    super("The target writer rejected this project.");
    this.name = "WriterDiagnosticsError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Complete every deterministic writer, helper-integrity and archive-plan check
 * before a system save picker is allowed to create a destination placeholder.
 */
export async function prepareConversionOutput({
  target,
  fileName,
  originalProject,
  workingProject,
  images,
  imageOutputPaths,
  sourceFormat,
  sourceProjectXmlText,
  originalProjectDirectory = "",
  language,
  allowConfirmedLoss,
  signal,
}: PrepareConversionOutputOptions): Promise<PreparedConversionOutput> {
  throwIfAborted(signal);
  if (target === "subvisionproj") {
    const result = await writeV2SubvisionProjectAsync(
      workingProject,
      {
        externalPaths: externalPathsForProject(originalProject),
        allowConfirmedLoss,
      },
      signal,
    );
    if (!result.ok) throw new WriterDiagnosticsError(result.diagnostics);
    const blob = new Blob([result.jsonText], {
      type: "application/json;charset=utf-8",
    });
    return { kind: "text", fileName, blob, estimatedBytes: blob.size };
  }

  if (target === "visionproj") {
    const result = await writeV2VisionProjectAsync(
      workingProject,
      {
        allowConfirmedLoss,
        imageOutputPaths,
      },
      signal,
    );
    if (!result.ok) throw new WriterDiagnosticsError(result.diagnostics);
    if (!images) throw new Error("Project images are required for a complete V2 project.");
    const archive = prepareVisionArchive({ built: result, images });
    return {
      kind: "vision",
      fileName,
      archive,
      estimatedBytes: archive.estimatedBytes,
    };
  }

  if (target === "srproj") {
    const xml = await writeSrprojAsync(
      workingProject,
      {
        pathByFileIndex: Object.fromEntries(
          workingProject.files.map((file) => [
            file.index,
            unquotePath(file.sourcePath),
          ]),
        ),
        allowConfirmedLoss,
      },
      signal,
    );
    const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    return { kind: "text", fileName, blob, estimatedBytes: blob.size };
  }

  if (!images) throw new Error("Project images are required for a complete V1 project.");
  const srprojXml =
    sourceFormat === "v1-srproj" && sourceProjectXmlText
      ? sourceProjectXmlText
      : await writeSrprojAsync(
          workingProject,
          {
            pathByFileIndex: Object.fromEntries(
              workingProject.files.map((file) => [file.index, file.sourcePath]),
            ),
            allowConfirmedLoss,
          },
          signal,
        );
  const archive = await prepareSvpaArchive({
    project: workingProject,
    srprojXml,
    images,
    language,
    originalProjectDirectory,
    signal,
  });
  return {
    kind: "svpa",
    fileName,
    archive,
    estimatedBytes: archive.estimatedBytes,
  };
}

export async function commitPreparedConversionOutput(
  prepared: PreparedConversionOutput,
  destination: SaveDestination,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: ContainerProgress) => void;
  } = {},
): Promise<SaveResult> {
  throwIfAborted(options.signal);
  if (prepared.kind === "text") {
    return saveBlob(destination, prepared.blob, options.signal);
  }
  if (prepared.kind === "vision") {
    return writePreparedVisionArchive({
      destination,
      prepared: prepared.archive,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  }
  return writePreparedSvpaArchive({
    destination,
    prepared: prepared.archive,
    onProgress: options.onProgress,
    signal: options.signal,
  });
}

function externalPathsForProject(project: ProjectIR): Readonly<Record<number, string>> {
  return Object.fromEntries(
    project.files.map((file) => [file.index, unquotePath(file.sourcePath)]),
  );
}

function unquotePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
