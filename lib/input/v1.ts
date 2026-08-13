import type {
  CompatibilityDisposition,
  CompatibilitySummary,
  JsonObject,
  JsonValue,
  ProjectClassIR,
  ProjectDiagnostic,
  ProjectFileIR,
  ProjectIR,
  ProjectParseResult,
  ProjectSplitIR,
  ProjectType,
  SplitType,
} from "../model/project.ts";
import {
  appendBoundedProjectDiagnostic,
  exceedsUtf8ByteLimit,
  PROJECT_DIAGNOSTIC_MAX_COUNT,
  PROJECT_PATH_MAX_BYTES,
  PROJECT_STRUCTURE_MAX_DEPTH,
  projectDiagnosticsAreTruncated,
  PROJECT_TEXT_MAX_BYTES,
  V1_PROJECT_LIMITS,
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
]);

// These nodes occur in verified V1 files, but this adapter deliberately does
// not map their training/runtime settings into the cross-version IR.
const KNOWN_UNMAPPED_ROOT_ELEMENTS = new Set([
  "MaskingParameter",
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
  if (type !== "classification") {
    compatibility(context, {
      code: "V1_PROJECT_TYPE_UNSUPPORTED",
      severity: "error",
      disposition: "block",
      path: "$.Project.Type",
      message:
        type === "unknown"
          ? `V1 project type '${rawType}' is unknown.`
          : `V1 ${rawType} parsing currently preserves only the common project skeleton; its labels are not mapped.`,
      details: { rawProjectType: rawType },
    });
  }

  const classesResult = parseClasses(context, classGroup);
  if (!classesResult) return failure(context.diagnostics);

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
      ...(hasNoopMaskingParameter(root) ? { roiMode: "no" } : {}),
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

  for (const [index, node] of imageNodes.entries()) {
    const imagePath = `${path}.Image[${index}]`;
    reportUnknownAttributes(context, node, imagePath);
    reportUnknownChildren(
      context,
      node,
      new Set(["Path", "Width", "Height", "SplitState", "ClassIndexOfLabel"]),
      imagePath,
    );

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

    if (!sourcePath || !rawSplit || !split) continue;
    if (projectType === "classification" && classificationClassIndex === undefined) {
      continue;
    }

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
          : undefined,
      ...(classificationClassIndex !== undefined
        ? { classificationClassIndex }
        : {}),
      splits,
      canonicalSplit: split,
      labels:
        classificationClassIndex === undefined
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
    if (node.name === "MaskingParameter" && isNoopMaskingParameter(node)) {
      reportPreservedNoopMasking(context, node, path);
      continue;
    }
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

function hasNoopMaskingParameter(root: XmlElement): boolean {
  return root.children.some(
    (node) => node.name === "MaskingParameter" && isNoopMaskingParameter(node),
  );
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
  for (const [name, value] of element.attributes) {
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
    const value = decodeXmlEntities(source.slice(valueStart, valueEnd), offset + valueStart);
    attributes.set(attributeName, value);
    if (attributes.size > remainingAttributeBudget) {
      throw xmlLimitError(
        "V1_XML_ATTRIBUTE_LIMIT_EXCEEDED",
        `XML attribute count exceeds ${V1_PROJECT_LIMITS.maxAttributes}.`,
        offset + cursor,
      );
    }
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
