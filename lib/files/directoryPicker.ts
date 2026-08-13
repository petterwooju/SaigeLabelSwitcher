import { normalizePath, pathComparisonKey } from "../security/paths.ts";

export interface PickedDirectoryFile {
  file: File;
  relativePath: string;
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
): Promise<PickedDirectoryFile[]> {
  if (!candidate.showDirectoryPicker) {
    throw new Error("This browser does not support the File System Access API.");
  }
  const root = await candidate.showDirectoryPicker(options);
  return readDirectoryFiles(root);
}

export async function readDirectoryFiles(
  root: DirectoryHandleLike,
): Promise<PickedDirectoryFile[]> {
  const files: PickedDirectoryFile[] = [];
  await visitDirectory(root, normalizePath(root.name), files);
  return sortPickedFiles(files);
}

/**
 * Convert a webkitdirectory FileList (or a test-friendly iterable) to the same
 * representation as showDirectoryPicker(). Files without a relative path use
 * their filename, which also supports ordinary multi-file fallbacks.
 */
export function readWebkitDirectoryFiles(
  selected: Iterable<File> | ArrayLike<File>,
): PickedDirectoryFile[] {
  const files = Array.from(selected as ArrayLike<File>, (file) => ({
    file,
    relativePath: browserRelativePath(file),
  })).filter((item) => item.relativePath.length > 0);
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
): Promise<void> {
  for await (const handle of directory.values()) {
    const relativePath = normalizePath(
      relativeDirectory ? `${relativeDirectory}/${handle.name}` : handle.name,
    );
    if (handle.kind === "directory") {
      await visitDirectory(handle, relativePath, files);
    } else {
      files.push({ file: await handle.getFile(), relativePath });
    }
  }
}

function sortPickedFiles(files: PickedDirectoryFile[]): PickedDirectoryFile[] {
  return files.sort((left, right) => {
    const keyOrder = pathComparisonKey(left.relativePath).localeCompare(
      pathComparisonKey(right.relativePath),
      "en-US",
    );
    return keyOrder || left.relativePath.localeCompare(right.relativePath);
  });
}
