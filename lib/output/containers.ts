import { TextReader, type ZipWriter } from "@zip.js/zip.js";
import type { OpenArchive } from "../archive/zip.ts";
import { parseV1Srproj } from "../input/v1.ts";
import type { ProjectIR } from "../model/project.ts";
import { APP_VERSION } from "../release.ts";
import { BROWSER_ARCHIVE_LIMITS } from "../security/resourceLimits.ts";
import {
  pathComparisonKey,
  validateZipEntryPath,
} from "../security/paths.ts";
import {
  assertHelperIntegrity,
  EXPECTED_HELPER_SHA256,
} from "../security/helperIntegrity.ts";
import type { SaveDestination, SaveResult } from "./save.ts";
import { createZipDestination } from "./save.ts";
import type { V2VisionWriteSuccess } from "./v2.ts";

export type AppLanguage = "zh-CN" | "en-US" | "ko-KR";

export interface BlobBinarySource {
  readonly kind: "blob";
  readonly blob: Blob;
  readonly relativePath?: string;
}

export interface ArchiveBinarySource {
  readonly kind: "archive";
  readonly archive: OpenArchive;
  readonly entryName: string;
  readonly size: number;
  readonly relativePath?: string;
}

export type BinarySource = BlobBinarySource | ArchiveBinarySource;

export interface ResolvedProjectImage {
  readonly fileIndex: number;
  readonly originalPath: string;
  readonly source: BinarySource;
}

export interface ContainerProgress {
  readonly stage: "project" | "images" | "helper" | "finalizing";
  readonly currentFile: string;
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export interface VisionArchiveOptions {
  readonly destination: SaveDestination;
  readonly built: V2VisionWriteSuccess;
  readonly images: readonly ResolvedProjectImage[];
  readonly onProgress?: (progress: ContainerProgress) => void;
  readonly signal?: AbortSignal;
}

export interface SvpaArchiveOptions {
  readonly destination: SaveDestination;
  readonly project: ProjectIR;
  readonly srprojXml: string;
  readonly images: readonly ResolvedProjectImage[];
  readonly language?: AppLanguage;
  /** Base used only to resolve relative paths stored by an original V1 project. */
  readonly originalProjectDirectory?: string;
  readonly helper?: Blob;
  readonly onProgress?: (progress: ContainerProgress) => void;
  readonly signal?: AbortSignal;
}

export class ContainerWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContainerWriteError";
    this.code = code;
  }
}

export async function writeVisionArchive({
  destination,
  built,
  images,
  onProgress,
  signal,
}: VisionArchiveOptions): Promise<SaveResult> {
  throwIfAborted(signal);
  const totalFiles = containerArchiveEntryCount(
    "vision",
    built.imageEntries.length,
  );
  const imageByIndex = uniqueImagesByIndex(images);
  const jsonBytes = utf8Size(built.projectJsonText);
  const imageSizes = built.imageEntries.map((entry) => {
    const image = imageByIndex.get(entry.fileIndex);
    if (!image) {
      throw new ContainerWriteError(
        "VISION_IMAGE_MISSING",
        `缺少项目图片（索引 ${entry.fileIndex}）。`,
      );
    }
    assertVisionImageIdentity(entry.source, image);
    return sourceSize(image.source);
  });
  const totalBytes = assertContainerArchiveLimits(
    totalFiles,
    [jsonBytes, ...imageSizes],
    [jsonBytes],
  );
  const output = await createZipDestination(
    destination,
    totalBytes + 4096,
    totalFiles,
    signal,
  );
  let completedBytes = 0;
  let completedFiles = 0;

  try {
    await addTextEntry(
      output.writer,
      built.projectJsonEntryName,
      built.projectJsonText,
      6,
      (loaded) =>
        emitProgress(
          onProgress,
          "project",
          built.projectJsonEntryName,
          completedFiles,
          totalFiles,
          completedBytes + loaded,
          totalBytes,
        ),
      signal,
    );
    completedBytes += jsonBytes;
    completedFiles += 1;

    for (const entry of built.imageEntries) {
      const resolved = imageByIndex.get(entry.fileIndex);
      if (!resolved) {
        throw new ContainerWriteError(
          "VISION_IMAGE_MISSING",
          `缺少项目图片（索引 ${entry.fileIndex}）。`,
        );
      }
      const size = sourceSize(resolved.source);
      await addBinaryEntry(
        output.writer,
        entry.entryName,
        resolved.source,
        (loaded) =>
          emitProgress(
            onProgress,
            "images",
            entry.entryName,
            completedFiles,
            totalFiles,
            completedBytes + loaded,
            totalBytes,
          ),
        signal,
      );
      completedBytes += size;
      completedFiles += 1;
    }
    emitProgress(
      onProgress,
      "finalizing",
      destination.fileName,
      completedFiles,
      totalFiles,
      totalBytes,
      totalBytes,
    );
    return await output.finalize();
  } catch (error) {
    await output.abort(error);
    throw error;
  }
}

function assertVisionImageIdentity(
  expected: V2VisionWriteSuccess["imageEntries"][number]["source"],
  resolved: ResolvedProjectImage,
): void {
  const expectedPath =
    expected.kind === "external" ? expected.path : expected.entryName;
  if (pathComparisonKey(expectedPath) !== pathComparisonKey(resolved.originalPath)) {
    throw new ContainerWriteError(
      "VISION_IMAGE_SOURCE_MISMATCH",
      `项目图片来源与文件索引 ${resolved.fileIndex} 不一致。`,
    );
  }
  if (
    expected.kind === "archive" &&
    (resolved.source.kind !== "archive" ||
      pathComparisonKey(expected.entryName) !==
        pathComparisonKey(resolved.source.entryName))
  ) {
    throw new ContainerWriteError(
      "VISION_IMAGE_SOURCE_MISMATCH",
      `归档图片来源与文件索引 ${resolved.fileIndex} 不一致。`,
    );
  }
}

export async function writeSvpaArchive({
  destination,
  project,
  srprojXml,
  images,
  language = "zh-CN",
  originalProjectDirectory = "",
  helper,
  onProgress,
  signal,
}: SvpaArchiveOptions): Promise<SaveResult> {
  throwIfAborted(signal);
  const orderedFiles = [...project.files].sort(
    (left, right) => left.index - right.index,
  );
  if (orderedFiles.length === 0) {
    throw new ContainerWriteError(
      "SVPA_EMPTY_PROJECT",
      "空图片项目不能生成完整 SVPA 项目包。",
    );
  }
  validateSrprojPathMultiset(srprojXml, orderedFiles);
  const imageByIndex = uniqueImagesByIndex(images);
  if (orderedFiles.length !== imageByIndex.size) {
    throw new ContainerWriteError(
      "SVPA_IMAGE_COUNT_MISMATCH",
      "项目中的每一条图片引用都必须唯一匹配一张图片。",
    );
  }
  const imageGroups = await groupSvpaImagesByOriginalPath(
    orderedFiles,
    imageByIndex,
    signal,
  );
  const totalFiles = containerArchiveEntryCount("svpa", imageGroups.length);

  const folders = packageFolders(language);
  const assignedPaths = assignSvpaImagePaths(imageGroups, folders.images);
  const projectFileName = `${safeFileStem(project.project.name)}.srproj`;
  const projectEntryName = `${folders.project}/${projectFileName}`;
  const manifest = JSON.stringify(
    {
      SchemaVersion: 1,
      Generator: "SaigeVision Project Converter",
      GeneratorVersion: APP_VERSION,
      ProjectFile: projectEntryName,
      OriginalProjectDirectory: originalProjectDirectory,
      Entries: imageGroups.map((group) => ({
        OriginalPath: group.originalPath,
        RelativePath: assignedPaths.get(group.key),
      })),
    },
    undefined,
    2,
  );
  const readme = packageReadme(language, projectFileName);
  const helperBlob = helper ?? (await loadHelper(signal));
  throwIfAborted(signal);
  const textEntrySizes = [srprojXml, manifest, readme].map(utf8Size);
  const totalBytes = assertContainerArchiveLimits(
    totalFiles,
    [
      ...textEntrySizes,
      ...imageGroups.map((group) => sourceSize(group.source)),
      helperBlob.size,
    ],
    textEntrySizes,
  );
  const output = await createZipDestination(
    destination,
    totalBytes + 8192,
    totalFiles,
    signal,
  );
  let completedFiles = 0;
  let completedBytes = 0;

  const addText = async (name: string, text: string) => {
    const size = utf8Size(text);
    await addTextEntry(
      output.writer,
      name,
      text,
      6,
      (loaded) =>
        emitProgress(
          onProgress,
          "project",
          name,
          completedFiles,
          totalFiles,
          completedBytes + loaded,
          totalBytes,
        ),
      signal,
    );
    completedBytes += size;
    completedFiles += 1;
  };

  try {
    await addText(projectEntryName, srprojXml);
    for (const group of imageGroups) {
      const path = assignedPaths.get(group.key);
      if (!path) {
        throw new ContainerWriteError(
          "SVPA_IMAGE_MISSING",
          `缺少项目图片（路径 ${redactPath(group.originalPath)}）。`,
        );
      }
      const size = sourceSize(group.source);
      await addBinaryEntry(
        output.writer,
        path,
        group.source,
        (loaded) =>
          emitProgress(
            onProgress,
            "images",
            path,
            completedFiles,
            totalFiles,
            completedBytes + loaded,
            totalBytes,
          ),
        signal,
      );
      completedBytes += size;
      completedFiles += 1;
    }
    await addText("svpa_manifest.json", manifest);
    await addText(readmeName(language), readme);
    await addBinaryEntry(
      output.writer,
      folders.helper,
      { kind: "blob", blob: helperBlob },
      (loaded) =>
        emitProgress(
          onProgress,
          "helper",
          folders.helper,
          completedFiles,
          totalFiles,
          completedBytes + loaded,
          totalBytes,
        ),
      signal,
    );
    completedBytes += helperBlob.size;
    completedFiles += 1;
    emitProgress(
      onProgress,
      "finalizing",
      destination.fileName,
      completedFiles,
      totalFiles,
      totalBytes,
      totalBytes,
    );
    return await output.finalize();
  } catch (error) {
    await output.abort(error);
    throw error;
  }
}

function uniqueImagesByIndex(
  images: readonly ResolvedProjectImage[],
): ReadonlyMap<number, ResolvedProjectImage> {
  const byIndex = new Map<number, ResolvedProjectImage>();
  for (const image of images) {
    if (byIndex.has(image.fileIndex)) {
      throw new ContainerWriteError(
        "DUPLICATE_IMAGE_INDEX",
        `图片索引 ${image.fileIndex} 出现重复映射。`,
      );
    }
    byIndex.set(image.fileIndex, image);
  }
  return byIndex;
}

async function addTextEntry(
  writer: ZipWriter<unknown>,
  name: string,
  value: string,
  level: number,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await writer.add(name, new TextReader(value), {
    level,
    onprogress: (loaded) => onProgress(loaded),
    signal,
  });
}

async function addBinaryEntry(
  writer: ZipWriter<unknown>,
  name: string,
  source: BinarySource,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (source.kind === "blob") {
    await writer.add(name, source.blob.stream(), {
      level: 0,
      onprogress: (loaded) => onProgress(loaded),
      signal,
    });
    return;
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const operations = [
    source.archive.pipeTo(source.entryName, stream.writable, undefined, controller.signal),
    writer.add(name, stream.readable, {
      level: 0,
      onprogress: (loaded) => onProgress(loaded),
      signal: controller.signal,
    }),
  ].map((operation) =>
    operation.catch((error: unknown) => {
      controller.abort(error);
      throw error;
    }),
  );
  const results = await Promise.allSettled(operations);
  signal?.removeEventListener("abort", forwardAbort);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

function sourceSize(source: BinarySource): number {
  return source.kind === "blob" ? source.blob.size : source.size;
}

/**
 * Validate the exact uncompressed resource plan that the archive writer will
 * emit. This mirrors the limits enforced when the generated archive is read
 * back, so a successful write cannot create an archive rejected by our loader.
 */
export function assertContainerArchiveLimits(
  totalFiles: number,
  entrySizes: readonly number[],
  textEntrySizes: readonly number[] = [],
): number {
  assertContainerEntryCount(totalFiles);
  if (entrySizes.length !== totalFiles) {
    throw new ContainerWriteError(
      "OUTPUT_ARCHIVE_ENTRY_COUNT_MISMATCH",
      "归档资源计划中的条目数量不一致。",
    );
  }

  for (const size of textEntrySizes) {
    assertValidEntrySize(size);
    if (size > BROWSER_ARCHIVE_LIMITS.maxTextBytes) {
      throw new ContainerWriteError(
        "OUTPUT_ARCHIVE_TEXT_ENTRY_LIMIT_EXCEEDED",
        `归档文本条目超过 ${BROWSER_ARCHIVE_LIMITS.maxTextBytes} 字节安全上限。`,
      );
    }
  }

  let totalBytes = 0;
  for (const size of entrySizes) {
    assertValidEntrySize(size);
    if (size > BROWSER_ARCHIVE_LIMITS.maxEntryBytes) {
      throw new ContainerWriteError(
        "OUTPUT_ARCHIVE_ENTRY_SIZE_LIMIT_EXCEEDED",
        `归档条目超过 ${BROWSER_ARCHIVE_LIMITS.maxEntryBytes} 字节安全上限。`,
      );
    }
    totalBytes = safeByteSum(totalBytes, size);
    if (totalBytes > BROWSER_ARCHIVE_LIMITS.maxTotalBytes) {
      throw new ContainerWriteError(
        "OUTPUT_ARCHIVE_TOTAL_SIZE_LIMIT_EXCEEDED",
        `归档未压缩总大小超过 ${BROWSER_ARCHIVE_LIMITS.maxTotalBytes} 字节安全上限。`,
      );
    }
  }
  return totalBytes;
}

export function containerArchiveEntryCount(
  format: "vision" | "svpa",
  imageEntryCount: number,
): number {
  if (!Number.isSafeInteger(imageEntryCount) || imageEntryCount < 0) {
    throw new ContainerWriteError(
      "OUTPUT_ARCHIVE_ENTRY_COUNT_INVALID",
      "归档图片条目数量无效。",
    );
  }
  const fixedEntryCount = format === "vision" ? 1 : 4;
  const totalFiles = imageEntryCount + fixedEntryCount;
  assertContainerEntryCount(totalFiles);
  return totalFiles;
}

function assertContainerEntryCount(totalFiles: number): void {
  if (!Number.isSafeInteger(totalFiles) || totalFiles < 0) {
    throw new ContainerWriteError(
      "OUTPUT_ARCHIVE_ENTRY_COUNT_INVALID",
      "归档条目数量无效。",
    );
  }
  if (totalFiles > BROWSER_ARCHIVE_LIMITS.maxEntries) {
    throw new ContainerWriteError(
      "OUTPUT_ARCHIVE_ENTRY_LIMIT_EXCEEDED",
      `归档条目数超过 ${BROWSER_ARCHIVE_LIMITS.maxEntries} 项安全上限。`,
    );
  }
}

function assertValidEntrySize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ContainerWriteError(
      "OUTPUT_ARCHIVE_ENTRY_SIZE_INVALID",
      "归档条目大小无效。",
    );
  }
}

interface SvpaImageGroup {
  readonly key: string;
  readonly originalPath: string;
  readonly fileName: string;
  readonly source: BinarySource;
}

function validateSrprojPathMultiset(
  srprojXml: string,
  files: readonly ProjectIR["files"][number][],
): void {
  const parsed = parseV1Srproj({ xmlText: srprojXml });
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostics.find(
      (item) => item.category === "security",
    ) ?? parsed.diagnostics[0];
    throw new ContainerWriteError(
      diagnostic?.category === "security"
        ? "SVPA_SRPROJ_XML_UNSAFE"
        : "SVPA_SRPROJ_XML_INVALID",
      diagnostic?.message ?? "传入的 .srproj XML 无法安全解析。",
    );
  }

  const projectPaths = pathMultiset(files.map((file) => file.sourcePath));
  const xmlPaths = pathMultiset(
    parsed.project.files.map((file) => file.sourcePath),
  );
  if (!samePathMultiset(projectPaths, xmlPaths)) {
    throw new ContainerWriteError(
      "SVPA_SRPROJ_PATH_MISMATCH",
      ".srproj 中的图片路径与 ProjectIR sourcePath 多重集合不一致。",
    );
  }
}

async function groupSvpaImagesByOriginalPath(
  files: readonly ProjectIR["files"][number][],
  images: ReadonlyMap<number, ResolvedProjectImage>,
  signal?: AbortSignal,
): Promise<readonly SvpaImageGroup[]> {
  const groups = new Map<string, SvpaImageGroup>();
  const projectIndexes = new Set(files.map((file) => file.index));
  for (const imageIndex of images.keys()) {
    if (!projectIndexes.has(imageIndex)) {
      throw new ContainerWriteError(
        "SVPA_IMAGE_INDEX_UNKNOWN",
        `图片索引 ${imageIndex} 不属于当前项目。`,
      );
    }
  }

  for (const file of files) {
    throwIfAborted(signal);
    const resolved = images.get(file.index);
    if (!resolved) {
      throw new ContainerWriteError(
        "SVPA_IMAGE_MISSING",
        `缺少项目图片（索引 ${file.index}）。`,
      );
    }

    const key = canonicalOriginalPath(file.sourcePath);
    if (!key) {
      throw new ContainerWriteError(
        "SVPA_ORIGINAL_PATH_EMPTY",
        `项目图片路径为空（索引 ${file.index}）。`,
      );
    }
    if (canonicalOriginalPath(resolved.originalPath) !== key) {
      throw new ContainerWriteError(
        "SVPA_IMAGE_PATH_MISMATCH",
        `图片解析路径与项目路径不一致（索引 ${file.index}）。`,
      );
    }

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        originalPath: file.sourcePath,
        fileName: file.fileName,
        source: resolved.source,
      });
      continue;
    }

    if (!(await binarySourcesEqual(existing.source, resolved.source, signal))) {
      throw new ContainerWriteError(
        "SVPA_IMAGE_SOURCE_CONFLICT",
        `同一原始路径解析到了不同的图片内容：${redactPath(file.sourcePath)}`,
      );
    }
  }
  return Array.from(groups.values());
}

function assignSvpaImagePaths(
  groups: readonly SvpaImageGroup[],
  imageFolder: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const relativeSource = group.source.relativePath || group.fileName;
    const preferred = `${imageFolder}/${safeRelativePath(relativeSource, index)}`;
    const { stem, suffix } = splitExtension(preferred);
    let candidate = preferred;
    let sequence = 1;
    while (used.has(entryKey(candidate))) {
      sequence += 1;
      candidate = `${stem}_${sequence}${suffix}`;
    }
    used.add(entryKey(candidate));
    result.set(group.key, candidate);
  }
  return result;
}

function pathMultiset(paths: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const path of paths) {
    const key = canonicalOriginalPath(path);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function samePathMultiset(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

function canonicalOriginalPath(value: string): string {
  return pathComparisonKey(value);
}

async function binarySourcesEqual(
  left: BinarySource,
  right: BinarySource,
  signal?: AbortSignal,
): Promise<boolean> {
  const leftSize = sourceSize(left);
  const rightSize = sourceSize(right);
  if (leftSize !== rightSize) return false;
  if (left.kind === "blob" && right.kind === "blob" && left.blob === right.blob) {
    return true;
  }
  if (
    left.kind === "archive" &&
    right.kind === "archive" &&
    left.archive === right.archive &&
    entryKey(left.entryName.replace(/\\/gu, "/")) ===
      entryKey(right.entryName.replace(/\\/gu, "/"))
  ) {
    return true;
  }
  return compareBinarySourceBytes(left, right, signal);
}

async function compareBinarySourceBytes(
  left: BinarySource,
  right: BinarySource,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const leftStream = binarySourceStream(left, signal);
  const rightStream = binarySourceStream(right, signal);
  const leftReader = leftStream.readable.getReader();
  const rightReader = rightStream.readable.getReader();
  let leftChunk: Uint8Array = new Uint8Array(0);
  let rightChunk: Uint8Array = new Uint8Array(0);
  let leftOffset = 0;
  let rightOffset = 0;
  let equal = true;

  try {
    while (true) {
      throwIfAborted(signal);
      if (leftOffset === leftChunk.byteLength) {
        const next = await leftReader.read();
        leftChunk = next.value ?? new Uint8Array(0);
        leftOffset = 0;
        if (next.done && rightOffset === rightChunk.byteLength) {
          const rightNext = await rightReader.read();
          if (!rightNext.done || (rightNext.value?.byteLength ?? 0) > 0) equal = false;
          break;
        }
        if (next.done) {
          equal = false;
          break;
        }
      }
      if (rightOffset === rightChunk.byteLength) {
        const next = await rightReader.read();
        rightChunk = next.value ?? new Uint8Array(0);
        rightOffset = 0;
        if (next.done) {
          equal = false;
          break;
        }
      }

      const length = Math.min(
        leftChunk.byteLength - leftOffset,
        rightChunk.byteLength - rightOffset,
      );
      for (let index = 0; index < length; index += 1) {
        if (leftChunk[leftOffset + index] !== rightChunk[rightOffset + index]) {
          equal = false;
          break;
        }
      }
      if (!equal) break;
      leftOffset += length;
      rightOffset += length;
    }
  } catch (error) {
    throw new ContainerWriteError(
      "SVPA_IMAGE_SOURCE_READ_FAILED",
      error instanceof Error
        ? `无法比较重复路径的图片内容：${error.message}`
        : "无法比较重复路径的图片内容。",
    );
  } finally {
    await Promise.allSettled([
      leftReader.cancel(),
      rightReader.cancel(),
      leftStream.completed,
      rightStream.completed,
    ]);
  }
  return equal;
}

function binarySourceStream(source: BinarySource, signal?: AbortSignal): {
  readonly readable: ReadableStream<Uint8Array>;
  readonly completed: Promise<void>;
} {
  if (source.kind === "blob") {
    return { readable: source.blob.stream(), completed: Promise.resolve() };
  }
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const completed = source.archive
    .pipeTo(source.entryName, stream.writable, undefined, signal)
    .catch((error: unknown) => {
      void stream.writable.abort(error).catch(() => undefined);
      throw error;
    });
  // Attach a handler immediately so a fast archive failure cannot become an
  // unhandled rejection before the reader reaches the finally block.
  void completed.catch(() => undefined);
  return { readable: stream.readable, completed };
}

function redactPath(value: string): string {
  const parts = value.replace(/\\/gu, "/").split("/").filter(Boolean);
  return parts.length <= 3 ? parts.join("/") : `…/${parts.slice(-3).join("/")}`;
}

function safeRelativePath(value: string, index: number): string {
  const segments = value
    .normalize("NFC")
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => {
      const sanitized = Array.from(segment, (character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f || '<>:"|?*'.includes(character)
          ? "_"
          : character;
      })
        .join("")
        .replace(/[ .]+$/u, "");
      const validation = validateZipEntryPath(sanitized);
      const safeName = !validation.safe && validation.reason === "reserved-name"
        ? `_${sanitized}`
        : sanitized;
      return truncateUtf8Segment(safeName, 120);
    })
    .filter(Boolean);
  while (segments.length > 2 && utf8Size(segments.join("/")) > 200) {
    segments.shift();
  }
  if (segments.length === 2 && utf8Size(segments.join("/")) > 200) {
    segments[0] = truncateUtf8Segment(segments[0], 60);
    segments[1] = truncateUtf8Segment(segments[1], 130);
  } else if (segments.length === 1) {
    segments[0] = truncateUtf8Segment(segments[0], 200);
  }
  return segments.join("/") || `image_${index + 1}`;
}

function truncateUtf8Segment(value: string, maxBytes: number): string {
  if (utf8Size(value) <= maxBytes) return value;
  const { stem, suffix } = splitExtension(value);
  const safeSuffix = utf8Size(suffix) <= 20 ? suffix : "";
  const characters = Array.from(stem);
  while (
    characters.length > 0 &&
    utf8Size(`${characters.join("")}${safeSuffix}`) > maxBytes
  ) {
    characters.pop();
  }
  return `${characters.join("") || "file"}${safeSuffix}`;
}

function splitExtension(value: string): { stem: string; suffix: string } {
  const slash = value.lastIndexOf("/");
  const dot = value.lastIndexOf(".");
  return dot > slash
    ? { stem: value.slice(0, dot), suffix: value.slice(dot) }
    : { stem: value, suffix: "" };
}

function safeFileStem(value: string): string {
  const stem = safeRelativePath(value, 0).split("/").at(-1) ?? "project";
  return stem.replace(/\.[^.]+$/u, "") || "project";
}

function entryKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function packageFolders(language: AppLanguage) {
  if (language === "ko-KR") {
    return { project: "프로젝트", images: "이미지", helper: "복구및실행.exe" };
  }
  if (language === "en-US") {
    return {
      project: "project",
      images: "images",
      helper: "RepairAndOpenProject.exe",
    };
  }
  return { project: "项目", images: "图像", helper: "一键修复并打开项目.exe" };
}

function readmeName(language: AppLanguage): string {
  if (language === "ko-KR") return "사용안내.txt";
  if (language === "en-US") return "README.txt";
  return "使用说明.txt";
}

function packageReadme(language: AppLanguage, projectFileName: string): string {
  if (language === "ko-KR") {
    return `SaigeVision 프로젝트 패키지\r\n\r\n1. ZIP을 로컬 폴더에 완전히 압축 해제합니다.\r\n2. “복구및실행.exe”를 실행합니다.\r\n3. 도구가 ${projectFileName}의 이미지 경로를 복구한 후 SaigeVision으로 엽니다.\r\n\r\n도구 SHA-256: ${EXPECTED_HELPER_SHA256}\r\n`;
  }
  if (language === "en-US") {
    return `SaigeVision project package\r\n\r\n1. Extract the entire ZIP to a local folder.\r\n2. Run “RepairAndOpenProject.exe”.\r\n3. The helper repairs image paths in ${projectFileName}, then opens it with SaigeVision.\r\n\r\nHelper SHA-256: ${EXPECTED_HELPER_SHA256}\r\n`;
  }
  return `SaigeVision 项目包\r\n\r\n1. 将 ZIP 完整解压到本机文件夹。\r\n2. 双击“一键修复并打开项目.exe”。\r\n3. 工具会修复 ${projectFileName} 中的图片路径，然后请求 SaigeVision 打开项目。\r\n\r\n工具 SHA-256：${EXPECTED_HELPER_SHA256}\r\n`;
}

async function loadHelper(signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(
    `/downloads/SaigeVisionProjectAssistant.ZipFixer.exe?sha256=${EXPECTED_HELPER_SHA256}`,
    { cache: "force-cache", signal },
  );
  if (!response.ok) {
    throw new ContainerWriteError(
      "HELPER_LOAD_FAILED",
      `无法读取路径修复工具（HTTP ${response.status}）。`,
    );
  }
  const blob = await response.blob();
  try {
    await assertHelperIntegrity(blob);
  } catch (error) {
    throw new ContainerWriteError(
      "HELPER_INTEGRITY_FAILED",
      error instanceof Error ? error.message : "路径修复工具校验失败。",
    );
  }
  return blob;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function emitProgress(
  handler: ((progress: ContainerProgress) => void) | undefined,
  stage: ContainerProgress["stage"],
  currentFile: string,
  completedFiles: number,
  totalFiles: number,
  completedBytes: number,
  totalBytes: number,
): void {
  handler?.({
    stage,
    currentFile,
    completedFiles,
    totalFiles,
    completedBytes: Math.min(completedBytes, totalBytes),
    totalBytes,
    percent:
      totalBytes > 0
        ? Math.min(100, Math.round((completedBytes / totalBytes) * 100))
        : 0,
  });
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeByteSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ContainerWriteError(
      "OUTPUT_SIZE_OVERFLOW",
      "项目大小超过当前浏览器可安全处理的范围。",
    );
  }
  return result;
}
