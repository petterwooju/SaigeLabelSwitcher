/** JSON values retained from an input project without coercion. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonObject
  | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ProjectSourceFormat =
  | "v1-srproj"
  | "v1-svpa"
  | "v2-visionproj"
  | "v2-subvisionproj";

export type ProjectType =
  | "classification"
  | "detection"
  | "segmentation"
  | "unknown";

export type SplitType = "training" | "validation" | "unassigned" | "unknown";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type CompatibilityDisposition =
  | "preserve"
  | "rebuild"
  | "degrade"
  | "drop"
  | "block";

export type DiagnosticCategory = "validation" | "security" | "compatibility";

/**
 * A validation or compatibility finding. `path` uses a JSONPath-like notation
 * so the UI can identify the exact source value without parsing prose.
 */
export interface ProjectDiagnostic {
  readonly code: string;
  readonly category: DiagnosticCategory;
  readonly severity: DiagnosticSeverity;
  readonly disposition: CompatibilityDisposition;
  readonly path: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type V1CompatibilityStatus =
  | "compatible"
  | "confirmation-required"
  | "blocked";

export interface CompatibilitySummary {
  readonly target: "v1" | "v2";
  readonly status: V1CompatibilityStatus;
  readonly preserveCount: number;
  readonly rebuildCount: number;
  readonly degradeCount: number;
  readonly dropCount: number;
  readonly blockCount: number;
}

export interface ProjectSourceIR {
  readonly format: ProjectSourceFormat;
  readonly fileName?: string;
  readonly projectJsonEntry?: string;
  readonly rawProjectType: string;
}

/** Canonical ROI geometry expressed as normalized image-space boundaries. */
export type ProjectRoiIR =
  | { readonly mode: "none" }
  | {
      readonly mode: "simple";
      readonly shape: "rectangle";
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
    };

export interface ProjectMetadataIR {
  readonly sourceId?: number | string;
  readonly name: string;
  readonly type: ProjectType;
  readonly rawType: string;
  readonly description: string;
  readonly createdAt?: number;
  readonly modifiedAt?: number;
  readonly roi?: ProjectRoiIR;
  /** Legacy source-facing ROI mode retained while adapters migrate to `roi`. */
  readonly roiMode?: string;
  /** V2 fields are retained even when V1 has no declared mapping. */
  readonly raw: JsonObject;
}

export interface ProjectClassIR {
  readonly sourceId?: number | string;
  /** Stable V1-facing zero-based class index. */
  readonly index: number;
  readonly sourceIndex: number;
  readonly name: string;
  readonly color?: string;
  readonly description: string;
  readonly isNg?: boolean;
  readonly raw: JsonObject;
}

export interface ProjectDatasetIR {
  readonly sourceId?: number | string;
  readonly index: number;
  readonly name: string;
  readonly description: string;
  readonly raw: JsonObject;
}

export interface ProjectSplitIR {
  readonly sourceId?: number | string;
  readonly sourceName?: string;
  readonly type: SplitType;
  readonly rawType?: string;
  readonly raw: JsonObject;
}

export interface PointIR {
  readonly x: number;
  readonly y: number;
}

/** Semantic role of a polygon ring in a segmentation label. */
export type ContourRingRole = "outer" | "inner" | "unknown";

export interface BoxIR {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RotatedBoxIR {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
  readonly radians: number;
}

export interface LabelGeometryIR {
  readonly box?: BoxIR;
  /** Each item is a contour ring in source order. */
  readonly contours?: readonly (readonly PointIR[])[];
  /** Ring roles parallel to `contours`; absent only for legacy/unknown inputs. */
  readonly contourRoles?: readonly ContourRingRole[];
  readonly rotatedBox?: RotatedBoxIR;
  readonly bitmap?: string;
  readonly text?: string;
}

export type LabelKind =
  | "classification"
  | "box"
  | "contour"
  | "rotated-box"
  | "unknown";

export type LabelOrigin = "manual" | "automatic" | "unknown";

export interface ProjectLabelIR {
  readonly sourceId?: number | string;
  readonly index: number;
  readonly kind: LabelKind;
  readonly origin: LabelOrigin;
  readonly classIndex?: number;
  readonly sourceClassId?: number | string;
  readonly sourceClassName?: string;
  readonly geometry: LabelGeometryIR;
  /** True for a classification label derived from file-level V2 fields. */
  readonly synthesized: boolean;
  readonly raw: JsonObject;
}

export interface ExternalImageSourceIR {
  readonly kind: "external";
  readonly path: string;
}

export interface ArchiveImageSourceIR {
  readonly kind: "archive";
  readonly entryName: string;
  /** Bytes are present only when the archive adapter supplied them. */
  readonly bytes?: Uint8Array;
}

export type ImageSourceIR = ExternalImageSourceIR | ArchiveImageSourceIR;

export interface ProjectFileIR {
  readonly sourceId?: number | string;
  readonly index: number;
  readonly sourcePath: string;
  /** Slash-normalized source path; it is not necessarily a usable OS path. */
  readonly normalizedPath: string;
  readonly fileName: string;
  readonly width?: number;
  readonly height?: number;
  readonly isLabeled?: boolean;
  /** V1 segmentation explicitly distinguishes normal images from defects. */
  readonly isNormal?: boolean;
  readonly datasetName?: string;
  readonly datasetIndex?: number;
  readonly classificationClassIndex?: number;
  readonly splits: readonly ProjectSplitIR[];
  /** A single V1-facing split after V2 split memberships are normalized. */
  readonly canonicalSplit: SplitType;
  readonly labels: readonly ProjectLabelIR[];
  readonly image: ImageSourceIR;
  readonly raw: JsonObject;
}

/** Canonical, loss-aware representation shared by all project adapters. */
export interface ProjectIR {
  readonly schemaVersion: 1;
  readonly source: ProjectSourceIR;
  readonly project: ProjectMetadataIR;
  readonly classes: readonly ProjectClassIR[];
  readonly datasets: readonly ProjectDatasetIR[];
  readonly files: readonly ProjectFileIR[];
  /** Entire parsed JSON root, retained for audit and future adapters. */
  readonly raw: JsonObject;
  /**
   * Loss analysis produced by the parser that created this IR. Writers use
   * this value as a last-line safety gate so callers cannot bypass a blocked
   * cross-version conversion by passing the normalized project directly.
   */
  readonly compatibility?: CompatibilitySummary;
}

export interface ProjectParseSuccess {
  readonly ok: true;
  readonly project: ProjectIR;
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly compatibility: CompatibilitySummary;
}

export interface ProjectParseFailure {
  readonly ok: false;
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly compatibility: CompatibilitySummary;
}

export type ProjectParseResult = ProjectParseSuccess | ProjectParseFailure;
