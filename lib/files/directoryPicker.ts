import { normalizePath, pathComparisonKey } from "../security/paths.ts";
import {
  DEFAULT_SOURCE_SELECTION_MAX_FILES,
  DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES,
} from "./sourceSelectionLimits.ts";

export interface PickedDirectoryFile {
  file: File;
  relativePath: string;
}

export interface DirectoryReadOptions {
  readonly signal?: AbortSignal;
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly includeFile?: (name: string) => boolean;
}

export const DEFAULT_DIRECTORY_MAX_DEPTH = 32;
export const DEFAULT_DIRECTORY_MAX_FILES = DEFAULT_SOURCE_SELECTION_MAX_FILES;
export const DEFAULT_DIRECTORY_MAX_TOTAL_BYTES =
  DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES;

export class DirectoryReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DirectoryReadError";
    this.code = code;
  }
}

/** Structural File System Access API types, kept usable in browsers whose DOM
 * declarations do not yet include showDirectoryPicker(). */
export interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface DirectoryHandleLike {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>;
}

export interface DirectoryPickerOptionsLike {
  mode?: "read";
  id?: string;
  startIn?: string | DirectoryHandleLike;
}

export interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (
    options?: DirectoryPickerOptionsLike,
  ) => Promise<DirectoryHandleLike>;
}

/** File shape returned by `<input type="file" webkitdirectory>`. */
export type WebkitDirectoryFile = File & { readonly webkitRelativePath?: string };

/** Input shape needed by the non-File-System-Access fallback. */
export type WebkitDirectoryInput = HTMLInputElement & {
  webkitdirectory: boolean;
  directory?: boolean;
};

export function supportsFileSystemDirectoryPicker(
  candidate: Pick<DirectoryPickerWindow, "showDirectoryPicker">,
): boolean {
  return typeof candidate.showDirectoryPicker === "function";
}

export async function pickDirectoryFiles(
  candidate: Pick<DirectoryPickerWindow, "showDirectoryPicker">,
  options: DirectoryPickerOptionsLike = { mode: "read" },
  readOptions: DirectoryReadOptions = {},
): Promise<PickedDirectoryFile[]> {
  if (!candidate.showDirectoryPicker) {
    throw new Error("This browser does not support the File System Access API.");
  }
  const root = await candidate.showDirectoryPicker(options);
  return readDirectoryFiles(root, readOptions);
}

export async function readDirectoryFiles(
  root: DirectoryHandleLike,
  options: DirectoryReadOptions = {},
): Promise<PickedDirectoryFile[]> {
  const files: PickedDirectoryFile[] = [];
  await visitDirectory(
    root,
    normalizePath(root.name),
    files,
    { totalBytes: 0 },
    0,
    options,
  );
  return sortPickedFiles(files);
}

/**
 * Convert a webkitdirectory FileList (or a test-friendly iterable) to the same
 * representation as showDirectoryPicker(). Files without a relative path use
 * their filename, which also supports ordinary multi-file fallbacks.
 */
export function readWebkitDirectoryFiles(
  selected: Iterable<File> | ArrayLike<File>,
  options: DirectoryReadOptions = {},
): PickedDirectoryFile[] {
  const files: PickedDirectoryFile[] = [];
  const state = { totalBytes: 0 };
  throwIfAborted(options.signal);
  for (const file of iterableFiles(selected)) {
    throwIfAborted(options.signal);
    const relativePath = browserRelativePath(file);
    if (!relativePath || (options.includeFile && !options.includeFile(relativePath))) {
      continue;
    }
    appendPickedFile(files, state, file, relativePath, options);
  }
  return sortPickedFiles(files);
}

export function browserRelativePath(file: File): string {
  const browserPath = (file as WebkitDirectoryFile).webkitRelativePath;
  return normalizePath(browserPath || file.name);
}

async function visitDirectory(
  directory: DirectoryHandleLike,
  relativeDirectory: string,
  files: PickedDirectoryFile[],
  state: { totalBytes: number },
  depth: number,
  options: DirectoryReadOptions,
): Promise<void> {
  throwIfAborted(options.signal);
  const maxDepth = options.maxDepth ?? DEFAULT_DIRECTORY_MAX_DEPTH;
  if (depth > maxDepth) {
    throw new DirectoryReadError(
      "DIRECTORY_DEPTH_LIMIT",
      `所选目录超过最大扫描深度（${maxDepth} 层）。`,
    );
  }
  for await (const handle of directory.values()) {
    throwIfAborted(options.signal);
    const relativePath = normalizePath(
      relativeDirectory ? `${relativeDirectory}/${handle.name}` : handle.name,
    );
    if (handle.kind === "directory") {
      await visitDirectory(handle, relativePath, files, state, depth + 1, options);
    } else {
      if (options.includeFile && !options.includeFile(handle.name)) continue;
      const file = await handle.getFile();
      throwIfAborted(options.signal);
      appendPickedFile(files, state, file, relativePath, options);
    }
  }
}

function appendPickedFile(
  files: PickedDirectoryFile[],
  state: { totalBytes: number },
  file: File,
  relativePath: string,
  options: DirectoryReadOptions,
): void {
  const maxFiles = options.maxFiles ?? DEFAULT_DIRECTORY_MAX_FILES;
  if (files.length >= maxFiles) {
    throw new DirectoryReadError(
      "DIRECTORY_FILE_LIMIT",
      `所选目录包含超过 ${maxFiles} 个候选文件。`,
    );
  }
  state.totalBytes += file.size;
  const maxTotalBytes =
    options.maxTotalBytes ?? DEFAULT_DIRECTORY_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(state.totalBytes) || state.totalBytes > maxTotalBytes) {
    throw new DirectoryReadError(
      "DIRECTORY_SIZE_LIMIT",
      `所选目录候选文件总大小超过 ${maxTotalBytes} 字节。`,
    );
  }
  files.push({ file, relativePath });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}

function sortPickedFiles(files: PickedDirectoryFile[]): PickedDirectoryFile[] {
  return files
    .map((file) => ({ file, comparisonKey: pathComparisonKey(file.relativePath) }))
    .sort((left, right) => {
      const keyOrder = left.comparisonKey.localeCompare(
        right.comparisonKey,
        "en-US",
      );
      return keyOrder || left.file.relativePath.localeCompare(right.file.relativePath);
    })
    .map(({ file }) => file);
}

function iterableFiles(
  selected: Iterable<File> | ArrayLike<File>,
): Iterable<File> {
  return Symbol.iterator in Object(selected)
    ? (selected as Iterable<File>)
    : Array.from(selected as ArrayLike<File>);
}
