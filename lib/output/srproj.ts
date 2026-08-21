import type {
  ContourRingRole,
  JsonObject,
  PointIR,
  ProjectClassIR,
  ProjectFileIR,
  ProjectIR,
  ProjectLabelIR,
  ProjectRoiIR,
  SplitType,
} from "../model/project.ts";
import { APP_VERSION, isSupportedProjectType } from "../release.ts";
import {
  countProjectContourPoints,
  exceedsUtf8ByteLimit,
  PROJECT_TEXT_MAX_BYTES,
  V1_PROJECT_LIMITS,
  V2_PROJECT_LIMITS,
} from "../security/resourceLimits.ts";

export interface SrprojWriteOptions {
  /** V1 schema version is intentionally pinned to the verified golden version. */
  readonly version?: "0.9";
  /** Overrides a preserved V1 ModifiedDate. No current-time value is generated. */
  readonly modifiedDate?: string;
  /** Required when archive-backed images need durable paths in the V1 project. */
  readonly pathForFile?: (file: ProjectFileIR, outputIndex: number) => string;
  readonly lineEnding?: "\n" | "\r\n";
  /** Required only when the parser reported acknowledged, non-blocking loss. */
  readonly allowConfirmedLoss?: boolean;
}

export class SrprojWriteError extends Error {
  readonly name = "SrprojWriteError";
  readonly code: string;
  readonly path: string;

  constructor(
    code: string,
    path: string,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

/**
 * Serialize a verified Classification or polygon Segmentation ProjectIR as
 * deterministic V1 XML.
 * User-controlled values are always emitted as escaped XML text nodes.
 */
export function writeSrproj(
  project: ProjectIR,
  options: SrprojWriteOptions = {},
): string {
  assertWriterCompatibility(project, "v1", options.allowConfirmedLoss ?? false);
  if (!isSupportedProjectType(project.project.type)) {
    throw new SrprojWriteError(
      "SRPROJ_PROJECT_TYPE_UNSUPPORTED",
      "$.project.type",
      `v${APP_VERSION} supports only Classification and polygon Segmentation; received '${project.project.rawType}'.`,
    );
  }
  const totalContourPoints = countProjectContourPoints(project);
  if (totalContourPoints > V2_PROJECT_LIMITS.maxContourPoints) {
    throw new SrprojWriteError(
      "SRPROJ_CONTOUR_POINT_LIMIT_EXCEEDED",
      "$.files[*].labels[*].geometry.contours",
      `Total contour point count exceeds ${V2_PROJECT_LIMITS.maxContourPoints}.`,
    );
  }

  const lineEnding = options.lineEnding ?? "\n";
  const structuralOkClassIndex =
    project.project.type === "segmentation"
      ? structuralSegmentationOkClassIndex(project)
      : undefined;
  const classes = orderAndValidateClasses(
    project.classes.filter((item) => item.index !== structuralOkClassIndex),
  );
  const files = orderAndValidateFiles(project.files);
  const outputClassIndex = new Map<number, number>();
  classes.forEach((item, index) => outputClassIndex.set(item.index, index));

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Project>",
    `  <Version>${escapeXmlText(options.version ?? "0.9", "$.Version")}</Version>`,
    `  <Type>${project.project.type === "segmentation" ? "Segmentation" : "Classification"}</Type>`,
  ];

  const modifiedDate =
    options.modifiedDate ??
    rawString(project.project.raw, "modifiedDate") ??
    formatV1Date(project.project.modifiedAt);
  if (modifiedDate !== undefined) {
    lines.push(
      `  <ModifiedDate>${escapeXmlText(modifiedDate, "$.ModifiedDate")}</ModifiedDate>`,
    );
  }

  lines.push("  <ClassGroup>", `    <NumberOfClasses>${classes.length}</NumberOfClasses>`);
  for (const [outputIndex, item] of classes.entries()) {
    const path = `$.classes[${outputIndex}]`;
    const name = requiredText(item.name, `${path}.name`, "SRPROJ_CLASS_NAME_INVALID");
    const color = colorToV1Integer(item.color, outputIndex, `${path}.color`);
    lines.push(
      "    <Class>",
      `      <Name>${escapeXmlText(name, `${path}.name`)}</Name>`,
      `      <Color>${color}</Color>`,
      "    </Class>",
    );
  }
  lines.push("  </ClassGroup>", "  <ImageGroup>", `    <NumberOfImages>${files.length}</NumberOfImages>`);

  for (const [outputIndex, file] of files.entries()) {
    const path = `$.files[${outputIndex}]`;
    const sourcePath = resolveOutputPath(file, outputIndex, options);
    const split = splitToV1(file.canonicalSplit, `${path}.canonicalSplit`);
    lines.push(
      "    <Image>",
      `      <Path>${escapeXmlText(sourcePath, `${path}.sourcePath`)}</Path>`,
    );
    if (file.width !== undefined) {
      lines.push(`      <Width>${positiveInteger(file.width, `${path}.width`)}</Width>`);
    }
    if (file.height !== undefined) {
      lines.push(`      <Height>${positiveInteger(file.height, `${path}.height`)}</Height>`);
    }
    lines.push(`      <SplitState>${split}</SplitState>`);
    if (project.project.type === "classification") {
      const sourceClassIndex = resolveClassificationClassIndex(file, path);
      const classIndex = outputClassIndex.get(sourceClassIndex);
      if (classIndex === undefined) {
        throw new SrprojWriteError(
          "SRPROJ_CLASS_REFERENCE_INVALID",
          `${path}.classificationClassIndex`,
          `Classification label references missing canonical class index ${sourceClassIndex}.`,
        );
      }
      lines.push(`      <ClassIndexOfLabel>${classIndex}</ClassIndexOfLabel>`);
    } else {
      appendSegmentationLabelGroup(
        lines,
        file,
        path,
        outputClassIndex,
        structuralOkClassIndex,
      );
    }
    lines.push("    </Image>");
  }

  lines.push("  </ImageGroup>");
  appendMaskingParameter(lines, project.project.roi, project.project.roiMode);
  lines.push("</Project>", "");
  const xml = lines.join(lineEnding);
  assertGeneratedXmlResourceLimits(xml);
  return xml;
}

function appendMaskingParameter(
  lines: string[],
  roi: ProjectRoiIR | undefined,
  legacyRoiMode: string | undefined,
): void {
  const legacyMode = normalizeLegacyRoiMode(legacyRoiMode);
  if (!roi) {
    if (legacyMode === "simple" || legacyMode === "other") {
      throw new SrprojWriteError(
        "SRPROJ_ROI_MAPPING_REQUIRED",
        "$.project.roi",
        "An active legacy roiMode requires verified structured ROI geometry before V1 output.",
      );
    }
    if (legacyMode === "none") appendDisabledMaskingParameter(lines);
    return;
  }

  const runtimeMode: unknown = (roi as { readonly mode?: unknown }).mode;
  if (runtimeMode !== "none" && runtimeMode !== "simple") {
    throw new SrprojWriteError(
      "SRPROJ_ROI_UNSUPPORTED",
      "$.project.roi.mode",
      "Only disabled ROI and a verified Simple Rectangle ROI can be written to V1.",
    );
  }
  if (
    legacyMode !== undefined &&
    (legacyMode === "other" || legacyMode !== runtimeMode)
  ) {
    throw new SrprojWriteError(
      "SRPROJ_ROI_MODE_CONFLICT",
      "$.project.roiMode",
      "The legacy ROI mode conflicts with the normalized ROI model.",
    );
  }

  if (roi.mode === "none") {
    appendDisabledMaskingParameter(lines);
    return;
  }

  if (roi.mode !== "simple" || roi.shape !== "rectangle") {
    throw new SrprojWriteError(
      "SRPROJ_ROI_UNSUPPORTED",
      "$.project.roi",
      "Only a verified Simple Rectangle ROI can be written to V1.",
    );
  }

  const left = normalizedRoiBoundary(roi.left, "$.project.roi.left");
  const top = normalizedRoiBoundary(roi.top, "$.project.roi.top");
  const right = normalizedRoiBoundary(roi.right, "$.project.roi.right");
  const bottom = normalizedRoiBoundary(roi.bottom, "$.project.roi.bottom");
  if (right <= left || bottom <= top) {
    throw new SrprojWriteError(
      "SRPROJ_ROI_BOUNDS_INVALID",
      "$.project.roi",
      "ROI boundaries must describe a positive-area rectangle.",
    );
  }
  const width = right - left;
  const height = bottom - top;

  lines.push(
    "  <MaskingParameter>",
    "    <Type>Simple</Type>",
    `    <RoiRectangle X="${formatRoiNumber(left)}" Y="${formatRoiNumber(top)}" Width="${formatRoiNumber(width)}" Height="${formatRoiNumber(height)}" Shape="Rectangle" />`,
    "    <RoiSetting>",
    '      <Intensity Min="0" Max="255" />',
    '      <Expansion Value="0" />',
    '      <Inversion Value="False" />',
    '      <Offset Left="100" Right="100" Top="100" Bottom="100" />',
    "    </RoiSetting>",
    "    <BlindGroup>",
    "      <NumberOfBlinds>0</NumberOfBlinds>",
    "    </BlindGroup>",
    "  </MaskingParameter>",
  );
}

function normalizeLegacyRoiMode(
  value: string | undefined,
): "none" | "simple" | "other" | undefined {
  const mode = value?.trim().toLocaleLowerCase("en-US");
  if (!mode) return undefined;
  if (mode === "no" || mode === "none" || mode === "not set") return "none";
  return mode === "simple" ? "simple" : "other";
}

function appendDisabledMaskingParameter(lines: string[]): void {
  lines.push(
    "  <MaskingParameter>",
    "    <Type>Not set</Type>",
    "  </MaskingParameter>",
  );
}

function normalizedRoiBoundary(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new SrprojWriteError(
      "SRPROJ_ROI_BOUNDS_INVALID",
      path,
      "ROI boundaries must be finite normalized numbers between 0 and 1.",
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function formatRoiNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function assertGeneratedXmlResourceLimits(xml: string): void {
  if (exceedsUtf8ByteLimit(xml, PROJECT_TEXT_MAX_BYTES)) {
    throw new SrprojWriteError(
      "SRPROJ_XML_TEXT_LIMIT_EXCEEDED",
      "$",
      `Generated .srproj XML exceeds the ${PROJECT_TEXT_MAX_BYTES}-byte UTF-8 limit.`,
    );
  }

  let nodeCount = 0;
  let attributeCount = 0;
  for (let index = 0; index < xml.length; index += 1) {
    if (xml[index] !== "<") continue;
    const next = xml[index + 1];
    const closing = next === "/" || next === "?" || next === "!";
    const end = xml.indexOf(">", index + 1);
    if (end < 0) break;
    if (!closing) {
      nodeCount += 1;
      for (let cursor = index + 1; cursor < end - 1; cursor += 1) {
        if (xml[cursor] === "=" && xml[cursor + 1] === '"') {
          attributeCount += 1;
        }
      }
    }
    index = end;
  }

  if (nodeCount > V1_PROJECT_LIMITS.maxNodes) {
    throw new SrprojWriteError(
      "SRPROJ_XML_NODE_LIMIT_EXCEEDED",
      "$",
      `Generated .srproj XML contains ${nodeCount} elements; the safe limit is ${V1_PROJECT_LIMITS.maxNodes}.`,
    );
  }
  if (attributeCount > V1_PROJECT_LIMITS.maxAttributes) {
    throw new SrprojWriteError(
      "SRPROJ_XML_ATTRIBUTE_LIMIT_EXCEEDED",
      "$",
      `Generated .srproj XML contains ${attributeCount} attributes; the safe limit is ${V1_PROJECT_LIMITS.maxAttributes}.`,
    );
  }
}

function structuralSegmentationOkClassIndex(project: ProjectIR): number | undefined {
  if (
    project.source.format !== "v2-subvisionproj" &&
    project.source.format !== "v2-visionproj"
  ) {
    return undefined;
  }
  const candidates = project.classes.filter((item) => {
    const classNo = typeof item.raw.classNo === "number" ? item.raw.classNo : item.index;
    return (
      classNo === 0 &&
      item.name.trim().normalize("NFKC").toLocaleLowerCase("en-US") === "ok" &&
      item.isNg === false
    );
  });
  const defectClassesAreExplicit = project.classes.every(
    (item) => candidates.includes(item) || item.isNg === true,
  );
  return candidates.length === 1 && defectClassesAreExplicit
    ? candidates[0]!.index
    : undefined;
}

function appendSegmentationLabelGroup(
  lines: string[],
  file: ProjectFileIR,
  path: string,
  outputClassIndex: ReadonlyMap<number, number>,
  structuralOkClassIndex: number | undefined,
): void {
  const labels = [...file.labels].sort((left, right) => left.index - right.index);
  if (labels.some((label) => label.kind !== "contour")) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_LABEL_KIND_UNSUPPORTED",
      `${path}.labels`,
      "V1 Segmentation accepts polygon contour labels only.",
    );
  }
  const inferredNormal = inferSegmentationNormal(file, structuralOkClassIndex);
  if (inferredNormal && labels.length > 0) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_NORMAL_LABEL_CONFLICT",
      path,
      "A normal segmentation image cannot also contain defect contours.",
    );
  }
  if (file.isLabeled === false && (inferredNormal || labels.length > 0)) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_STATE_CONFLICT",
      `${path}.isLabeled`,
      "An explicitly unlabeled segmentation image cannot contain labels.",
    );
  }
  if (file.isLabeled === true && !inferredNormal && labels.length === 0) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_LABEL_MISSING",
      `${path}.labels`,
      "A labeled segmentation image must be normal or contain a contour label.",
    );
  }

  lines.push(
    "      <LabelGroup>",
    `        <IsNormal>${inferredNormal ? "true" : "false"}</IsNormal>`,
    `        <NumberOfLabels>${labels.length}</NumberOfLabels>`,
  );
  for (const [labelPosition, label] of labels.entries()) {
    appendSegmentationLabel(
      lines,
      label,
      `${path}.labels[${labelPosition}]`,
      outputClassIndex,
      structuralOkClassIndex,
    );
  }
  lines.push("      </LabelGroup>");
}

function inferSegmentationNormal(
  file: ProjectFileIR,
  structuralOkClassIndex: number | undefined,
): boolean {
  if (file.isNormal !== undefined) return file.isNormal;
  if (file.labels.length > 0 || structuralOkClassIndex === undefined) return false;
  const rawClassName =
    typeof file.raw.className === "string"
      ? file.raw.className.trim().toLocaleLowerCase("en-US")
      : "";
  return file.isLabeled === true && rawClassName === "ok";
}

function appendSegmentationLabel(
  lines: string[],
  label: ProjectLabelIR,
  path: string,
  outputClassIndex: ReadonlyMap<number, number>,
  structuralOkClassIndex: number | undefined,
): void {
  if (label.geometry.bitmap) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_BITMAP_UNSUPPORTED",
      `${path}.geometry.bitmap`,
      "Bitmap masks cannot be represented by the verified V1 contour schema.",
    );
  }
  if (label.classIndex === undefined || label.classIndex === structuralOkClassIndex) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_CLASS_REFERENCE_INVALID",
      `${path}.classIndex`,
      "A defect contour must reference a non-OK class.",
    );
  }
  const classIndex = outputClassIndex.get(label.classIndex);
  if (classIndex === undefined) {
    throw new SrprojWriteError(
      "SRPROJ_CLASS_REFERENCE_INVALID",
      `${path}.classIndex`,
      `Segmentation label references missing canonical class index ${label.classIndex}.`,
    );
  }
  const contours = label.geometry.contours;
  const roles = label.geometry.contourRoles;
  if (!contours?.length) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_CONTOUR_MISSING",
      `${path}.geometry.contours`,
      "A segmentation label requires at least one contour ring.",
    );
  }
  if (!roles || roles.length !== contours.length || roles.includes("unknown")) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_RING_ROLE_REQUIRED",
      `${path}.geometry.contourRoles`,
      "Every contour ring must be identified as outer or inner.",
    );
  }
  if (!roles.includes("outer")) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_OUTER_RING_REQUIRED",
      `${path}.geometry.contourRoles`,
      "A segmentation label requires at least one outer ring.",
    );
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
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_RING_ORDER_INVALID",
      `${path}.geometry.contourRoles[${leadingInnerIndex}]`,
      "Each inner contour must follow an outer contour in the same label.",
    );
  }

  lines.push(
    "        <Label>",
    `          <ClassIndex>${classIndex}</ClassIndex>`,
    "          <Type>Contours</Type>",
    "          <ContourGroup>",
  );
  contours.forEach((sourceRing, ringIndex) => {
    const role = roles[ringIndex]!;
    const ring = normalizeV1Ring(sourceRing, role, `${path}.geometry.contours[${ringIndex}]`);
    lines.push(`            <Contour Type="${role === "outer" ? "Outer" : "Inner"}">`);
    for (const point of ring) {
      lines.push(
        `              <Point X="${finiteXmlNumber(point.x, `${path}.geometry.contours[${ringIndex}].x`)}" Y="${finiteXmlNumber(point.y, `${path}.geometry.contours[${ringIndex}].y`)}" />`,
      );
    }
    lines.push("            </Contour>");
  });
  lines.push("          </ContourGroup>", "        </Label>");
}

function normalizeV1Ring(
  source: readonly PointIR[],
  role: ContourRingRole,
  path: string,
): PointIR[] {
  if (source.length < 3) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_CONTOUR_INVALID",
      path,
      "A contour ring requires at least three points.",
    );
  }
  const ring = source.map((point) => ({ x: point.x, y: point.y }));
  const area = signedRingArea(ring, path);
  const wantsPositiveArea = role === "inner";
  if ((area > 0) !== wantsPositiveArea) ring.reverse();
  return ring;
}

function signedRingArea(points: readonly PointIR[], path: string): number {
  let doubledArea = 0;
  for (const [index, point] of points.entries()) {
    finiteXmlNumber(point.x, `${path}[${index}].x`);
    finiteXmlNumber(point.y, `${path}[${index}].y`);
    const next = points[(index + 1) % points.length]!;
    doubledArea += point.x * next.y - next.x * point.y;
  }
  const area = doubledArea / 2;
  if (!Number.isFinite(area) || area === 0) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_CONTOUR_AREA_INVALID",
      path,
      "A contour ring must have non-zero finite area.",
    );
  }
  return area;
}

function finiteXmlNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new SrprojWriteError(
      "SRPROJ_SEGMENTATION_POINT_INVALID",
      path,
      "Contour coordinates must be finite numbers.",
    );
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function assertWriterCompatibility(
  project: ProjectIR,
  target: "v1" | "v2",
  allowConfirmedLoss: boolean,
): void {
  const compatibility = project.compatibility;
  if (!compatibility || compatibility.target !== target) return;
  if (compatibility.status === "blocked") {
    throw new SrprojWriteError(
      "SRPROJ_COMPATIBILITY_BLOCKED",
      "$.compatibility",
      "The parsed project contains fields that cannot be represented safely in V1.",
    );
  }
  if (compatibility.status === "confirmation-required" && !allowConfirmedLoss) {
    throw new SrprojWriteError(
      "SRPROJ_CONFIRMATION_REQUIRED",
      "$.compatibility",
      "The parsed project requires explicit confirmation before lossy V1 output.",
    );
  }
}

/** Return the exact UTF-8 bytes to save as `.srproj` (without a BOM). */
export function writeSrprojBytes(
  project: ProjectIR,
  options: SrprojWriteOptions = {},
): Uint8Array {
  return new TextEncoder().encode(writeSrproj(project, options));
}

/** Adapter-friendly aliases. */
export const serializeSrproj = writeSrproj;
export const buildSrproj = writeSrproj;

function orderAndValidateClasses(
  input: readonly ProjectClassIR[],
): ProjectClassIR[] {
  const classes = [...input].sort(
    (left, right) => left.index - right.index || left.sourceIndex - right.sourceIndex,
  );
  const indexes = new Set<number>();
  const names = new Set<string>();
  for (const [position, item] of classes.entries()) {
    nonNegativeInteger(item.index, `$.classes[${position}].index`);
    if (indexes.has(item.index)) {
      throw new SrprojWriteError(
        "SRPROJ_DUPLICATE_CLASS_INDEX",
        `$.classes[${position}].index`,
        `Duplicate canonical class index ${item.index}.`,
      );
    }
    indexes.add(item.index);
    const name = requiredText(
      item.name,
      `$.classes[${position}].name`,
      "SRPROJ_CLASS_NAME_INVALID",
    );
    const key = name.toLocaleLowerCase();
    if (names.has(key)) {
      throw new SrprojWriteError(
        "SRPROJ_DUPLICATE_CLASS_NAME",
        `$.classes[${position}].name`,
        `Duplicate class name '${name}'.`,
      );
    }
    names.add(key);
  }
  return classes;
}

function orderAndValidateFiles(input: readonly ProjectFileIR[]): ProjectFileIR[] {
  const files = [...input].sort((left, right) => left.index - right.index);
  const indexes = new Set<number>();
  for (const [position, item] of files.entries()) {
    nonNegativeInteger(item.index, `$.files[${position}].index`);
    if (indexes.has(item.index)) {
      throw new SrprojWriteError(
        "SRPROJ_DUPLICATE_FILE_INDEX",
        `$.files[${position}].index`,
        `Duplicate canonical file index ${item.index}.`,
      );
    }
    indexes.add(item.index);
  }
  return files;
}

function resolveOutputPath(
  file: ProjectFileIR,
  outputIndex: number,
  options: SrprojWriteOptions,
): string {
  const path = options.pathForFile?.(file, outputIndex);
  if (path !== undefined) {
    return requiredText(path, `$.files[${outputIndex}].sourcePath`, "SRPROJ_IMAGE_PATH_INVALID");
  }
  if (file.image.kind === "archive") {
    throw new SrprojWriteError(
      "SRPROJ_ARCHIVE_PATH_REQUIRED",
      `$.files[${outputIndex}].image`,
      "Archive-backed images require pathForFile; ZIP entry names are not durable V1 paths.",
    );
  }
  return requiredText(
    file.image.path || file.sourcePath,
    `$.files[${outputIndex}].sourcePath`,
    "SRPROJ_IMAGE_PATH_INVALID",
  );
}

function resolveClassificationClassIndex(file: ProjectFileIR, path: string): number {
  const labelIndexes = file.labels
    .filter((label) => label.kind === "classification")
    .map((label) => label.classIndex)
    .filter((index): index is number => index !== undefined);

  if (labelIndexes.length > 1) {
    throw new SrprojWriteError(
      "SRPROJ_MULTIPLE_CLASS_LABELS",
      `${path}.labels`,
      "V1 Classification supports exactly one class label per image.",
    );
  }
  const labelIndex = labelIndexes[0];
  if (
    file.classificationClassIndex !== undefined &&
    labelIndex !== undefined &&
    file.classificationClassIndex !== labelIndex
  ) {
    throw new SrprojWriteError(
      "SRPROJ_CLASS_LABEL_CONFLICT",
      `${path}.classificationClassIndex`,
      "File-level and explicit classification labels disagree.",
    );
  }
  const result = file.classificationClassIndex ?? labelIndex;
  if (result === undefined) {
    throw new SrprojWriteError(
      "SRPROJ_CLASS_LABEL_MISSING",
      `${path}.classificationClassIndex`,
      "Every Classification image requires one class label.",
    );
  }
  return nonNegativeInteger(result, `${path}.classificationClassIndex`);
}

function splitToV1(split: SplitType, path: string): string {
  switch (split) {
    case "training":
      return "Training";
    case "validation":
      return "Validation";
    case "unassigned":
      return "Not split";
    case "unknown":
      throw new SrprojWriteError(
        "SRPROJ_SPLIT_UNSUPPORTED",
        path,
        "An unknown split cannot be written to V1 without guessing.",
      );
  }
}

function colorToV1Integer(
  color: string | undefined,
  classIndex: number,
  path: string,
): number {
  if (color === undefined || color.trim() === "") {
    return fallbackColor(classIndex);
  }
  const value = color.trim();
  if (/^-?\d+$/.test(value)) {
    const number = Number(value);
    if (
      Number.isSafeInteger(number) &&
      number >= -0x80000000 &&
      number <= 0xffffffff
    ) {
      return toSigned32(number);
    }
  }

  const hex = /^#([\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const argb = hex.length === 6 ? `ff${hex}` : hex;
    return toSigned32(Number.parseInt(argb, 16));
  }
  throw new SrprojWriteError(
    "SRPROJ_CLASS_COLOR_INVALID",
    path,
    `Class color '${value}' must be a V1 integer, #RRGGBB, or #AARRGGBB.`,
  );
}

function fallbackColor(index: number): number {
  // Stable, opaque palette used only when the source has no cosmetic color.
  const palette = [
    0xff00b050,
    0xfff00000,
    0xffffc000,
    0xff0070c0,
    0xff7030a0,
    0xff00b0f0,
    0xffff00ff,
    0xff92d050,
  ];
  return toSigned32(palette[index % palette.length]);
}

function toSigned32(value: number): number {
  const unsigned = value < 0 ? value + 0x1_0000_0000 : value;
  return unsigned > 0x7fffffff ? unsigned - 0x1_0000_0000 : unsigned;
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SrprojWriteError(
      "SRPROJ_IMAGE_DIMENSION_INVALID",
      path,
      "Image dimensions must be positive safe integers.",
    );
  }
  return value;
}

function nonNegativeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SrprojWriteError(
      "SRPROJ_INDEX_INVALID",
      path,
      "Indexes must be non-negative safe integers.",
    );
  }
  return value;
}

function requiredText(value: string, path: string, code: string): string {
  if (value.trim() === "") {
    throw new SrprojWriteError(code, path, "Required text value cannot be empty.");
  }
  assertLegalXmlText(value, path);
  return value;
}

function escapeXmlText(value: string, path: string): string {
  assertLegalXmlText(value, path);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertLegalXmlText(value: string, path: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const legal =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!legal) {
      throw new SrprojWriteError(
        "SRPROJ_XML_CHARACTER_INVALID",
        path,
        "Value contains a character forbidden by XML 1.0.",
      );
    }
  }
}

function rawString(raw: Readonly<JsonObject>, key: string): string | undefined {
  return typeof raw[key] === "string" ? raw[key] : undefined;
}

function formatV1Date(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const part = (number: number): string => String(number).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    "-",
    part(date.getUTCMonth() + 1),
    "-",
    part(date.getUTCDate()),
    " ",
    part(date.getUTCHours()),
    ":",
    part(date.getUTCMinutes()),
    ":",
    part(date.getUTCSeconds()),
  ].join("");
}
