import type {
  ProjectIR,
  ProjectParseResult,
} from "../model/project.ts";
import type {
  V2SubvisionWriterOptions,
  V2SubvisionWriteResult,
  V2VisionWriterOptions,
  V2VisionWriteResult,
} from "../output/v2.ts";

export type ProjectParseWorkerRequest =
  | {
      readonly kind: "v1";
      readonly input: {
        readonly xmlText: string;
        readonly fileName?: string;
      };
    }
  | {
      readonly kind: "v2-subvision";
      readonly input: {
        readonly jsonText: string;
        readonly fileName?: string;
      };
    }
  | {
      readonly kind: "v2-vision";
      readonly input: {
        readonly projectJsonText: string;
        readonly projectJsonEntryName: string;
        readonly entries: readonly { readonly name: string }[];
        readonly fileName?: string;
      };
    };

export type ProjectParseWorkerResponse =
  | { readonly ok: true; readonly result: ProjectParseResult }
  | { readonly ok: false; readonly error: SerializedWorkerError };

export interface WorkerSrprojOptions {
  readonly version?: "0.9";
  readonly modifiedDate?: string;
  readonly lineEnding?: "\n" | "\r\n";
  readonly allowConfirmedLoss?: boolean;
  readonly pathByFileIndex?: Readonly<Record<number, string>>;
}

export type ProjectWriteWorkerRequest =
  | {
      readonly kind: "v2-subvision";
      readonly project: ProjectIR;
      readonly options: V2SubvisionWriterOptions;
    }
  | {
      readonly kind: "v2-vision";
      readonly project: ProjectIR;
      readonly options: V2VisionWriterOptions;
    }
  | {
      readonly kind: "v1-srproj";
      readonly project: ProjectIR;
      readonly options: WorkerSrprojOptions;
    };

export type ProjectWriteWorkerValue =
  | { readonly kind: "v2-subvision"; readonly result: V2SubvisionWriteResult }
  | { readonly kind: "v2-vision"; readonly result: V2VisionWriteResult }
  | { readonly kind: "v1-srproj"; readonly xml: string };

export type ProjectWriteWorkerResponse =
  | { readonly ok: true; readonly value: ProjectWriteWorkerValue }
  | { readonly ok: false; readonly error: SerializedWorkerError };

export interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  readonly stack?: string;
}

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const candidate = error as Error & { readonly code?: unknown; readonly path?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(typeof candidate.path === "string" ? { path: candidate.path } : {}),
    ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
  };
}
