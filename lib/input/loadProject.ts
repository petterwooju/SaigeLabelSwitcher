import {
  ArchiveValidationError,
  assertSafeArchiveEntryName,
  canonicalArchiveName,
  normalizeArchiveEntryName,
  openValidatedZip,
  type OpenArchive,
} from "../archive/zip.ts";
import type {
  CompatibilitySummary,
  JsonObject,
  JsonValue,
  ProjectDiagnostic,
  ProjectIR,
  ProjectParseResult,
  ProjectSourceFormat,
} from "../model/project.ts";
import {
  BROWSER_ARCHIVE_LIMITS,
  exceedsUtf8ByteLimit,
  inspectJsonResourceUsage,
  PROJECT_PATH_MAX_BYTES,
  V1_PROJECT_TEXT_MAX_BYTES,
  V2_PROJECT_TEXT_MAX_BYTES,
} from "../security/resourceLimits.ts";
import { parseV1Srproj } from "./v1.ts";
import {
  parseV2SubvisionProject,
  parseV2VisionProject,
} from "./v2.ts";

export interface SvpaManifestEntry {
  readonly OriginalPath: string;
  readonly RelativePath: string;
  readonly raw: JsonObject;
}

export interface SvpaManifest {
  readonly ProjectFile: string;
  readonly OriginalProjectDirectory: string;
  readonly Entries: readonly SvpaManifestEntry[];
  readonly raw: JsonObject;
}

export interface LoadedProject {
  readonly format: ProjectSourceFormat;
  readonly sourceFile: File;
  readonly parseResult: ProjectParseResult;
  /** Present when parseResult.ok is true. */
  readonly project?: ProjectIR;
  /** Kept open for lazy image reads; callers must call close(). */
  readonly archive?: OpenArchive;
  readonly svpaManifest?: SvpaManifest;
  readonly projectJsonText?: string;
  readonly projectXmlText?: string;
  close(): Promise<void>;
}

export class ProjectLoadError extends Error {
  readonly name = "ProjectLoadError";
  readonly code: string;
  readonly details?: Readonly<Record<string, JsonValue>>;

  constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const LoadProjectError = ProjectLoadError;

const MANIFEST_NAME = "svpa_manifest.json";

/**
 * Load a browser File by its bytes, never by its suffix. ZIP images stay lazy
 * in OpenArchive and are not inflated during format detection or parsing.
 */
export async function loadProject(
  sourceFile: File,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LoadedProject> {
  const { signal } = options;
  throwIfAborted(signal);
  if (!(sourceFile instanceof Blob)) {
    throw new ProjectLoadError(
      "INPUT_NOT_FILE",
      "Project input must be a browser File or Blob-backed File.",
    );
  }

  const signature = new Uint8Array(
    await sourceFile.slice(0, Math.min(sourceFile.size, 4)).arrayBuffer(),
  );
  throwIfAborted(signal);
  if (hasZipSignature(signature)) {
    const archive = await openValidatedZip(sourceFile);
    try {
      throwIfAborted(signal);
      return await loadArchiveProject(sourceFile, archive, signal);
    } catch (error) {
      await archive.close().catch(() => undefined);
      throw error;
    }
  }

  const plainFormat = await detectPlainProjectFormat(sourceFile, signal);
  const maximumTextBytes =
    plainFormat === "v1-srproj"
      ? V1_PROJECT_TEXT_MAX_BYTES
      : V2_PROJECT_TEXT_MAX_BYTES;
  if (sourceFile.size > maximumTextBytes) {
    throw new ProjectLoadError(
      "PROJECT_TEXT_TOO_LARGE",
      "Plain project text exceeds the safe read limit for its detected format.",
      {
        size: sourceFile.size,
        maximum: maximumTextBytes,
        detectedFormat: plainFormat,
      },
    );
  }

  const text = await readUtf8File(sourceFile, signal);
  if (plainFormat === "v1-srproj") {
    const result = withExtensionDiagnostic(
      parseV1Srproj({ xmlText: text, fileName: sourceFile.name }),
      sourceFile.name,
      "v1-srproj",
    );
    return createLoadedProject({
      format: "v1-srproj",
      sourceFile,
      parseResult: result,
      projectXmlText: text,
    });
  }
  if (plainFormat === "v2-subvisionproj") {
    const result = withExtensionDiagnostic(
      parseV2SubvisionProject({ jsonText: text, fileName: sourceFile.name }),
      sourceFile.name,
      "v2-subvisionproj",
    );
    return createLoadedProject({
      format: "v2-subvisionproj",
      sourceFile,
      parseResult: result,
      projectJsonText: text,
    });
  }

  throw new ProjectLoadError(
    "INPUT_FORMAT_UNKNOWN",
    "File bytes are not V1 XML, V2 JSON, or a ZIP project container.",
    { fileName: sourceFile.name },
  );
}

async function loadArchiveProject(
  sourceFile: File,
  archive: OpenArchive,
  signal?: AbortSignal,
): Promise<LoadedProject> {
  throwIfAborted(signal);
  const names = archive.names();
  const manifestCandidates = names.filter(
    (name) => leafName(name).toLocaleLowerCase() === MANIFEST_NAME,
  );
  if (manifestCandidates.length > 0) {
    if (
      manifestCandidates.length !== 1 ||
      canonicalArchiveName(manifestCandidates[0]) !== MANIFEST_NAME
    ) {
      throw new ProjectLoadError(
        "SVPA_MANIFEST_LOCATION_INVALID",
        "SVPA must contain exactly one root-level svpa_manifest.json.",
        { manifestCount: manifestCandidates.length },
      );
    }
    const manifestEntryName = manifestCandidates[0];
    const manifestText = await archive.readText(
      manifestEntryName,
      V2_PROJECT_TEXT_MAX_BYTES,
      signal,
    );
    throwIfAborted(signal);
    // `svpa_manifest.json` is a conventional SVPA control filename, not a
    // globally reserved V2 project name. A valid V2 project may itself be
    // named `svpa_manifest`, in which case its sole root JSON entry has this
    // filename. Prefer the V2 root discriminator only when no SVPA manifest
    // fields are present; malformed or partial manifests still go through
    // strict manifest validation instead of being silently reclassified.
    if (!isV2ProjectDocumentNamedLikeManifest(manifestText)) {
      return loadSvpaProject(
        sourceFile,
        archive,
        manifestEntryName,
        signal,
        manifestText,
      );
    }
  }

  const rootJsonEntries = names.filter(
    (name) => !name.includes("/") && name.toLocaleLowerCase().endsWith(".json"),
  );
  if (rootJsonEntries.length !== 1) {
    throw new ProjectLoadError(
      "VISION_PROJECT_JSON_COUNT_INVALID",
      "A V2 .visionproj must contain exactly one root-level project JSON.",
      { rootJsonCount: rootJsonEntries.length },
    );
  }

  const projectJsonEntry = rootJsonEntries[0];
  const projectJsonText = await archive.readText(
    projectJsonEntry,
    V2_PROJECT_TEXT_MAX_BYTES,
    signal,
  );
  throwIfAborted(signal);
  const result = withExtensionDiagnostic(
    parseV2VisionProject({
      projectJsonText,
      projectJsonEntryName: projectJsonEntry,
      // Names are sufficient for schema/reference validation. Image bytes stay
      // behind OpenArchive and are read only by a later writer.
      entries: names.map((name) => ({ name })),
      fileName: sourceFile.name,
    }),
    sourceFile.name,
    "v2-visionproj",
  );
  return createLoadedProject({
    format: "v2-visionproj",
    sourceFile,
    parseResult: result,
    archive,
    projectJsonText,
  });
}

async function loadSvpaProject(
  sourceFile: File,
  archive: OpenArchive,
  manifestEntryName: string,
  signal?: AbortSignal,
  manifestTextInput?: string,
): Promise<LoadedProject> {
  const manifestText =
    manifestTextInput ??
    (await archive.readText(
      manifestEntryName,
      V2_PROJECT_TEXT_MAX_BYTES,
      signal,
    ));
  throwIfAborted(signal);
  const manifest = parseSvpaManifest(manifestText, archive);
  const projectXmlText = await archive.readText(
    manifest.ProjectFile,
    V1_PROJECT_TEXT_MAX_BYTES,
    signal,
  );
  throwIfAborted(signal);
  let result = parseV1Srproj({
    xmlText: projectXmlText,
    fileName: leafName(manifest.ProjectFile),
  });
  if (result.ok) {
    result = bindSvpaImages(result, manifest, sourceFile.name);
  }
  result = withExtensionDiagnostic(result, sourceFile.name, "v1-svpa");

  return createLoadedProject({
    format: "v1-svpa",
    sourceFile,
    parseResult: result,
    archive,
    svpaManifest: manifest,
    projectXmlText,
  });
}

function isV2ProjectDocumentNamedLikeManifest(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch {
    return false;
  }
  if (!isJsonObject(value) || !isJsonObject(value.project)) return false;
  return !(
    "ProjectFile" in value ||
    "OriginalProjectDirectory" in value ||
    "Entries" in value
  );
}

function parseSvpaManifest(text: string, archive: OpenArchive): SvpaManifest {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch (error) {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_JSON_INVALID",
      "svpa_manifest.json is not valid JSON.",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
  const usage = inspectJsonResourceUsage(value);
  if (!usage.ok) {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_RESOURCE_LIMIT",
      `svpa_manifest.json exceeds the safe JSON ${usage.reason} limit.`,
      { valueCount: usage.valueCount, maximumDepth: usage.maximumDepth },
    );
  }
  if (!isJsonObject(value)) {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_ROOT_INVALID",
      "SVPA manifest root must be an object.",
    );
  }

  const projectFileValue = requiredString(value.ProjectFile, "ProjectFile");
  const projectFile = safeManifestArchivePath(
    projectFileValue,
    "SVPA_PROJECT_PATH_UNSAFE",
  );
  if (!projectFile.toLocaleLowerCase().endsWith(".srproj")) {
    throw new ProjectLoadError(
      "SVPA_PROJECT_SUFFIX_INVALID",
      "SVPA ProjectFile must reference a .srproj entry.",
      { ProjectFile: projectFile },
    );
  }
  if (!archive.has(projectFile)) {
    throw new ProjectLoadError(
      "SVPA_PROJECT_MISSING",
      "SVPA ProjectFile does not exist in the archive.",
      { ProjectFile: projectFile },
    );
  }

  const originalProjectDirectoryValue = value.OriginalProjectDirectory;
  if (
    originalProjectDirectoryValue !== undefined &&
    typeof originalProjectDirectoryValue !== "string"
  ) {
    throw new ProjectLoadError(
      "SVPA_ORIGINAL_DIRECTORY_INVALID",
      "SVPA OriginalProjectDirectory must be a string.",
    );
  }
  const storedOriginalProjectDirectory = originalProjectDirectoryValue ?? "";
  if (
    exceedsUtf8ByteLimit(
      storedOriginalProjectDirectory,
      PROJECT_PATH_MAX_BYTES,
    )
  ) {
    throw new ProjectLoadError(
      "SVPA_ORIGINAL_DIRECTORY_INVALID",
      "SVPA OriginalProjectDirectory exceeds the safe path length limit.",
    );
  }
  const originalProjectDirectory =
    storedOriginalProjectDirectory === ""
      ? ""
      : normalizeExternalPath(
          storedOriginalProjectDirectory,
          undefined,
          "SVPA_ORIGINAL_DIRECTORY_INVALID",
        );
  if (!Array.isArray(value.Entries)) {
    throw new ProjectLoadError(
      "SVPA_ENTRIES_INVALID",
      "SVPA Entries must be an array.",
    );
  }
  if (value.Entries.length > BROWSER_ARCHIVE_LIMITS.maxEntries) {
    throw new ProjectLoadError(
      "SVPA_ENTRIES_TOO_MANY",
      `SVPA Entries exceeds the safe limit (${BROWSER_ARCHIVE_LIMITS.maxEntries}).`,
      { count: value.Entries.length },
    );
  }

  const originalTargets = new Map<string, string>();
  const entries: SvpaManifestEntry[] = [];
  for (const [index, rawEntry] of value.Entries.entries()) {
    if (!isJsonObject(rawEntry)) {
      throw new ProjectLoadError(
        "SVPA_ENTRY_INVALID",
        `SVPA Entries[${index}] must be an object.`,
      );
    }
    const originalPath = normalizeExternalPath(
      requiredString(
        rawEntry.OriginalPath,
        `Entries[${index}].OriginalPath`,
      ),
      originalProjectDirectory || undefined,
      "SVPA_ORIGINAL_PATH_INVALID",
      true,
    );
    const relativePath = safeManifestArchivePath(
      requiredString(
        rawEntry.RelativePath,
        `Entries[${index}].RelativePath`,
      ),
      "SVPA_RELATIVE_PATH_UNSAFE",
    );
    const relativeKey = canonicalArchiveName(relativePath);
    const originalKey = canonicalExternalPath(originalPath);
    const existingTarget = originalTargets.get(originalKey);
    if (existingTarget !== undefined) {
      throw new ProjectLoadError(
        existingTarget === relativeKey
          ? "SVPA_ORIGINAL_PATH_DUPLICATE"
          : "SVPA_ORIGINAL_PATH_CONFLICT",
        existingTarget === relativeKey
          ? `SVPA Entries[${index}].OriginalPath is duplicated.`
          : `SVPA Entries[${index}].OriginalPath points to conflicting archive entries.`,
        { OriginalPath: originalPath, RelativePath: relativePath },
      );
    }
    if (
      relativeKey === canonicalArchiveName(projectFile) ||
      relativeKey === MANIFEST_NAME
    ) {
      throw new ProjectLoadError(
        "SVPA_IMAGE_REFERENCE_INVALID",
        "SVPA image entries cannot reference the manifest or project XML.",
        { RelativePath: relativePath },
      );
    }
    if (!archive.has(relativePath)) {
      throw new ProjectLoadError(
        "SVPA_IMAGE_MISSING",
        `SVPA Entries[${index}].RelativePath does not exist in the archive.`,
        { RelativePath: relativePath },
      );
    }
    originalTargets.set(originalKey, relativeKey);
    entries.push({ OriginalPath: originalPath, RelativePath: relativePath, raw: rawEntry });
  }

  return {
    ProjectFile: projectFile,
    OriginalProjectDirectory: originalProjectDirectory,
    Entries: entries,
    raw: value,
  };
}

function bindSvpaImages(
  result: Extract<ProjectParseResult, { readonly ok: true }>,
  manifest: SvpaManifest,
  outerFileName: string,
): ProjectParseResult {
  const entriesByOriginalPath = new Map(
    manifest.Entries.map((entry) => [canonicalExternalPath(entry.OriginalPath), entry]),
  );
  const usedEntries = new Set<string>();
  const files = result.project.files.map((file, index) => {
    const normalizedSourcePath = normalizeExternalPath(
      file.sourcePath,
      manifest.OriginalProjectDirectory || undefined,
      "SVPA_PROJECT_IMAGE_PATH_UNSAFE",
      true,
    );
    const key = canonicalExternalPath(normalizedSourcePath);
    const entry = entriesByOriginalPath.get(key);
    if (!entry) {
      throw new ProjectLoadError(
        "SVPA_PROJECT_IMAGE_UNMAPPED",
        `Project image ${index} has no unique manifest mapping.`,
        {
          sourcePath: file.sourcePath,
          normalizedSourcePath,
          OriginalProjectDirectory: manifest.OriginalProjectDirectory,
        },
      );
    }
    usedEntries.add(key);
    return {
      ...file,
      // The XML may store a relative or quoted path while the desktop SVPA
      // exporter records its resolved absolute path in the manifest. Keep the
      // resolved path in the IR so later lightweight exports do not re-emit a
      // path that only made sense beside the original .srproj file.
      sourcePath: entry.OriginalPath,
      normalizedPath: entry.OriginalPath,
      image: { kind: "archive" as const, entryName: entry.RelativePath },
    };
  });
  if (usedEntries.size !== manifest.Entries.length) {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_ENTRY_UNUSED",
      "SVPA manifest contains image entries not referenced by the project XML.",
      {
        manifestEntryCount: manifest.Entries.length,
        projectImageCount: result.project.files.length,
      },
    );
  }

  const project: ProjectIR = {
    ...result.project,
    source: {
      ...result.project.source,
      format: "v1-svpa",
      fileName: outerFileName,
    },
    files,
    compatibility: result.compatibility,
  };
  return { ...result, project };
}

function createLoadedProject(input: {
  readonly format: ProjectSourceFormat;
  readonly sourceFile: File;
  readonly parseResult: ProjectParseResult;
  readonly archive?: OpenArchive;
  readonly svpaManifest?: SvpaManifest;
  readonly projectJsonText?: string;
  readonly projectXmlText?: string;
}): LoadedProject {
  let closed = false;
  return {
    ...input,
    ...(input.parseResult.ok ? { project: input.parseResult.project } : {}),
    async close() {
      if (closed) return;
      closed = true;
      await input.archive?.close();
    },
  };
}

function withExtensionDiagnostic(
  result: ProjectParseResult,
  fileName: string,
  format: ProjectSourceFormat,
): ProjectParseResult {
  const expected = expectedExtension(format);
  if (fileName.toLocaleLowerCase().endsWith(expected)) return result;
  const diagnostic: ProjectDiagnostic = {
    code: "INPUT_EXTENSION_MISMATCH",
    category: "validation",
    severity: "warning",
    disposition: "preserve",
    path: "$.source.fileName",
    message: `File content is ${format}, but the name does not end with '${expected}'. Content detection was used.`,
    details: { fileName, detectedFormat: format, expectedExtension: expected },
  };
  const compatibility: CompatibilitySummary = {
    ...result.compatibility,
    preserveCount: result.compatibility.preserveCount + 1,
  };
  return result.ok
    ? {
        ...result,
        diagnostics: [...result.diagnostics, diagnostic],
        compatibility,
      }
    : {
        ...result,
        diagnostics: [...result.diagnostics, diagnostic],
        compatibility,
      };
}

function expectedExtension(format: ProjectSourceFormat): string {
  switch (format) {
    case "v1-srproj": return ".srproj";
    case "v1-svpa": return ".zip";
    case "v2-visionproj": return ".visionproj";
    case "v2-subvisionproj": return ".subvisionproj";
  }
}

function safeManifestArchivePath(value: string, code: string): string {
  const normalized = normalizeArchiveEntryName(value);
  try {
    assertSafeArchiveEntryName(normalized);
  } catch (error) {
    if (error instanceof ArchiveValidationError) {
      throw new ProjectLoadError(code, error.message, { path: value });
    }
    throw error;
  }
  return normalized;
}

function requiredString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_FIELD_INVALID",
      `SVPA manifest '${path}' must be a non-empty string.`,
    );
  }
  if (value !== value.trim()) {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_FIELD_INVALID",
      `SVPA manifest '${path}' must not have surrounding whitespace.`,
    );
  }
  if (exceedsUtf8ByteLimit(value, PROJECT_PATH_MAX_BYTES)) {
    throw new ProjectLoadError(
      "SVPA_MANIFEST_FIELD_INVALID",
      `SVPA manifest '${path}' exceeds the safe path length limit.`,
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalExternalPath(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

interface ExternalPathParts {
  readonly root: string;
  readonly absolute: boolean;
  readonly segments: readonly string[];
}

/** Normalize Windows drive, UNC, POSIX, and relative paths without filesystem I/O. */
function normalizeExternalPath(
  value: string,
  baseDirectory: string | undefined,
  code: string,
  allowUnresolvedRelativeParent = false,
): string {
  const parsed = parseExternalPath(value, code);
  if (
    !parsed.absolute &&
    !baseDirectory &&
    parsed.segments.includes("..") &&
    !allowUnresolvedRelativeParent
  ) {
    throw new ProjectLoadError(
      code,
      "Relative parent segments require a trusted original project directory in this context.",
      { path: value },
    );
  }
  let parts = parsed;
  if (!parsed.absolute && baseDirectory) {
    const base = parseExternalPath(baseDirectory, code);
    parts = {
      root: base.root,
      absolute: base.absolute,
      segments: collapseExternalSegments(
        [...base.segments, ...parsed.segments],
        base.absolute,
        value,
        code,
      ),
    };
  }
  const normalized = renderExternalPath(parts);
  if (!normalized) {
    throw new ProjectLoadError(code, "External image path resolves to an empty path.", {
      path: value,
    });
  }
  return normalized;
}

function parseExternalPath(value: string, code: string): ExternalPathParts {
  const unquoted = stripExternalPathQuotes(value, code);
  const externalPath = decodeFileUrl(unquoted, code);
  const slashed = externalPath.normalize("NFC").replaceAll("\\", "/");
  if (!slashed || slashed.includes("\0")) {
    throw new ProjectLoadError(code, "External image path is empty or contains NUL.", {
      path: value,
    });
  }
  if (/^[a-z]:[^/]/iu.test(slashed)) {
    throw new ProjectLoadError(
      code,
      "Drive-relative Windows paths are ambiguous and cannot be resolved safely.",
      { path: value },
    );
  }

  let root = "";
  let absolute = false;
  let rawSegments: string[];
  if (/^\/{2,}/u.test(slashed)) {
    const uncSegments = slashed.replace(/^\/+/u, "").split(/\/+/u);
    const server = uncSegments.shift();
    const share = uncSegments.shift();
    if (!server || !share || server === "." || server === ".." || share === "." || share === "..") {
      throw new ProjectLoadError(
        code,
        "UNC paths must include a server and share name.",
        { path: value },
      );
    }
    assertExternalSegment(server, value, code);
    assertExternalSegment(share, value, code);
    root = `//${server}/${share}`;
    absolute = true;
    rawSegments = uncSegments;
  } else {
    const drive = /^([a-z]):\/+/iu.exec(slashed);
    if (drive) {
      root = `${drive[1].toLocaleUpperCase("en-US")}:`;
      absolute = true;
      rawSegments = slashed.slice(drive[0].length).split(/\/+/u);
    } else if (slashed.startsWith("/")) {
      root = "/";
      absolute = true;
      rawSegments = slashed.replace(/^\/+/u, "").split(/\/+/u);
    } else {
      rawSegments = slashed.split(/\/+/u);
    }
  }

  return {
    root,
    absolute,
    segments: collapseExternalSegments(rawSegments, absolute, value, code),
  };
}

function decodeFileUrl(value: string, code: string): string {
  if (!/^file:\/\//iu.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Unsupported file URL components.");
    }
    const decodedPath = decodeURIComponent(url.pathname);
    const host = url.hostname;
    if (host && host.toLocaleLowerCase("en-US") !== "localhost") {
      return `//${host}${decodedPath}`;
    }
    return /^\/[a-z]:\//iu.test(decodedPath) ? decodedPath.slice(1) : decodedPath;
  } catch (error) {
    throw new ProjectLoadError(code, "External file URL is invalid.", {
      path: value,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function collapseExternalSegments(
  input: readonly string[],
  absolute: boolean,
  originalPath: string,
  code: string,
): string[] {
  const result: string[] = [];
  for (const segment of input) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (result.length > 0 && result.at(-1) !== "..") {
        result.pop();
      } else if (absolute) {
        throw new ProjectLoadError(
          code,
          "External path traversal escapes its drive/share root.",
          { path: originalPath },
        );
      } else {
        result.push(segment);
      }
      continue;
    }
    assertExternalSegment(segment, originalPath, code);
    result.push(segment);
  }
  return result;
}

function assertExternalSegment(segment: string, originalPath: string, code: string): void {
  if (
    [...segment].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point === 0 || point < 0x20 || '<>:"|?*'.includes(character);
    })
  ) {
    throw new ProjectLoadError(
      code,
      "External path contains characters forbidden in Windows file names.",
      { path: originalPath },
    );
  }
}

function stripExternalPathQuotes(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const unquoted = trimmed.slice(1, -1).trim();
      if (!unquoted) {
        throw new ProjectLoadError(code, "Quoted external image path is empty.", {
          path: value,
        });
      }
      return unquoted;
    }
  }
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    throw new ProjectLoadError(code, "External image path has unmatched quotes.", {
      path: value,
    });
  }
  return trimmed;
}

function renderExternalPath(parts: ExternalPathParts): string {
  const suffix = parts.segments.join("/");
  if (!parts.root) return suffix;
  if (parts.root === "/") return suffix ? `/${suffix}` : "/";
  return suffix ? `${parts.root}/${suffix}` : `${parts.root}/`;
}

function leafName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (
    (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08)
  );
}

type PlainProjectFormat = "v1-srproj" | "v2-subvisionproj" | "unknown";

/**
 * Identify the plain-text format from a bounded, streaming prefix before
 * applying its format-specific byte ceiling. This prevents a 16–32 MiB JSON
 * document from borrowing the larger V1 XML allowance while still accepting
 * contour-heavy V1 XML without materializing an over-limit file.
 */
async function detectPlainProjectFormat(
  file: File,
  signal?: AbortSignal,
): Promise<PlainProjectFormat> {
  const chunkSize = 64 * 1024;
  const scanLimit = Math.min(file.size, V1_PROJECT_TEXT_MAX_BYTES);
  let offset = 0;
  let firstChunk = true;

  while (offset < scanLimit) {
    throwIfAborted(signal);
    const end = Math.min(offset + chunkSize, scanLimit);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    throwIfAborted(signal);
    let index = 0;
    if (
      firstChunk &&
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      index = 3;
    }
    firstChunk = false;
    for (; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) {
        continue;
      }
      if (byte === 0x3c) return "v1-srproj";
      if (byte === 0x7b) return "v2-subvisionproj";
      return "unknown";
    }
    offset = end;
  }
  return "unknown";
}

async function readUtf8File(file: File, signal?: AbortSignal): Promise<string> {
  try {
    throwIfAborted(signal);
    const bytes = await file.arrayBuffer();
    throwIfAborted(signal);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ProjectLoadError(
      "PROJECT_TEXT_UTF8_INVALID",
      "Plain project files must be valid UTF-8.",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}
