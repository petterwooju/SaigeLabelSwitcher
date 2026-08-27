import type { ProjectIR } from "../model/project.ts";
import {
  SrprojWriteError,
  writeSrproj,
} from "./srproj.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
  type V2SubvisionWriterOptions,
  type V2SubvisionWriteResult,
  type V2VisionWriterOptions,
  type V2VisionWriteResult,
} from "./v2.ts";
import {
  type ProjectWriteWorkerRequest,
  type ProjectWriteWorkerResponse,
  type ProjectWriteWorkerValue,
  type SerializedWorkerError,
  type WorkerSrprojOptions,
} from "../workers/projectWorkerProtocol.ts";

export async function writeV2SubvisionProjectAsync(
  project: ProjectIR,
  options: V2SubvisionWriterOptions,
  signal?: AbortSignal,
): Promise<V2SubvisionWriteResult> {
  return runWriterWorker(
    { kind: "v2-subvision", project, options },
    () => ({
      kind: "v2-subvision",
      result: writeV2SubvisionProject(project, options),
    }),
    signal,
  ).then((value) => {
    if (value.kind !== "v2-subvision") throw mismatchedWorkerResponse();
    return value.result;
  });
}

export async function writeV2VisionProjectAsync(
  project: ProjectIR,
  options: V2VisionWriterOptions,
  signal?: AbortSignal,
): Promise<V2VisionWriteResult> {
  return runWriterWorker(
    { kind: "v2-vision", project, options },
    () => ({
      kind: "v2-vision",
      result: writeV2VisionProject(project, options),
    }),
    signal,
  ).then((value) => {
    if (value.kind !== "v2-vision") throw mismatchedWorkerResponse();
    return value.result;
  });
}

export async function writeSrprojAsync(
  project: ProjectIR,
  options: WorkerSrprojOptions,
  signal?: AbortSignal,
): Promise<string> {
  const fallbackOptions = {
    ...options,
    ...(options.pathByFileIndex
      ? {
          pathForFile: (file: ProjectIR["files"][number]) =>
            Object.hasOwn(options.pathByFileIndex ?? {}, file.index)
              ? options.pathByFileIndex?.[file.index] ?? file.sourcePath
              : file.sourcePath,
        }
      : {}),
  };
  return runWriterWorker(
    { kind: "v1-srproj", project, options },
    () => ({
      kind: "v1-srproj",
      xml: writeSrproj(project, fallbackOptions),
    }),
    signal,
  ).then((value) => {
    if (value.kind !== "v1-srproj") throw mismatchedWorkerResponse();
    return value.xml;
  });
}

function runWriterWorker(
  request: ProjectWriteWorkerRequest,
  fallback: () => ProjectWriteWorkerValue,
  signal?: AbortSignal,
): Promise<ProjectWriteWorkerValue> {
  throwIfAborted(signal);
  if (typeof Worker !== "function") return Promise.resolve(fallback());

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("workers/project-writer.worker.js", document.baseURI),
      { type: "module", name: "saige-project-writer" },
    );
  } catch {
    return Promise.resolve(fallback());
  }

  return new Promise<ProjectWriteWorkerValue>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    worker.onmessage = (event: MessageEvent<ProjectWriteWorkerResponse>) => {
      finish(() => {
        if (event.data.ok) resolve(event.data.value);
        else reject(deserializeWriterError(event.data.error));
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => {
        try {
          throwIfAborted(signal);
          resolve(fallback());
        } catch (error) {
          reject(error);
        }
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      worker.postMessage(request);
    } catch {
      finish(() => {
        try {
          throwIfAborted(signal);
          resolve(fallback());
        } catch (error) {
          reject(error);
        }
      });
    }
  });
}

function deserializeWriterError(error: SerializedWorkerError): Error {
  if (error.name === "SrprojWriteError" && error.code && error.path) {
    const result = new SrprojWriteError(error.code, error.path, error.message);
    if (error.stack) result.stack = error.stack;
    return result;
  }
  return Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code ? { code: error.code } : {}),
    ...(error.path ? { path: error.path } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  });
}

function mismatchedWorkerResponse(): Error {
  return new Error("Project writer worker returned an unexpected response.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
