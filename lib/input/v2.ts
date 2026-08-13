import type {
  ArchiveImageSourceIR,
  CompatibilityDisposition,
  CompatibilitySummary,
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
  ProjectSourceFormat,
  ProjectSplitIR,
  ProjectType,
  SplitType,
} from "../model/project.ts";

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
}

interface ArchiveContext {
  readonly projectJsonEntryName: string;
  readonly entriesByName: ReadonlyMap<string, V2ArchiveEntry>;
}

interface ParsedLabels {
  readonly labels: readonly ProjectLabelIR[];
  readonly classificationClassIndex?: number;
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
]);

/** Parse a V2 light project. The file carries JSON and external paths only. */
export function parseV2SubvisionProject(
  input: V2SubvisionProjectInput,
): ProjectParseResult {
  const context: ParseContext = {
    format: "v2-subvisionproj",
    fileName: input.fileName,
    diagnostics: [],
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
  };
  return parseProjectJson(input.projectJsonText, context);
}

/** Backwards-friendly aliases for adapters that name functions after suffixes. */
export const parseSubvisionproj = parseV2SubvisionProject;
export const parseVisionproj = parseV2VisionProject;
export const parseSubvisionProject = parseV2SubvisionProject;
export const parseVisionProject = parseV2VisionProject;

function parseProjectJson(text: string, context: ParseContext): ProjectParseResult {
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
  if (type === "unknown") {
    addDiagnostic(context, {
      code: "V2_PROJECT_TYPE_UNSUPPORTED",
      category: "compatibility",
      severity: "error",
      disposition: "block",
      path: "$.project.projectType",
      message: `V2 project type '${rawType}' has no verified V1 mapping.`,
      details: { rawProjectType: rawType },
    });
  }

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

  const classes = parseClasses(context, classValues);
  const datasets = parseDatasets(context, datasetValues);
  if (!classes || !datasets) return failure(context.diagnostics);

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

  const files = parseFiles(context, fileValues, classes, datasets, type);
  if (!files) return failure(context.diagnostics);

  reportKnownLosses(context, projectRaw, classes, datasets, files);

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
      ...(optionalString(projectRaw.roiMode)
        ? { roiMode: optionalString(projectRaw.roiMode) }
        : {}),
      raw: projectRaw,
    },
    classes,
    datasets,
    files,
    raw: value,
  };

  if (hasFatalValidation(context.diagnostics)) return failure(context.diagnostics);
  return {
    ok: true,
    project,
    diagnostics: context.diagnostics,
    compatibility: summarizeCompatibility(context.diagnostics),
  };
}

function parseClasses(
  context: ParseContext,
  values: readonly JsonObject[],
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
    if (typeof raw.isNg === "boolean") {
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
): ProjectFileIR[] | undefined {
  const ids = new Map<string, number>();
  const paths = new Map<string, number>();
  const files: ProjectFileIR[] = [];

  for (const [index, raw] of values.entries()) {
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
      projectType === "classification"
        ? resolveClassIndex(context, raw, classes, path, hasClassReference(raw))
        : undefined;

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
    );
    const labels = parsedLabels.labels;

    const width = positiveInteger(raw.width);
    const height = positiveInteger(raw.height);
    if (raw.width !== undefined && width === undefined) {
      invalid(context, `${path}.width`, "V2_WIDTH_INVALID", "Image width must be a positive integer.");
    }
    if (raw.height !== undefined && height === undefined) {
      invalid(context, `${path}.height`, "V2_HEIGHT_INVALID", "Image height must be a positive integer.");
    }
    validateGeometryBounds(context, labels, width, height, path);

    files.push({
      sourceId,
      index,
      sourcePath,
      normalizedPath,
      fileName: lastSegment(normalizedPath),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(typeof raw.isLabeled === "boolean" ? { isLabeled: raw.isLabeled } : {}),
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
): ParsedLabels {
  if (projectType === "classification") {
    return parseClassificationLabels(
      context,
      values,
      classes,
      fileRaw,
      filePath,
      fileClassIndex,
    );
  }

  const labels = values.map((raw, index) => {
    const path = `${filePath}.labelDataList[${index}]`;
    reportUnknownFields(context, raw, LABEL_KNOWN_FIELDS, path, "label");
    const classIndex = resolveClassIndex(context, raw, classes, path, true);
    const kind = inferLabelKind(projectType, raw);
    const geometry = parseLabelGeometry(context, raw, kind, path);
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
    return {
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
    };
  });
  return { labels };
}

function parseClassificationLabels(
  context: ParseContext,
  values: readonly JsonObject[],
  classes: readonly ProjectClassIR[],
  fileRaw: JsonObject,
  filePath: string,
  fileClassIndex: number | undefined,
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

  const labels = values.map((raw, index): ProjectLabelIR => {
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
    return {
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
      geometry: parseClassificationGeometry(context, raw, path),
      synthesized: false,
      raw,
    };
  });

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
): LabelGeometryIR {
  const geometry: {
    box?: { x: number; y: number; width: number; height: number };
    contours?: readonly (readonly PointIR[])[];
  } = {};
  if (hasBoxFields(raw)) {
    const x = finiteNumber(raw.labelPosX);
    const y = finiteNumber(raw.labelPosY);
    const width = positiveNumber(raw.labelWidth);
    const height = positiveNumber(raw.labelHeight);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      invalid(
        context,
        path,
        "V2_CLASSIFICATION_GEOMETRY_INVALID",
        "A full-image classification label requires finite x/y and positive width/height.",
      );
    } else {
      geometry.box = { x, y, width, height };
    }
  }
  const contourValue = raw.labelContour ?? raw.labelPolygon;
  if (contourValue !== undefined) {
    const contours = parseContours(context, contourValue, path);
    if (contours.length > 0) geometry.contours = contours;
  }
  return geometry;
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
    if (contours.length > 1) {
      compatibility(context, {
        code: "V2_MULTIRING_CONTOUR_UNSUPPORTED",
        disposition: "block",
        severity: "error",
        path,
        message: "Multiple contour rings or holes require a verified V1 mapping.",
        details: { ringCount: contours.length },
      });
    }
    return {
      ...(contours.length > 0 ? { contours } : {}),
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
  const rings = normalizeRings(decoded);
  if (!rings || rings.length === 0 || rings.some((ring) => ring.length < 3)) {
    invalid(
      context,
      `${path}.labelContour`,
      "V2_CONTOUR_INVALID",
      "A contour requires at least three finite points per ring.",
    );
    return [];
  }
  return rings;
}

function normalizeRings(value: unknown): readonly (readonly PointIR[])[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const directRing = normalizeRing(value);
  if (directRing) return [directRing];
  const rings: PointIR[][] = [];
  for (const candidate of value) {
    const ring = normalizeRing(candidate);
    if (ring) {
      rings.push(ring);
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const nested of candidate) {
        const nestedRing = normalizeRing(nested);
        if (!nestedRing) return undefined;
        rings.push(nestedRing);
      }
      continue;
    }
    return undefined;
  }
  return rings.length > 0 ? rings : undefined;
}

function normalizeRing(value: unknown): PointIR[] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const points: PointIR[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) return undefined;
    const x = finiteNumber(item[0]);
    const y = finiteNumber(item[1]);
    if (x === undefined || y === undefined) return undefined;
    points.push({ x, y });
  }
  return points;
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
  };
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
        message: "A detection box falls outside the image bounds.",
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
  reportRoiCompatibility(context, project);
  if (files.some((file) => hasMeaningfulValue(file.raw.metadata))) {
    compatibility(context, {
      code: "V2_FILE_METADATA_NOT_IN_V1",
      disposition: "drop",
      severity: "warning",
      path: "$.project.projectFiles[*].metadata",
      message: "Per-file V2 metadata is retained in raw data but is not emitted to V1.",
    });
  }
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

function reportRoiCompatibility(context: ParseContext, project: JsonObject): void {
  const mode = optionalString(project.roiMode)?.trim().toLocaleLowerCase("en-US");
  if (!mode || mode === "no") return;

  const isDefaultFullImageRoi =
    mode === "simple" &&
    finiteNumber(project.roiPosX) === 0 &&
    finiteNumber(project.roiPosY) === 0 &&
    finiteNumber(project.roiWidth) === 1 &&
    finiteNumber(project.roiHeight) === 1 &&
    optionalString(project.roiShapeType)?.trim().toLocaleLowerCase("en-US") ===
      "rectangle";
  if (isDefaultFullImageRoi) {
    compatibility(context, {
      code: "V2_DEFAULT_FULL_IMAGE_ROI",
      disposition: "preserve",
      severity: "info",
      path: "$.project.roiMode",
      message: "The normalized full-image rectangle ROI is semantically equivalent to no crop.",
    });
    return;
  }

  compatibility(context, {
    code: "V2_ROI_MAPPING_UNVERIFIED",
    disposition: "block",
    severity: "error",
    path: "$.project.roiMode",
    message: "A custom or incomplete V2 ROI has no verified V1 mapping.",
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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
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
  context.diagnostics.push(diagnostic);
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
