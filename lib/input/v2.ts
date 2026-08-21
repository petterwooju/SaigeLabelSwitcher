import type {
  ArchiveImageSourceIR,
  CompatibilityDisposition,
  CompatibilitySummary,
  ContourRingRole,
  DiagnosticSeverity,
  ImageSourceIR,
  JsonObject,
  JsonValue,
  LabelGeometryIR,
  LabelKind,
  LabelOrigin,
  PointIR,
  ProjectClassIR,
  ProjectDatasetIR,
  ProjectDiagnostic,
  ProjectFileIR,
  ProjectIR,
  ProjectLabelIR,
  ProjectParseResult,
  ProjectRoiIR,
  ProjectSourceFormat,
  ProjectSplitIR,
  ProjectType,
  SplitType,
} from "../model/project.ts";
import { APP_VERSION, isSupportedProjectType } from "../release.ts";
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "../files/imageDimensions.ts";
import {
  appendBoundedProjectDiagnostic,
  BROWSER_ARCHIVE_LIMITS,
  exceedsUtf8ByteLimit,
  PROJECT_PATH_MAX_BYTES,
  PROJECT_JSON_MAX_VALUES,
  PROJECT_STRUCTURE_MAX_DEPTH,
  projectDiagnosticsAreTruncated,
  V2_PROJECT_TEXT_MAX_BYTES,
  V2_PROJECT_LIMITS,
} from "../security/resourceLimits.ts";

export interface V2ArchiveEntry {
  readonly name: string;
  readonly bytes?: Uint8Array;
}

export interface V2SubvisionProjectInput {
  readonly jsonText: string;
  readonly fileName?: string;
}

export interface V2VisionProjectInput {
  readonly projectJsonText: string;
  readonly projectJsonEntryName: string;
  readonly entries: readonly V2ArchiveEntry[];
  readonly fileName?: string;
}

interface ParseContext {
  readonly format: ProjectSourceFormat;
  readonly fileName?: string;
  readonly diagnostics: ProjectDiagnostic[];
  readonly archive?: ArchiveContext;
  contourPointCount: number;
  contourPointLimitExceeded: boolean;
}

interface ArchiveContext {
  readonly projectJsonEntryName: string;
  readonly entriesByName: ReadonlyMap<string, V2ArchiveEntry>;
}

interface ParsedLabels {
  readonly labels: readonly ProjectLabelIR[];
  readonly classificationClassIndex?: number;
  readonly segmentationNormalMarker?: boolean;
}

const SUPPORTED_PROJECT_TYPES: Readonly<Record<string, ProjectType>> = {
  cls: "classification",
  classification: "classification",
  det: "detection",
  detection: "detection",
  seg: "segmentation",
  segmentation: "segmentation",
};

const PROJECT_KNOWN_FIELDS = new Set([
  "projectId",
  "projectName",
  "projectType",
  "description",
  "roiMode",
  "roiPosX",
  "roiPosY",
  "roiWidth",
  "roiHeight",
  "roiShapeType",
  "roiShape",
  "roiBitmap",
  "modifiedDate",
  "createdDate",
  "createdBy",
  "metadataList",
  "metadataKeys",
  "classInfos",
  "datasets",
  "projectFiles",
]);

const CLASS_KNOWN_FIELDS = new Set([
  "classId",
  "className",
  "classNo",
  "description",
  "classColor",
  "isNg",
]);

const DATASET_KNOWN_FIELDS = new Set([
  "datasetId",
  "datasetName",
  "description",
  "modifiedDate",
  "createdDate",
  "createdBy",
  "projects",
  "metadataList",
  "splitSets",
]);

const FILE_KNOWN_FIELDS = new Set([
  "fileId",
  "projectId",
  "fileName",
  "filePath",
  "isLabeled",
  "classId",
  "classNo",
  "className",
  "datasetId",
  "datasetName",
  "width",
  "height",
  "labelDataList",
  "metadata",
  "modifiedDate",
  "assignedDate",
  "registeredDate",
  "isGenerated",
  "splitSets",
]);

const SPLIT_KNOWN_FIELDS = new Set([
  "splitId",
  "splitName",
  "splitType",
]);

const LABEL_KNOWN_FIELDS = new Set([
  "labelId",
  "labelType",
  "labeledDate",
  "contourId",
  "classId",
  "classNo",
  "className",
  "labelPosX",
  "labelPosY",
  "labelWidth",
  "labelHeight",
  "labelBitmap",
  "labelPolygon",
  "labelContour",
  "contourSize",
]);

/** Parse a V2 light project. The file carries JSON and external paths only. */
export function parseV2SubvisionProject(
  input: V2SubvisionProjectInput,
): ProjectParseResult {
  const context: ParseContext = {
    format: "v2-subvisionproj",
    fileName: input.fileName,
    diagnostics: [],
    contourPointCount: 0,
    contourPointLimitExceeded: false,
  };
  return parseProjectJson(input.jsonText, context);
}

/**
 * Parse an already-unpacked V2 full project. ZIP extraction deliberately stays
 * outside this module; callers provide the JSON text and all member names/bytes.
 */
export function parseV2VisionProject(
  input: V2VisionProjectInput,
): ProjectParseResult {
  const diagnostics: ProjectDiagnostic[] = [];
  const archive = validateArchive(input, diagnostics);
  if (!archive) return failure(diagnostics);

  const context: ParseContext = {
    format: "v2-visionproj",
    fileName: input.fileName,
    diagnostics,
    archive,
    contourPointCount: 0,
    contourPointLimitExceeded: false,
  };
  return parseProjectJson(input.projectJsonText, context);
}

/** Backwards-friendly aliases for adapters that name functions after suffixes. */
export const parseSubvisionproj = parseV2SubvisionProject;
export const parseVisionproj = parseV2VisionProject;
export const parseSubvisionProject = parseV2SubvisionProject;
export const parseVisionProject = parseV2VisionProject;

function parseProjectJson(text: string, context: ParseContext): ProjectParseResult {
  if (!preflightJsonText(context, text, "$")) {
    return failure(context.diagnostics);
  }

  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch (error) {
    addDiagnostic(context, {
      code: "V2_INVALID_JSON",
      category: "validation",
      severity: "error",
      disposition: "block",
      path: "$",
      message: "V2 project is not valid JSON.",
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
    return failure(context.diagnostics);
  }

  if (!isJsonObject(value)) {
    invalid(context, "$", "V2_ROOT_NOT_OBJECT", "The JSON root must be an object.");
    return failure(context.diagnostics);
  }
  if (!validateJsonValueBudget(context, value, "$")) {
    return failure(context.diagnostics);
  }

  reportUnknownFields(context, value, new Set(["project"]), "$", "root");
  if (!isJsonObject(value.project)) {
    invalid(
      context,
      "$.project",
      "V2_PROJECT_MISSING",
      "The JSON root must contain a project object.",
    );
    return failure(context.diagnostics);
  }

  const projectRaw = value.project;
  if (!validateV2ResourceShape(context, projectRaw)) {
    return failure(context.diagnostics);
  }
  reportUnknownFields(context, projectRaw, PROJECT_KNOWN_FIELDS, "$.project", "project");

  const name = requiredNonEmptyString(
    context,
    projectRaw.projectName,
    "$.project.projectName",
    "V2_PROJECT_NAME_INVALID",
  );
  const rawType = requiredNonEmptyString(
    context,
    projectRaw.projectType,
    "$.project.projectType",
    "V2_PROJECT_TYPE_INVALID",
  );

  if (!name || !rawType) return failure(context.diagnostics);
  const type = normalizeProjectType(rawType);
  if (!isSupportedProjectType(type)) {
    addDiagnostic(context, {
      code: "V2_PROJECT_TYPE_UNSUPPORTED",
      category: "compatibility",
      severity: "error",
      disposition: "block",
      path: "$.project.projectType",
      message: `V2 project type '${rawType}' is outside the v${APP_VERSION} release scope and has no verified cross-version mapping.`,
      details: { rawProjectType: rawType },
    });
  }

  const roi = parseProjectRoi(context, projectRaw);

  const classValues = optionalObjectArray(
    context,
    projectRaw.classInfos,
    "$.project.classInfos",
  );
  const datasetValues = optionalObjectArray(
    context,
    projectRaw.datasets,
    "$.project.datasets",
  );
  const fileValues = requiredObjectArray(
    context,
    projectRaw.projectFiles,
    "$.project.projectFiles",
    "V2_PROJECT_FILES_INVALID",
  );
  if (!classValues || !datasetValues || !fileValues) return failure(context.diagnostics);

  const classes = parseClasses(context, classValues, type);
  const datasets = parseDatasets(context, datasetValues);
  if (!classes || !datasets) return failure(context.diagnostics);

  const segmentationNormalClassIndex =
    type === "segmentation"
      ? identifySegmentationNormalClass(context, classes)
      : undefined;

  if (datasets.length > 1) {
    compatibility(context, {
      code: "V2_MULTIPLE_DATASETS",
      disposition: "block",
      severity: "error",
      path: "$.project.datasets",
      message: "V1 cannot preserve multiple V2 datasets without a declared merge rule.",
      details: { datasetCount: datasets.length },
    });
  }

  const files = parseFiles(
    context,
    fileValues,
    classes,
    datasets,
    type,
    segmentationNormalClassIndex,
  );
  if (!files) return failure(context.diagnostics);

  reportKnownLosses(context, projectRaw, classes, datasets, files);

  const compatibilitySummary = summarizeCompatibility(context.diagnostics);
  const project: ProjectIR = {
    schemaVersion: 1,
    source: {
      format: context.format,
      ...(context.fileName ? { fileName: context.fileName } : {}),
      ...(context.archive
        ? { projectJsonEntry: context.archive.projectJsonEntryName }
        : {}),
      rawProjectType: rawType,
    },
    project: {
      ...optionalSourceId(projectRaw.projectId),
      name,
      type,
      rawType,
      description: optionalString(projectRaw.description) ?? "",
      ...optionalNumberProperty("createdAt", projectRaw.createdDate),
      ...optionalNumberProperty("modifiedAt", projectRaw.modifiedDate),
      ...(roi ? { roi } : {}),
      ...(optionalString(projectRaw.roiMode)
        ? { roiMode: optionalString(projectRaw.roiMode) }
        : {}),
      raw: projectRaw,
    },
    classes,
    datasets,
    files,
    raw: value,
    compatibility: compatibilitySummary,
  };

  if (hasFatalValidation(context.diagnostics)) return failure(context.diagnostics);
  return {
    ok: true,
    project,
    diagnostics: context.diagnostics,
    compatibility: compatibilitySummary,
  };
}

function preflightJsonText(
  context: ParseContext,
  text: string,
  path: string,
  enforceTextLimit = true,
): boolean {
  if (
    enforceTextLimit &&
    exceedsUtf8ByteLimit(text, V2_PROJECT_TEXT_MAX_BYTES)
  ) {
    addDiagnostic(context, {
      code: "V2_TEXT_LIMIT_EXCEEDED",
      category: "security",
      severity: "error",
      disposition: "block",
      path,
      message: `V2 JSON exceeds the ${V2_PROJECT_TEXT_MAX_BYTES}-byte UTF-8 text limit.`,
      details: { maxBytes: V2_PROJECT_TEXT_MAX_BYTES },
    });
    return false;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > PROJECT_STRUCTURE_MAX_DEPTH) {
        addDiagnostic(context, {
          code: "V2_JSON_DEPTH_LIMIT_EXCEEDED",
          category: "security",
          severity: "error",
          disposition: "block",
          path,
          message: `JSON nesting exceeds ${PROJECT_STRUCTURE_MAX_DEPTH} levels.`,
          details: { maxDepth: PROJECT_STRUCTURE_MAX_DEPTH, offset: index },
        });
        return false;
      }
    } else if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
    }
  }
  return true;
}

function validateV2ResourceShape(
  context: ParseContext,
  project: JsonObject,
): boolean {
  let valid = true;
  const checkArrayLimit = (
    value: JsonValue | undefined,
    maximum: number,
    code: string,
    path: string,
    entityName: string,
  ): boolean => {
    if (!Array.isArray(value) || value.length <= maximum) return true;
    addDiagnostic(context, {
      code,
      category: "security",
      severity: "error",
      disposition: "block",
      path,
      message: `V2 ${entityName} count must not exceed ${maximum}.`,
      details: { actualCount: value.length, maximum },
    });
    return false;
  };

  valid =
    checkArrayLimit(
      project.classInfos,
      V2_PROJECT_LIMITS.maxClasses,
      "V2_CLASS_LIMIT_EXCEEDED",
      "$.project.classInfos",
      "class",
    ) && valid;
  valid =
    checkArrayLimit(
      project.datasets,
      V2_PROJECT_LIMITS.maxDatasets,
      "V2_DATASET_LIMIT_EXCEEDED",
      "$.project.datasets",
      "dataset",
    ) && valid;
  const filesWithinLimit = checkArrayLimit(
    project.projectFiles,
    V2_PROJECT_LIMITS.maxFiles,
    "V2_FILE_LIMIT_EXCEEDED",
    "$.project.projectFiles",
    "file",
  );
  valid = filesWithinLimit && valid;

  if (filesWithinLimit && Array.isArray(project.projectFiles)) {
    let totalLabels = 0;
    let totalSplitMemberships = 0;
    let overlongPathCount = 0;
    for (const file of project.projectFiles) {
      if (!isJsonObject(file)) continue;
      if (
        typeof file.filePath === "string" &&
        exceedsUtf8ByteLimit(file.filePath, PROJECT_PATH_MAX_BYTES)
      ) {
        overlongPathCount += 1;
      }
      if (Array.isArray(file.labelDataList)) {
        totalLabels = Math.min(
          V2_PROJECT_LIMITS.maxLabels + 1,
          totalLabels + file.labelDataList.length,
        );
      }
      if (Array.isArray(file.splitSets)) {
        totalSplitMemberships = Math.min(
          V2_PROJECT_LIMITS.maxSplitMemberships + 1,
          totalSplitMemberships + file.splitSets.length,
        );
      }
    }
    if (totalLabels > V2_PROJECT_LIMITS.maxLabels) {
      addDiagnostic(context, {
        code: "V2_LABEL_LIMIT_EXCEEDED",
        category: "security",
        severity: "error",
        disposition: "block",
        path: "$.project.projectFiles[*].labelDataList",
        message: `Total V2 label count must not exceed ${V2_PROJECT_LIMITS.maxLabels}.`,
        details: {
          observedCountAtLeast: totalLabels,
          maximum: V2_PROJECT_LIMITS.maxLabels,
        },
      });
      valid = false;
    }
    if (overlongPathCount > 0) {
      addDiagnostic(context, {
        code: "V2_PATH_LIMIT_EXCEEDED",
        category: "security",
        severity: "error",
        disposition: "block",
        path: "$.project.projectFiles[*].filePath",
        message: `V2 image paths must not exceed ${PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
        details: {
          overlongPathCount,
          maxBytes: PROJECT_PATH_MAX_BYTES,
        },
      });
      valid = false;
    }
    if (totalSplitMemberships > V2_PROJECT_LIMITS.maxSplitMemberships) {
      addDiagnostic(context, {
        code: "V2_SPLIT_LIMIT_EXCEEDED",
        category: "security",
        severity: "error",
        disposition: "block",
        path: "$.project.projectFiles[*].splitSets",
        message: `Total V2 split membership count must not exceed ${V2_PROJECT_LIMITS.maxSplitMemberships}.`,
        details: {
          observedCountAtLeast: totalSplitMemberships,
          maximum: V2_PROJECT_LIMITS.maxSplitMemberships,
        },
      });
      valid = false;
    }
  }
  return valid;
}

function validateJsonValueBudget(
  context: ParseContext,
  root: unknown,
  path: string,
): boolean {
  const stack: unknown[] = [root];
  let valueCount = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    valueCount += 1;
    if (valueCount > PROJECT_JSON_MAX_VALUES) {
      addDiagnostic(context, {
        code: "V2_JSON_VALUE_LIMIT_EXCEEDED",
        category: "security",
        severity: "error",
        disposition: "block",
        path,
        message: `JSON value count must not exceed ${PROJECT_JSON_MAX_VALUES}.`,
        details: { maximum: PROJECT_JSON_MAX_VALUES },
      });
      return false;
    }
    if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
    } else if (isJsonObject(value)) {
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  return true;
}

function parseClasses(
  context: ParseContext,
  values: readonly JsonObject[],
  projectType: ProjectType,
): ProjectClassIR[] | undefined {
  type ParsedClass = ProjectClassIR & { readonly requestedIndex?: number };
  const parsed: ParsedClass[] = [];
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  const requestedIndexes = new Map<number, number>();

  for (const [sourceIndex, raw] of values.entries()) {
    const path = `$.project.classInfos[${sourceIndex}]`;
    reportUnknownFields(context, raw, CLASS_KNOWN_FIELDS, path, "class");
    const name = requiredNonEmptyString(
      context,
      raw.className,
      `${path}.className`,
      "V2_CLASS_NAME_INVALID",
    );
    if (!name) continue;

    if (hasMeaningfulValue(raw.description)) {
      compatibility(context, {
        code: "V2_CLASS_DESCRIPTION_NOT_IN_V1",
        disposition: "drop",
        severity: "warning",
        path: `${path}.description`,
        message: "V2 class descriptions are retained in raw data but have no V1 field.",
      });
    }
    if (typeof raw.isNg === "boolean" && projectType !== "segmentation") {
      compatibility(context, {
        code: "V2_CLASS_NG_FLAG_NOT_IN_V1",
        disposition: "drop",
        severity: "warning",
        path: `${path}.isNg`,
        message: "The V2 class-level NG flag has no verified V1 field.",
      });
    }

    const sourceId = sourceIdValue(raw.classId);
    if (sourceId !== undefined) {
      const key = idKey(sourceId);
      if (ids.has(key)) {
        invalid(
          context,
          `${path}.classId`,
          "V2_DUPLICATE_CLASS_ID",
          `Duplicate classId '${sourceId}'.`,
        );
      } else {
        ids.set(key, sourceIndex);
      }
    }

    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) {
      invalid(
        context,
        `${path}.className`,
        "V2_DUPLICATE_CLASS_NAME",
        `Duplicate class name '${name}'.`,
      );
    } else {
      names.set(nameKey, sourceIndex);
    }

    const requestedIndex = nonNegativeInteger(raw.classNo);
    if (requestedIndex !== undefined) {
      if (requestedIndexes.has(requestedIndex)) {
        invalid(
          context,
          `${path}.classNo`,
          "V2_DUPLICATE_CLASS_NUMBER",
          `Duplicate classNo '${requestedIndex}'.`,
        );
      } else {
        requestedIndexes.set(requestedIndex, sourceIndex);
      }
    }

    parsed.push({
      ...(sourceId !== undefined ? { sourceId } : {}),
      index: requestedIndex ?? sourceIndex,
      sourceIndex,
      ...(requestedIndex !== undefined ? { requestedIndex } : {}),
      name,
      ...(optionalString(raw.classColor) ? { color: optionalString(raw.classColor) } : {}),
      description: optionalString(raw.description) ?? "",
      ...(typeof raw.isNg === "boolean" ? { isNg: raw.isNg } : {}),
      raw,
    });
  }

  if (hasFatalValidation(context.diagnostics)) return undefined;
  const classNumbersAreCanonical =
    parsed.length > 0 &&
    parsed.every((item) => item.requestedIndex !== undefined) &&
    parsed.every((_, index) => requestedIndexes.has(index));

  if (!classNumbersAreCanonical && parsed.length > 0) {
    compatibility(context, {
      code: "V2_CLASS_INDEX_REBUILT",
      disposition: "rebuild",
      severity: "info",
      path: "$.project.classInfos",
      message: "Class indexes will be rebuilt deterministically from source order.",
    });
    return parsed.map((item, index) => withoutRequestedIndex(item, index));
  }

  return parsed
    .sort((left, right) => left.index - right.index)
    .map((item) => withoutRequestedIndex(item, item.index));
}

function identifySegmentationNormalClass(
  context: ParseContext,
  classes: readonly ProjectClassIR[],
): number | undefined {
  const candidates = classes.filter(
    (item) =>
      item.index === 0 &&
      nonNegativeInteger(item.raw.classNo) === 0 &&
      normalizedClassName(item.name) === "ok" &&
      item.isNg === false,
  );
  const defectClassesAreExplicit = classes.every(
    (item) => candidates.includes(item) || item.isNg === true,
  );

  if (candidates.length !== 1 || !defectClassesAreExplicit) {
    compatibility(context, {
      code: "V2_SEGMENTATION_CLASS_STRUCTURE_INVALID",
      disposition: "block",
      severity: "error",
      path: "$.project.classInfos",
      message:
        "A V2 Segmentation project must declare one classNo 0 class named 'OK' with isNg=false, and every defect class must declare isNg=true.",
      details: {
        okCandidateCount: candidates.length,
        classCount: classes.length,
      },
    });
    return undefined;
  }

  const normalClass = candidates[0]!;
  compatibility(context, {
    code: "V2_SEGMENTATION_OK_CLASS_RECOGNIZED",
    disposition: "rebuild",
    severity: "info",
    path: `$.project.classInfos[${normalClass.sourceIndex}]`,
    message:
      "The structural V2 OK class is retained in the IR and rebuilt as V1 normal-image state during conversion.",
    details: {
      normalClassIndex: normalClass.index,
      defectClassCount: classes.length - 1,
    },
  });
  return normalClass.index;
}

function withoutRequestedIndex(
  item: ProjectClassIR & { readonly requestedIndex?: number },
  index: number,
): ProjectClassIR {
  return {
    ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
    index,
    sourceIndex: item.sourceIndex,
    name: item.name,
    ...(item.color !== undefined ? { color: item.color } : {}),
    description: item.description,
    ...(item.isNg !== undefined ? { isNg: item.isNg } : {}),
    raw: item.raw,
  };
}

function parseDatasets(
  context: ParseContext,
  values: readonly JsonObject[],
): ProjectDatasetIR[] | undefined {
  const ids = new Set<string>();
  const datasets: ProjectDatasetIR[] = [];
  for (const [index, raw] of values.entries()) {
    const path = `$.project.datasets[${index}]`;
    reportUnknownFields(context, raw, DATASET_KNOWN_FIELDS, path, "dataset");
    const name = requiredNonEmptyString(
      context,
      raw.datasetName,
      `${path}.datasetName`,
      "V2_DATASET_NAME_INVALID",
    );
    if (!name) continue;
    const sourceId = sourceIdValue(raw.datasetId);
    if (sourceId !== undefined) {
      const key = idKey(sourceId);
      if (ids.has(key)) {
        invalid(
          context,
          `${path}.datasetId`,
          "V2_DUPLICATE_DATASET_ID",
          `Duplicate datasetId '${sourceId}'.`,
        );
      }
      ids.add(key);
    }
    datasets.push({
      ...(sourceId !== undefined ? { sourceId } : {}),
      index,
      name,
      description: optionalString(raw.description) ?? "",
      raw,
    });
  }
  return hasFatalValidation(context.diagnostics) ? undefined : datasets;
}

function parseFiles(
  context: ParseContext,
  values: readonly JsonObject[],
  classes: readonly ProjectClassIR[],
  datasets: readonly ProjectDatasetIR[],
  projectType: ProjectType,
  segmentationNormalClassIndex: number | undefined,
): ProjectFileIR[] | undefined {
  const ids = new Map<string, number>();
  const paths = new Map<string, number>();
  const files: ProjectFileIR[] = [];
  let segmentationNormalMarkerCount = 0;

  for (const [index, raw] of values.entries()) {
    if (context.contourPointLimitExceeded) return undefined;
    const path = `$.project.projectFiles[${index}]`;
    reportUnknownFields(context, raw, FILE_KNOWN_FIELDS, path, "file");
    const sourceId = sourceIdValue(raw.fileId);
    if (sourceId === undefined) {
      invalid(context, `${path}.fileId`, "V2_FILE_ID_INVALID", "fileId is required.");
      continue;
    }
    const id = idKey(sourceId);
    if (ids.has(id)) {
      invalid(
        context,
        `${path}.fileId`,
        "V2_DUPLICATE_FILE_ID",
        `Duplicate fileId '${sourceId}'.`,
      );
      continue;
    }
    ids.set(id, index);

    const sourcePath = requiredNonEmptyString(
      context,
      raw.filePath,
      `${path}.filePath`,
      "V2_FILE_PATH_INVALID",
    );
    if (!sourcePath) continue;
    const normalizedPath = normalizeSlashes(sourcePath);
    const declaredFileName = optionalString(raw.fileName);
    if (
      declaredFileName &&
      declaredFileName.toLocaleLowerCase() !== lastSegment(normalizedPath).toLocaleLowerCase()
    ) {
      compatibility(context, {
        code: "V2_FILE_NAME_MISMATCH",
        disposition: "drop",
        severity: "warning",
        path: `${path}.fileName`,
        message: "fileName differs from the last segment of filePath; filePath is canonical.",
        details: { fileName: declaredFileName, filePath: sourcePath },
      });
    }
    const pathKey = normalizedPath.toLocaleLowerCase();
    if (paths.has(pathKey)) {
      invalid(
        context,
        `${path}.filePath`,
        "V2_DUPLICATE_FILE_PATH",
        `Two project files reference the same normalized path '${normalizedPath}'.`,
      );
      continue;
    }
    paths.set(pathKey, index);

    const image = resolveImageSource(context, normalizedPath, `${path}.filePath`);
    if (!image) continue;

    const splitValues = optionalObjectArray(context, raw.splitSets, `${path}.splitSets`);
    if (!splitValues) continue;
    const splits = parseSplits(context, splitValues, path);
    const canonicalSplit = canonicalizeSplits(context, splits, path);

    const datasetIndex = resolveDatasetIndex(context, raw, datasets, path);
    const fileClassIndex =
      projectType === "classification" || projectType === "segmentation"
        ? resolveClassIndex(context, raw, classes, path, hasClassReference(raw))
        : undefined;

    if (raw.isLabeled !== undefined && typeof raw.isLabeled !== "boolean") {
      invalid(
        context,
        `${path}.isLabeled`,
        "V2_IS_LABELED_INVALID",
        "isLabeled must be boolean when supplied.",
      );
    }

    const width = positiveSafeInteger(raw.width);
    const height = positiveSafeInteger(raw.height);
    if (raw.width !== undefined && width === undefined) {
      invalid(
        context,
        `${path}.width`,
        "V2_WIDTH_INVALID",
        "Image width must be a positive safe integer.",
      );
    }
    if (raw.height !== undefined && height === undefined) {
      invalid(
        context,
        `${path}.height`,
        "V2_HEIGHT_INVALID",
        "Image height must be a positive safe integer.",
      );
    }
    if (width !== undefined && width > MAX_IMAGE_DIMENSION) {
      invalid(
        context,
        `${path}.width`,
        "V2_IMAGE_DIMENSION_LIMIT_EXCEEDED",
        `Image width must not exceed ${MAX_IMAGE_DIMENSION}.`,
      );
    }
    if (height !== undefined && height > MAX_IMAGE_DIMENSION) {
      invalid(
        context,
        `${path}.height`,
        "V2_IMAGE_DIMENSION_LIMIT_EXCEEDED",
        `Image height must not exceed ${MAX_IMAGE_DIMENSION}.`,
      );
    }
    if (
      width !== undefined &&
      height !== undefined &&
      width <= MAX_IMAGE_DIMENSION &&
      height <= MAX_IMAGE_DIMENSION &&
      width * height > MAX_IMAGE_PIXELS
    ) {
      invalid(
        context,
        path,
        "V2_IMAGE_PIXEL_LIMIT_EXCEEDED",
        `Image pixel count must not exceed ${MAX_IMAGE_PIXELS}.`,
      );
    }

    const labelValues = optionalObjectArray(
      context,
      raw.labelDataList,
      `${path}.labelDataList`,
    );
    if (!labelValues) continue;
    const parsedLabels = parseLabels(
      context,
      labelValues,
      classes,
      projectType,
      raw,
      path,
      fileClassIndex,
      width,
      height,
      segmentationNormalClassIndex,
    );
    if (context.contourPointLimitExceeded) return undefined;
    if (parsedLabels.segmentationNormalMarker) {
      segmentationNormalMarkerCount += 1;
    }
    const labels = parsedLabels.labels;
    validateGeometryBounds(context, labels, width, height, path);
    const segmentationIsNormal =
      projectType === "segmentation"
        ? parseSegmentationFileState(
            context,
            raw,
            path,
            labels,
            fileClassIndex,
            segmentationNormalClassIndex,
            parsedLabels.segmentationNormalMarker === true,
          )
        : undefined;

    files.push({
      sourceId,
      index,
      sourcePath,
      normalizedPath,
      fileName: lastSegment(normalizedPath),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(typeof raw.isLabeled === "boolean" ? { isLabeled: raw.isLabeled } : {}),
      ...(segmentationIsNormal !== undefined
        ? { isNormal: segmentationIsNormal }
        : {}),
      ...(optionalString(raw.datasetName) ? { datasetName: optionalString(raw.datasetName) } : {}),
      ...(datasetIndex !== undefined ? { datasetIndex } : {}),
      ...(parsedLabels.classificationClassIndex !== undefined
        ? { classificationClassIndex: parsedLabels.classificationClassIndex }
        : {}),
      splits,
      canonicalSplit,
      labels,
      image,
      raw,
    });
  }

  if (segmentationNormalMarkerCount > 0) {
    compatibility(context, {
      code: "V2_SEGMENTATION_NORMAL_MARKERS_REBUILT",
      disposition: "rebuild",
      severity: "info",
      path: "$.project.projectFiles[*].labelDataList",
      message:
        "Geometry-less structural OK markers are normalized to V1 normal-image state.",
      details: { affectedEntityCount: segmentationNormalMarkerCount },
    });
  }

  return hasFatalValidation(context.diagnostics) ? undefined : files;
}

function parseSplits(
  context: ParseContext,
  values: readonly JsonObject[],
  filePath: string,
): ProjectSplitIR[] {
  return values.map((raw, index) => {
    const path = `${filePath}.splitSets[${index}]`;
    reportUnknownFields(context, raw, SPLIT_KNOWN_FIELDS, path, "split");
    const rawType = optionalString(raw.splitType);
    const type = normalizeSplitType(rawType);
    if (type === "unknown") {
      compatibility(context, {
        code: "V2_SPLIT_TYPE_UNSUPPORTED",
        disposition: "block",
        severity: "error",
        path: `${path}.splitType`,
        message: `Split type '${rawType ?? ""}' has no V1 equivalent.`,
      });
    }
    return {
      ...optionalSourceId(raw.splitId),
      ...(optionalString(raw.splitName) ? { sourceName: optionalString(raw.splitName) } : {}),
      type,
      ...(rawType ? { rawType } : {}),
      raw,
    };
  });
}

function canonicalizeSplits(
  context: ParseContext,
  splits: readonly ProjectSplitIR[],
  filePath: string,
): SplitType {
  if (splits.length === 0) {
    compatibility(context, {
      code: "V2_SPLIT_MISSING",
      disposition: "block",
      severity: "error",
      path: `${filePath}.splitSets`,
      message: "The image has no V2 split assignment.",
    });
    return "unassigned";
  }
  const known = new Set(
    splits.map((split) => split.type).filter((type) => type !== "unknown"),
  );
  if (known.size > 1) {
    compatibility(context, {
      code: "V2_SPLIT_CONFLICT",
      disposition: "block",
      severity: "error",
      path: `${filePath}.splitSets`,
      message: "The image belongs to conflicting V2 split types.",
    });
    return "unknown";
  }
  if (splits.length > 1) {
    compatibility(context, {
      code: "V2_MULTIPLE_SPLIT_MEMBERSHIPS",
      disposition: "degrade",
      severity: "warning",
      path: `${filePath}.splitSets`,
      message: "Multiple V2 split memberships collapse to one V1 SplitState.",
      details: { membershipCount: splits.length },
    });
  }
  return known.values().next().value ?? "unknown";
}

function parseLabels(
  context: ParseContext,
  values: readonly JsonObject[],
  classes: readonly ProjectClassIR[],
  projectType: ProjectType,
  fileRaw: JsonObject,
  filePath: string,
  fileClassIndex: number | undefined,
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  segmentationNormalClassIndex: number | undefined,
): ParsedLabels {
  if (projectType === "classification") {
    return parseClassificationLabels(
      context,
      values,
      classes,
      fileRaw,
      filePath,
      fileClassIndex,
      imageWidth,
      imageHeight,
    );
  }

  const labels: ProjectLabelIR[] = [];
  for (const [index, raw] of values.entries()) {
    if (context.contourPointLimitExceeded) break;
    const path = `${filePath}.labelDataList[${index}]`;
    reportUnknownFields(context, raw, LABEL_KNOWN_FIELDS, path, "label");
    const classIndex = resolveClassIndex(context, raw, classes, path, true);
    const kind = inferLabelKind(projectType, raw);
    if (projectType === "segmentation") {
      validateContourSize(context, raw.contourSize, path);
    }
    if (
      projectType === "segmentation" &&
      values.length === 1 &&
      fileRaw.isLabeled === true &&
      segmentationNormalClassIndex !== undefined &&
      classIndex === segmentationNormalClassIndex &&
      (fileClassIndex === undefined || fileClassIndex === segmentationNormalClassIndex) &&
      !hasSegmentationGeometryFields(raw)
    ) {
      return { labels: [], segmentationNormalMarker: true };
    }

    const geometry = parseLabelGeometry(context, raw, kind, path);
    if (context.contourPointLimitExceeded) break;
    if (kind === "unknown") {
      compatibility(context, {
        code: "V2_LABEL_GEOMETRY_UNSUPPORTED",
        disposition: "block",
        severity: "error",
        path,
        message: "The label geometry cannot be represented by the declared project type.",
      });
    }
    const cls = classIndex === undefined ? undefined : classes[classIndex];
    const sourceId = sourceIdValue(raw.labelId);
    const origin = normalizeLabelOrigin(optionalString(raw.labelType));
    if (origin !== "manual") {
      compatibility(context, {
        code: "V2_LABEL_ORIGIN_NOT_IN_V1",
        disposition: "drop",
        severity: "warning",
        path: `${path}.labelType`,
        message: "V2 label origin is retained in raw data but has no V1 equivalent.",
        details: { labelType: optionalString(raw.labelType) ?? "" },
      });
    }
    labels.push({
      ...(sourceId !== undefined ? { sourceId } : {}),
      index,
      kind,
      origin,
      ...(classIndex !== undefined ? { classIndex } : {}),
      ...(cls?.sourceId !== undefined ? { sourceClassId: cls.sourceId } : {}),
      ...(optionalString(raw.className)
        ? { sourceClassName: optionalString(raw.className) }
        : cls
          ? { sourceClassName: cls.name }
          : {}),
      geometry,
      synthesized: false,
      raw,
    });
  }
  return { labels };
}

function hasSegmentationGeometryFields(raw: JsonObject): boolean {
  return [
    "labelPosX",
    "labelPosY",
    "labelWidth",
    "labelHeight",
    "labelBitmap",
    "labelPolygon",
    "labelContour",
    "contourSize",
    "contourId",
  ].some((field) => raw[field] !== undefined);
}

function parseClassificationLabels(
  context: ParseContext,
  values: readonly JsonObject[],
  classes: readonly ProjectClassIR[],
  fileRaw: JsonObject,
  filePath: string,
  fileClassIndex: number | undefined,
  imageWidth: number | undefined,
  imageHeight: number | undefined,
): ParsedLabels {
  if (values.length === 0) {
    if (fileClassIndex === undefined) {
      compatibility(context, {
        code: "V2_CLASSIFICATION_CLASS_MISSING",
        disposition: "block",
        severity: "error",
        path: filePath,
        message:
          "A classification file must resolve to exactly one class, but it has neither a full-image label nor a valid file-level class.",
        details: { isLabeled: fileRaw.isLabeled ?? null },
      });
      return { labels: [] };
    }
    if (fileRaw.isLabeled === false) {
      reportClassificationStateConflict(context, filePath);
    }
    const cls = classes[fileClassIndex];
    return {
      labels: [
        {
          index: 0,
          kind: "classification",
          origin: "manual",
          classIndex: fileClassIndex,
          ...(cls?.sourceId !== undefined ? { sourceClassId: cls.sourceId } : {}),
          ...(cls ? { sourceClassName: cls.name } : {}),
          geometry: {},
          synthesized: true,
          raw: classificationRaw(fileRaw),
        },
      ],
      classificationClassIndex: fileClassIndex,
    };
  }

  if (values.length > 1) {
    compatibility(context, {
      code: "V2_CLASSIFICATION_MULTIPLE_LABELS",
      disposition: "block",
      severity: "error",
      path: `${filePath}.labelDataList`,
      message: "A classification image must contain at most one full-image label.",
      details: { labelCount: values.length },
    });
  }

  const labels: ProjectLabelIR[] = [];
  for (const [index, raw] of values.entries()) {
    if (context.contourPointLimitExceeded) break;
    const path = `${filePath}.labelDataList[${index}]`;
    reportUnknownFields(context, raw, LABEL_KNOWN_FIELDS, path, "label");
    const classIndex = resolveClassIndex(context, raw, classes, path, true);
    const cls = classIndex === undefined ? undefined : classes[classIndex];
    const sourceId = sourceIdValue(raw.labelId);
    const origin = normalizeLabelOrigin(optionalString(raw.labelType));
    if (origin !== "manual") {
      compatibility(context, {
        code: "V2_LABEL_ORIGIN_NOT_IN_V1",
        disposition: "drop",
        severity: "warning",
        path: `${path}.labelType`,
        message: "V2 label origin is retained in raw data but has no V1 equivalent.",
        details: { labelType: optionalString(raw.labelType) ?? "" },
      });
    }
    const geometry = parseClassificationGeometry(
      context,
      raw,
      path,
      imageWidth,
      imageHeight,
    );
    if (context.contourPointLimitExceeded) break;
    labels.push({
      ...(sourceId !== undefined ? { sourceId } : {}),
      index,
      kind: "classification",
      origin,
      ...(classIndex !== undefined ? { classIndex } : {}),
      ...(cls?.sourceId !== undefined ? { sourceClassId: cls.sourceId } : {}),
      ...(optionalString(raw.className)
        ? { sourceClassName: optionalString(raw.className) }
        : cls
          ? { sourceClassName: cls.name }
          : {}),
      geometry,
      synthesized: false,
      raw,
    });
  }

  const labelClassIndexes = Array.from(
    new Set(
      labels
        .map((label) => label.classIndex)
        .filter((value): value is number => value !== undefined),
    ),
  );
  const labelClassIndex =
    labelClassIndexes.length === 1 ? labelClassIndexes[0] : undefined;
  const representationsConflict =
    fileClassIndex !== undefined &&
    labelClassIndex !== undefined &&
    fileClassIndex !== labelClassIndex;
  if (representationsConflict) {
    compatibility(context, {
      code: "V2_CLASSIFICATION_CLASS_CONFLICT",
      disposition: "block",
      severity: "error",
      path: filePath,
      message: "The file-level class conflicts with the full-image classification label.",
      details: { fileClassIndex, labelClassIndex },
    });
  }
  if (fileRaw.isLabeled === false) {
    reportClassificationStateConflict(context, filePath);
  }

  return {
    labels,
    ...(!representationsConflict && labelClassIndex !== undefined
      ? { classificationClassIndex: labelClassIndex }
      : !representationsConflict && fileClassIndex !== undefined
        ? { classificationClassIndex: fileClassIndex }
        : {}),
  };
}

function parseClassificationGeometry(
  context: ParseContext,
  raw: JsonObject,
  path: string,
  imageWidth: number | undefined,
  imageHeight: number | undefined,
): LabelGeometryIR {
  const geometry: {
    box?: { x: number; y: number; width: number; height: number };
    contours?: readonly (readonly PointIR[])[];
    bitmap?: string;
  } = {};
  let hasGeometry = false;
  let isVerifiedFullImage = true;

  if (hasMeaningfulValue(raw.labelBitmap)) {
    hasGeometry = true;
    isVerifiedFullImage = false;
    const bitmap = optionalString(raw.labelBitmap);
    if (bitmap !== undefined) geometry.bitmap = bitmap;
    reportUnsupportedClassificationGeometry(
      context,
      `${path}.labelBitmap`,
      "Bitmap classification geometry cannot be represented by a V1 image-level class.",
      "bitmap",
    );
  }

  if (hasBoxFields(raw)) {
    hasGeometry = true;
    const x = finiteNumber(raw.labelPosX);
    const y = finiteNumber(raw.labelPosY);
    const width = positiveNumber(raw.labelWidth);
    const height = positiveNumber(raw.labelHeight);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      isVerifiedFullImage = false;
      invalid(
        context,
        path,
        "V2_CLASSIFICATION_GEOMETRY_INVALID",
        "A full-image classification label requires finite x/y and positive width/height.",
      );
    } else {
      geometry.box = { x, y, width, height };
      if (!isFullImageBox(geometry.box, imageWidth, imageHeight)) {
        isVerifiedFullImage = false;
        reportUnsupportedClassificationGeometry(
          context,
          path,
          imageWidth === undefined || imageHeight === undefined
            ? "Classification box geometry cannot be verified as full-image because image dimensions are missing."
            : "Classification box geometry covers less or more than the complete image.",
          imageWidth === undefined || imageHeight === undefined
            ? "dimensions-missing"
            : "not-full-image",
        );
      }
    }
  }
  const contourValue = raw.labelContour ?? raw.labelPolygon;
  if (contourValue !== undefined) {
    hasGeometry = true;
    const contours = parseContours(context, contourValue, path);
    if (contours.length > 0) geometry.contours = contours;
    if (contours.length === 0) {
      isVerifiedFullImage = false;
    } else if (contours.length > 1) {
      isVerifiedFullImage = false;
      reportUnsupportedClassificationGeometry(
        context,
        `${path}.labelContour`,
        "V1 Classification cannot preserve multiple contour rings or holes.",
        "multiple-rings",
      );
    } else if (
      contours.length === 1 &&
      !isFullImageContour(contours[0]!, imageWidth, imageHeight)
    ) {
      isVerifiedFullImage = false;
      reportUnsupportedClassificationGeometry(
        context,
        `${path}.labelContour`,
        imageWidth === undefined || imageHeight === undefined
          ? "Classification contour geometry cannot be verified as full-image because image dimensions are missing."
          : "Classification contour geometry is not strictly equivalent to the complete image boundary.",
        imageWidth === undefined || imageHeight === undefined
          ? "dimensions-missing"
          : "not-full-image",
      );
    }
  }

  if (hasGeometry && isVerifiedFullImage) {
    compatibility(context, {
      code: "V2_CLASSIFICATION_FULL_IMAGE_GEOMETRY",
      disposition: "preserve",
      severity: "info",
      path,
      message:
        "Full-image classification geometry is semantically equivalent to the V1 image-level class.",
    });
  }
  return geometry;
}

function reportUnsupportedClassificationGeometry(
  context: ParseContext,
  path: string,
  message: string,
  reason: string,
): void {
  compatibility(context, {
    code: "V2_CLASSIFICATION_GEOMETRY_NOT_IN_V1",
    disposition: "block",
    severity: "error",
    path,
    message,
    details: { reason },
  });
}

function isFullImageBox(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  imageWidth: number | undefined,
  imageHeight: number | undefined,
): boolean {
  return (
    imageWidth !== undefined &&
    imageHeight !== undefined &&
    box.x === 0 &&
    box.y === 0 &&
    box.width === imageWidth &&
    box.height === imageHeight
  );
}

function isFullImageContour(
  sourceRing: readonly PointIR[],
  imageWidth: number | undefined,
  imageHeight: number | undefined,
): boolean {
  if (imageWidth === undefined || imageHeight === undefined) return false;
  const ring =
    sourceRing.length > 1 && pointsEqual(sourceRing[0]!, sourceRing.at(-1)!)
      ? sourceRing.slice(0, -1)
      : sourceRing;
  if (ring.length < 4) return false;

  for (const point of ring) {
    const onHorizontalEdge =
      (point.y === 0 || point.y === imageHeight) &&
      point.x >= 0 &&
      point.x <= imageWidth;
    const onVerticalEdge =
      (point.x === 0 || point.x === imageWidth) &&
      point.y >= 0 &&
      point.y <= imageHeight;
    if (!onHorizontalEdge && !onVerticalEdge) return false;
  }

  for (const [index, point] of ring.entries()) {
    const next = ring[(index + 1) % ring.length]!;
    if (pointsEqual(point, next)) return false;
    const followsHorizontalBoundary =
      point.y === next.y && (point.y === 0 || point.y === imageHeight);
    const followsVerticalBoundary =
      point.x === next.x && (point.x === 0 || point.x === imageWidth);
    if (!followsHorizontalBoundary && !followsVerticalBoundary) return false;
  }

  let doubledArea = 0;
  for (const [index, point] of ring.entries()) {
    const next = ring[(index + 1) % ring.length]!;
    doubledArea += point.x * next.y - next.x * point.y;
  }
  return Math.abs(doubledArea) === 2 * imageWidth * imageHeight;
}

function pointsEqual(left: PointIR, right: PointIR): boolean {
  return left.x === right.x && left.y === right.y;
}

function reportClassificationStateConflict(
  context: ParseContext,
  filePath: string,
): void {
  compatibility(context, {
    code: "V2_CLASSIFICATION_STATE_CONFLICT",
    disposition: "block",
    severity: "error",
    path: `${filePath}.isLabeled`,
    message: "An explicitly unlabeled file cannot carry a classification class or label.",
  });
}

function parseSegmentationFileState(
  context: ParseContext,
  fileRaw: JsonObject,
  filePath: string,
  labels: readonly ProjectLabelIR[],
  fileClassIndex: number | undefined,
  normalClassIndex: number | undefined,
  hasNormalMarker: boolean,
): boolean | undefined {
  const isLabeled =
    typeof fileRaw.isLabeled === "boolean" ? fileRaw.isLabeled : undefined;

  if (hasNormalMarker) {
    if (isLabeled !== true) {
      compatibility(context, {
        code: "V2_SEGMENTATION_LABEL_STATE_CONFLICT",
        disposition: "block",
        severity: "error",
        path: `${filePath}.isLabeled`,
        message:
          "A geometry-less structural OK marker requires isLabeled=true.",
      });
      return undefined;
    }
    if (
      fileClassIndex !== undefined &&
      (normalClassIndex === undefined || fileClassIndex !== normalClassIndex)
    ) {
      compatibility(context, {
        code: "V2_SEGMENTATION_NORMAL_CLASS_CONTOUR_CONFLICT",
        disposition: "block",
        severity: "error",
        path: `${filePath}.labelDataList`,
        message:
          "The structural OK marker conflicts with the file-level defect class assignment.",
        details: { fileClassIndex, normalClassIndex: normalClassIndex ?? null },
      });
      return undefined;
    }
    return true;
  }

  if (labels.length > 0) {
    if (isLabeled === false) {
      compatibility(context, {
        code: "V2_SEGMENTATION_LABEL_STATE_CONFLICT",
        disposition: "block",
        severity: "error",
        path: `${filePath}.isLabeled`,
        message:
          "A V2 Segmentation file marked as unlabeled cannot contain contour labels.",
        details: { labelCount: labels.length },
      });
    }

    const resolvedClassIndexes = labels
      .map((label) => label.classIndex)
      .filter((value): value is number => value !== undefined);
    const containsNormalLabel =
      normalClassIndex !== undefined &&
      resolvedClassIndexes.includes(normalClassIndex);
    const fileUsesNormalClass =
      normalClassIndex !== undefined && fileClassIndex === normalClassIndex;
    if (containsNormalLabel || fileUsesNormalClass) {
      compatibility(context, {
        code: "V2_SEGMENTATION_NORMAL_CLASS_CONTOUR_CONFLICT",
        disposition: "block",
        severity: "error",
        path: `${filePath}.labelDataList`,
        message:
          "The structural OK class represents a normal image and cannot carry a defect contour.",
      });
    }

    return false;
  }

  if (isLabeled === false) {
    if (fileClassIndex !== undefined) {
      compatibility(context, {
        code: "V2_SEGMENTATION_UNLABELED_CLASS_CONFLICT",
        disposition: "block",
        severity: "error",
        path: filePath,
        message:
          "An explicitly unlabeled Segmentation file cannot retain a file-level class assignment.",
        details: { fileClassIndex },
      });
    }
    return undefined;
  }
  if (
    isLabeled === true &&
    normalClassIndex !== undefined &&
    fileClassIndex === normalClassIndex
  ) {
    return true;
  }
  if (fileRaw.isLabeled !== undefined && isLabeled === undefined) {
    return undefined;
  }

  compatibility(context, {
    code: "V2_SEGMENTATION_EMPTY_LABEL_STATE_AMBIGUOUS",
    disposition: "block",
    severity: "error",
    path: `${filePath}.labelDataList`,
    message:
      "An empty Segmentation label list is only unambiguous when isLabeled=false (unlabeled) or isLabeled=true with the structural OK class (normal).",
    details: {
      isLabeled: isLabeled ?? null,
      fileClassIndex: fileClassIndex ?? null,
      normalClassIndex: normalClassIndex ?? null,
    },
  });
  return undefined;
}

function inferLabelKind(projectType: ProjectType, raw: JsonObject): LabelKind {
  if (projectType === "detection") {
    return hasBoxFields(raw) ? "box" : "unknown";
  }
  if (projectType === "segmentation") {
    return raw.labelContour !== undefined ||
      raw.labelPolygon !== undefined ||
      raw.labelBitmap !== undefined
      ? "contour"
      : "unknown";
  }
  return "unknown";
}

function parseLabelGeometry(
  context: ParseContext,
  raw: JsonObject,
  kind: LabelKind,
  path: string,
): LabelGeometryIR {
  if (kind === "box") {
    const x = finiteNumber(raw.labelPosX);
    const y = finiteNumber(raw.labelPosY);
    const width = positiveNumber(raw.labelWidth);
    const height = positiveNumber(raw.labelHeight);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      invalid(
        context,
        path,
        "V2_BOX_INVALID",
        "Detection labels require finite x/y and positive width/height.",
      );
      return {};
    }
    return { box: { x, y, width, height } };
  }

  if (kind === "contour") {
    if (optionalString(raw.labelBitmap)) {
      compatibility(context, {
        code: "V2_BITMAP_MASK_UNSUPPORTED",
        disposition: "block",
        severity: "error",
        path: `${path}.labelBitmap`,
        message: "Bitmap-only masks have no verified V1 contour mapping.",
      });
    }
    const contourValue = raw.labelContour ?? raw.labelPolygon;
    const contours = parseContours(context, contourValue, path);
    const box = parseSegmentationBoundingBox(context, raw, contours, path);
    const contourRoles = contours.map(inferContourRingRole);
    const ambiguousRingIndexes = contourRoles.flatMap((role, index) =>
      role === "unknown" ? [index] : [],
    );
    const leadingInnerRingIndexes: number[] = [];
    let hasOuterRing = false;
    for (const [index, role] of contourRoles.entries()) {
      if (role === "outer") {
        hasOuterRing = true;
      } else if (role === "inner" && !hasOuterRing) {
        leadingInnerRingIndexes.push(index);
      }
    }
    if (ambiguousRingIndexes.length > 0 || leadingInnerRingIndexes.length > 0) {
      compatibility(context, {
        code: "V2_CONTOUR_RING_WINDING_AMBIGUOUS",
        disposition: "block",
        severity: "error",
        path: `${path}.labelContour`,
        message:
          "V2 Segmentation rings require positive-area outer winding and negative-area inner winding, with each inner ring following an outer ring.",
        details: {
          ambiguousRingIndexes,
          leadingInnerRingIndexes,
        },
      });
    }
    return {
      ...(box ? { box } : {}),
      ...(contours.length > 0 ? { contours } : {}),
      ...(contourRoles.length > 0 ? { contourRoles } : {}),
      ...(optionalString(raw.labelBitmap) ? { bitmap: optionalString(raw.labelBitmap) } : {}),
    };
  }
  return {};
}

function parseContours(
  context: ParseContext,
  value: JsonValue | undefined,
  path: string,
): readonly (readonly PointIR[])[] {
  if (value === undefined) {
    invalid(context, path, "V2_CONTOUR_MISSING", "Segmentation label has no contour.");
    return [];
  }
  let decoded: unknown = value;
  if (typeof value === "string") {
    if (!preflightJsonText(context, value, `${path}.labelContour`, false)) {
      return [];
    }
    try {
      decoded = JSON.parse(value);
    } catch {
      invalid(
        context,
        `${path}.labelContour`,
        "V2_CONTOUR_INVALID_JSON",
        "labelContour is not valid JSON.",
      );
      return [];
    }
  }
  if (!validateJsonValueBudget(context, decoded, `${path}.labelContour`)) {
    return [];
  }
  let coordinateLimitExceeded = false;
  const rings = normalizeRings(decoded, () => {
    coordinateLimitExceeded = true;
  });
  if (coordinateLimitExceeded) {
    invalid(
      context,
      `${path}.labelContour`,
      "V2_POINT_COORDINATE_INVALID",
      `Contour coordinates must be finite numbers with an absolute value no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
    return [];
  }
  if (!rings || rings.length === 0 || rings.some((ring) => ring.length < 3)) {
    invalid(
      context,
      `${path}.labelContour`,
      "V2_CONTOUR_INVALID",
      "A contour requires at least three finite points per ring.",
    );
    return [];
  }
  const contourPointCount = rings.reduce(
    (total, ring) => total + ring.length,
    0,
  );
  if (contourPointCount > V2_PROJECT_LIMITS.maxContourPoints) {
    context.contourPointCount = V2_PROJECT_LIMITS.maxContourPoints + 1;
    context.contourPointLimitExceeded = true;
    addDiagnostic(context, {
      code: "V2_CONTOUR_POINT_LIMIT_EXCEEDED",
      category: "security",
      severity: "error",
      disposition: "block",
      path: `${path}.labelContour`,
      message: `A V2 contour must not exceed ${V2_PROJECT_LIMITS.maxContourPoints} total points.`,
      details: {
        contourPointCount,
        maximum: V2_PROJECT_LIMITS.maxContourPoints,
      },
    });
    return [];
  }
  context.contourPointCount = Math.min(
    V2_PROJECT_LIMITS.maxContourPoints + 1,
    context.contourPointCount + contourPointCount,
  );
  if (context.contourPointCount > V2_PROJECT_LIMITS.maxContourPoints) {
    context.contourPointLimitExceeded = true;
    addDiagnostic(context, {
      code: "V2_CONTOUR_POINT_LIMIT_EXCEEDED",
      category: "security",
      severity: "error",
      disposition: "block",
      path: "$.project.projectFiles[*].labelDataList[*].labelContour",
      message: `Total V2 contour point count must not exceed ${V2_PROJECT_LIMITS.maxContourPoints}.`,
      details: {
        observedCountAtLeast: context.contourPointCount,
        maximum: V2_PROJECT_LIMITS.maxContourPoints,
      },
    });
    return [];
  }
  return rings;
}

function validateContourSize(
  context: ParseContext,
  value: JsonValue | undefined,
  labelPath: string,
): void {
  if (value === undefined) return;
  const size = finiteNumber(value);
  if (size === undefined || size < 0) {
    invalid(
      context,
      `${labelPath}.contourSize`,
      "V2_CONTOUR_SIZE_INVALID",
      "contourSize must be a finite non-negative number when supplied.",
    );
  }
}

function inferContourRingRole(ring: readonly PointIR[]): ContourRingRole {
  let doubledArea = 0;
  for (const [index, point] of ring.entries()) {
    const next = ring[(index + 1) % ring.length]!;
    doubledArea += point.x * next.y - next.x * point.y;
  }
  if (!Number.isFinite(doubledArea) || doubledArea === 0) return "unknown";
  return doubledArea > 0 ? "outer" : "inner";
}

function parseSegmentationBoundingBox(
  context: ParseContext,
  raw: JsonObject,
  contours: readonly (readonly PointIR[])[],
  path: string,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!hasBoxFields(raw)) return undefined;
  const x = finiteNumber(raw.labelPosX);
  const y = finiteNumber(raw.labelPosY);
  const width = positiveNumber(raw.labelWidth);
  const height = positiveNumber(raw.labelHeight);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    invalid(
      context,
      path,
      "V2_SEGMENTATION_BOUNDS_INVALID",
      "Segmentation bounding fields require finite x/y and positive width/height.",
    );
    return undefined;
  }

  if (contours.length > 0) {
    let minimumX = Number.POSITIVE_INFINITY;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (const ring of contours) {
      for (const point of ring) {
        minimumX = Math.min(minimumX, point.x);
        minimumY = Math.min(minimumY, point.y);
        maximumX = Math.max(maximumX, point.x);
        maximumY = Math.max(maximumY, point.y);
      }
    }
    const expected = {
      x: Math.round(minimumX),
      y: Math.round(minimumY),
      width: Math.round(maximumX - minimumX),
      height: Math.round(maximumY - minimumY),
    };
    if (
      x !== expected.x ||
      y !== expected.y ||
      width !== expected.width ||
      height !== expected.height
    ) {
      compatibility(context, {
        code: "V2_SEGMENTATION_BOUNDS_CONFLICT",
        disposition: "block",
        severity: "error",
        path,
        message:
          "Segmentation bounding fields conflict with the native bounds derived from labelContour.",
        details: {
          actualX: x,
          actualY: y,
          actualWidth: width,
          actualHeight: height,
          expectedX: expected.x,
          expectedY: expected.y,
          expectedWidth: expected.width,
          expectedHeight: expected.height,
        },
      });
    }
  }
  return { x, y, width, height };
}

function normalizeRings(
  value: unknown,
  onCoordinateLimitExceeded: () => void,
): readonly (readonly PointIR[])[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const directRing = normalizeRing(value, onCoordinateLimitExceeded);
  if (directRing) return [directRing];
  const rings: PointIR[][] = [];
  for (const candidate of value) {
    const ring = normalizeRing(candidate, onCoordinateLimitExceeded);
    if (ring) {
      rings.push(ring);
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const nested of candidate) {
        const nestedRing = normalizeRing(nested, onCoordinateLimitExceeded);
        if (!nestedRing) return undefined;
        rings.push(nestedRing);
      }
      continue;
    }
    return undefined;
  }
  return rings.length > 0 ? rings : undefined;
}

function normalizeRing(
  value: unknown,
  onCoordinateLimitExceeded: () => void,
): PointIR[] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const points: PointIR[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) return undefined;
    const x = safeContourCoordinate(item[0], onCoordinateLimitExceeded);
    const y = safeContourCoordinate(item[1], onCoordinateLimitExceeded);
    if (x === undefined || y === undefined) return undefined;
    points.push({ x, y });
  }
  return points;
}

function safeContourCoordinate(
  value: unknown,
  onCoordinateLimitExceeded: () => void,
): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  if (Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    onCoordinateLimitExceeded();
    return undefined;
  }
  return number;
}

function resolveClassIndex(
  context: ParseContext,
  raw: JsonObject,
  classes: readonly ProjectClassIR[],
  path: string,
  required: boolean,
): number | undefined {
  type ClassReferenceField = "classId" | "classNo" | "className";
  interface ResolvedReference {
    readonly field: ClassReferenceField;
    readonly index: number;
  }

  const resolved: ResolvedReference[] = [];
  let providedCount = 0;
  let hasInvalidReference = false;

  const recordResolution = (
    field: ClassReferenceField,
    matches: readonly ProjectClassIR[],
    invalidCode: string,
  ): void => {
    providedCount += 1;
    if (matches.length !== 1) {
      hasInvalidReference = true;
      compatibility(context, {
        code: invalidCode,
        disposition: "block",
        severity: "error",
        path: `${path}.${field}`,
        message:
          matches.length > 1
            ? `The supplied ${field} is ambiguous and matches more than one declared class.`
            : `The supplied ${field} does not resolve to a declared class.`,
        details: { matchCount: matches.length },
      });
      return;
    }
    const match = matches[0];
    if (match) resolved.push({ field, index: match.index });
  };

  if (raw.classId !== undefined) {
    const id = sourceIdValue(raw.classId);
    recordResolution(
      "classId",
      id === undefined
        ? []
        : classes.filter(
            (item) =>
              item.sourceId !== undefined && idKey(item.sourceId) === idKey(id),
          ),
      "V2_CLASS_ID_REFERENCE_INVALID",
    );
  }

  if (raw.classNo !== undefined) {
    const classNo = nonNegativeInteger(raw.classNo);
    recordResolution(
      "classNo",
      classNo === undefined
        ? []
        : classes.filter((item) => {
            const declaredClassNo =
              item.raw.classNo === undefined
                ? item.index
                : nonNegativeInteger(item.raw.classNo);
            return declaredClassNo === classNo;
          }),
      "V2_CLASS_NUMBER_REFERENCE_INVALID",
    );
  }

  if (raw.className !== undefined) {
    const name = optionalString(raw.className)?.trim();
    const nameKey = name ? normalizedClassName(name) : undefined;
    recordResolution(
      "className",
      nameKey === undefined
        ? []
        : classes.filter((item) => normalizedClassName(item.name) === nameKey),
      "V2_CLASS_NAME_REFERENCE_INVALID",
    );
  }

  if (providedCount === 0) {
    if (!required) return undefined;
    compatibility(context, {
      code: "V2_CLASS_REFERENCE_INVALID",
      disposition: "block",
      severity: "error",
      path,
      message: "A class reference is required but classId, classNo, and className are all absent.",
    });
    return undefined;
  }

  if (hasInvalidReference) return undefined;
  const resolvedIndexes = new Set(resolved.map((item) => item.index));
  if (resolvedIndexes.size !== 1) {
    const details: Record<string, JsonValue> = {};
    for (const reference of resolved) {
      details[`${reference.field}Index`] = reference.index;
    }
    compatibility(context, {
      code: "V2_CLASS_REFERENCE_CONFLICT",
      disposition: "block",
      severity: "error",
      path,
      message: "The supplied classId, classNo, and className resolve to different declared classes.",
      details,
    });
    return undefined;
  }

  return resolved[0]?.index;
}

function normalizedClassName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function resolveDatasetIndex(
  context: ParseContext,
  raw: JsonObject,
  datasets: readonly ProjectDatasetIR[],
  path: string,
): number | undefined {
  const id = sourceIdValue(raw.datasetId);
  const name = optionalString(raw.datasetName);
  if (id === undefined && !name) return undefined;
  const matches = datasets.filter((dataset) =>
    id !== undefined
      ? dataset.sourceId !== undefined && idKey(dataset.sourceId) === idKey(id)
      : dataset.name.toLocaleLowerCase() === name?.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    compatibility(context, {
      code: "V2_DATASET_REFERENCE_INVALID",
      disposition: "block",
      severity: "error",
      path,
      message: "The file dataset reference does not resolve uniquely.",
    });
    return undefined;
  }
  return matches[0]?.index;
}

function resolveImageSource(
  context: ParseContext,
  normalizedPath: string,
  path: string,
): ImageSourceIR | undefined {
  if (context.format === "v2-subvisionproj") {
    if (hasTraversal(normalizedPath)) {
      addDiagnostic(context, {
        code: "V2_EXTERNAL_PATH_TRAVERSAL",
        category: "security",
        severity: "error",
        disposition: "block",
        path,
        message: "External image paths must not contain '..' traversal.",
        details: { filePath: normalizedPath },
      });
      return undefined;
    }
    if (!isAbsoluteExternalPath(normalizedPath)) {
      compatibility(context, {
        code: "V2_EXTERNAL_PATH_RELATIVE",
        disposition: "degrade",
        severity: "warning",
        path,
        message: "The light project uses a relative external image path.",
        details: { filePath: normalizedPath },
      });
    }
    return { kind: "external", path: normalizedPath };
  }

  if (!isSafeArchivePath(normalizedPath) || !normalizedPath.startsWith("images/")) {
    addDiagnostic(context, {
      code: "V2_ARCHIVE_IMAGE_PATH_UNSAFE",
      category: "security",
      severity: "error",
      disposition: "block",
      path,
      message: "A .visionproj image path must be a safe relative path under images/.",
      details: { filePath: normalizedPath },
    });
    return undefined;
  }
  const entry = context.archive?.entriesByName.get(normalizedPath);
  if (!entry) {
    invalid(
      context,
      path,
      "V2_ARCHIVE_IMAGE_MISSING",
      `The archive does not contain '${normalizedPath}'.`,
    );
    return undefined;
  }
  const image: ArchiveImageSourceIR = {
    kind: "archive",
    entryName: normalizedPath,
    ...(entry.bytes ? { bytes: entry.bytes } : {}),
  };
  return image;
}

function validateArchive(
  input: V2VisionProjectInput,
  diagnostics: ProjectDiagnostic[],
): ArchiveContext | undefined {
  const context: ParseContext = {
    format: "v2-visionproj",
    fileName: input.fileName,
    diagnostics,
    contourPointCount: 0,
    contourPointLimitExceeded: false,
  };
  if (input.entries.length > BROWSER_ARCHIVE_LIMITS.maxEntries) {
    addDiagnostic(context, {
      code: "V2_ARCHIVE_ENTRY_LIMIT_EXCEEDED",
      category: "security",
      severity: "error",
      disposition: "block",
      path: "$.archive.entries",
      message: `A V2 archive must not contain more than ${BROWSER_ARCHIVE_LIMITS.maxEntries} entries.`,
      details: {
        actualCount: input.entries.length,
        maximum: BROWSER_ARCHIVE_LIMITS.maxEntries,
      },
    });
    return undefined;
  }
  if (
    exceedsUtf8ByteLimit(
      input.projectJsonEntryName,
      PROJECT_PATH_MAX_BYTES,
    )
  ) {
    addDiagnostic(context, {
      code: "V2_ARCHIVE_ENTRY_NAME_LIMIT_EXCEEDED",
      category: "security",
      severity: "error",
      disposition: "block",
      path: "$.archive.projectJsonEntryName",
      message: `Archive entry names must not exceed ${PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
      details: { maxBytes: PROJECT_PATH_MAX_BYTES },
    });
    return undefined;
  }
  const projectEntry = normalizeSlashes(input.projectJsonEntryName);
  if (!isSafeArchivePath(projectEntry) || projectEntry.includes("/") || !projectEntry.endsWith(".json")) {
    addDiagnostic(context, {
      code: "V2_PROJECT_JSON_PATH_UNSAFE",
      category: "security",
      severity: "error",
      disposition: "block",
      path: "$.archive.projectJsonEntryName",
      message: "The project JSON must be a safe root-level .json entry.",
      details: { entryName: projectEntry },
    });
  }

  const entries = new Map<string, V2ArchiveEntry>();
  const caseFolded = new Map<string, string>();
  for (const [index, rawEntry] of input.entries.entries()) {
    if (exceedsUtf8ByteLimit(rawEntry.name, PROJECT_PATH_MAX_BYTES)) {
      addDiagnostic(context, {
        code: "V2_ARCHIVE_ENTRY_NAME_LIMIT_EXCEEDED",
        category: "security",
        severity: "error",
        disposition: "block",
        path: `$.archive.entries[${index}].name`,
        message: `Archive entry names must not exceed ${PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
        details: { maxBytes: PROJECT_PATH_MAX_BYTES },
      });
      continue;
    }
    const name = normalizeSlashes(rawEntry.name);
    if (name.endsWith("/")) {
      const directoryName = name.slice(0, -1);
      if (!isSafeArchivePath(directoryName)) {
        addDiagnostic(context, {
          code: "V2_ARCHIVE_ENTRY_UNSAFE",
          category: "security",
          severity: "error",
          disposition: "block",
          path: `$.archive.entries[${index}].name`,
          message: "Archive directory entries must be safe relative paths.",
          details: { entryName: name },
        });
      }
      continue;
    }
    if (!isSafeArchivePath(name)) {
      addDiagnostic(context, {
        code: "V2_ARCHIVE_ENTRY_UNSAFE",
        category: "security",
        severity: "error",
        disposition: "block",
        path: `$.archive.entries[${index}].name`,
        message: "Archive entries must be safe relative paths without traversal.",
        details: { entryName: name },
      });
      continue;
    }
    const folded = name.toLocaleLowerCase();
    if (caseFolded.has(folded)) {
      addDiagnostic(context, {
        code: "V2_ARCHIVE_ENTRY_DUPLICATE",
        category: "security",
        severity: "error",
        disposition: "block",
        path: `$.archive.entries[${index}].name`,
        message: "Archive entry names must be unique after case folding.",
        details: { entryName: name, conflictingEntry: caseFolded.get(folded) ?? "" },
      });
      continue;
    }
    caseFolded.set(folded, name);
    entries.set(name, { ...rawEntry, name });
  }

  const rootJsonEntries = [...entries.keys()].filter(
    (name) => !name.includes("/") && name.toLocaleLowerCase().endsWith(".json"),
  );
  if (
    rootJsonEntries.length !== 1 ||
    rootJsonEntries[0] !== projectEntry ||
    !entries.has(projectEntry)
  ) {
    invalid(
      context,
      "$.archive",
      "V2_PROJECT_JSON_ENTRY_INVALID",
      "A .visionproj must contain exactly one root project JSON matching the supplied entry.",
    );
  }

  return hasFatalValidation(diagnostics)
    ? undefined
    : { projectJsonEntryName: projectEntry, entriesByName: entries };
}

function validateGeometryBounds(
  context: ParseContext,
  labels: readonly ProjectLabelIR[],
  width: number | undefined,
  height: number | undefined,
  filePath: string,
): void {
  if (width === undefined || height === undefined) return;
  for (const label of labels) {
    const path = `${filePath}.labelDataList[${label.index}]`;
    const box = label.geometry.box;
    if (box && (box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height)) {
      compatibility(context, {
        code: "V2_LABEL_OUT_OF_BOUNDS",
        disposition: "block",
        severity: "error",
        path,
        message: "A label bounding box falls outside the image bounds.",
      });
    }
    const contours = label.geometry.contours;
    if (
      contours?.some((ring) =>
        ring.some((point) => point.x < 0 || point.y < 0 || point.x > width || point.y > height),
      )
    ) {
      compatibility(context, {
        code: "V2_CONTOUR_OUT_OF_BOUNDS",
        disposition: "block",
        severity: "error",
        path,
        message: "A contour point falls outside the image bounds.",
      });
    }
  }
}

function reportKnownLosses(
  context: ParseContext,
  project: JsonObject,
  classes: readonly ProjectClassIR[],
  datasets: readonly ProjectDatasetIR[],
  files: readonly ProjectFileIR[],
): void {
  const rebuildFields = ["projectId", "createdDate", "modifiedDate"] as const;
  for (const field of rebuildFields) {
    if (project[field] !== undefined) {
      compatibility(context, {
        code: "V2_FIELD_REBUILT",
        disposition: "rebuild",
        severity: "info",
        path: `$.project.${field}`,
        message: `V2 field '${field}' is retained in raw data but V1 identifiers/timestamps are rebuilt.`,
      });
    }
  }
  const dropFields = ["description", "createdBy", "metadataList", "metadataKeys"] as const;
  for (const field of dropFields) {
    if (hasMeaningfulValue(project[field])) {
      compatibility(context, {
        code: "V2_FIELD_NOT_IN_V1",
        disposition: "drop",
        severity: "warning",
        path: `$.project.${field}`,
        message: `V2 field '${field}' is retained in raw data but has no declared V1 output field.`,
      });
    }
  }
  if (files.some((file) => hasMeaningfulValue(file.raw.metadata))) {
    compatibility(context, {
      code: "V2_FILE_METADATA_NOT_IN_V1",
      disposition: "drop",
      severity: "warning",
      path: "$.project.projectFiles[*].metadata",
      message: "Per-file V2 metadata is retained in raw data but is not emitted to V1.",
    });
  }
  const fileRaw = files.map((file) => file.raw);
  for (const field of ["modifiedDate", "assignedDate", "registeredDate"] as const) {
    reportAggregatedFieldLoss(context, fileRaw, field, {
      code: "V2_FILE_TIMESTAMP_NOT_IN_V1",
      disposition: "drop",
      severity: "warning",
      path: `$.project.projectFiles[*].${field}`,
      message: `Per-file V2 timestamp '${field}' is retained in raw data but is not emitted to V1.`,
    });
  }
  const labelRaw = files.flatMap((file) => file.labels.map((label) => label.raw));
  reportAggregatedFieldLoss(context, labelRaw, "labeledDate", {
    code: "V2_LABEL_TIMESTAMP_NOT_IN_V1",
    disposition: "drop",
    severity: "warning",
    path: "$.project.projectFiles[*].labelDataList[*].labeledDate",
    message: "Per-label V2 labeledDate values are retained in raw data but are not emitted to V1.",
  });
  reportAggregatedFieldLoss(context, labelRaw, "contourId", {
    code: "V2_CONTOUR_ID_REBUILT",
    disposition: "rebuild",
    severity: "info",
    path: "$.project.projectFiles[*].labelDataList[*].contourId",
    message: "V2 contourId values are retained as source data and regenerated after V1 conversion.",
  });
  reportAggregatedFieldLoss(context, labelRaw, "contourSize", {
    code: "V2_CONTOUR_SIZE_REBUILT",
    disposition: "rebuild",
    severity: "info",
    path: "$.project.projectFiles[*].labelDataList[*].contourSize",
    message:
      "V2 contourSize values are retained as source data and rebuilt from contour geometry after conversion.",
  });
  const contourBoundsCount = files
    .flatMap((file) => file.labels)
    .filter((label) => label.kind === "contour" && hasBoxFields(label.raw)).length;
  if (contourBoundsCount > 0) {
    compatibility(context, {
      code: "V2_SEGMENTATION_BOUNDS_REBUILT",
      disposition: "rebuild",
      severity: "info",
      path: "$.project.projectFiles[*].labelDataList[*]",
      message:
        "Segmentation bounding fields are validated against labelContour and rebuilt after V1 conversion.",
      details: { affectedEntityCount: contourBoundsCount },
    });
  }
  const datasetSplitRaw = datasets.flatMap((dataset) => {
    const splitSets = dataset.raw.splitSets;
    return Array.isArray(splitSets) ? splitSets.filter(isJsonObject) : [];
  });
  const splitRaw = [
    ...datasetSplitRaw,
    ...files.flatMap((file) => file.splits.map((split) => split.raw)),
  ];
  reportAggregatedFieldLoss(context, splitRaw, "splitName", {
    code: "V2_SPLIT_NAME_NOT_IN_V1",
    disposition: "drop",
    severity: "warning",
    path: "$.project.projectFiles[*].splitSets[*].splitName",
    message: "V2 splitName values are retained in raw data, but V1 preserves only SplitState.",
  });
  reportAggregatedFieldLoss(context, splitRaw, "splitId", {
    code: "V2_SPLIT_ID_REBUILT",
    disposition: "rebuild",
    severity: "info",
    path: "$.project.projectFiles[*].splitSets[*].splitId",
    message: "V2 splitId values are retained as source IDs and regenerated after V1 conversion.",
  });
  const generatedFiles = files.filter((file) => file.raw.isGenerated === true).length;
  const invalidGeneratedFlags = files.filter(
    (file) =>
      file.raw.isGenerated !== undefined &&
      typeof file.raw.isGenerated !== "boolean",
  ).length;
  if (generatedFiles > 0) {
    compatibility(context, {
      code: "V2_GENERATED_FILE_FLAG_NOT_IN_V1",
      disposition: "drop",
      severity: "warning",
      path: "$.project.projectFiles[*].isGenerated",
      message: "V1 cannot preserve whether an image was generated.",
      details: { generatedFileCount: generatedFiles },
    });
  }
  if (invalidGeneratedFlags > 0) {
    compatibility(context, {
      code: "V2_GENERATED_FILE_FLAG_INVALID",
      disposition: "block",
      severity: "error",
      path: "$.project.projectFiles[*].isGenerated",
      message: "isGenerated must be boolean when supplied.",
      details: { invalidFileCount: invalidGeneratedFlags },
    });
  }
  if (datasets.length > 0) {
    compatibility(context, {
      code: "V2_DATASET_IDENTITY_NOT_IN_V1",
      disposition: "drop",
      severity: "warning",
      path: "$.project.datasets",
      message: "V2 dataset identity is retained in the IR but V1 has no equivalent dataset entity.",
      details: { datasetCount: datasets.length },
    });
  }
  if (
    classes.some((item) => item.sourceId !== undefined) ||
    datasets.some((item) => item.sourceId !== undefined) ||
    files.some(
      (file) =>
        file.sourceId !== undefined || file.labels.some((label) => label.sourceId !== undefined),
    )
  ) {
    compatibility(context, {
      code: "V2_ENTITY_IDS_REBUILT",
      disposition: "rebuild",
      severity: "info",
      path: "$.project",
      message: "V2 entity IDs are retained as source IDs; V1 indexes are rebuilt deterministically.",
    });
  }
}

function reportAggregatedFieldLoss(
  context: ParseContext,
  values: readonly JsonObject[],
  field: string,
  diagnostic: {
    readonly code: string;
    readonly disposition: CompatibilityDisposition;
    readonly severity: DiagnosticSeverity;
    readonly path: string;
    readonly message: string;
  },
): void {
  const affectedEntityCount = values.filter((raw) =>
    hasMeaningfulValue(raw[field]),
  ).length;
  if (affectedEntityCount === 0) return;
  compatibility(context, {
    ...diagnostic,
    details: { field, affectedEntityCount },
  });
}

const V2_ROI_AUXILIARY_FIELDS = [
  "roiPosX",
  "roiPosY",
  "roiWidth",
  "roiHeight",
  "roiShapeType",
  "roiShape",
  "roiBitmap",
] as const;

interface ParsedRectangleRoiShape {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** Native SaigeVision may persist Konva's rendered client bounds, while
   * converter output persists the rectangle's geometry bounds. */
  readonly renderedBounds?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

const ROI_BOUNDARY_TOLERANCE = 1e-6;

type RoiShapeParseResult =
  | { readonly ok: true; readonly shape: ParsedRectangleRoiShape }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse the V2 ROI contract into normalized image-space boundaries. Despite
 * their names, roiWidth and roiHeight are the right and bottom boundaries in
 * native V2 projects; they are not extent width/height values.
 */
function parseProjectRoi(
  context: ParseContext,
  project: JsonObject,
): ProjectRoiIR | undefined {
  const rawMode = project.roiMode;
  if (rawMode === undefined || rawMode === null || rawMode === "") {
    if (V2_ROI_AUXILIARY_FIELDS.some((field) => hasMeaningfulValue(project[field]))) {
      roiBlock(
        context,
        "V2_ROI_MODE_MISSING",
        "$.project.roiMode",
        "ROI geometry is present but roiMode is missing.",
      );
    }
    return undefined;
  }
  if (typeof rawMode !== "string") {
    roiBlock(
      context,
      "V2_ROI_MODE_INVALID",
      "$.project.roiMode",
      "roiMode must be a string.",
    );
    return undefined;
  }

  const mode = rawMode.trim().toLocaleLowerCase("en-US");
  if (mode === "no") {
    if (V2_ROI_AUXILIARY_FIELDS.some((field) => hasMeaningfulValue(project[field]))) {
      roiBlock(
        context,
        "V2_ROI_DISABLED_FIELD_CONFLICT",
        "$.project.roiMode",
        "A disabled ROI must not retain active ROI geometry or drawing fields.",
      );
      return undefined;
    }
    return { mode: "none" };
  }
  if (mode !== "simple") {
    roiBlock(
      context,
      "V2_ROI_MODE_UNSUPPORTED",
      "$.project.roiMode",
      `ROI mode '${rawMode}' has no verified V1 mapping.`,
    );
    return undefined;
  }

  const left = finiteNumber(project.roiPosX);
  const top = finiteNumber(project.roiPosY);
  const right = finiteNumber(project.roiWidth);
  const bottom = finiteNumber(project.roiHeight);
  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined ||
    left < 0 ||
    top < 0 ||
    right > 1 ||
    bottom > 1 ||
    right <= left ||
    bottom <= top
  ) {
    roiBlock(
      context,
      "V2_ROI_BOUNDS_INVALID",
      "$.project",
      "A Simple ROI requires finite normalized boundaries with 0 <= left < right <= 1 and 0 <= top < bottom <= 1.",
    );
    return undefined;
  }

  let valid = true;
  const rawShapeType = project.roiShapeType;
  const hasShapeType = hasMeaningfulValue(rawShapeType);
  if (
    hasShapeType &&
    (typeof rawShapeType !== "string" ||
      rawShapeType.trim().toLocaleLowerCase("en-US") !== "rectangle")
  ) {
    roiBlock(
      context,
      "V2_ROI_SHAPE_TYPE_UNSUPPORTED",
      "$.project.roiShapeType",
      "Only a rectangular Simple ROI can be converted safely.",
    );
    valid = false;
  }

  const rawShape = project.roiShape;
  const hasShape = hasMeaningfulValue(rawShape);
  if (!hasShapeType && !hasShape) {
    roiBlock(
      context,
      "V2_ROI_SHAPE_MISSING",
      "$.project",
      "A Simple ROI requires roiShapeType='rectangle' or a verifiable serialized rectangle roiShape.",
    );
    valid = false;
  }

  if (hasShape) {
    if (typeof rawShape !== "string") {
      roiBlock(
        context,
        "V2_ROI_SHAPE_INVALID",
        "$.project.roiShape",
        "roiShape must be serialized Konva JSON.",
      );
      valid = false;
    } else {
      const parsedShape = parseSerializedRectangleRoiShape(context, rawShape);
      if (!parsedShape.ok) {
        roiBlock(
          context,
          "V2_ROI_SHAPE_INVALID",
          "$.project.roiShape",
          `roiShape is not a supported single rectangle: ${parsedShape.reason}`,
        );
        valid = false;
      } else if (
        !roiShapeMatchesBoundaries(
          parsedShape.shape,
          left,
          top,
          right,
          bottom,
        )
      ) {
        roiBlock(
          context,
          "V2_ROI_SHAPE_CONFLICT",
          "$.project.roiShape",
          "The serialized ROI rectangle disagrees with the normalized ROI boundaries.",
        );
        valid = false;
      }
    }
  }

  const rawBitmap = project.roiBitmap;
  const hasBitmap = hasMeaningfulValue(rawBitmap);
  if (hasBitmap && (typeof rawBitmap !== "string" || !isPngBase64(rawBitmap))) {
    roiBlock(
      context,
      "V2_ROI_BITMAP_INVALID",
      "$.project.roiBitmap",
      "roiBitmap must be an unprefixed Base64-encoded PNG when supplied.",
    );
    valid = false;
  }
  if (!valid) return undefined;

  const roi: ProjectRoiIR = {
    mode: "simple",
    shape: "rectangle",
    left,
    top,
    right,
    bottom,
  };
  const isFullImage = left === 0 && top === 0 && right === 1 && bottom === 1;
  compatibility(context, {
    code: isFullImage ? "V2_DEFAULT_FULL_IMAGE_ROI" : "V2_SIMPLE_RECTANGLE_ROI",
    disposition: "preserve",
    severity: "info",
    path: "$.project.roiMode",
    message: isFullImage
      ? "The normalized full-image rectangle ROI is semantically equivalent to no crop."
      : "The Simple rectangle ROI is preserved as normalized left/top/right/bottom boundaries.",
  });
  if (hasShape) {
    compatibility(context, {
      code: "V2_ROI_SHAPE_REBUILT",
      disposition: "rebuild",
      severity: "info",
      path: "$.project.roiShape",
      message: "The serialized Konva ROI drawing is validated and rebuilt from normalized boundaries.",
    });
  }
  if (hasBitmap) {
    compatibility(context, {
      code: "V2_ROI_BITMAP_REBUILT",
      disposition: "rebuild",
      severity: "info",
      path: "$.project.roiBitmap",
      message: "The derived ROI bitmap is validated and rebuilt from normalized boundaries.",
    });
  }
  return roi;
}

function parseSerializedRectangleRoiShape(
  context: ParseContext,
  text: string,
): RoiShapeParseResult {
  if (!preflightJsonText(context, text, "$.project.roiShape", false)) {
    return { ok: false, reason: "nested JSON exceeds the structural depth limit" };
  }
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!validateJsonValueBudget(context, value, "$.project.roiShape")) {
    return { ok: false, reason: "nested JSON exceeds the value limit" };
  }
  if (!isJsonObject(value) || value.className !== "Layer") {
    return { ok: false, reason: "root is not a Konva Layer" };
  }
  const layerAttrs = isJsonObject(value.attrs) ? value.attrs : undefined;
  const stageSize = layerAttrs && isJsonObject(layerAttrs.stageSize)
    ? layerAttrs.stageSize
    : undefined;
  const stageWidth = positiveNumber(stageSize?.width);
  const stageHeight = positiveNumber(stageSize?.height);
  if (stageWidth === undefined || stageHeight === undefined) {
    return { ok: false, reason: "stageSize is missing or invalid" };
  }
  if (!Array.isArray(value.children) || !value.children.every(isJsonObject)) {
    return { ok: false, reason: "Layer children are invalid" };
  }

  const groups = value.children.filter(
    (child) =>
      child.className === "Group" &&
      isJsonObject(child.attrs) &&
      child.attrs.name === "roi-area",
  );
  if (groups.length !== 1) {
    return { ok: false, reason: "expected exactly one roi-area Group" };
  }
  const group = groups[0]!;
  if (
    value.children.some(
      (child) => child !== group && child.className !== "Rect",
    )
  ) {
    return { ok: false, reason: "Layer contains unsupported drawing nodes" };
  }
  const groupAttrs = isJsonObject(group.attrs) ? group.attrs : undefined;
  if (!groupAttrs) return { ok: false, reason: "roi-area attributes are invalid" };
  if (groupAttrs.UIType !== "roi") {
    return { ok: false, reason: "roi-area is not a rectangular ROI group" };
  }
  for (const field of [
    "x",
    "y",
    "scaleX",
    "scaleY",
    "rotation",
    "skewX",
    "skewY",
    "offsetX",
    "offsetY",
  ] as const) {
    if (groupAttrs[field] !== undefined && finiteNumber(groupAttrs[field]) === undefined) {
      return { ok: false, reason: `roi-area ${field} is not a finite number` };
    }
  }
  const groupX = finiteNumber(groupAttrs.x) ?? 0;
  const groupY = finiteNumber(groupAttrs.y) ?? 0;
  const scaleX = finiteNumber(groupAttrs.scaleX) ?? 1;
  const scaleY = finiteNumber(groupAttrs.scaleY) ?? 1;
  const rotation = finiteNumber(groupAttrs.rotation) ?? 0;
  const skewX = finiteNumber(groupAttrs.skewX) ?? 0;
  const skewY = finiteNumber(groupAttrs.skewY) ?? 0;
  const offsetX = finiteNumber(groupAttrs.offsetX) ?? 0;
  const offsetY = finiteNumber(groupAttrs.offsetY) ?? 0;
  if (
    scaleX <= 0 ||
    scaleY <= 0 ||
    rotation !== 0 ||
    skewX !== 0 ||
    skewY !== 0 ||
    offsetX !== 0 ||
    offsetY !== 0
  ) {
    return { ok: false, reason: "rotated, skewed, offset, or reflected ROI groups are unsupported" };
  }
  if (!Array.isArray(group.children) || !group.children.every(isJsonObject)) {
    return { ok: false, reason: "roi-area children are invalid" };
  }
  const rectangles = group.children.filter((child) => child.className === "Rect");
  if (
    rectangles.length < 1 ||
    rectangles.length > 2 ||
    rectangles.length !== group.children.length
  ) {
    return { ok: false, reason: "roi-area must contain one rectangle or two matching render rectangles" };
  }
  const firstAttrs = isJsonObject(rectangles[0]?.attrs)
    ? rectangles[0].attrs
    : undefined;
  if (!firstAttrs || !rectangleShapeTransformIsIdentity(firstAttrs)) {
    return { ok: false, reason: "rectangle transform fields are unsupported" };
  }
  const x = finiteNumber(firstAttrs?.x);
  const y = finiteNumber(firstAttrs?.y);
  const width = positiveNumber(firstAttrs?.width);
  const height = positiveNumber(firstAttrs?.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return { ok: false, reason: "rectangle geometry is invalid" };
  }
  for (const rectangle of rectangles.slice(1)) {
    const attrs = isJsonObject(rectangle.attrs) ? rectangle.attrs : undefined;
    if (
      !attrs ||
      !rectangleShapeTransformIsIdentity(attrs) ||
      !shapeNumberClose(finiteNumber(attrs?.x), x) ||
      !shapeNumberClose(finiteNumber(attrs?.y), y) ||
      !shapeNumberClose(finiteNumber(attrs?.width), width) ||
      !shapeNumberClose(finiteNumber(attrs?.height), height)
    ) {
      return { ok: false, reason: "render rectangles do not describe one geometry" };
    }
  }

  const left = (groupX + x * scaleX) / stageWidth;
  const top = (groupY + y * scaleY) / stageHeight;
  const right = (groupX + (x + width) * scaleX) / stageWidth;
  const bottom = (groupY + (y + height) * scaleY) / stageHeight;
  const outlineAttrs = isJsonObject(rectangles[1]?.attrs)
    ? rectangles[1].attrs
    : undefined;
  const renderedRectangle = outlineAttrs
    ? renderedRectangleClientBounds(outlineAttrs, x, y, width, height)
    : undefined;
  const renderedBounds = renderedRectangle
    ? {
        left: (groupX + renderedRectangle.left * scaleX) / stageWidth,
        top: (groupY + renderedRectangle.top * scaleY) / stageHeight,
        right: (groupX + renderedRectangle.right * scaleX) / stageWidth,
        bottom: (groupY + renderedRectangle.bottom * scaleY) / stageHeight,
      }
    : undefined;
  return {
    ok: true,
    shape: {
      left,
      top,
      right,
      bottom,
      ...(renderedBounds ? { renderedBounds } : {}),
    },
  };
}

function renderedRectangleClientBounds(
  attrs: JsonObject,
  x: number,
  y: number,
  width: number,
  height: number,
): {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
} | undefined {
  const strokeWidth = attrs.stroke === undefined
    ? 0
    : finiteNumber(attrs.strokeWidth) ?? 0;
  const shadowBlur = attrs.shadowColor === undefined
    ? 0
    : finiteNumber(attrs.shadowBlur) ?? 0;
  const shadowOffsetX = finiteNumber(attrs.shadowOffsetX) ?? 0;
  const shadowOffsetY = finiteNumber(attrs.shadowOffsetY) ?? 0;
  if (strokeWidth < 0 || shadowBlur < 0) return undefined;

  // This mirrors the client-bound representation persisted by native V2 for
  // its standard outline rectangle (strokeWidth=1, shadowBlur=1,
  // shadowOffset=0.5). It is an exact alternate semantic representation, not
  // a pixel-sized comparison tolerance.
  const strokeExpansion = strokeWidth / 2;
  const leftExpansion = Math.max(
    strokeExpansion,
    shadowBlur + Math.max(-shadowOffsetX, 0),
  );
  const rightExpansion = Math.max(
    strokeExpansion,
    shadowBlur + Math.max(shadowOffsetX, 0),
  );
  const topExpansion = Math.max(
    strokeExpansion,
    shadowBlur + Math.max(-shadowOffsetY, 0),
  );
  const bottomExpansion = Math.max(
    strokeExpansion,
    shadowBlur + Math.max(shadowOffsetY, 0),
  );
  if (
    leftExpansion === 0 &&
    rightExpansion === 0 &&
    topExpansion === 0 &&
    bottomExpansion === 0
  ) {
    return undefined;
  }
  return {
    left: x - leftExpansion,
    top: y - topExpansion,
    right: x + width + rightExpansion,
    bottom: y + height + bottomExpansion,
  };
}

function rectangleShapeTransformIsIdentity(attrs: JsonObject): boolean {
  const fields = [
    ["scaleX", 1],
    ["scaleY", 1],
    ["rotation", 0],
    ["skewX", 0],
    ["skewY", 0],
    ["offsetX", 0],
    ["offsetY", 0],
  ] as const;
  return fields.every(([field, identity]) => {
    const value = attrs[field];
    return value === undefined || finiteNumber(value) === identity;
  });
}

function shapeNumberClose(
  value: number | undefined,
  expected: number,
): boolean {
  return value !== undefined && Math.abs(value - expected) <= 1e-7;
}

function roiBoundaryClose(
  value: number,
  expected: number,
): boolean {
  return Math.abs(value - expected) <= ROI_BOUNDARY_TOLERANCE;
}

function roiShapeMatchesBoundaries(
  shape: ParsedRectangleRoiShape,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  const candidates = shape.renderedBounds
    ? [shape, shape.renderedBounds]
    : [shape];
  return candidates.some(
    (candidate) =>
      roiBoundaryClose(left, candidate.left) &&
      roiBoundaryClose(top, candidate.top) &&
      roiBoundaryClose(right, candidate.right) &&
      roiBoundaryClose(bottom, candidate.bottom),
  );
}

function isPngBase64(value: string): boolean {
  const normalized = value.trim();
  if (
    normalized.length < 64 ||
    normalized.length % 4 !== 0 ||
    !normalized.startsWith("iVBORw0KGgoAAAANSUhEUg") ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(
      normalized,
    )
  ) {
    return false;
  }
  try {
    const prefix = globalThis.atob(normalized.slice(0, 32));
    if (prefix.length < 24) return false;
    const readUint32 = (offset: number): number =>
      ((prefix.charCodeAt(offset) << 24) |
        (prefix.charCodeAt(offset + 1) << 16) |
        (prefix.charCodeAt(offset + 2) << 8) |
        prefix.charCodeAt(offset + 3)) >>> 0;
    const width = readUint32(16);
    const height = readUint32(20);
    return (
      width > 0 &&
      height > 0 &&
      width <= MAX_IMAGE_DIMENSION &&
      height <= MAX_IMAGE_DIMENSION &&
      width * height <= MAX_IMAGE_PIXELS
    );
  } catch {
    return false;
  }
}

function roiBlock(
  context: ParseContext,
  code: string,
  path: string,
  message: string,
): void {
  compatibility(context, {
    code,
    disposition: "block",
    severity: "error",
    path,
    message,
  });
}

function reportUnknownFields(
  context: ParseContext,
  raw: JsonObject,
  known: ReadonlySet<string>,
  path: string,
  owner: string,
): void {
  for (const key of Object.keys(raw)) {
    if (projectDiagnosticsAreTruncated(context.diagnostics)) break;
    if (known.has(key)) continue;
    if (!hasMeaningfulValue(raw[key])) continue;
    compatibility(context, {
      code: "V2_UNMAPPED_FIELD",
      disposition: "drop",
      severity: "warning",
      path: `${path}.${key}`,
      message: `Unknown V2 ${owner} field '${key}' is retained in raw data but has no declared mapping.`,
    });
  }
}

function optionalObjectArray(
  context: ParseContext,
  value: JsonValue | undefined,
  path: string,
): readonly JsonObject[] | undefined {
  if (value === undefined || value === null) return [];
  return objectArray(context, value, path, "V2_ARRAY_INVALID");
}

function requiredObjectArray(
  context: ParseContext,
  value: JsonValue | undefined,
  path: string,
  code: string,
): readonly JsonObject[] | undefined {
  if (value === undefined) {
    invalid(context, path, code, "A required array is missing.");
    return undefined;
  }
  return objectArray(context, value, path, code);
}

function objectArray(
  context: ParseContext,
  value: JsonValue,
  path: string,
  code: string,
): readonly JsonObject[] | undefined {
  if (!Array.isArray(value) || !value.every(isJsonObject)) {
    invalid(context, path, code, "Expected an array of objects.");
    return undefined;
  }
  return value;
}

function normalizeProjectType(value: string): ProjectType {
  return SUPPORTED_PROJECT_TYPES[value.trim().toLocaleLowerCase()] ?? "unknown";
}

function normalizeSplitType(value: string | undefined): SplitType {
  switch (value?.trim().toLocaleLowerCase()) {
    case "train":
    case "training":
      return "training";
    case "val":
    case "valid":
    case "validation":
      return "validation";
    case "unassigned":
    case "not-split":
    case "not_split":
      return "unassigned";
    default:
      return "unknown";
  }
}

function normalizeLabelOrigin(value: string | undefined): LabelOrigin {
  switch (value?.trim().toLocaleLowerCase()) {
    case "man":
    case "manual":
      return "manual";
    case "auto":
    case "automatic":
      return "automatic";
    default:
      return "unknown";
  }
}

function requiredNonEmptyString(
  context: ParseContext,
  value: JsonValue | undefined,
  path: string,
  code: string,
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(context, path, code, "Expected a non-empty string.");
    return undefined;
  }
  return value.trim();
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sourceIdValue(value: JsonValue | undefined): number | string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function optionalSourceId(value: JsonValue | undefined): { readonly sourceId?: number | string } {
  const sourceId = sourceIdValue(value);
  return sourceId === undefined ? {} : { sourceId };
}

function optionalNumberProperty<Key extends string>(
  key: Key,
  value: JsonValue | undefined,
): { readonly [Property in Key]?: number } {
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as { readonly [Property in Key]?: number })
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function classificationRaw(raw: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = {};
  if (raw.classId !== undefined) result.classId = raw.classId;
  if (raw.className !== undefined) result.className = raw.className;
  if (raw.classColor !== undefined) result.classColor = raw.classColor;
  return result;
}

function hasClassReference(raw: JsonObject): boolean {
  return (
    sourceIdValue(raw.classId) !== undefined ||
    nonNegativeInteger(raw.classNo) !== undefined ||
    Boolean(optionalString(raw.className)?.trim())
  );
}

function hasBoxFields(raw: JsonObject): boolean {
  return ["labelPosX", "labelPosY", "labelWidth", "labelHeight"].some(
    (key) => raw[key] !== undefined,
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function isSafeArchivePath(path: string): boolean {
  if (
    !path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-z]:\//i.test(path) ||
    path.includes(":")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasTraversal(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

function isAbsoluteExternalPath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:\//i.test(path) || /^file:\/\//i.test(path);
}

function idKey(value: number | string): string {
  return `${typeof value}:${String(value).toLocaleLowerCase()}`;
}

function hasMeaningfulValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isJsonObject(value)) return Object.keys(value).length > 0;
  return true;
}

function invalid(
  context: ParseContext,
  path: string,
  code: string,
  message: string,
): void {
  addDiagnostic(context, {
    code,
    category: "validation",
    severity: "error",
    disposition: "block",
    path,
    message,
  });
}

function compatibility(
  context: ParseContext,
  input: {
    readonly code: string;
    readonly disposition: CompatibilityDisposition;
    readonly severity: DiagnosticSeverity;
    readonly path: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, JsonValue>>;
  },
): void {
  addDiagnostic(context, { category: "compatibility", ...input });
}

function addDiagnostic(context: ParseContext, diagnostic: ProjectDiagnostic): void {
  appendBoundedProjectDiagnostic(context.diagnostics, diagnostic);
}

function hasFatalValidation(diagnostics: readonly ProjectDiagnostic[]): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" && item.category !== "compatibility",
  );
}

function summarizeCompatibility(
  diagnostics: readonly ProjectDiagnostic[],
): CompatibilitySummary {
  const count = (disposition: CompatibilityDisposition): number =>
    diagnostics.filter((item) => item.disposition === disposition).length;
  const blockCount = count("block");
  const degradeCount = count("degrade");
  const dropCount = count("drop");
  return {
    target: "v1",
    status:
      blockCount > 0
        ? "blocked"
        : degradeCount > 0 || dropCount > 0
          ? "confirmation-required"
          : "compatible",
    preserveCount: count("preserve"),
    rebuildCount: count("rebuild"),
    degradeCount,
    dropCount,
    blockCount,
  };
}

function failure(diagnostics: readonly ProjectDiagnostic[]): ProjectParseResult {
  return {
    ok: false,
    diagnostics,
    compatibility: summarizeCompatibility(diagnostics),
  };
}
