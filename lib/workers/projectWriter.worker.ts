import { writeSrproj } from "../output/srproj.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
} from "../output/v2.ts";
import {
  serializeWorkerError,
  type ProjectWriteWorkerRequest,
  type ProjectWriteWorkerResponse,
} from "./projectWorkerProtocol.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ProjectWriteWorkerRequest>) => void) | null;
  postMessage(message: ProjectWriteWorkerResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  try {
    const request = event.data;
    if (request.kind === "v2-subvision") {
      workerScope.postMessage({
        ok: true,
        value: {
          kind: request.kind,
          result: writeV2SubvisionProject(request.project, request.options),
        },
      });
      return;
    }
    if (request.kind === "v2-vision") {
      workerScope.postMessage({
        ok: true,
        value: {
          kind: request.kind,
          result: writeV2VisionProject(request.project, request.options),
        },
      });
      return;
    }
    const { pathByFileIndex, ...serializableOptions } = request.options;
    const xml = writeSrproj(request.project, {
      ...serializableOptions,
      ...(pathByFileIndex
        ? {
            pathForFile: (file) =>
              Object.hasOwn(pathByFileIndex, file.index)
                ? pathByFileIndex[file.index]
                : file.sourcePath,
          }
        : {}),
    });
    workerScope.postMessage({
      ok: true,
      value: { kind: request.kind, xml },
    });
  } catch (error) {
    workerScope.postMessage({ ok: false, error: serializeWorkerError(error) });
  }
};
