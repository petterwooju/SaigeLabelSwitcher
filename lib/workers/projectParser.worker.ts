import { parseV1Srproj } from "../input/v1.ts";
import {
  parseV2SubvisionProject,
  parseV2VisionProject,
} from "../input/v2.ts";
import {
  serializeWorkerError,
  type ProjectParseWorkerRequest,
  type ProjectParseWorkerResponse,
} from "./projectWorkerProtocol.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ProjectParseWorkerRequest>) => void) | null;
  postMessage(message: ProjectParseWorkerResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  try {
    const request = event.data;
    const result =
      request.kind === "v1"
        ? parseV1Srproj(request.input)
        : request.kind === "v2-subvision"
          ? parseV2SubvisionProject(request.input)
          : parseV2VisionProject(request.input);
    workerScope.postMessage({ ok: true, result });
  } catch (error) {
    workerScope.postMessage({ ok: false, error: serializeWorkerError(error) });
  }
};
