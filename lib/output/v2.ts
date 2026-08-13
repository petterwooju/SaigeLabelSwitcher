import type {
  ImageSourceIR,
  JsonObject,
  JsonValue,
  ProjectClassIR,
  ProjectDiagnostic,
  ProjectFileIR,
  ProjectIR,
  SplitType,
} from "../model/project.ts";
import { validateZipEntryPath } from "../security/paths.ts";

const CLASS_COLORS = [
  "#CC3F31",
  "#2F80ED",
  "#27AE60",
  "#F2994A",
  "#9B51E0",
  "#00A3A3",
  "#EB5757",
  "#6FCF97",
  "#56CCF2",
  "#F2C94C",
] as const;

const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

type MutableJsonValue =
  | string
  | number
  | boolean
  | null
  | MutableJsonObject
  | MutableJsonValue[];

interface MutableJsonObject {
  [key: string]: MutableJsonValue;
}

export interface V2WriterOptions {
  /** JSON indentation. The default is compact JSON, matching observed files. */
  readonly space?: number;
}

export interface V2SubvisionWriterOptions extends V2WriterOptions {
  readonly fileName?: string;
  /** Required when an archive-backed image has no usable external path. */
  readonly externalPaths?: Readonly<Record<number, string>>;
}

export interface V2VisionWriterOptions extends V2WriterOptions {
  readonly fileName?: string;
  readonly projectJsonEntryName?: string;
}

export interface V2VisionImageEntry {
  readonly fileIndex: number;
  readonly sourceFileId?: number | string;
  readonly entryName: string;
  /** The archive/save adapter resolves this source and writes it to entryName. */
  readonly source: ImageSourceIR;
  readonly bytes?: Uint8Array;
}

export interface V2WriteFailure {
  readonly ok: false;
  readonly diagnostics: readonly ProjectDiagnostic[];
}

export interface V2SubvisionWriteSuccess {
  readonly ok: true;
  readonly format: "v2-subvisionproj";
  readonly fileName: string;
  readonly json: JsonObject;
  readonly jsonText: string;
  readonly diagnostics: readonly ProjectDiagnostic[];
}

export interface V2VisionWriteSuccess {
  readonly ok: true;
  readonly format: "v2-visionproj";
  readonly fileName: string;
  readonly projectJsonEntryName: string;
  readonly json: JsonObject;
  readonly projectJsonText: string;
  readonly imageEntries: readonly V2VisionImageEntry[];
  readonly diagnostics: readonly ProjectDiagnostic[];
}

export type V2SubvisionWriteResult = V2SubvisionWriteSuccess | V2WriteFailure;
export type V2VisionWriteResult = V2VisionWriteSuccess | V2WriteFailure;

/**
 * Build the text of a lightweight V2 project. It never reads image files.
 */
export function writeV2SubvisionProject(
  project: ProjectIR,
  options: V2SubvisionWriterOptions = {},
): V2SubvisionWriteResult {
  const diagnostics: ProjectDiagnostic[] = [];
  if (!validateSupportedProject(project, diagnostics)) {
    return { ok: false, diagnostics };
  }

  const paths = [...project.files]
    .sort((left, right) => left.index - right.index)
    .map((file) => {
      const override = options.externalPaths?.[file.index];
      if (override?.trim()) {
        return validateExternalPath(override, file.index, diagnostics);
      }
      const retainedPath =
        project.source.format === "v2-subvisionproj"
          ? jsonString(file.raw.filePath)
          : undefined;
      if (retainedPath?.trim()) {
        return validateExternalPath(retainedPath, file.index, diagnostics);
      }
      if (file.image.kind === "external" && file.image.path.trim()) {
        return validateExternalPath(file.image.path, file.index, diagnostics);
      }
      block(
        diagnostics,
        "V2_WRITE_EXTERNAL_PATH_REQUIRED",
        `$.files[${file.index}].image`,
        "A .subvisionproj requires an external image path for every archive-backed file.",
      );
      return "";
    });
  const pathKeys = new Map<string, number>();
  paths.forEach((path, index) => {
    if (!path) return;
    const key = path
      .replaceAll("\\", "/")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    const previousIndex = pathKeys.get(key);
    if (previousIndex !== undefined) {
      block(
        diagnostics,
        "V2_WRITE_EXTERNAL_PATH_DUPLICATE",
        `$.files[${index}].image`,
        `The external image path duplicates file ${previousIndex} after slash, Unicode, and case normalization.`,
      );
      return;
    }
    pathKeys.set(key, index);
  });
  if (hasBlockingDiagnostic(diagnostics)) {
    return { ok: false, diagnostics };
  }

  const json = buildProjectJson(project, paths, diagnostics);
  if (!json || hasBlockingDiagnostic(diagnostics)) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    format: "v2-subvisionproj",
    fileName:
      options.fileName ?? `${safeOutputStem(project.project.name)}.subvisionproj`,
    json,
    jsonText: stringifyProject(json, options.space),
    diagnostics,
  };
}

/**
 * Build the project JSON and an image source-to-entry mapping for a complete
 * V2 archive. ZIP creation intentionally belongs to the save adapter.
 */
export function writeV2VisionProject(
  project: ProjectIR,
  options: V2VisionWriterOptions = {},
): V2VisionWriteResult {
  const diagnostics: ProjectDiagnostic[] = [];
  if (!validateSupportedProject(project, diagnostics)) {
    return { ok: false, diagnostics };
  }

  const imageEntries = buildImageEntries(project.files);
  const json = buildProjectJson(
    project,
    imageEntries.map((entry) => entry.entryName),
    diagnostics,
  );
  if (!json || hasBlockingDiagnostic(diagnostics)) {
    return { ok: false, diagnostics };
  }

  const requestedJsonEntry = options.projectJsonEntryName?.trim();
  const preservedJsonEntry =
    project.source.format === "v2-visionproj"
      ? project.source.projectJsonEntry
      : undefined;
  const projectJsonEntryName = safeRootJsonEntry(
    requestedJsonEntry ?? preservedJsonEntry,
    project.project.name,
  );

  return {
    ok: true,
    format: "v2-visionproj",
    fileName: options.fileName ?? `${safeOutputStem(project.project.name)}.visionproj`,
    projectJsonEntryName,
    json,
    projectJsonText: stringifyProject(json, options.space),
    imageEntries,
    diagnostics,
  };
}

export const buildV2SubvisionProject = writeV2SubvisionProject;
export const buildV2VisionProject = writeV2VisionProject;

function validateSupportedProject(
  project: ProjectIR,
  diagnostics: ProjectDiagnostic[],
): boolean {
  if (project.project.type === "unknown") {
    block(
      diagnostics,
      "V2_WRITE_PROJECT_TYPE_UNSUPPORTED",
      "$.project.type",
      `Unknown project type '${project.project.rawType}' cannot be written safely.`,
    );
    return false;
  }
  if (project.project.type !== "classification") {
    block(
      diagnostics,
      "V2_WRITE_GOLDEN_REQUIRED",
      "$.project.type",
      `${project.project.type} output is disabled until a verified V2 golden project is available.`,
    );
    return false;
  }
  if (!project.project.name.trim()) {
    block(
      diagnostics,
      "V2_WRITE_PROJECT_NAME_REQUIRED",
      "$.project.name",
      "A V2 project name is required.",
    );
    return false;
  }
  return true;
}

function buildProjectJson(
  project: ProjectIR,
  filePaths: readonly string[],
  diagnostics: ProjectDiagnostic[],
): JsonObject | undefined {
  if (filePaths.length !== project.files.length) {
    block(
      diagnostics,
      "V2_WRITE_FILE_PATH_COUNT_MISMATCH",
      "$.project.projectFiles",
      "The generated file path count does not match the project file count.",
    );
    return undefined;
  }
  return isV2Source(project)
    ? cloneV2JsonWithPaths(project, filePaths, diagnostics)
    : buildClassificationJson(project, filePaths, diagnostics);
}

/** Preserve every parsed V2 field, changing only projectFiles[].filePath. */
function cloneV2JsonWithPaths(
  project: ProjectIR,
  filePaths: readonly string[],
  diagnostics: ProjectDiagnostic[],
): JsonObject | undefined {
  const root = cloneObject(project.raw);
  const projectRaw = mutableObject(root.project);
  const rawFiles = mutableObjectArray(projectRaw?.projectFiles);
  if (!projectRaw || !rawFiles) {
    block(
      diagnostics,
      "V2_WRITE_RAW_SCHEMA_INVALID",
      "$.project.projectFiles",
      "The retained V2 source does not contain a writable projectFiles array.",
    );
    return undefined;
  }
  if (rawFiles.length !== project.files.length) {
    block(
      diagnostics,
      "V2_WRITE_RAW_FILE_COUNT_MISMATCH",
      "$.project.projectFiles",
      "The retained V2 file count differs from the normalized project.",
    );
    return undefined;
  }

  rawFiles.forEach((file, index) => {
    file.filePath = filePaths[index] ?? "";
  });
  return root;
}

function buildClassificationJson(
  project: ProjectIR,
  filePaths: readonly string[],
  diagnostics: ProjectDiagnostic[],
): JsonObject | undefined {
  const classes = [...project.classes].sort((left, right) => left.index - right.index);
  const files = [...project.files].sort((left, right) => left.index - right.index);
  if (!validateCanonicalIndexes(classes, files, diagnostics)) return undefined;
  if (project.datasets.length > 1) {
    block(
      diagnostics,
      "V2_WRITE_MULTIPLE_DATASETS_UNSUPPORTED",
      "$.datasets",
      "Strict V1-to-V2 classification output supports one generated dataset.",
    );
    return undefined;
  }

  const timestamp = deterministicTimestamp(project);
  const projectId = deterministicProjectId(project);
  const datasetId = projectId + 1;
  const splitId = projectId + 2;
  const datasetName =
    project.datasets[0]?.name.trim() || project.project.name.trim() || "dataset";
  const classByIndex = new Map(classes.map((item) => [item.index, item]));
  const classIdByIndex = new Map(
    classes.map((item) => [item.index, projectId + 10 + item.index]),
  );

  const classInfos: MutableJsonObject[] = classes.map((item) => ({
    projectId,
    classId: classIdByIndex.get(item.index) ?? projectId + 10 + item.index,
    classNo: item.index,
    classSeq: item.index,
    className: item.name,
    description: item.description,
    classColor: normalizedClassColor(item, item.index),
    isNg: item.isNg ?? false,
  }));

  let nextLabelId = projectId + 100_000;
  const fileJson: MutableJsonObject[] = files.map((file, outputIndex) => {
    const path = `$.files[${file.index}]`;
    if (!isPositiveFinite(file.width) || !isPositiveFinite(file.height)) {
      block(
        diagnostics,
        "V2_WRITE_IMAGE_DIMENSIONS_REQUIRED",
        path,
        "Strict classification output requires positive image width and height.",
      );
    }
    const classIndex = classificationClassIndex(file, diagnostics);
    const cls = classIndex === undefined ? undefined : classByIndex.get(classIndex);
    const classId =
      classIndex === undefined ? undefined : classIdByIndex.get(classIndex);
    if (classIndex !== undefined && (!cls || classId === undefined)) {
      block(
        diagnostics,
        "V2_WRITE_CLASS_REFERENCE_INVALID",
        `${path}.classificationClassIndex`,
        `Classification class index ${classIndex} does not exist.`,
      );
    }
    const splitType = v2SplitType(file.canonicalSplit, diagnostics, path);
    const labels: MutableJsonObject[] = [];
    if (
      cls &&
      classId !== undefined &&
      isPositiveFinite(file.width) &&
      isPositiveFinite(file.height)
    ) {
      const width = file.width;
      const height = file.height;
      const labelId = nextLabelId;
      nextLabelId += 1;
      labels.push({
        labelId,
        labelType: "man",
        labelPosX: 0,
        labelPosY: 0,
        labelWidth: width,
        labelHeight: height,
        className: cls.name,
        classColor: normalizedClassColor(cls, cls.index),
        classId,
        labeledDate: timestamp,
        labelContour: JSON.stringify([
          [
            [0, 0],
            [width, 0],
            [width, height],
            [0, height],
          ],
        ]),
        contourSize: width * height,
        contourId: deterministicUuid(`${projectId}:label:${labelId}`),
      });
    }

    return {
      projectId,
      fileId: projectId + 1_000 + outputIndex,
      filePath: filePaths[file.index] ?? filePaths[outputIndex] ?? "",
      isLabeled: labels.length > 0,
      modifiedDate: timestamp,
      assignedDate: timestamp,
      datasetName,
      ...(file.width !== undefined ? { width: file.width } : {}),
      ...(file.height !== undefined ? { height: file.height } : {}),
      labelDataList: labels,
      metadata: [],
      registeredDate: timestamp,
      splitSets: [
        { splitId, splitName: "default", splitType },
      ],
    };
  });

  if (hasBlockingDiagnostic(diagnostics)) return undefined;

  const root: MutableJsonObject = {
    project: {
      projectId,
      projectName: project.project.name,
      projectType: "cls",
      description: project.project.description,
      roiMode: project.project.roiMode || "no",
      modifiedDate: timestamp,
      createdDate: timestamp,
      metadataList: [],
      classInfos,
      datasets: [
        {
          datasetId,
          datasetName,
          description: project.datasets[0]?.description ?? "",
          modifiedDate: timestamp,
          createdDate: timestamp,
          createdBy: "admin",
          projects: [],
          metadataList: [],
          splitSets: [{ splitId, splitName: "default", createdDate: timestamp }],
        },
      ],
      projectFiles: fileJson,
    },
  };
  return root;
}

function validateCanonicalIndexes(
  classes: readonly ProjectClassIR[],
  files: readonly ProjectFileIR[],
  diagnostics: ProjectDiagnostic[],
): boolean {
  const classIndexes = classes.map((item) => item.index);
  const fileIndexes = files.map((item) => item.index);
  if (!isZeroBasedContiguous(classIndexes)) {
    block(
      diagnostics,
      "V2_WRITE_CLASS_INDEX_INVALID",
      "$.classes",
      "Class indexes must be unique, contiguous, and zero-based.",
    );
  }
  if (!isZeroBasedContiguous(fileIndexes)) {
    block(
      diagnostics,
      "V2_WRITE_FILE_INDEX_INVALID",
      "$.files",
      "File indexes must be unique, contiguous, and zero-based.",
    );
  }
  const classNames = classes.map((item) => item.name.trim());
  if (classNames.some((name) => !name)) {
    block(
      diagnostics,
      "V2_WRITE_CLASS_NAME_REQUIRED",
      "$.classes",
      "Every V2 class requires a non-empty name.",
    );
  }
  const normalizedNames = classNames.map((name) =>
    name.normalize("NFKC").toLocaleLowerCase("en-US"),
  );
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    block(
      diagnostics,
      "V2_WRITE_CLASS_NAME_DUPLICATE",
      "$.classes",
      "V2 class names must be unique.",
    );
  }
  return !hasBlockingDiagnostic(diagnostics);
}

function classificationClassIndex(
  file: ProjectFileIR,
  diagnostics: ProjectDiagnostic[],
): number | undefined {
  if (file.labels.some((label) => label.kind !== "classification")) {
    block(
      diagnostics,
      "V2_WRITE_CLASSIFICATION_OBJECT_LABEL",
      `$.files[${file.index}].labels`,
      "A classification project cannot contain object-level labels.",
    );
  }
  const labelIndexes = Array.from(
    new Set(
      file.labels
        .filter((label) => label.kind === "classification")
        .map((label) => label.classIndex)
        .filter((value): value is number => value !== undefined),
    ),
  );
  if (labelIndexes.length > 1) {
    block(
      diagnostics,
      "V2_WRITE_CLASSIFICATION_LABEL_CONFLICT",
      `$.files[${file.index}].labels`,
      "A classification image cannot refer to multiple classes.",
    );
    return undefined;
  }
  const labelIndex = labelIndexes[0];
  if (
    file.classificationClassIndex !== undefined &&
    labelIndex !== undefined &&
    file.classificationClassIndex !== labelIndex
  ) {
    block(
      diagnostics,
      "V2_WRITE_CLASSIFICATION_LABEL_CONFLICT",
      `$.files[${file.index}].classificationClassIndex`,
      "The file-level class and classification label disagree.",
    );
    return undefined;
  }
  const result = file.classificationClassIndex ?? labelIndex;
  if (file.isLabeled === false && result !== undefined) {
    block(
      diagnostics,
      "V2_WRITE_CLASSIFICATION_STATE_CONFLICT",
      `$.files[${file.index}].isLabeled`,
      "An explicitly unlabeled image cannot also carry a classification class.",
    );
  }
  if (file.isLabeled === true && result === undefined) {
    block(
      diagnostics,
      "V2_WRITE_LABELED_FILE_CLASS_REQUIRED",
      `$.files[${file.index}].classificationClassIndex`,
      "A labeled classification image requires a class.",
    );
  }
  return result;
}

function v2SplitType(
  split: SplitType,
  diagnostics: ProjectDiagnostic[],
  path: string,
): string {
  switch (split) {
    case "training":
      return "train";
    case "validation":
      return "valid";
    case "unassigned":
      return "not-split";
    case "unknown":
      block(
        diagnostics,
        "V2_WRITE_SPLIT_UNSUPPORTED",
        `${path}.canonicalSplit`,
        "An unknown split cannot be written to V2.",
      );
      return "not-split";
  }
}

function buildImageEntries(
  files: readonly ProjectFileIR[],
): V2VisionImageEntry[] {
  const used = new Set<string>();
  return [...files]
    .sort((left, right) => left.index - right.index)
    .map((file) => {
      const entryName = uniqueImageEntryName(file, used);
      return {
        fileIndex: file.index,
        ...(file.sourceId !== undefined ? { sourceFileId: file.sourceId } : {}),
        entryName,
        source: file.image,
        ...(file.image.kind === "archive" && file.image.bytes
          ? { bytes: file.image.bytes }
          : {}),
      };
    });
}

function uniqueImageEntryName(file: ProjectFileIR, used: Set<string>): string {
  if (file.image.kind === "archive") {
    const validation = validateZipEntryPath(file.image.entryName);
    if (
      validation.safe &&
      validation.normalizedPath.toLocaleLowerCase("en-US").startsWith("images/") &&
      !used.has(entryKey(validation.normalizedPath))
    ) {
      used.add(entryKey(validation.normalizedPath));
      return validation.normalizedPath;
    }
  }

  const sourceName =
    lastPathSegment(file.fileName) ||
    lastPathSegment(file.sourcePath) ||
    `image_${file.index + 1}`;
  const safeName = safeImageFileName(sourceName, file.index);
  const { stem, suffix } = splitExtension(safeName);
  let sequence = 1;
  let candidate = `images/${safeName}`;
  while (used.has(entryKey(candidate))) {
    sequence += 1;
    candidate = `images/${stem}_${sequence}${suffix}`;
  }
  used.add(entryKey(candidate));
  return candidate;
}

function deterministicProjectId(project: ProjectIR): number {
  const identity = JSON.stringify({
    name: project.project.name,
    classes: [...project.classes]
      .sort((left, right) => left.index - right.index)
      .map((item) => [item.index, item.name]),
    files: [...project.files]
      .sort((left, right) => left.index - right.index)
      .map((item) => [item.index, item.normalizedPath, item.fileName]),
  });
  return 100_000 + (fnv1a(identity) % 700_000);
}

function deterministicTimestamp(project: ProjectIR): number {
  const candidate = project.project.modifiedAt ?? project.project.createdAt;
  return candidate !== undefined && Number.isFinite(candidate)
    ? Math.max(0, Math.trunc(candidate))
    : 0;
}

function deterministicUuid(value: string): string {
  const parts = [
    fnv1a(`a:${value}`),
    fnv1a(`b:${value}`),
    fnv1a(`c:${value}`),
    fnv1a(`d:${value}`),
  ]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
  return `${parts.slice(0, 8)}-${parts.slice(8, 12)}-4${parts.slice(13, 16)}-8${parts.slice(17, 20)}-${parts.slice(20, 32)}`;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizedClassColor(cls: ProjectClassIR, index: number): string {
  const color = cls.color?.trim();
  if (color && /^#[\da-f]{6}$/iu.test(color)) return color.toUpperCase();
  if (color && /^#[\da-f]{8}$/iu.test(color)) {
    return `#${color.slice(-6).toUpperCase()}`;
  }
  return CLASS_COLORS[index % CLASS_COLORS.length] ?? CLASS_COLORS[0];
}

function validateExternalPath(
  rawPath: string,
  fileIndex: number,
  diagnostics: ProjectDiagnostic[],
): string {
  const diagnosticPath = `$.files[${fileIndex}].image`;
  if (
    Array.from(rawPath).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    block(
      diagnostics,
      "V2_WRITE_EXTERNAL_PATH_CONTROL_CHARACTER",
      diagnosticPath,
      "A .subvisionproj image path cannot contain control characters.",
    );
    return "";
  }

  const trimmed = rawPath.trim();
  const first = trimmed.at(0);
  const unquoted =
    trimmed.length >= 2 &&
    (first === '"' || first === "'") &&
    trimmed.at(-1) === first
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  const normalized = unquoted.replaceAll("\\", "/");

  if (normalized.split("/").some((segment) => segment === "..")) {
    block(
      diagnostics,
      "V2_WRITE_EXTERNAL_PATH_TRAVERSAL",
      diagnosticPath,
      "A .subvisionproj image path cannot contain a '..' path segment.",
    );
    return "";
  }
  if (!isAbsoluteExternalPath(normalized)) {
    block(
      diagnostics,
      "V2_WRITE_EXTERNAL_PATH_RELATIVE",
      diagnosticPath,
      "A .subvisionproj image path must be an absolute Windows, UNC, POSIX, or file:// path.",
    );
    return "";
  }
  return unquoted;
}

function isAbsoluteExternalPath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:\//iu.test(path) || /^file:\/\//iu.test(path);
}

function safeRootJsonEntry(value: string | undefined, projectName: string): string {
  if (value) {
    const validation = validateZipEntryPath(value);
    if (
      validation.safe &&
      !validation.normalizedPath.includes("/") &&
      validation.normalizedPath.toLocaleLowerCase("en-US").endsWith(".json")
    ) {
      return validation.normalizedPath;
    }
  }
  return `${safeOutputStem(projectName)}.json`;
}

function safeOutputStem(value: string): string {
  const candidate = safeImageFileName(value, 0).replace(/\.[^.]+$/u, "");
  return candidate || "project";
}

function safeImageFileName(value: string, index: number): string {
  let name = replaceUnsafeFileNameCharacters(
    lastPathSegment(value).normalize("NFC"),
  )
    .replace(/[ .]+$/u, "")
    .trim();
  if (!name) name = `image_${index + 1}`;
  if (WINDOWS_RESERVED_BASENAME.test(name)) name = `_${name}`;
  return name;
}

function replaceUnsafeFileNameCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      codePoint === 0x7f ||
      '<>:"/\\|?*'.includes(character)
      ? "_"
      : character;
  }).join("");
}

function splitExtension(value: string): { stem: string; suffix: string } {
  const dot = value.lastIndexOf(".");
  return dot > 0
    ? { stem: value.slice(0, dot), suffix: value.slice(dot) }
    : { stem: value, suffix: "" };
}

function lastPathSegment(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean)
    .at(-1) ?? "";
}

function entryKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function stringifyProject(value: JsonObject, space: number | undefined): string {
  const normalizedSpace =
    space === undefined ? 0 : Math.max(0, Math.min(10, Math.trunc(space)));
  return JSON.stringify(value, undefined, normalizedSpace);
}

function isV2Source(project: ProjectIR): boolean {
  return (
    project.source.format === "v2-subvisionproj" ||
    project.source.format === "v2-visionproj"
  );
}

function isZeroBasedContiguous(values: readonly number[]): boolean {
  return values.every(
    (value, index) => Number.isInteger(value) && value === index,
  );
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cloneObject(value: JsonObject): MutableJsonObject {
  return cloneJson(value) as MutableJsonObject;
}

function cloneJson(value: JsonValue): MutableJsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    );
  }
  return value;
}

function mutableObject(value: MutableJsonValue | undefined): MutableJsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function mutableObjectArray(
  value: MutableJsonValue | undefined,
): MutableJsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const objects = value.map((item) => mutableObject(item));
  return objects.every((item): item is MutableJsonObject => item !== undefined)
    ? objects
    : undefined;
}

function block(
  diagnostics: ProjectDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  diagnostics.push({
    code,
    category: "compatibility",
    severity: "error",
    disposition: "block",
    path,
    message,
  });
}

function hasBlockingDiagnostic(diagnostics: readonly ProjectDiagnostic[]): boolean {
  return diagnostics.some((item) => item.disposition === "block");
}
