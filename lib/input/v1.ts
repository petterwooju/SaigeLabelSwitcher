import type {
  CompatibilityDisposition,
  CompatibilitySummary,
  ContourRingRole,
  JsonObject,
  JsonValue,
  PointIR,
  ProjectClassIR,
  ProjectDiagnostic,
  ProjectFileIR,
  ProjectIR,
  ProjectLabelIR,
  ProjectParseResult,
  ProjectRoiIR,
  ProjectSplitIR,
  ProjectType,
  SplitType,
} from "../model/project.ts";
import { APP_VERSION, isSupportedProjectType } from "../release.ts";
import {
  appendBoundedProjectDiagnostic,
  exceedsUtf8ByteLimit,
  PROJECT_DIAGNOSTIC_MAX_COUNT,
  PROJECT_PATH_MAX_BYTES,
  PROJECT_STRUCTURE_MAX_DEPTH,
  projectDiagnosticsAreTruncated,
  PROJECT_TEXT_MAX_BYTES,
  V1_PROJECT_LIMITS,
  V2_PROJECT_LIMITS,
} from "../security/resourceLimits.ts";

export interface V1SrprojInput {
  readonly xmlText: string;
  readonly fileName?: string;
}

interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: XmlElement[];
  readonly textParts: string[];
  readonly start: number;
  end: number;
}

interface ParseContext {
  readonly source: string;
  readonly diagnostics: ProjectDiagnostic[];
  readonly unknownNodes: JsonObject[];
}

interface SegmentationResourceUsage {
  labelCount: number;
  contourPointCount: number;
}

interface ParsedSegmentationLabelGroup {
  readonly isNormal: boolean;
  readonly declaredCount: number;
  readonly labels: readonly ProjectLabelIR[];
  readonly raw: JsonObject;
}

interface ParsedV1MaskingParameter {
  readonly roi?: ProjectRoiIR;
  /** Retains an active source mode even when its geometry/settings are blocked. */
  readonly roiMode: string;
}

class XmlSyntaxError extends Error {
  readonly code: string;
  readonly offset: number;
  readonly category: "validation" | "security";

  constructor(
    code: string,
    message: string,
    offset: number,
    category: "validation" | "security" = "validation",
  ) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.category = category;
  }
}

const CORE_ROOT_ELEMENTS = new Set([
  "Version",
  "Type",
  "ModifiedDate",
  "ClassGroup",
  "ImageGroup",
  "MaskingParameter",
]);

// These nodes occur in verified V1 files, but this adapter deliberately does
// not map their training/runtime settings into the cross-version IR.
const KNOWN_UNMAPPED_ROOT_ELEMENTS = new Set([
  "TrainingParameter",
  "AugmentationParameter",
  "SpecificType",
  "OtherSettings",
  "MultipageParameter",
]);

/** Parse a standalone V1 `.srproj` XML document into the shared ProjectIR. */
export function parseV1Srproj(input: V1SrprojInput | string): ProjectParseResult {
  const normalizedInput =
    typeof input === "string" ? { xmlText: input } : input;
  const source = stripBom(normalizedInput.xmlText);
  const context: ParseContext = {
    source,
    diagnostics: [],
    unknownNodes: [],
  };

  if (exceedsUtf8ByteLimit(normalizedInput.xmlText, PROJECT_TEXT_MAX_BYTES)) {
    resourceLimit(
      context,
      "$",
      "V1_TEXT_LIMIT_EXCEEDED",
      `V1 XML exceeds the ${PROJECT_TEXT_MAX_BYTES}-byte UTF-8 text limit.`,
      { maxBytes: PROJECT_TEXT_MAX_BYTES },
    );
    return failure(context.diagnostics);
  }

  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (error) {
    const syntax =
      error instanceof XmlSyntaxError
        ? error
        : new XmlSyntaxError("V1_INVALID_XML", String(error), 0);
    addDiagnostic(context, {
      code: syntax.code,
      category: syntax.category,
      severity: "error",
      disposition: "block",
      path: "$",
      message: syntax.message,
      details: { offset: syntax.offset },
    });
    return failure(context.diagnostics);
  }

  if (root.name !== "Project") {
    invalid(
      context,
      "$",
      "V1_ROOT_INVALID",
      "V1 XML must have a single <Project> root element.",
      { actualRoot: root.name },
    );
    return failure(context.diagnostics);
  }

  reportUnknownAttributes(context, root, "$.Project");
  reportRootNodes(context, root);
  const masking = parseV1MaskingParameter(context, root);

  const version = requiredLeaf(context, root, "Version", "$.Project.Version");
  const rawType = requiredLeaf(context, root, "Type", "$.Project.Type");
  const classGroup = requiredElement(
    context,
    root,
    "ClassGroup",
    "$.Project.ClassGroup",
  );
  const imageGroup = requiredElement(
    context,
    root,
    "ImageGroup",
    "$.Project.ImageGroup",
  );
  const modifiedDate = optionalLeaf(
    context,
    root,
    "ModifiedDate",
    "$.Project.ModifiedDate",
  );

  if (!version || !rawType || !classGroup || !imageGroup) {
    return failure(context.diagnostics);
  }

  if (version !== "0.9") {
    compatibility(context, {
      code: "V1_VERSION_UNVERIFIED",
      severity: "error",
      disposition: "block",
      path: "$.Project.Version",
      message: `V1 schema version '${version}' has not been verified for conversion.`,
      details: { version },
    });
  }

  const type = normalizeProjectType(rawType);
  if (!isSupportedProjectType(type)) {
    compatibility(context, {
      code: "V1_PROJECT_TYPE_UNSUPPORTED",
      severity: "error",
      disposition: "block",
      path: "$.Project.Type",
      message:
        type === "unknown"
          ? `V1 project type '${rawType}' is unknown.`
          : `V1 ${rawType} is outside the v${APP_VERSION} release scope; its labels are not mapped.`,
      details: { rawProjectType: rawType },
    });
  }

  const classesResult = parseClasses(context, classGroup);
  if (!classesResult) return failure(context.diagnostics);
  reportV1ToV2ClassCompatibility(context, type, classesResult.classes);

  const filesResult = parseImages(
    context,
    imageGroup,
    classesResult.classes,
    type,
  );
  if (!filesResult) return failure(context.diagnostics);

  if (hasFatalValidation(context.diagnostics)) {
    return failure(context.diagnostics);
  }

  const projectRaw: Record<string, JsonValue> = {
    version,
    type: rawType,
    declaredClassCount: classesResult.declaredCount,
    declaredImageCount: filesResult.declaredCount,
    classes: classesResult.classes.map((item) => item.raw),
    images: filesResult.files.map((item) => item.raw),
  };
  if (modifiedDate !== undefined) projectRaw.modifiedDate = modifiedDate;
  if (context.unknownNodes.length > 0) {
    projectRaw.unknownNodes = context.unknownNodes;
  }

  const modifiedAt = modifiedDate
    ? parseV1DateAsUtcMilliseconds(modifiedDate)
    : undefined;
  const compatibilitySummary = summarizeCompatibility(context.diagnostics);
  const project: ProjectIR = {
    schemaVersion: 1,
    source: {
      format: "v1-srproj",
      ...(normalizedInput.fileName
        ? { fileName: normalizedInput.fileName }
        : {}),
      rawProjectType: rawType,
    },
    project: {
      name: deriveProjectName(normalizedInput.fileName),
      type,
      rawType,
      description: "",
      ...(masking?.roi
        ? {
            roi: masking.roi,
          }
        : {}),
      ...(masking ? { roiMode: masking.roiMode } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      raw: projectRaw,
    },
    classes: classesResult.classes,
    datasets: [],
    files: filesResult.files,
    raw: { Project: projectRaw },
    compatibility: compatibilitySummary,
  };

  return {
    ok: true,
    project,
    diagnostics: context.diagnostics,
    compatibility: compatibilitySummary,
  };
}

/** Adapter-friendly aliases. */
export const parseSrproj = parseV1Srproj;
export const parseV1Project = parseV1Srproj;

function parseClasses(
  context: ParseContext,
  group: XmlElement,
): { readonly classes: ProjectClassIR[]; readonly declaredCount: number } | undefined {
  const path = "$.Project.ClassGroup";
  reportUnknownAttributes(context, group, path);
  reportUnknownChildren(context, group, new Set(["NumberOfClasses", "Class"]), path);

  const countText = requiredLeaf(
    context,
    group,
    "NumberOfClasses",
    `${path}.NumberOfClasses`,
  );
  const declaredCount = parseNonNegativeInteger(
    context,
    countText,
    `${path}.NumberOfClasses`,
    "V1_CLASS_COUNT_INVALID",
  );
  const classNodes = childElements(group, "Class");
  if (
    classNodes.length > V1_PROJECT_LIMITS.maxClasses ||
    (declaredCount !== undefined && declaredCount > V1_PROJECT_LIMITS.maxClasses)
  ) {
    resourceLimit(
      context,
      path,
      "V1_CLASS_LIMIT_EXCEEDED",
      `V1 class count must not exceed ${V1_PROJECT_LIMITS.maxClasses}.`,
      {
        declaredCount: declaredCount ?? null,
        actualCount: classNodes.length,
        maxClasses: V1_PROJECT_LIMITS.maxClasses,
      },
    );
    return undefined;
  }
  const classes: ProjectClassIR[] = [];
  const names = new Set<string>();

  for (const [index, node] of classNodes.entries()) {
    const classPath = `${path}.Class[${index}]`;
    reportUnknownAttributes(context, node, classPath);
    reportUnknownChildren(context, node, new Set(["Name", "Color"]), classPath);
    const name = requiredLeaf(context, node, "Name", `${classPath}.Name`);
    const rawColor = requiredLeaf(context, node, "Color", `${classPath}.Color`);
    const color = parseV1Color(context, rawColor, `${classPath}.Color`);
    if (!name || !rawColor || !color) continue;

    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) {
      invalid(
        context,
        `${classPath}.Name`,
        "V1_DUPLICATE_CLASS_NAME",
        `Duplicate V1 class name '${name}'.`,
      );
    }
    names.add(nameKey);
    classes.push({
      index,
      sourceIndex: index,
      name,
      color,
      description: "",
      raw: { name, color: rawColor },
    });
  }

  if (declaredCount === undefined) return undefined;
  if (declaredCount !== classNodes.length) {
    invalid(
      context,
      `${path}.NumberOfClasses`,
      "V1_CLASS_COUNT_MISMATCH",
      `NumberOfClasses declares ${declaredCount}, but ${classNodes.length} <Class> elements were found.`,
      { declaredCount, actualCount: classNodes.length },
    );
  }
  if (declaredCount > 0 && classes.length !== classNodes.length) return undefined;
  return { classes, declaredCount };
}

function reportV1ToV2ClassCompatibility(
  context: ParseContext,
  projectType: ProjectType,
  classes: readonly ProjectClassIR[],
): void {
  if (projectType !== "segmentation") return;
  for (const cls of classes) {
    if (
      cls.name.trim().normalize("NFKC").toLocaleLowerCase("en-US") !== "ok"
    ) {
      continue;
    }
    compatibility(context, {
      code: "V1_SEGMENTATION_OK_CLASS_RESERVED_IN_V2",
      severity: "error",
      disposition: "block",
      path: `$.Project.ClassGroup.Class[${cls.sourceIndex}].Name`,
      message:
        "The class name 'OK' is reserved for V2 Segmentation normal-image state and cannot be used as a V1 defect class.",
      details: {
        className: cls.name,
        blockedTargets: ["visionproj", "subvisionproj"],
      },
    });
  }
}

function parseImages(
  context: ParseContext,
  group: XmlElement,
  classes: readonly ProjectClassIR[],
  projectType: ProjectType,
): { readonly files: ProjectFileIR[]; readonly declaredCount: number } | undefined {
  const path = "$.Project.ImageGroup";
  reportUnknownAttributes(context, group, path);
  reportUnknownChildren(context, group, new Set(["NumberOfImages", "Image"]), path);

  const countText = requiredLeaf(
    context,
    group,
    "NumberOfImages",
    `${path}.NumberOfImages`,
  );
  const declaredCount = parseNonNegativeInteger(
    context,
    countText,
    `${path}.NumberOfImages`,
    "V1_IMAGE_COUNT_INVALID",
  );
  const imageNodes = childElements(group, "Image");
  if (
    imageNodes.length > V1_PROJECT_LIMITS.maxFiles ||
    (declaredCount !== undefined && declaredCount > V1_PROJECT_LIMITS.maxFiles)
  ) {
    resourceLimit(
      context,
      path,
      "V1_FILE_LIMIT_EXCEEDED",
      `V1 image count must not exceed ${V1_PROJECT_LIMITS.maxFiles}.`,
      {
        declaredCount: declaredCount ?? null,
        actualCount: imageNodes.length,
        maxFiles: V1_PROJECT_LIMITS.maxFiles,
      },
    );
    return undefined;
  }
  const overlongPathCount = imageNodes.filter((node) => {
    const pathNodes = childElements(node, "Path");
    if (pathNodes.length !== 1 || pathNodes[0]!.children.length > 0) return false;
    return exceedsUtf8ByteLimit(
      pathNodes[0]!.textParts.join("").trim(),
      PROJECT_PATH_MAX_BYTES,
    );
  }).length;
  if (overlongPathCount > 0) {
    resourceLimit(
      context,
      `${path}.Image[*].Path`,
      "V1_PATH_LIMIT_EXCEEDED",
      `V1 image paths must not exceed ${PROJECT_PATH_MAX_BYTES} UTF-8 bytes.`,
      { overlongPathCount, maxBytes: PROJECT_PATH_MAX_BYTES },
    );
    return undefined;
  }
  const files: ProjectFileIR[] = [];
  const segmentationUsage: SegmentationResourceUsage = {
    labelCount: 0,
    contourPointCount: 0,
  };

  for (const [index, node] of imageNodes.entries()) {
    const imagePath = `${path}.Image[${index}]`;
    const knownImageChildren = new Set(["Path", "Width", "Height", "SplitState"]);
    if (projectType === "classification") {
      knownImageChildren.add("ClassIndexOfLabel");
    } else if (projectType === "segmentation") {
      knownImageChildren.add("LabelGroup");
    }
    reportUnknownAttributes(context, node, imagePath);
    reportUnknownChildren(context, node, knownImageChildren, imagePath);

    const sourcePath = requiredLeaf(context, node, "Path", `${imagePath}.Path`);
    const widthText = optionalLeaf(context, node, "Width", `${imagePath}.Width`);
    const heightText = optionalLeaf(context, node, "Height", `${imagePath}.Height`);
    const rawSplit = requiredLeaf(
      context,
      node,
      "SplitState",
      `${imagePath}.SplitState`,
    );
    const width = parseOptionalPositiveInteger(
      context,
      widthText,
      `${imagePath}.Width`,
      "V1_IMAGE_WIDTH_INVALID",
    );
    const height = parseOptionalPositiveInteger(
      context,
      heightText,
      `${imagePath}.Height`,
      "V1_IMAGE_HEIGHT_INVALID",
    );
    const split = rawSplit
      ? parseSplit(context, rawSplit, `${imagePath}.SplitState`)
      : undefined;

    let classificationClassIndex: number | undefined;
    if (projectType === "classification") {
      const labelText = requiredLeaf(
        context,
        node,
        "ClassIndexOfLabel",
        `${imagePath}.ClassIndexOfLabel`,
      );
      classificationClassIndex = parseNonNegativeInteger(
        context,
        labelText,
        `${imagePath}.ClassIndexOfLabel`,
        "V1_CLASS_LABEL_INVALID",
      );
      if (
        classificationClassIndex !== undefined &&
        classificationClassIndex >= classes.length
      ) {
        invalid(
          context,
          `${imagePath}.ClassIndexOfLabel`,
          "V1_CLASS_LABEL_OUT_OF_RANGE",
          `ClassIndexOfLabel ${classificationClassIndex} does not reference a declared class.`,
          { classIndex: classificationClassIndex, classCount: classes.length },
        );
      }
    }

    const segmentation =
      projectType === "segmentation"
        ? parseSegmentationLabelGroup(
            context,
            node,
            classes,
            imagePath,
            segmentationUsage,
          )
        : undefined;

    if (!sourcePath || !rawSplit || !split) continue;
    if (projectType === "classification" && classificationClassIndex === undefined) {
      continue;
    }
    if (projectType === "segmentation" && segmentation === undefined) continue;

    const normalizedPath = normalizeSlashes(sourcePath);
    const raw: Record<string, JsonValue> = {
      path: sourcePath,
      splitState: rawSplit,
    };
    if (width !== undefined) raw.width = width;
    if (height !== undefined) raw.height = height;
    if (classificationClassIndex !== undefined) {
      raw.classIndexOfLabel = classificationClassIndex;
    }
    if (segmentation !== undefined) {
      raw.isNormal = segmentation.isNormal;
      raw.declaredLabelCount = segmentation.declaredCount;
      raw.labels = segmentation.labels.map((label) => label.raw);
    }

    const splits: readonly ProjectSplitIR[] = [
      {
        sourceName: rawSplit,
        type: split,
        rawType: rawSplit,
        raw: { splitState: rawSplit },
      },
    ];
    files.push({
      index,
      sourcePath,
      normalizedPath,
      fileName: lastPathSegment(normalizedPath),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      isLabeled:
        projectType === "classification"
          ? classificationClassIndex !== undefined
          : projectType === "segmentation"
            ? segmentation!.isNormal || segmentation!.labels.length > 0
            : undefined,
      ...(segmentation !== undefined
        ? { isNormal: segmentation.isNormal }
        : {}),
      ...(classificationClassIndex !== undefined
        ? { classificationClassIndex }
        : {}),
      splits,
      canonicalSplit: split,
      labels:
        projectType === "segmentation"
          ? segmentation!.labels
          : classificationClassIndex === undefined
            ? []
            : [
              {
                index: 0,
                kind: "classification",
                origin: "manual",
                classIndex: classificationClassIndex,
                geometry: {},
                synthesized: false,
                raw: { classIndexOfLabel: classificationClassIndex },
              },
            ],
      image: { kind: "external", path: sourcePath },
      raw,
    });
  }

  if (declaredCount === undefined) return undefined;
  if (declaredCount !== imageNodes.length) {
    invalid(
      context,
      `${path}.NumberOfImages`,
      "V1_IMAGE_COUNT_MISMATCH",
      `NumberOfImages declares ${declaredCount}, but ${imageNodes.length} <Image> elements were found.`,
      { declaredCount, actualCount: imageNodes.length },
    );
  }
  if (files.length !== imageNodes.length) return undefined;
  return { files, declaredCount };
}

function parseSegmentationLabelGroup(
  context: ParseContext,
  image: XmlElement,
  classes: readonly ProjectClassIR[],
  imagePath: string,
  usage: SegmentationResourceUsage,
): ParsedSegmentationLabelGroup | undefined {
  const path = `${imagePath}.LabelGroup`;
  const group = requiredElement(context, image, "LabelGroup", path);
  if (!group) return undefined;

  reportUnknownAttributes(context, group, path);
  reportUnknownChildren(
    context,
    group,
    new Set(["IsNormal", "NumberOfLabels", "Label"]),
    path,
  );
  const isNormalText = requiredLeaf(context, group, "IsNormal", `${path}.IsNormal`);
  const countText = requiredLeaf(
    context,
    group,
    "NumberOfLabels",
    `${path}.NumberOfLabels`,
  );
  const isNormal = parseRequiredBoolean(
    context,
    isNormalText,
    `${path}.IsNormal`,
    "V1_IS_NORMAL_INVALID",
  );
  const declaredCount = parseNonNegativeInteger(
    context,
    countText,
    `${path}.NumberOfLabels`,
    "V1_LABEL_COUNT_INVALID",
  );
  const labelNodes = childElements(group, "Label");
  usage.labelCount = saturatingResourceAdd(
    usage.labelCount,
    labelNodes.length,
    V2_PROJECT_LIMITS.maxLabels,
  );
  if (
    usage.labelCount > V2_PROJECT_LIMITS.maxLabels ||
    labelNodes.length > V2_PROJECT_LIMITS.maxLabels ||
    (declaredCount !== undefined && declaredCount > V2_PROJECT_LIMITS.maxLabels)
  ) {
    resourceLimit(
      context,
      `${path}.Label`,
      "V1_LABEL_LIMIT_EXCEEDED",
      `V1 segmentation label count must not exceed ${V2_PROJECT_LIMITS.maxLabels}.`,
      {
        declaredCount: declaredCount ?? null,
        imageLabelCount: labelNodes.length,
        projectLabelCount: usage.labelCount,
        maxLabels: V2_PROJECT_LIMITS.maxLabels,
      },
    );
    return undefined;
  }
  if (declaredCount !== undefined && declaredCount !== labelNodes.length) {
    invalid(
      context,
      `${path}.NumberOfLabels`,
      "V1_LABEL_COUNT_MISMATCH",
      `NumberOfLabels declares ${declaredCount}, but ${labelNodes.length} <Label> elements were found.`,
      { declaredCount, actualCount: labelNodes.length },
    );
  }
  if (
    isNormal === true &&
    (declaredCount !== 0 || labelNodes.length !== 0)
  ) {
    invalid(
      context,
      path,
      "V1_NORMAL_IMAGE_HAS_LABELS",
      "A V1 image marked IsNormal=true must not contain segmentation labels.",
      {
        declaredCount: declaredCount ?? null,
        actualCount: labelNodes.length,
      },
    );
  }

  const labels: ProjectLabelIR[] = [];
  for (const [index, node] of labelNodes.entries()) {
    const label = parseSegmentationLabel(
      context,
      node,
      classes,
      `${path}.Label[${index}]`,
      index,
      usage,
    );
    if (label) labels.push(label);
  }

  if (
    isNormal === undefined ||
    declaredCount === undefined ||
    labels.length !== labelNodes.length
  ) {
    return undefined;
  }
  return {
    isNormal,
    declaredCount,
    labels,
    raw: {
      isNormal,
      declaredLabelCount: declaredCount,
      labels: labels.map((label) => label.raw),
    },
  };
}

function parseSegmentationLabel(
  context: ParseContext,
  node: XmlElement,
  classes: readonly ProjectClassIR[],
  path: string,
  index: number,
  usage: SegmentationResourceUsage,
): ProjectLabelIR | undefined {
  reportUnknownAttributes(context, node, path);
  reportUnknownChildren(
    context,
    node,
    new Set(["ClassIndex", "Type", "ContourGroup"]),
    path,
  );
  const classIndexText = requiredLeaf(
    context,
    node,
    "ClassIndex",
    `${path}.ClassIndex`,
  );
  const labelType = requiredLeaf(context, node, "Type", `${path}.Type`);
  const contourGroup = requiredElement(
    context,
    node,
    "ContourGroup",
    `${path}.ContourGroup`,
  );
  const classIndex = parseNonNegativeInteger(
    context,
    classIndexText,
    `${path}.ClassIndex`,
    "V1_SEGMENTATION_CLASS_INDEX_INVALID",
  );
  if (classIndex !== undefined && classIndex >= classes.length) {
    invalid(
      context,
      `${path}.ClassIndex`,
      "V1_SEGMENTATION_CLASS_INDEX_OUT_OF_RANGE",
      `ClassIndex ${classIndex} does not reference a declared class.`,
      { classIndex, classCount: classes.length },
    );
  }
  if (labelType !== undefined && labelType.toLocaleLowerCase("en-US") !== "contours") {
    invalid(
      context,
      `${path}.Type`,
      "V1_SEGMENTATION_LABEL_TYPE_INVALID",
      "V1 segmentation labels must use <Type>Contours</Type>.",
      { labelType },
    );
  }

  const geometry = contourGroup
    ? parseSegmentationContours(
        context,
        contourGroup,
        `${path}.ContourGroup`,
        usage,
      )
    : undefined;
  if (
    classIndex === undefined ||
    classIndex >= classes.length ||
    labelType === undefined ||
    labelType.toLocaleLowerCase("en-US") !== "contours" ||
    geometry === undefined
  ) {
    return undefined;
  }

  const raw: JsonObject = {
    classIndex,
    type: labelType,
    contours: geometry.rawContours,
  };
  return {
    index,
    kind: "contour",
    origin: "manual",
    classIndex,
    sourceClassName: classes[classIndex]!.name,
    geometry: {
      contours: geometry.contours,
      contourRoles: geometry.contourRoles,
    },
    synthesized: false,
    raw,
  };
}

function parseSegmentationContours(
  context: ParseContext,
  group: XmlElement,
  path: string,
  usage: SegmentationResourceUsage,
):
  | {
      readonly contours: readonly (readonly PointIR[])[];
      readonly contourRoles: readonly ContourRingRole[];
      readonly rawContours: readonly JsonObject[];
    }
  | undefined {
  reportUnknownAttributes(context, group, path);
  reportUnknownChildren(context, group, new Set(["Contour"]), path);
  const contourNodes = childElements(group, "Contour");
  if (contourNodes.length === 0) {
    invalid(
      context,
      path,
      "V1_CONTOUR_REQUIRED",
      "A V1 segmentation label must contain at least one <Contour>.",
    );
    return undefined;
  }

  const contours: PointIR[][] = [];
  const contourRoles: ContourRingRole[] = [];
  const rawContours: JsonObject[] = [];
  for (const [contourIndex, contourNode] of contourNodes.entries()) {
    const contourPath = `${path}.Contour[${contourIndex}]`;
    reportUnknownAttributesExcept(
      context,
      contourNode,
      new Set(["Type"]),
      contourPath,
    );
    reportUnknownChildren(context, contourNode, new Set(["Point"]), contourPath);
    if (contourNode.textParts.join("").trim() !== "") {
      invalid(
        context,
        contourPath,
        "V1_CONTOUR_TEXT_INVALID",
        "A V1 <Contour> may contain only <Point> elements.",
      );
    }

    const rawRole = contourNode.attributes.get("Type");
    const normalizedRole = rawRole?.trim().toLocaleLowerCase("en-US");
    const role: ContourRingRole | undefined =
      normalizedRole === "outer"
        ? "outer"
        : normalizedRole === "inner"
          ? "inner"
          : undefined;
    if (!role) {
      invalid(
        context,
        `${contourPath}.@Type`,
        "V1_CONTOUR_TYPE_INVALID",
        "V1 contour Type must be 'Outer' or 'Inner'.",
        { contourType: rawRole ?? null },
      );
    }

    const pointNodes = childElements(contourNode, "Point");
    usage.contourPointCount = saturatingResourceAdd(
      usage.contourPointCount,
      pointNodes.length,
      V2_PROJECT_LIMITS.maxContourPoints,
    );
    if (usage.contourPointCount > V2_PROJECT_LIMITS.maxContourPoints) {
      resourceLimit(
        context,
        `${contourPath}.Point`,
        "V1_CONTOUR_POINT_LIMIT_EXCEEDED",
        `V1 contour point count must not exceed ${V2_PROJECT_LIMITS.maxContourPoints}.`,
        {
          projectPointCount: usage.contourPointCount,
          maxContourPoints: V2_PROJECT_LIMITS.maxContourPoints,
        },
      );
      return undefined;
    }
    if (pointNodes.length < 3) {
      invalid(
        context,
        `${contourPath}.Point`,
        "V1_CONTOUR_POINT_COUNT_INVALID",
        "A V1 contour must contain at least three points.",
        { pointCount: pointNodes.length },
      );
    }

    const points: PointIR[] = [];
    for (const [pointIndex, pointNode] of pointNodes.entries()) {
      const point = parseSegmentationPoint(
        context,
        pointNode,
        `${contourPath}.Point[${pointIndex}]`,
      );
      if (point) points.push(point);
    }
    if (!role || points.length !== pointNodes.length || points.length < 3) continue;
    contours.push(points);
    contourRoles.push(role);
    rawContours.push({
      type: rawRole!,
      points: points.map(({ x, y }) => ({ x, y })),
    });
  }

  if (contours.length !== contourNodes.length) return undefined;
  if (!contourRoles.includes("outer")) {
    invalid(
      context,
      path,
      "V1_OUTER_CONTOUR_REQUIRED",
      "A V1 segmentation label must contain at least one Outer contour.",
    );
    return undefined;
  }
  let hasOuter = false;
  const leadingInnerIndex = contourRoles.findIndex((role) => {
    if (role === "outer") {
      hasOuter = true;
      return false;
    }
    return !hasOuter;
  });
  if (leadingInnerIndex >= 0) {
    invalid(
      context,
      `${path}.Contour[${leadingInnerIndex}]`,
      "V1_INNER_CONTOUR_BEFORE_OUTER",
      "Each V1 Inner contour must follow an Outer contour in the same label.",
      { contourIndex: leadingInnerIndex },
    );
    return undefined;
  }
  return { contours, contourRoles, rawContours };
}

function parseSegmentationPoint(
  context: ParseContext,
  node: XmlElement,
  path: string,
): PointIR | undefined {
  reportUnknownAttributesExcept(context, node, new Set(["X", "Y"]), path);
  if (node.children.length > 0 || node.textParts.join("").trim() !== "") {
    invalid(
      context,
      path,
      "V1_POINT_CONTENT_INVALID",
      "A V1 <Point> must not contain text or child elements.",
    );
  }
  const rawX = node.attributes.get("X");
  const rawY = node.attributes.get("Y");
  if (rawX === undefined) {
    invalid(context, `${path}.@X`, "V1_POINT_COORDINATE_MISSING", "Point X is required.");
  }
  if (rawY === undefined) {
    invalid(context, `${path}.@Y`, "V1_POINT_COORDINATE_MISSING", "Point Y is required.");
  }
  const x =
    rawX === undefined
      ? undefined
      : parseFiniteCoordinate(context, rawX, `${path}.@X`);
  const y =
    rawY === undefined
      ? undefined
      : parseFiniteCoordinate(context, rawY, `${path}.@Y`);
  if (
    node.children.length > 0 ||
    node.textParts.join("").trim() !== "" ||
    x === undefined ||
    y === undefined
  ) {
    return undefined;
  }
  return { x, y };
}

function parseRequiredBoolean(
  context: ParseContext,
  value: string | undefined,
  path: string,
  code: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  invalid(context, path, code, "Expected 'true' or 'false'.", { value });
  return undefined;
}

function parseFiniteCoordinate(
  context: ParseContext,
  value: string | undefined,
  path: string,
): number | undefined {
  if (
    value === undefined ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  ) {
    invalid(context, path, "V1_POINT_COORDINATE_INVALID", "Point coordinates must be finite numbers.");
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    invalid(context, path, "V1_POINT_COORDINATE_INVALID", "Point coordinate is outside the safe numeric range.");
    return undefined;
  }
  return number;
}

function saturatingResourceAdd(current: number, addition: number, maximum: number): number {
  return Math.min(maximum + 1, current + addition);
}

function normalizeProjectType(value: string): ProjectType {
  switch (value.trim().toLocaleLowerCase()) {
    case "classification":
    case "cls":
      return "classification";
    case "detection":
    case "det":
      return "detection";
    case "segmentation":
    case "seg":
      return "segmentation";
    default:
      return "unknown";
  }
}

function parseSplit(
  context: ParseContext,
  value: string,
  path: string,
): SplitType {
  const normalized = value.trim().toLocaleLowerCase().replace(/[ _-]+/g, "");
  switch (normalized) {
    case "training":
    case "train":
      return "training";
    case "validation":
    case "valid":
    case "val":
      return "validation";
    case "notsplit":
    case "unassigned":
    case "none":
      return "unassigned";
    default:
      compatibility(context, {
        code: "V1_SPLIT_UNSUPPORTED",
        severity: "error",
        disposition: "block",
        path,
        message: `V1 SplitState '${value}' has no verified V2 mapping.`,
        details: { splitState: value },
      });
      return "unknown";
  }
}

function parseV1Color(
  context: ParseContext,
  value: string | undefined,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) {
    invalid(context, path, "V1_CLASS_COLOR_INVALID", "V1 class Color must be a 32-bit integer.");
    return undefined;
  }
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < -0x80000000 ||
    number > 0xffffffff
  ) {
    invalid(context, path, "V1_CLASS_COLOR_INVALID", "V1 class Color is outside the 32-bit ARGB range.");
    return undefined;
  }
  const unsigned = number < 0 ? number + 0x1_0000_0000 : number;
  const argb = unsigned.toString(16).padStart(8, "0").toLocaleLowerCase();
  if (!argb.startsWith("ff")) {
    compatibility(context, {
      code: "V1_CLASS_COLOR_ALPHA_NOT_IN_V2",
      severity: "warning",
      disposition: "degrade",
      path,
      message:
        "V2 class colors do not preserve the V1 ARGB alpha channel; only RGB will be retained.",
      details: {
        alpha: Number.parseInt(argb.slice(0, 2), 16),
        affectedTargets: ["visionproj", "subvisionproj"],
      },
    });
  }
  return argb.startsWith("ff") ? `#${argb.slice(2)}` : `#${argb}`;
}

function parseNonNegativeInteger(
  context: ParseContext,
  value: string | undefined,
  path: string,
  code: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    invalid(context, path, code, "Expected a non-negative integer.");
    return undefined;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    invalid(context, path, code, "Integer is outside the safe numeric range.");
    return undefined;
  }
  return number;
}

function parseOptionalPositiveInteger(
  context: ParseContext,
  value: string | undefined,
  path: string,
  code: string,
): number | undefined {
  if (value === undefined) return undefined;
  const number = parseNonNegativeInteger(context, value, path, code);
  if (number === 0) {
    invalid(context, path, code, "Image dimensions must be positive integers.");
    return undefined;
  }
  return number;
}

function requiredElement(
  context: ParseContext,
  parent: XmlElement,
  name: string,
  path: string,
): XmlElement | undefined {
  const matches = childElements(parent, name);
  if (matches.length === 0) {
    invalid(context, path, "V1_REQUIRED_ELEMENT_MISSING", `Required <${name}> element is missing.`);
    return undefined;
  }
  if (matches.length > 1) {
    invalid(context, path, "V1_DUPLICATE_ELEMENT", `Expected one <${name}> element, found ${matches.length}.`);
  }
  return matches[0];
}

function requiredLeaf(
  context: ParseContext,
  parent: XmlElement,
  name: string,
  path: string,
): string | undefined {
  const element = requiredElement(context, parent, name, path);
  if (!element) return undefined;
  return readLeaf(context, element, path, true);
}

function optionalLeaf(
  context: ParseContext,
  parent: XmlElement,
  name: string,
  path: string,
): string | undefined {
  const matches = childElements(parent, name);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    invalid(context, path, "V1_DUPLICATE_ELEMENT", `Expected at most one <${name}> element, found ${matches.length}.`);
  }
  return readLeaf(context, matches[0], path, false);
}

function readLeaf(
  context: ParseContext,
  element: XmlElement,
  path: string,
  required: boolean,
): string | undefined {
  reportUnknownAttributes(context, element, path);
  if (element.children.length > 0) {
    invalid(context, path, "V1_LEAF_HAS_CHILDREN", `<${element.name}> must contain text only.`);
    return undefined;
  }
  const value = element.textParts.join("").trim();
  if (required && value === "") {
    invalid(context, path, "V1_REQUIRED_VALUE_EMPTY", `<${element.name}> cannot be empty.`);
    return undefined;
  }
  return value === "" ? undefined : value;
}

function reportRootNodes(context: ParseContext, root: XmlElement): void {
  const indexes = new Map<string, number>();
  for (const node of root.children) {
    const index = indexes.get(node.name) ?? 0;
    indexes.set(node.name, index + 1);
    if (CORE_ROOT_ELEMENTS.has(node.name)) continue;
    const path = `$.Project.${node.name}[${index}]`;
    reportUnmappedNode(
      context,
      node,
      path,
      KNOWN_UNMAPPED_ROOT_ELEMENTS.has(node.name)
        ? "V1_UNMAPPED_XML_NODE"
        : "V1_UNKNOWN_XML_NODE",
    );
  }
}

function parseV1MaskingParameter(
  context: ParseContext,
  root: XmlElement,
): ParsedV1MaskingParameter | undefined {
  const nodes = childElements(root, "MaskingParameter");
  if (nodes.length === 0) return undefined;
  const path = "$.Project.MaskingParameter[0]";
  if (nodes.length > 1) {
    invalid(
      context,
      "$.Project.MaskingParameter",
      "V1_DUPLICATE_ELEMENT",
      `Expected at most one <MaskingParameter> element, found ${nodes.length}.`,
    );
  }

  const node = nodes[0]!;
  const diagnosticStart = context.diagnostics.length;
  const typeNode = requiredElement(context, node, "Type", `${path}.Type`);
  const rawType = typeNode
    ? readRoiLeaf(context, typeNode, `${path}.Type`, true)
    : undefined;
  if (!rawType) return undefined;
  const type = rawType.trim().toLocaleLowerCase("en-US");

  if (type === "not set") {
    if (!isNoopMaskingParameter(node)) {
      unsupportedRoi(
        context,
        path,
        "V1_ROI_STRUCTURE_UNSUPPORTED",
        "Only the verified disabled masking form <MaskingParameter><Type>Not set</Type></MaskingParameter> is supported.",
      );
    } else {
      reportPreservedNoopMasking(context, node, path);
    }
    return { roi: { mode: "none" }, roiMode: "no" };
  }

  if (type !== "simple") {
    unsupportedRoi(
      context,
      `${path}.Type`,
      "V1_ROI_TYPE_UNSUPPORTED",
      `Active V1 ROI type '${rawType}' has no verified cross-version mapping.`,
      { roiType: rawType },
    );
    return { roiMode: rawType };
  }

  const roi = parseV1SimpleRectangleRoi(context, node, path);
  const blocked = context.diagnostics
    .slice(diagnosticStart)
    .some((diagnostic) => diagnostic.disposition === "block");
  if (!roi || blocked) return { roiMode: "simple" };
  compatibility(context, {
    code: "V1_SIMPLE_RECTANGLE_ROI_MAPPED",
    severity: "info",
    disposition: "rebuild",
    path,
    message: "V1 Simple Rectangle ROI is mapped as normalized image boundaries.",
    details: {
      left: roi.left,
      top: roi.top,
      right: roi.right,
      bottom: roi.bottom,
    },
  });
  return { roi, roiMode: "simple" };
}

function parseV1SimpleRectangleRoi(
  context: ParseContext,
  node: XmlElement,
  path: string,
): Extract<ProjectRoiIR, { readonly mode: "simple" }> | undefined {
  reportUnsupportedRoiAttributes(context, node, new Set(), path);
  reportUnsupportedRoiChildren(
    context,
    node,
    new Set(["Type", "RoiRectangle", "RoiSetting", "BlindGroup"]),
    path,
  );

  const rectangle = requiredElement(
    context,
    node,
    "RoiRectangle",
    `${path}.RoiRectangle`,
  );
  const setting = requiredElement(
    context,
    node,
    "RoiSetting",
    `${path}.RoiSetting`,
  );
  const blindGroup = requiredElement(
    context,
    node,
    "BlindGroup",
    `${path}.BlindGroup`,
  );

  const geometry = rectangle
    ? parseV1RoiRectangle(context, rectangle, `${path}.RoiRectangle`)
    : undefined;
  if (setting) {
    validateDefaultV1RoiSetting(context, setting, `${path}.RoiSetting`);
  }
  if (blindGroup) {
    validateDefaultV1BlindGroup(context, blindGroup, `${path}.BlindGroup`);
  }

  if (!geometry) return undefined;
  return {
    mode: "simple",
    shape: "rectangle",
    ...geometry,
  };
}

function parseV1RoiRectangle(
  context: ParseContext,
  node: XmlElement,
  path: string,
):
  | {
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
    }
  | undefined {
  reportUnsupportedRoiAttributes(
    context,
    node,
    new Set(["X", "Y", "Width", "Height", "Shape"]),
    path,
  );
  reportUnsupportedRoiChildren(context, node, new Set(), path);
  rejectRoiElementText(context, node, path);

  const x = parseFiniteRoiNumber(
    context,
    requiredRoiAttribute(context, node, "X", `${path}.@X`),
    `${path}.@X`,
  );
  const y = parseFiniteRoiNumber(
    context,
    requiredRoiAttribute(context, node, "Y", `${path}.@Y`),
    `${path}.@Y`,
  );
  const width = parseFiniteRoiNumber(
    context,
    requiredRoiAttribute(context, node, "Width", `${path}.@Width`),
    `${path}.@Width`,
  );
  const height = parseFiniteRoiNumber(
    context,
    requiredRoiAttribute(context, node, "Height", `${path}.@Height`),
    `${path}.@Height`,
  );
  const shape = requiredRoiAttribute(
    context,
    node,
    "Shape",
    `${path}.@Shape`,
  );
  const shapeSupported =
    shape?.trim().toLocaleLowerCase("en-US") === "rectangle";
  if (shape !== undefined && !shapeSupported) {
    unsupportedRoi(
      context,
      `${path}.@Shape`,
      "V1_ROI_SHAPE_UNSUPPORTED",
      `V1 ROI shape '${shape}' is not supported; only Rectangle is verified.`,
      { shape },
    );
  }

  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    !shapeSupported
  ) {
    return undefined;
  }
  const right = x + width;
  const bottom = y + height;
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    right > 1 ||
    bottom > 1
  ) {
    invalid(
      context,
      path,
      "V1_ROI_BOUNDS_INVALID",
      "V1 ROI rectangle must have positive area and remain inside normalized image bounds.",
      { x, y, width, height, right, bottom },
    );
    return undefined;
  }
  return { left: x, top: y, right, bottom };
}

function validateDefaultV1RoiSetting(
  context: ParseContext,
  node: XmlElement,
  path: string,
): void {
  reportUnsupportedRoiAttributes(context, node, new Set(), path);
  reportUnsupportedRoiChildren(
    context,
    node,
    new Set(["Intensity", "Expansion", "Inversion", "Offset"]),
    path,
  );
  const intensity = requiredElement(context, node, "Intensity", `${path}.Intensity`);
  const expansion = requiredElement(context, node, "Expansion", `${path}.Expansion`);
  const inversion = requiredElement(context, node, "Inversion", `${path}.Inversion`);
  const offset = requiredElement(context, node, "Offset", `${path}.Offset`);

  if (intensity) {
    validateDefaultRoiAttributeElement(
      context,
      intensity,
      `${path}.Intensity`,
      { Min: 0, Max: 255 },
    );
  }
  if (expansion) {
    validateDefaultRoiAttributeElement(
      context,
      expansion,
      `${path}.Expansion`,
      { Value: 0 },
    );
  }
  if (inversion) {
    reportUnsupportedRoiAttributes(
      context,
      inversion,
      new Set(["Value"]),
      `${path}.Inversion`,
    );
    reportUnsupportedRoiChildren(context, inversion, new Set(), `${path}.Inversion`);
    rejectRoiElementText(context, inversion, `${path}.Inversion`);
    const value = requiredRoiAttribute(
      context,
      inversion,
      "Value",
      `${path}.Inversion.@Value`,
    );
    const parsed = parseRequiredBoolean(
      context,
      value,
      `${path}.Inversion.@Value`,
      "V1_ROI_SETTING_INVALID",
    );
    if (parsed === true) {
      unsupportedRoi(
        context,
        `${path}.Inversion.@Value`,
        "V1_ROI_SETTING_UNSUPPORTED",
        "Only the verified default ROI inversion value False is supported.",
        { value: true },
      );
    }
  }
  if (offset) {
    validateDefaultRoiAttributeElement(
      context,
      offset,
      `${path}.Offset`,
      { Left: 100, Right: 100, Top: 100, Bottom: 100 },
    );
  }
}

function validateDefaultV1BlindGroup(
  context: ParseContext,
  node: XmlElement,
  path: string,
): void {
  reportUnsupportedRoiAttributes(context, node, new Set(), path);
  reportUnsupportedRoiChildren(
    context,
    node,
    new Set(["NumberOfBlinds"]),
    path,
  );
  const countText = requiredRoiLeaf(
    context,
    node,
    "NumberOfBlinds",
    `${path}.NumberOfBlinds`,
  );
  const count = parseNonNegativeInteger(
    context,
    countText,
    `${path}.NumberOfBlinds`,
    "V1_ROI_BLIND_COUNT_INVALID",
  );
  if (count !== undefined && count !== 0) {
    unsupportedRoi(
      context,
      `${path}.NumberOfBlinds`,
      "V1_ROI_BLINDS_UNSUPPORTED",
      "V1 ROI blind regions are not yet supported.",
      { numberOfBlinds: count },
    );
  }
}

function validateDefaultRoiAttributeElement(
  context: ParseContext,
  node: XmlElement,
  path: string,
  expected: Readonly<Record<string, number>>,
): void {
  reportUnsupportedRoiAttributes(context, node, new Set(Object.keys(expected)), path);
  reportUnsupportedRoiChildren(context, node, new Set(), path);
  rejectRoiElementText(context, node, path);
  for (const [name, expectedValue] of Object.entries(expected)) {
    const attributePath = `${path}.@${name}`;
    const raw = requiredRoiAttribute(context, node, name, attributePath);
    const value = parseFiniteRoiNumber(context, raw, attributePath);
    if (value !== undefined && value !== expectedValue) {
      unsupportedRoi(
        context,
        attributePath,
        "V1_ROI_SETTING_UNSUPPORTED",
        `Only the verified default ROI ${name} value ${expectedValue} is supported.`,
        { expected: expectedValue, actual: value },
      );
    }
  }
}

function requiredRoiLeaf(
  context: ParseContext,
  parent: XmlElement,
  name: string,
  path: string,
): string | undefined {
  const element = requiredElement(context, parent, name, path);
  return element ? readRoiLeaf(context, element, path, true) : undefined;
}

function readRoiLeaf(
  context: ParseContext,
  element: XmlElement,
  path: string,
  required: boolean,
): string | undefined {
  reportUnsupportedRoiAttributes(context, element, new Set(), path);
  if (element.children.length > 0) {
    invalid(context, path, "V1_LEAF_HAS_CHILDREN", `<${element.name}> must contain text only.`);
    return undefined;
  }
  const value = element.textParts.join("").trim();
  if (required && value === "") {
    invalid(context, path, "V1_REQUIRED_VALUE_EMPTY", `<${element.name}> cannot be empty.`);
    return undefined;
  }
  return value === "" ? undefined : value;
}

function requiredRoiAttribute(
  context: ParseContext,
  node: XmlElement,
  name: string,
  path: string,
): string | undefined {
  const value = node.attributes.get(name);
  if (value === undefined || value.trim() === "") {
    invalid(
      context,
      path,
      "V1_ROI_ATTRIBUTE_MISSING",
      `Required ROI attribute '${name}' is missing or empty.`,
    );
    return undefined;
  }
  return value;
}

function parseFiniteRoiNumber(
  context: ParseContext,
  value: string | undefined,
  path: string,
): number | undefined {
  if (
    value === undefined ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  ) {
    if (value !== undefined) {
      invalid(context, path, "V1_ROI_NUMBER_INVALID", "ROI values must be finite numbers.");
    }
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    invalid(context, path, "V1_ROI_NUMBER_INVALID", "ROI value is outside the safe numeric range.");
    return undefined;
  }
  return number;
}

function reportUnsupportedRoiAttributes(
  context: ParseContext,
  element: XmlElement,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const [name, value] of element.attributes) {
    if (known.has(name)) continue;
    unsupportedRoi(
      context,
      `${path}.@${name}`,
      "V1_ROI_STRUCTURE_UNSUPPORTED",
      `ROI attribute '${name}' on <${element.name}> has no verified mapping.`,
      { nodeName: element.name, attributeName: name, value },
    );
  }
}

function reportUnsupportedRoiChildren(
  context: ParseContext,
  parent: XmlElement,
  known: ReadonlySet<string>,
  path: string,
): void {
  const indexes = new Map<string, number>();
  for (const node of parent.children) {
    const index = indexes.get(node.name) ?? 0;
    indexes.set(node.name, index + 1);
    if (known.has(node.name)) continue;
    unsupportedRoi(
      context,
      `${path}.${node.name}[${index}]`,
      "V1_ROI_STRUCTURE_UNSUPPORTED",
      `ROI node <${node.name}> has no verified mapping.`,
      { nodeName: node.name },
    );
  }
}

function rejectRoiElementText(
  context: ParseContext,
  node: XmlElement,
  path: string,
): void {
  if (node.textParts.join("").trim() !== "") {
    invalid(
      context,
      path,
      "V1_ROI_ELEMENT_TEXT_INVALID",
      `<${node.name}> must not contain text.`,
    );
  }
}

function unsupportedRoi(
  context: ParseContext,
  path: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): void {
  compatibility(context, {
    code,
    severity: "error",
    disposition: "block",
    path,
    message,
    ...(details ? { details } : {}),
  });
}

function isNoopMaskingParameter(node: XmlElement): boolean {
  if (node.attributes.size > 0 || node.children.length !== 1) return false;
  const type = node.children[0];
  return Boolean(
    type &&
      type.name === "Type" &&
      type.attributes.size === 0 &&
      type.children.length === 0 &&
      type.textParts.join("").trim().toLocaleLowerCase("en-US") === "not set",
  );
}

function reportPreservedNoopMasking(
  context: ParseContext,
  node: XmlElement,
  path: string,
): void {
  if (projectDiagnosticsAreTruncated(context.diagnostics)) return;
  const completeOuterXml = context.source.slice(node.start, node.end);
  const outerXml = completeOuterXml.slice(0, 1024);
  const details: Record<string, JsonValue> = {
    nodeName: node.name,
    outerXml,
    truncated: completeOuterXml.length > outerXml.length,
    mappedRoiMode: "no",
  };
  if (context.unknownNodes.length < PROJECT_DIAGNOSTIC_MAX_COUNT) {
    context.unknownNodes.push({ path, ...details });
  }
  compatibility(context, {
    code: "V1_MASKING_NOT_SET",
    severity: "info",
    disposition: "preserve",
    path,
    message: "V1 masking is not enabled; the V2 project will use roiMode 'no'.",
    details,
  });
}

function reportUnknownChildren(
  context: ParseContext,
  parent: XmlElement,
  known: ReadonlySet<string>,
  parentPath: string,
): void {
  const indexes = new Map<string, number>();
  for (const node of parent.children) {
    const index = indexes.get(node.name) ?? 0;
    indexes.set(node.name, index + 1);
    if (known.has(node.name)) continue;
    reportUnmappedNode(
      context,
      node,
      `${parentPath}.${node.name}[${index}]`,
      "V1_UNKNOWN_XML_NODE",
    );
  }
}

function reportUnmappedNode(
  context: ParseContext,
  node: XmlElement,
  path: string,
  code: string,
): void {
  if (projectDiagnosticsAreTruncated(context.diagnostics)) return;
  const completeOuterXml = context.source.slice(node.start, node.end);
  const outerXml = completeOuterXml.slice(0, 1024);
  const details: Record<string, JsonValue> = {
    nodeName: node.name,
    outerXml,
    truncated: completeOuterXml.length > outerXml.length,
  };
  if (context.unknownNodes.length < PROJECT_DIAGNOSTIC_MAX_COUNT) {
    context.unknownNodes.push({ path, ...details });
  }
  compatibility(context, {
    code,
    severity: "warning",
    disposition: "drop",
    path,
    message: `XML node <${node.name}> is retained for diagnostics but has no current cross-version mapping.`,
    details,
  });
}

function reportUnknownAttributes(
  context: ParseContext,
  element: XmlElement,
  path: string,
): void {
  reportUnknownAttributesExcept(context, element, new Set(), path);
}

function reportUnknownAttributesExcept(
  context: ParseContext,
  element: XmlElement,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const [name, value] of element.attributes) {
    if (known.has(name)) continue;
    if (projectDiagnosticsAreTruncated(context.diagnostics)) break;
    const attributePath = `${path}.@${name}`;
    const details: Record<string, JsonValue> = {
      nodeName: element.name,
      attributeName: name,
      value,
    };
    if (context.unknownNodes.length < PROJECT_DIAGNOSTIC_MAX_COUNT) {
      context.unknownNodes.push({ path: attributePath, ...details });
    }
    compatibility(context, {
      code: "V1_UNKNOWN_XML_ATTRIBUTE",
      severity: "warning",
      disposition: "drop",
      path: attributePath,
      message: `XML attribute '${name}' on <${element.name}> has no current mapping.`,
      details,
    });
  }
}

function invalid(
  context: ParseContext,
  path: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): void {
  addDiagnostic(context, {
    code,
    category: "validation",
    severity: "error",
    disposition: "block",
    path,
    message,
    ...(details ? { details } : {}),
  });
}

function compatibility(
  context: ParseContext,
  input: Omit<ProjectDiagnostic, "category">,
): void {
  addDiagnostic(context, { category: "compatibility", ...input });
}

function resourceLimit(
  context: ParseContext,
  path: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): void {
  addDiagnostic(context, {
    code,
    category: "security",
    severity: "error",
    disposition: "block",
    path,
    message,
    ...(details ? { details } : {}),
  });
}

function addDiagnostic(context: ParseContext, diagnostic: ProjectDiagnostic): void {
  appendBoundedProjectDiagnostic(context.diagnostics, diagnostic);
}

function hasFatalValidation(diagnostics: readonly ProjectDiagnostic[]): boolean {
  return diagnostics.some(
    (item) =>
      item.severity === "error" &&
      (item.category === "validation" || item.category === "security"),
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
    target: "v2",
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

function childElements(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((child) => child.name === name);
}

function deriveProjectName(fileName: string | undefined): string {
  if (!fileName) return "Untitled";
  const leaf = normalizeSlashes(fileName).split("/").filter(Boolean).at(-1) ?? "";
  const withoutExtension = leaf.replace(/\.srproj$/i, "").trim();
  return withoutExtension || "Untitled";
}

function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseV1DateAsUtcMilliseconds(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  const milliseconds = Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5],
  );
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== parts[0] ||
    date.getUTCMonth() !== parts[1] - 1 ||
    date.getUTCDate() !== parts[2] ||
    date.getUTCHours() !== parts[3] ||
    date.getUTCMinutes() !== parts[4] ||
    date.getUTCSeconds() !== parts[5]
  ) {
    return undefined;
  }
  return milliseconds;
}

function parseXml(source: string): XmlElement {
  if (/<!DOCTYPE\b/i.test(source) || /<!ENTITY\b/i.test(source)) {
    throw new XmlSyntaxError(
      "V1_XML_DECLARATION_FORBIDDEN",
      "DOCTYPE and custom entity declarations are forbidden in .srproj input.",
      Math.max(0, source.search(/<!(?:DOCTYPE|ENTITY)\b/i)),
      "security",
    );
  }

  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let nodeCount = 0;
  let attributeCount = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening < 0) {
      appendXmlText(source.slice(cursor), cursor, stack);
      cursor = source.length;
      break;
    }
    appendXmlText(source.slice(cursor, opening), cursor, stack);

    if (source.startsWith("<!--", opening)) {
      const end = source.indexOf("-->", opening + 4);
      if (end < 0) throw xmlError("Unterminated XML comment.", opening);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", opening)) {
      if (stack.length === 0) throw xmlError("CDATA is not allowed outside the root element.", opening);
      const end = source.indexOf("]]>", opening + 9);
      if (end < 0) throw xmlError("Unterminated CDATA section.", opening);
      stack.at(-1)!.textParts.push(source.slice(opening + 9, end));
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", opening)) {
      const end = source.indexOf("?>", opening + 2);
      if (end < 0) throw xmlError("Unterminated processing instruction.", opening);
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", opening)) {
      throw new XmlSyntaxError(
        "V1_XML_DECLARATION_FORBIDDEN",
        "XML declarations other than the XML header, comments, and CDATA are forbidden.",
        opening,
        "security",
      );
    }

    const close = findTagEnd(source, opening + 1);
    const token = source.slice(opening + 1, close);
    if (token.startsWith("/")) {
      const closingName = token.slice(1).trim();
      if (!isXmlName(closingName)) throw xmlError("Invalid XML closing tag.", opening);
      const current = stack.pop();
      if (!current || current.name !== closingName) {
        throw xmlError(`Mismatched closing tag </${closingName}>.`, opening);
      }
      current.end = close + 1;
      cursor = close + 1;
      continue;
    }

    const parsed = parseStartTag(
      token,
      opening,
      V1_PROJECT_LIMITS.maxAttributes - attributeCount,
      V1_PROJECT_LIMITS.maxAttributesPerElement,
    );
    nodeCount += 1;
    if (nodeCount > V1_PROJECT_LIMITS.maxNodes) {
      throw xmlLimitError(
        "V1_XML_NODE_LIMIT_EXCEEDED",
        `XML element count exceeds ${V1_PROJECT_LIMITS.maxNodes}.`,
        opening,
      );
    }
    attributeCount += parsed.attributes.size;
    const node: XmlElement = {
      name: parsed.name,
      attributes: parsed.attributes,
      children: [],
      textParts: [],
      start: opening,
      end: close + 1,
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);

    const nodeDepth = stack.length + 1;
    if (nodeDepth > PROJECT_STRUCTURE_MAX_DEPTH) {
      throw xmlLimitError(
        "V1_XML_DEPTH_LIMIT_EXCEEDED",
        `XML nesting exceeds ${PROJECT_STRUCTURE_MAX_DEPTH} levels.`,
        opening,
      );
    }
    if (!parsed.selfClosing) {
      stack.push(node);
    }
    cursor = close + 1;
  }

  if (stack.length > 0) {
    throw xmlError(`Unclosed XML element <${stack.at(-1)!.name}>.`, stack.at(-1)!.start);
  }
  if (roots.length !== 1) {
    throw xmlError(`Expected exactly one XML root element, found ${roots.length}.`, 0);
  }
  return roots[0];
}

function appendXmlText(text: string, offset: number, stack: XmlElement[]): void {
  if (text === "") return;
  const decoded = decodeXmlEntities(text, offset);
  const current = stack.at(-1);
  if (!current) {
    if (decoded.trim() !== "") throw xmlError("Text is not allowed outside the XML root.", offset);
    return;
  }
  current.textParts.push(decoded);
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw xmlError("Unterminated XML tag.", start - 1);
}

function parseStartTag(
  token: string,
  offset: number,
  remainingAttributeBudget: number,
  perElementAttributeBudget: number,
): {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
} {
  let source = token.trim();
  let selfClosing = false;
  if (source.endsWith("/")) {
    selfClosing = true;
    source = source.slice(0, -1).trimEnd();
  }
  const nameMatch = /^([^\s/>]+)/.exec(source);
  if (!nameMatch || !isXmlName(nameMatch[1])) throw xmlError("Invalid XML start tag.", offset);
  const name = nameMatch[1];
  const attributes = new Map<string, string>();
  let cursor = name.length;

  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    const attributeMatch = /^([^\s=/>]+)/.exec(source.slice(cursor));
    if (!attributeMatch || !isXmlName(attributeMatch[1])) throw xmlError("Invalid XML attribute name.", offset + cursor);
    const attributeName = attributeMatch[1];
    if (attributes.has(attributeName)) throw xmlError(`Duplicate XML attribute '${attributeName}'.`, offset + cursor);
    cursor += attributeName.length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") throw xmlError(`Attribute '${attributeName}' is missing '='.`, offset + cursor);
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") throw xmlError(`Attribute '${attributeName}' must be quoted.`, offset + cursor);
    const valueStart = cursor + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) throw xmlError(`Attribute '${attributeName}' is unterminated.`, offset + cursor);
    if (attributes.size >= perElementAttributeBudget) {
      throw xmlLimitError(
        "V1_XML_ELEMENT_ATTRIBUTE_LIMIT_EXCEEDED",
        `One XML element contains more than ${perElementAttributeBudget} attributes.`,
        offset + cursor,
      );
    }
    if (attributes.size >= remainingAttributeBudget) {
      throw xmlLimitError(
        "V1_XML_ATTRIBUTE_LIMIT_EXCEEDED",
        `XML attribute count exceeds ${V1_PROJECT_LIMITS.maxAttributes}.`,
        offset + cursor,
      );
    }
    const value = decodeXmlEntities(source.slice(valueStart, valueEnd), offset + valueStart);
    attributes.set(attributeName, value);
    cursor = valueEnd + 1;
  }
  return { name, attributes, selfClosing };
}

function decodeXmlEntities(value: string, offset: number): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf("&", cursor);
    if (ampersand < 0) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, ampersand);
    const semicolon = value.indexOf(";", ampersand + 1);
    if (semicolon < 0) throw xmlError("Unterminated XML entity reference.", offset + ampersand);
    const entity = value.slice(ampersand + 1, semicolon);
    let decoded: string | undefined;
    switch (entity) {
      case "amp": decoded = "&"; break;
      case "lt": decoded = "<"; break;
      case "gt": decoded = ">"; break;
      case "quot": decoded = '"'; break;
      case "apos": decoded = "'"; break;
      default: {
        const match = /^#(x[\da-f]+|\d+)$/i.exec(entity);
        if (match) {
          const codePoint = match[1].toLocaleLowerCase().startsWith("x")
            ? Number.parseInt(match[1].slice(1), 16)
            : Number.parseInt(match[1], 10);
          if (isLegalXmlCodePoint(codePoint)) decoded = String.fromCodePoint(codePoint);
        }
      }
    }
    if (decoded === undefined) throw xmlError(`Unsupported or invalid XML entity '&${entity};'.`, offset + ampersand);
    result += decoded;
    cursor = semicolon + 1;
  }
  assertLegalXmlText(result, offset);
  return result;
}

function assertLegalXmlText(value: string, offset: number): void {
  for (const character of value) {
    if (!isLegalXmlCodePoint(character.codePointAt(0)!)) {
      throw xmlError("XML contains a character forbidden by XML 1.0.", offset);
    }
  }
}

function isLegalXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function isXmlName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value);
}

function xmlError(message: string, offset: number): XmlSyntaxError {
  return new XmlSyntaxError("V1_INVALID_XML", message, Math.max(0, offset));
}

function xmlLimitError(code: string, message: string, offset: number): XmlSyntaxError {
  return new XmlSyntaxError(code, message, Math.max(0, offset), "security");
}
