import type {
  ImageSourceIR,
  JsonObject,
  JsonValue,
  ProjectClassIR,
  ProjectDiagnostic,
  ProjectFileIR,
  ProjectIR,
  ProjectLabelIR,
  PointIR,
  SplitType,
} from "../model/project.ts";
import { APP_VERSION, isSupportedProjectType } from "../release.ts";
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "../files/imageDimensions.ts";
import { validateZipEntryPath } from "../security/paths.ts";
import {
  ARCHIVE_ENTRY_SEGMENT_MAX_BYTES,
  appendBoundedProjectDiagnostic,
  BROWSER_ARCHIVE_LIMITS,
  countProjectContourPoints,
  EXTERNAL_PROJECT_PATH_MAX_BYTES,
  exceedsUtf8ByteLimit,
  inspectJsonResourceUsage,
  PROJECT_TEXT_MAX_BYTES,
  V2_PROJECT_LIMITS,
} from "../security/resourceLimits.ts";

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
  /** Required only when the parser reported acknowledged, non-blocking loss. */
  readonly allowConfirmedLoss?: boolean;
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
  if (!validateCompatibility(project, options.allowConfirmedLoss ?? false, diagnostics)) {
    return { ok: false, diagnostics };
  }
  if (!validateProjectResourceLimits(project, diagnostics)) {
    return { ok: false, diagnostics };
  }
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
  const jsonText = stringifyProject(json, options.space);
  if (exceedsUtf8ByteLimit(jsonText, PROJECT_TEXT_MAX_BYTES)) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_TEXT_LIMIT_EXCEEDED",
      "$",
      `Generated V2 JSON exceeds the ${PROJECT_TEXT_MAX_BYTES}-byte UTF-8 limit.`,
    );
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    format: "v2-subvisionproj",
    fileName:
      options.fileName ?? `${safeOutputStem(project.project.name)}.subvisionproj`,
    json,
    jsonText,
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
  if (!validateCompatibility(project, options.allowConfirmedLoss ?? false, diagnostics)) {
    return { ok: false, diagnostics };
  }
  if (!validateProjectResourceLimits(project, diagnostics)) {
    return { ok: false, diagnostics };
  }
  if (
    options.projectJsonEntryName !== undefined &&
    exceedsUtf8ByteLimit(
      options.projectJsonEntryName,
      EXTERNAL_PROJECT_PATH_MAX_BYTES,
    )
  ) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_PATH_LIMIT_EXCEEDED",
      "$.options.projectJsonEntryName",
      `The requested project JSON entry name exceeds ${EXTERNAL_PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
    );
    return { ok: false, diagnostics };
  }
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
  const projectJsonText = stringifyProject(json, options.space);
  if (exceedsUtf8ByteLimit(projectJsonText, PROJECT_TEXT_MAX_BYTES)) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_TEXT_LIMIT_EXCEEDED",
      "$",
      `Generated V2 JSON exceeds the ${PROJECT_TEXT_MAX_BYTES}-byte UTF-8 limit.`,
    );
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
  if (
    exceedsUtf8ByteLimit(
      projectJsonEntryName,
      BROWSER_ARCHIVE_LIMITS.maxEntryNameBytes,
    )
  ) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_PATH_LIMIT_EXCEEDED",
      "$.options.projectJsonEntryName",
      `The project JSON entry name exceeds ${BROWSER_ARCHIVE_LIMITS.maxEntryNameBytes} UTF-8 bytes.`,
    );
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    format: "v2-visionproj",
    fileName: options.fileName ?? `${safeOutputStem(project.project.name)}.visionproj`,
    projectJsonEntryName,
    json,
    projectJsonText,
    imageEntries,
    diagnostics,
  };
}

export const buildV2SubvisionProject = writeV2SubvisionProject;
export const buildV2VisionProject = writeV2VisionProject;

function validateProjectResourceLimits(
  project: ProjectIR,
  diagnostics: ProjectDiagnostic[],
): boolean {
  let valid = true;
  const collections = [
    {
      actual: project.classes.length,
      maximum: V2_PROJECT_LIMITS.maxClasses,
      code: "V2_WRITE_CLASS_LIMIT_EXCEEDED",
      path: "$.classes",
      name: "class",
    },
    {
      actual: project.datasets.length,
      maximum: V2_PROJECT_LIMITS.maxDatasets,
      code: "V2_WRITE_DATASET_LIMIT_EXCEEDED",
      path: "$.datasets",
      name: "dataset",
    },
    {
      actual: project.files.length,
      maximum: V2_PROJECT_LIMITS.maxFiles,
      code: "V2_WRITE_FILE_LIMIT_EXCEEDED",
      path: "$.files",
      name: "file",
    },
  ] as const;
  for (const collection of collections) {
    if (collection.actual <= collection.maximum) continue;
    resourceBlock(
      diagnostics,
      collection.code,
      collection.path,
      `V2 ${collection.name} count ${collection.actual} exceeds ${collection.maximum}.`,
    );
    valid = false;
  }
  if (project.files.length > V2_PROJECT_LIMITS.maxFiles) return false;

  let totalLabels = 0;
  let totalSplits = 0;
  let invalidPathCount = 0;
  let overlongPathCount = exceedsUtf8ByteLimit(
    project.project.name,
    EXTERNAL_PROJECT_PATH_MAX_BYTES,
  )
    ? 1
    : 0;
  let invalidDimensionCount = 0;
  let oversizedAxisCount = 0;
  let oversizedPixelCount = 0;

  const checkPath = (value: unknown): void => {
    if (typeof value !== "string") {
      invalidPathCount += 1;
    } else if (
      exceedsUtf8ByteLimit(value, EXTERNAL_PROJECT_PATH_MAX_BYTES)
    ) {
      overlongPathCount += 1;
    }
  };

  for (const file of project.files) {
    totalLabels = saturatingAdd(totalLabels, file.labels.length, V2_PROJECT_LIMITS.maxLabels);
    totalSplits = saturatingAdd(
      totalSplits,
      file.splits.length,
      V2_PROJECT_LIMITS.maxSplitMemberships,
    );
    checkPath(file.sourcePath);
    checkPath(file.normalizedPath);
    checkPath(file.fileName);
    checkPath(file.image.kind === "external" ? file.image.path : file.image.entryName);

    const width = file.width;
    const height = file.height;
    if (
      (width !== undefined && !isPositiveSafeInteger(width)) ||
      (height !== undefined && !isPositiveSafeInteger(height))
    ) {
      invalidDimensionCount += 1;
      continue;
    }
    if (
      (width !== undefined && width > MAX_IMAGE_DIMENSION) ||
      (height !== undefined && height > MAX_IMAGE_DIMENSION)
    ) {
      oversizedAxisCount += 1;
      continue;
    }
    if (
      width !== undefined &&
      height !== undefined &&
      width * height > MAX_IMAGE_PIXELS
    ) {
      oversizedPixelCount += 1;
    }
  }

  if (totalLabels > V2_PROJECT_LIMITS.maxLabels) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_LABEL_LIMIT_EXCEEDED",
      "$.files[*].labels",
      `Total V2 label count exceeds ${V2_PROJECT_LIMITS.maxLabels}.`,
    );
    valid = false;
  }
  const totalContourPoints = countProjectContourPoints(project);
  if (totalContourPoints > V2_PROJECT_LIMITS.maxContourPoints) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_CONTOUR_POINT_LIMIT_EXCEEDED",
      "$.files[*].labels[*].geometry.contours",
      `Total V2 contour point count exceeds ${V2_PROJECT_LIMITS.maxContourPoints}.`,
    );
    valid = false;
  }
  if (totalSplits > V2_PROJECT_LIMITS.maxSplitMemberships) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_SPLIT_LIMIT_EXCEEDED",
      "$.files[*].splits",
      `Total V2 split membership count exceeds ${V2_PROJECT_LIMITS.maxSplitMemberships}.`,
    );
    valid = false;
  }
  if (invalidPathCount > 0) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_PATH_INVALID",
      "$.files[*]",
      `${invalidPathCount} V2 path value(s) are not strings.`,
    );
    valid = false;
  }
  if (overlongPathCount > 0) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_PATH_LIMIT_EXCEEDED",
      "$.files[*]",
      `${overlongPathCount} V2 path value(s) exceed ${EXTERNAL_PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
    );
    valid = false;
  }
  if (invalidDimensionCount > 0) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_IMAGE_DIMENSIONS_INVALID",
      "$.files[*]",
      `${invalidDimensionCount} image(s) use dimensions that are not positive safe integers.`,
    );
    valid = false;
  }
  if (oversizedAxisCount > 0) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_IMAGE_DIMENSION_LIMIT_EXCEEDED",
      "$.files[*]",
      `${oversizedAxisCount} image(s) exceed the ${MAX_IMAGE_DIMENSION}-pixel axis limit.`,
    );
    valid = false;
  }
  if (oversizedPixelCount > 0) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_IMAGE_PIXEL_LIMIT_EXCEEDED",
      "$.files[*]",
      `${oversizedPixelCount} image(s) exceed the ${MAX_IMAGE_PIXELS}-pixel limit.`,
    );
    valid = false;
  }

  if (isV2Source(project)) {
    valid = validateSameVersionRawResources(project.raw, diagnostics) && valid;
  }
  return valid;
}

function validateSameVersionRawResources(
  raw: JsonObject,
  diagnostics: ProjectDiagnostic[],
): boolean {
  const inspection = inspectJsonResourceUsage(raw);
  if (!inspection.ok) {
    const code =
      inspection.reason === "depth"
        ? "V2_WRITE_RAW_DEPTH_LIMIT_EXCEEDED"
        : inspection.reason === "values"
          ? "V2_WRITE_RAW_VALUE_LIMIT_EXCEEDED"
          : inspection.reason === "cycle"
            ? "V2_WRITE_RAW_CYCLE"
            : "V2_WRITE_RAW_JSON_INVALID";
    resourceBlock(
      diagnostics,
      code,
      "$.raw",
      `Retained V2 JSON cannot be cloned safely because its ${inspection.reason} limit was exceeded.`,
    );
    return false;
  }

  const rawProject = readonlyJsonObject(raw.project);
  const rawFiles = rawProject?.projectFiles;
  if (!rawProject || !Array.isArray(rawFiles)) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_RAW_SCHEMA_INVALID",
      "$.raw.project.projectFiles",
      "Retained V2 JSON must contain a projectFiles array before cloning.",
    );
    return false;
  }

  let valid = true;
  const rawCollections = [
    {
      value: rawProject.classInfos,
      maximum: V2_PROJECT_LIMITS.maxClasses,
      code: "V2_WRITE_RAW_CLASS_LIMIT_EXCEEDED",
      path: "$.raw.project.classInfos",
    },
    {
      value: rawProject.datasets,
      maximum: V2_PROJECT_LIMITS.maxDatasets,
      code: "V2_WRITE_RAW_DATASET_LIMIT_EXCEEDED",
      path: "$.raw.project.datasets",
    },
    {
      value: rawFiles,
      maximum: V2_PROJECT_LIMITS.maxFiles,
      code: "V2_WRITE_RAW_FILE_LIMIT_EXCEEDED",
      path: "$.raw.project.projectFiles",
    },
  ] as const;
  for (const collection of rawCollections) {
    if (!Array.isArray(collection.value) || collection.value.length <= collection.maximum) {
      continue;
    }
    resourceBlock(
      diagnostics,
      collection.code,
      collection.path,
      `Retained V2 collection count ${collection.value.length} exceeds ${collection.maximum}.`,
    );
    valid = false;
  }
  if (rawFiles.length > V2_PROJECT_LIMITS.maxFiles) return false;

  let totalLabels = 0;
  let totalSplits = 0;
  let overlongPaths = 0;
  for (const value of rawFiles) {
    const file = readonlyJsonObject(value);
    if (!file) continue;
    if (Array.isArray(file.labelDataList)) {
      totalLabels = saturatingAdd(
        totalLabels,
        file.labelDataList.length,
        V2_PROJECT_LIMITS.maxLabels,
      );
    }
    if (Array.isArray(file.splitSets)) {
      totalSplits = saturatingAdd(
        totalSplits,
        file.splitSets.length,
        V2_PROJECT_LIMITS.maxSplitMemberships,
      );
    }
    if (
      typeof file.filePath === "string" &&
      exceedsUtf8ByteLimit(file.filePath, EXTERNAL_PROJECT_PATH_MAX_BYTES)
    ) {
      overlongPaths += 1;
    }
  }
  if (totalLabels > V2_PROJECT_LIMITS.maxLabels) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_RAW_LABEL_LIMIT_EXCEEDED",
      "$.raw.project.projectFiles[*].labelDataList",
      `Retained V2 label count exceeds ${V2_PROJECT_LIMITS.maxLabels}.`,
    );
    valid = false;
  }
  if (totalSplits > V2_PROJECT_LIMITS.maxSplitMemberships) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_RAW_SPLIT_LIMIT_EXCEEDED",
      "$.raw.project.projectFiles[*].splitSets",
      `Retained V2 split membership count exceeds ${V2_PROJECT_LIMITS.maxSplitMemberships}.`,
    );
    valid = false;
  }
  if (overlongPaths > 0) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_RAW_PATH_LIMIT_EXCEEDED",
      "$.raw.project.projectFiles[*].filePath",
      `${overlongPaths} retained V2 file path(s) exceed ${EXTERNAL_PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
    );
    valid = false;
  }
  return valid;
}

function saturatingAdd(current: number, addition: number, maximum: number): number {
  return Math.min(maximum + 1, current + addition);
}

function readonlyJsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

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
  if (!isSupportedProjectType(project.project.type)) {
    block(
      diagnostics,
      "V2_WRITE_GOLDEN_REQUIRED",
      "$.project.type",
      `${project.project.type} output is not available in v${APP_VERSION}; a verified V2 golden project is required first.`,
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

function validateCompatibility(
  project: ProjectIR,
  allowConfirmedLoss: boolean,
  diagnostics: ProjectDiagnostic[],
): boolean {
  const compatibility = project.compatibility;
  if (!compatibility || compatibility.target !== "v2") return true;
  if (compatibility.status === "blocked") {
    block(
      diagnostics,
      "V2_WRITE_COMPATIBILITY_BLOCKED",
      "$.compatibility",
      "The parsed project contains fields that cannot be represented safely in V2.",
    );
    return false;
  }
  if (compatibility.status === "confirmation-required" && !allowConfirmedLoss) {
    block(
      diagnostics,
      "V2_WRITE_CONFIRMATION_REQUIRED",
      "$.compatibility",
      "The parsed project requires explicit confirmation before lossy V2 output.",
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
    : project.project.type === "segmentation"
      ? buildSegmentationJson(project, filePaths, diagnostics)
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

type V2RoiDefault = "classification" | "segmentation";

function buildV2RoiFields(
  project: ProjectIR,
  files: readonly ProjectFileIR[],
  defaultMode: V2RoiDefault,
  diagnostics: ProjectDiagnostic[],
): MutableJsonObject | undefined {
  const roi = project.project.roi;
  const legacyMode = normalizeLegacyRoiMode(project.project.roiMode);
  if (!roi) {
    if (legacyMode === "simple" || legacyMode === "other") {
      block(
        diagnostics,
        "V2_WRITE_ROI_GEOMETRY_REQUIRED",
        "$.project.roi",
        "An enabled legacy ROI mode cannot be written without normalized rectangle boundaries.",
      );
      return undefined;
    }
    return defaultV2RoiFields(defaultMode);
  }

  const runtimeMode: unknown = (roi as { readonly mode?: unknown }).mode;
  if (runtimeMode !== "none" && runtimeMode !== "simple") {
    block(
      diagnostics,
      "V2_WRITE_ROI_MODE_UNSUPPORTED",
      "$.project.roi.mode",
      "Only disabled ROI and a verified Simple Rectangle ROI can be written to V2.",
    );
    return undefined;
  }
  if (
    legacyMode !== undefined &&
    (legacyMode === "other" || legacyMode !== runtimeMode)
  ) {
    block(
      diagnostics,
      "V2_WRITE_ROI_MODE_CONFLICT",
      "$.project.roiMode",
      "The legacy ROI mode conflicts with the normalized ROI model.",
    );
    return undefined;
  }
  if (roi.mode === "none") return defaultV2RoiFields(defaultMode);
  if (roi.shape !== "rectangle") {
    block(
      diagnostics,
      "V2_WRITE_ROI_SHAPE_UNSUPPORTED",
      "$.project.roi.shape",
      "Only a rectangular Simple ROI can be written to V2.",
    );
    return undefined;
  }

  const { left, top, right, bottom } = roi;
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom) ||
    left < 0 ||
    top < 0 ||
    right > 1 ||
    bottom > 1 ||
    right <= left ||
    bottom <= top
  ) {
    block(
      diagnostics,
      "V2_WRITE_ROI_BOUNDS_INVALID",
      "$.project.roi",
      "A Simple ROI requires finite normalized boundaries with 0 <= left < right <= 1 and 0 <= top < bottom <= 1.",
    );
    return undefined;
  }

  const fields: MutableJsonObject = {
    roiMode: "simple",
    roiPosX: left,
    roiPosY: top,
    // Native V2 stores right/bottom boundaries in the misleadingly named
    // roiWidth/roiHeight fields.
    roiWidth: right,
    roiHeight: bottom,
    roiShapeType: "rectangle",
  };
  if (left === 0 && top === 0 && right === 1 && bottom === 1) return fields;

  const referenceFile = files[0];
  if (
    !referenceFile ||
    !isPositiveSafeInteger(referenceFile.width) ||
    !isPositiveSafeInteger(referenceFile.height)
  ) {
    block(
      diagnostics,
      "V2_WRITE_ROI_STAGE_SIZE_REQUIRED",
      "$.files[0]",
      "A custom ROI requires the first image width and height to rebuild the native drawing shape.",
    );
    return undefined;
  }
  fields.roiShape = buildRectangleRoiShape(
    project,
    referenceFile.width,
    referenceFile.height,
    left,
    top,
    right,
    bottom,
  );
  rebuildInfo(
    diagnostics,
    "V2_WRITE_ROI_SHAPE_REBUILT",
    "$.project.roiShape",
    "The native Konva rectangle is rebuilt deterministically from normalized ROI boundaries.",
  );
  rebuildInfo(
    diagnostics,
    "V2_WRITE_ROI_BITMAP_REGENERATION_DEFERRED",
    "$.project.roiBitmap",
    "The derived roiBitmap is intentionally omitted so V2 can regenerate it from roiShape.",
  );
  return fields;
}

function normalizeLegacyRoiMode(
  value: string | undefined,
): "none" | "simple" | "other" | undefined {
  const mode = value?.trim().toLocaleLowerCase("en-US");
  if (!mode) return undefined;
  if (mode === "no" || mode === "none" || mode === "not set") return "none";
  return mode === "simple" ? "simple" : "other";
}

function defaultV2RoiFields(defaultMode: V2RoiDefault): MutableJsonObject {
  return defaultMode === "classification"
    ? {
        roiMode: "simple",
        roiPosX: 0,
        roiPosY: 0,
        roiWidth: 1,
        roiHeight: 1,
        roiShapeType: "rectangle",
      }
    : { roiMode: "no" };
}

function buildRectangleRoiShape(
  project: ProjectIR,
  stageWidth: number,
  stageHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): string {
  const rectangle = {
    x: left * stageWidth,
    y: top * stageHeight,
    width: (right - left) * stageWidth,
    height: (bottom - top) * stageHeight,
  };
  const identity = `${deterministicProjectId(project)}:${left}:${top}:${right}:${bottom}`;
  const shape: MutableJsonObject = {
    attrs: {
      id: "base-layer",
      stageSize: { width: stageWidth, height: stageHeight },
    },
    className: "Layer",
    children: [
      {
        attrs: {
          id: deterministicUuid(`${identity}:background`),
          isBackground: true,
          width: stageWidth,
          height: stageHeight,
          fill: "black",
          selectable: false,
          opacity: 0.6,
          selected: false,
        },
        className: "Rect",
      },
      {
        attrs: {
          id: deterministicUuid(`${identity}:group`),
          name: "roi-area",
          selectable: true,
          selected: false,
          UIType: "roi",
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
        },
        className: "Group",
        children: [
          {
            attrs: {
              ...rectangle,
              id: deterministicUuid(`${identity}:mask`),
              fill: "white",
              selectable: false,
              strokeWidth: 1,
              globalCompositeOperation: "destination-out",
            },
            className: "Rect",
          },
          {
            attrs: {
              ...rectangle,
              id: deterministicUuid(`${identity}:outline`),
              selectable: false,
              stroke: "white",
              dash: [2, 2],
              shadowColor: "black",
              shadowBlur: 1,
              shadowOffsetX: 0.5,
              shadowOffsetY: 0.5,
              strokeWidth: 1,
              strokeScaleEnabled: false,
            },
            className: "Rect",
          },
        ],
      },
    ],
  };
  return JSON.stringify(shape);
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
    classId: classIdByIndex.get(item.index) ?? projectId + 10 + item.index,
    className: item.name,
    classNo: item.index,
    description: item.description,
    classColor: normalizedClassColor(item, item.index),
    isNg: item.isNg ?? false,
  }));

  let nextLabelId = projectId + 100_000;
  const fileJson: MutableJsonObject[] = files.map((file, outputIndex) => {
    const path = `$.files[${file.index}]`;
    if (!isPositiveSafeInteger(file.width) || !isPositiveSafeInteger(file.height)) {
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
      isPositiveSafeInteger(file.width) &&
      isPositiveSafeInteger(file.height)
    ) {
      const labelId = nextLabelId;
      nextLabelId += 1;
      labels.push({
        labelId,
        labelType: "man",
        labeledDate: timestamp,
        contourId: deterministicUuid(`${projectId}:label:${labelId}`),
        className: cls.name,
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
      ...(cls ? { className: cls.name } : {}),
      labelDataList: labels,
      metadata: [],
      registeredDate: timestamp,
      isGenerated: false,
      splitSets: [
        { splitId, splitName: "srproj", splitType },
      ],
    };
  });

  const roiFields = buildV2RoiFields(project, files, "classification", diagnostics);
  if (!roiFields) return undefined;

  if (hasBlockingDiagnostic(diagnostics)) return undefined;

  const root: MutableJsonObject = {
    project: {
      projectId,
      projectName: project.project.name,
      projectType: "cls",
      description: project.project.description,
      ...roiFields,
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
          splitSets: [{ splitId, splitName: "srproj", createdDate: timestamp }],
        },
      ],
      projectFiles: fileJson,
    },
  };
  return root;
}

/** Build the native V2 2.7.8 polygon-segmentation schema from a V1 project. */
function buildSegmentationJson(
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
      "Strict V1-to-V2 segmentation output supports one generated dataset.",
    );
    return undefined;
  }
  if (classes.length + 1 > V2_PROJECT_LIMITS.maxClasses) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_CLASS_LIMIT_EXCEEDED",
      "$.classes",
      `Segmentation output adds one structural OK class and must not exceed ${V2_PROJECT_LIMITS.maxClasses} classes.`,
    );
    return undefined;
  }
  if (
    classes.some(
      (item) =>
        item.name.trim().normalize("NFKC").toLocaleLowerCase("en-US") === "ok",
    )
  ) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_OK_CLASS_RESERVED",
      "$.classes",
      "The class name 'OK' is reserved for V2 Segmentation normal images.",
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
  const classInfos: MutableJsonObject[] = [
    {
      classId: 0,
      className: "OK",
      classNo: 0,
      description: "",
      classColor: "#1DDB16",
      isNg: false,
    },
    ...classes.map((item) => ({
      classId: projectId + 10 + item.index,
      className: item.name,
      classNo: item.index + 1,
      description: item.description,
      classColor: normalizedClassColor(item, item.index),
      isNg: item.isNg ?? true,
    })),
  ];

  let nextLabelId = projectId + 100_000;
  const fileJson: MutableJsonObject[] = files.map((file, outputIndex) => {
    const path = `$.files[${file.index}]`;
    if (!isPositiveSafeInteger(file.width) || !isPositiveSafeInteger(file.height)) {
      block(
        diagnostics,
        "V2_WRITE_IMAGE_DIMENSIONS_REQUIRED",
        path,
        "Strict segmentation output requires positive image width and height.",
      );
    }

    if (file.isNormal === true && file.labels.length > 0) {
      block(
        diagnostics,
        "V2_WRITE_SEGMENTATION_NORMAL_LABEL_CONFLICT",
        path,
        "A normal segmentation image cannot also contain defect contours.",
      );
    }
    if (file.isLabeled === false && (file.isNormal === true || file.labels.length > 0)) {
      block(
        diagnostics,
        "V2_WRITE_SEGMENTATION_STATE_CONFLICT",
        `${path}.isLabeled`,
        "An explicitly unlabeled segmentation image cannot contain a normal/defect label state.",
      );
    }
    if (file.isLabeled === true && file.isNormal !== true && file.labels.length === 0) {
      block(
        diagnostics,
        "V2_WRITE_SEGMENTATION_LABEL_REQUIRED",
        `${path}.labels`,
        "A labeled segmentation image must be normal or contain at least one contour label.",
      );
    }

    const labels: MutableJsonObject[] = [];
    for (const label of file.labels) {
      const labelPath = `${path}.labels[${label.index}]`;
      if (label.kind !== "contour") {
        block(
          diagnostics,
          "V2_WRITE_SEGMENTATION_LABEL_KIND_UNSUPPORTED",
          labelPath,
          "Segmentation output accepts polygon contour labels only.",
        );
        continue;
      }
      const classIndex = label.classIndex;
      const cls = classIndex === undefined ? undefined : classByIndex.get(classIndex);
      if (!cls) {
        block(
          diagnostics,
          "V2_WRITE_CLASS_REFERENCE_INVALID",
          `${labelPath}.classIndex`,
          "A segmentation contour references a missing class.",
        );
        continue;
      }
      const contour = normalizeSegmentationContours(
        label,
        file.width,
        file.height,
        diagnostics,
        labelPath,
      );
      if (!contour) continue;
      const labelId = nextLabelId;
      nextLabelId += 1;
      labels.push({
        labelId,
        labelType: "man",
        labelPosX: contour.x,
        labelPosY: contour.y,
        labelWidth: contour.width,
        labelHeight: contour.height,
        labeledDate: timestamp,
        labelContour: JSON.stringify(
          contour.rings.map((ring) => ring.map((point) => [point.x, point.y])),
        ),
        contourSize: contour.area,
        contourId: deterministicUuid(`${projectId}:label:${labelId}`),
        className: cls.name,
      });
    }

    const firstLabelClass = file.labels
      .map((label) =>
        label.classIndex === undefined ? undefined : classByIndex.get(label.classIndex),
      )
      .find((item): item is ProjectClassIR => item !== undefined);
    const isNormal = file.isNormal === true;
    const isLabeled = isNormal || labels.length > 0;
    const splitType = v2SplitType(file.canonicalSplit, diagnostics, path);

    return {
      projectId,
      fileId: projectId + 1_000 + outputIndex,
      filePath: filePaths[file.index] ?? filePaths[outputIndex] ?? "",
      isLabeled,
      modifiedDate: timestamp,
      assignedDate: timestamp,
      datasetName,
      ...(file.width !== undefined ? { width: file.width } : {}),
      ...(file.height !== undefined ? { height: file.height } : {}),
      ...(isNormal
        ? { className: "OK" }
        : firstLabelClass
          ? { className: firstLabelClass.name }
          : {}),
      labelDataList: labels,
      metadata: [{}, {}, {}],
      registeredDate: timestamp,
      splitSets: [{ splitId, splitName: "srproj", splitType }],
    };
  });

  const roiFields = buildV2RoiFields(project, files, "segmentation", diagnostics);
  if (!roiFields) return undefined;

  if (hasBlockingDiagnostic(diagnostics)) return undefined;
  return {
    project: {
      projectId,
      projectName: project.project.name,
      projectType: "seg",
      description: project.project.description,
      ...roiFields,
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
          splitSets: [{ splitId, splitName: "srproj", createdDate: timestamp }],
        },
      ],
      projectFiles: fileJson,
    },
  };
}

interface NormalizedSegmentationContour {
  readonly rings: readonly (readonly PointIR[])[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly area: number;
}

function normalizeSegmentationContours(
  label: ProjectLabelIR,
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  diagnostics: ProjectDiagnostic[],
  path: string,
): NormalizedSegmentationContour | undefined {
  if (label.geometry.bitmap) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_BITMAP_UNSUPPORTED",
      `${path}.geometry.bitmap`,
      "Bitmap masks cannot be converted by the verified polygon writer.",
    );
    return undefined;
  }
  const contours = label.geometry.contours;
  const roles = label.geometry.contourRoles;
  if (!contours?.length) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_CONTOUR_REQUIRED",
      `${path}.geometry.contours`,
      "A segmentation label requires at least one polygon ring.",
    );
    return undefined;
  }
  if (!roles || roles.length !== contours.length || roles.includes("unknown")) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_RING_ROLE_REQUIRED",
      `${path}.geometry.contourRoles`,
      "Every segmentation ring must be identified as outer or inner.",
    );
    return undefined;
  }
  if (!roles.includes("outer")) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_OUTER_RING_REQUIRED",
      `${path}.geometry.contourRoles`,
      "A segmentation label requires at least one outer ring.",
    );
    return undefined;
  }
  let hasOuter = false;
  const leadingInnerIndex = roles.findIndex((role) => {
    if (role === "outer") {
      hasOuter = true;
      return false;
    }
    return !hasOuter;
  });
  if (leadingInnerIndex >= 0) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_RING_ORDER_INVALID",
      `${path}.geometry.contourRoles[${leadingInnerIndex}]`,
      "Each inner contour must follow an outer contour in the same label.",
    );
    return undefined;
  }

  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  let signedCompositeArea = 0;
  const rings: PointIR[][] = [];

  contours.forEach((sourceRing, ringIndex) => {
    const role = roles[ringIndex]!;
    if (sourceRing.length < 3) {
      block(
        diagnostics,
        "V2_WRITE_SEGMENTATION_CONTOUR_INVALID",
        `${path}.geometry.contours[${ringIndex}]`,
        "A polygon ring requires at least three points.",
      );
      return;
    }
    const ring = sourceRing.map((point) => ({ x: point.x, y: point.y }));
    if (
      ring.some(
        (point) =>
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          (imageWidth !== undefined && (point.x < 0 || point.x > imageWidth)) ||
          (imageHeight !== undefined && (point.y < 0 || point.y > imageHeight)),
      )
    ) {
      block(
        diagnostics,
        "V2_WRITE_SEGMENTATION_POINT_INVALID",
        `${path}.geometry.contours[${ringIndex}]`,
        "Segmentation points must be finite and inside the image bounds.",
      );
      return;
    }
    let area = signedRingArea(ring);
    if (!Number.isFinite(area) || area === 0) {
      block(
        diagnostics,
        "V2_WRITE_SEGMENTATION_CONTOUR_AREA_INVALID",
        `${path}.geometry.contours[${ringIndex}]`,
        "A segmentation ring must have non-zero finite area.",
      );
      return;
    }
    const wantsPositiveArea = role === "outer";
    if ((area > 0) !== wantsPositiveArea) {
      ring.reverse();
      area = -area;
    }
    signedCompositeArea += area;
    for (const point of ring) {
      minimumX = Math.min(minimumX, point.x);
      minimumY = Math.min(minimumY, point.y);
      maximumX = Math.max(maximumX, point.x);
      maximumY = Math.max(maximumY, point.y);
    }
    rings.push(ring);
  });

  if (hasBlockingDiagnostic(diagnostics) || rings.length !== contours.length) {
    return undefined;
  }
  const x = Math.round(minimumX);
  const y = Math.round(minimumY);
  const width = Math.round(maximumX - minimumX);
  const height = Math.round(maximumY - minimumY);
  // Polygon shoelace area is exact to half a pixel for integer V1 points;
  // preserve that precision because native V2 exports do as well.
  const area = Math.abs(signedCompositeArea);
  if (width <= 0 || height <= 0 || area <= 0) {
    block(
      diagnostics,
      "V2_WRITE_SEGMENTATION_GEOMETRY_INVALID",
      `${path}.geometry`,
      "A segmentation label must have a positive bounding box and composite area.",
    );
    return undefined;
  }
  return { rings, x, y, width, height, area };
}

function signedRingArea(points: readonly PointIR[]): number {
  let doubledArea = 0;
  for (const [index, point] of points.entries()) {
    const next = points[(index + 1) % points.length]!;
    doubledArea += point.x * next.y - next.x * point.y;
  }
  return doubledArea / 2;
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
      return "val";
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
  const nextSequenceByBase = new Map<string, number>();
  return [...files]
    .sort((left, right) => left.index - right.index)
    .map((file) => {
      const entryName = uniqueImageEntryName(file, used, nextSequenceByBase);
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

function uniqueImageEntryName(
  file: ProjectFileIR,
  used: Set<string>,
  nextSequenceByBase: Map<string, number>,
): string {
  if (file.image.kind === "archive") {
    const validation = validateZipEntryPath(file.image.entryName);
    if (
      validation.safe &&
      validation.normalizedPath.toLocaleLowerCase("en-US").startsWith("images/") &&
      archiveEntryNameFitsLimits(validation.normalizedPath) &&
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
  let candidate = `images/${safeName}`;
  const baseKey = entryKey(candidate);
  let sequence = nextSequenceByBase.get(baseKey) ?? 2;
  while (used.has(entryKey(candidate))) {
    candidate = `images/${fitFileName(safeName, `_${sequence}`)}`;
    sequence += 1;
  }
  nextSequenceByBase.set(baseKey, sequence);
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
  if (exceedsUtf8ByteLimit(rawPath, EXTERNAL_PROJECT_PATH_MAX_BYTES)) {
    resourceBlock(
      diagnostics,
      "V2_WRITE_PATH_LIMIT_EXCEEDED",
      diagnosticPath,
      `A .subvisionproj image path must not exceed ${EXTERNAL_PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
    );
    return "";
  }
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
  let candidate: string | undefined;
  if (value) {
    const validation = validateZipEntryPath(value);
    if (
      validation.safe &&
      !validation.normalizedPath.includes("/") &&
      validation.normalizedPath.toLocaleLowerCase("en-US").endsWith(".json")
    ) {
      candidate = validation.normalizedPath;
    }
  }
  return fitFileName(candidate ?? `${safeOutputStem(projectName)}.json`);
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
  return fitFileName(name);
}

function fitFileName(value: string, conflictSuffix = ""): string {
  const { stem, suffix } = splitExtension(value);
  const reservedBytes = utf8ByteLength(conflictSuffix) + utf8ByteLength(suffix);
  const stemBudget = Math.max(1, ARCHIVE_ENTRY_SEGMENT_MAX_BYTES - reservedBytes);
  let fittedStem = truncateUtf8(stem, stemBudget);
  if (!fittedStem) fittedStem = truncateUtf8("image", stemBudget);
  const candidate = `${fittedStem}${conflictSuffix}${suffix}`;
  return exceedsUtf8ByteLimit(candidate, ARCHIVE_ENTRY_SEGMENT_MAX_BYTES)
    ? truncateUtf8(candidate, ARCHIVE_ENTRY_SEGMENT_MAX_BYTES)
    : candidate;
}

function archiveEntryNameFitsLimits(value: string): boolean {
  return (
    !exceedsUtf8ByteLimit(value, BROWSER_ARCHIVE_LIMITS.maxEntryNameBytes) &&
    value
      .split("/")
      .every(
        (segment) =>
          !exceedsUtf8ByteLimit(segment, ARCHIVE_ENTRY_SEGMENT_MAX_BYTES),
      )
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
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

function isPositiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
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
  appendBoundedProjectDiagnostic(diagnostics, {
    code,
    category: "compatibility",
    severity: "error",
    disposition: "block",
    path,
    message,
  });
}

function resourceBlock(
  diagnostics: ProjectDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  appendBoundedProjectDiagnostic(diagnostics, {
    code,
    category: "security",
    severity: "error",
    disposition: "block",
    path,
    message,
  });
}

function rebuildInfo(
  diagnostics: ProjectDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  appendBoundedProjectDiagnostic(diagnostics, {
    code,
    category: "compatibility",
    severity: "info",
    disposition: "rebuild",
    path,
    message,
  });
}

function hasBlockingDiagnostic(diagnostics: readonly ProjectDiagnostic[]): boolean {
  return diagnostics.some((item) => item.disposition === "block");
}
