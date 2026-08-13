import type {
  JsonObject,
  ProjectClassIR,
  ProjectFileIR,
  ProjectIR,
  SplitType,
} from "../model/project.ts";

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
 * Serialize the Classification subset of ProjectIR as deterministic V1 XML.
 * User-controlled values are always emitted as escaped XML text nodes.
 */
export function writeSrproj(
  project: ProjectIR,
  options: SrprojWriteOptions = {},
): string {
  assertWriterCompatibility(project, "v1", options.allowConfirmedLoss ?? false);
  if (project.project.type !== "classification") {
    throw new SrprojWriteError(
      "SRPROJ_PROJECT_TYPE_UNSUPPORTED",
      "$.project.type",
      `Only Classification has a verified V1 writer; received '${project.project.rawType}'.`,
    );
  }

  const lineEnding = options.lineEnding ?? "\n";
  const classes = orderAndValidateClasses(project.classes);
  const files = orderAndValidateFiles(project.files);
  const outputClassIndex = new Map<number, number>();
  classes.forEach((item, index) => outputClassIndex.set(item.index, index));

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Project>",
    `  <Version>${escapeXmlText(options.version ?? "0.9", "$.Version")}</Version>`,
    "  <Type>Classification</Type>",
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
    const sourceClassIndex = resolveClassificationClassIndex(file, path);
    const classIndex = outputClassIndex.get(sourceClassIndex);
    if (classIndex === undefined) {
      throw new SrprojWriteError(
        "SRPROJ_CLASS_REFERENCE_INVALID",
        `${path}.classificationClassIndex`,
        `Classification label references missing canonical class index ${sourceClassIndex}.`,
      );
    }

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
    lines.push(
      `      <SplitState>${split}</SplitState>`,
      `      <ClassIndexOfLabel>${classIndex}</ClassIndexOfLabel>`,
      "    </Image>",
    );
  }

  lines.push("  </ImageGroup>", "</Project>", "");
  return lines.join(lineEnding);
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
