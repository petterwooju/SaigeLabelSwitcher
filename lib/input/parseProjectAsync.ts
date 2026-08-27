import type { ProjectParseResult } from "../model/project.ts";
import {
  type ProjectParseWorkerRequest,
  type ProjectParseWorkerResponse,
  type SerializedWorkerError,
} from "../workers/projectWorkerProtocol.ts";
import { parseV1Srproj } from "./v1.ts";
import {
  parseV2SubvisionProject,
  parseV2VisionProject,
} from "./v2.ts";

/**
 * Run the CPU-heavy project parser outside the UI thread when module workers
 * are available. Node tests and unsupported browsers retain a deterministic
 * synchronous fallback.
 */
export async function parseProjectAsync(
  request: ProjectParseWorkerRequest,
  signal?: AbortSignal,
): Promise<ProjectParseResult> {
  throwIfAborted(signal);
  if (typeof Worker !== "function") {
    return Promise.resolve(parseSynchronously(request));
  }

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("workers/project-parser.worker.js", document.baseURI),
      { type: "module", name: "saige-project-parser" },
    );
  } catch {
    return Promise.resolve(parseSynchronously(request));
  }

  return new Promise<ProjectParseResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    worker.onmessage = (event: MessageEvent<ProjectParseWorkerResponse>) => {
      finish(() => {
        if (event.data.ok) resolve(event.data.result);
        else reject(deserializeWorkerError(event.data.error));
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => {
        try {
          throwIfAborted(signal);
          resolve(parseSynchronously(request));
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
          resolve(parseSynchronously(request));
        } catch (error) {
          reject(error);
        }
      });
    }
  });
}

function parseSynchronously(request: ProjectParseWorkerRequest): ProjectParseResult {
  if (request.kind === "v1") return parseV1Srproj(request.input);
  if (request.kind === "v2-subvision") {
    return parseV2SubvisionProject(request.input);
  }
  return parseV2VisionProject(request.input);
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
  return Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code ? { code: error.code } : {}),
    ...(error.path ? { path: error.path } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
