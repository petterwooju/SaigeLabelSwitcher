import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseProjectAsync } from "../lib/input/parseProjectAsync.ts";
import {
  writeSrprojAsync,
  writeV2SubvisionProjectAsync,
} from "../lib/output/writeProjectAsync.ts";

const fixtureUrl = new URL(
  "./fixtures/native-v2-2.7.8-classification.subvisionproj",
  import.meta.url,
);

test("async parser and writer fallbacks preserve the conversion contract", async () => {
  const jsonText = await readFile(fixtureUrl, "utf8");
  const parsed = await parseProjectAsync({
    kind: "v2-subvision",
    input: { jsonText, fileName: "fixture.subvisionproj" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const xml = await writeSrprojAsync(parsed.project, {
    allowConfirmedLoss: true,
    pathByFileIndex: Object.fromEntries(
      parsed.project.files.map((file) => [file.index, file.sourcePath]),
    ),
  });
  assert.match(xml, /<Project>/u);
  const reparsedV1 = await parseProjectAsync({
    kind: "v1",
    input: { xmlText: xml, fileName: "fixture.srproj" },
  });
  assert.equal(reparsedV1.ok, true);

  const writtenV2 = await writeV2SubvisionProjectAsync(
    parsed.project,
    {
      allowConfirmedLoss: true,
      externalPaths: Object.fromEntries(
        parsed.project.files.map((file) => [file.index, file.sourcePath]),
      ),
    },
  );
  assert.equal(writtenV2.ok, true);
  if (!writtenV2.ok) return;
  const reparsedV2 = await parseProjectAsync({
    kind: "v2-subvision",
    input: { jsonText: writtenV2.jsonText },
  });
  assert.equal(reparsedV2.ok, true);
});

test("async parser and writer honor an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));

  await assert.rejects(
    parseProjectAsync(
      { kind: "v2-subvision", input: { jsonText: "{}" } },
      controller.signal,
    ),
    { name: "AbortError" },
  );

  const jsonText = await readFile(fixtureUrl, "utf8");
  const parsed = await parseProjectAsync({
    kind: "v2-subvision",
    input: { jsonText },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  await assert.rejects(
    writeV2SubvisionProjectAsync(
      parsed.project,
      { allowConfirmedLoss: true },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

test("async parser and writer fall back when a browser worker cannot load", async () => {
  const originalWorker = globalThis.Worker;
  const originalDocument = globalThis.document;
  class FailingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage(): void {
      queueMicrotask(() => {
        this.onerror?.({
          message: "worker script unavailable",
          preventDefault() {},
        } as ErrorEvent);
      });
    }

    terminate(): void {}
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FailingWorker,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: "https://example.test/" },
  });

  try {
    const jsonText = await readFile(fixtureUrl, "utf8");
    const parsed = await parseProjectAsync({
      kind: "v2-subvision",
      input: { jsonText, fileName: "fixture.subvisionproj" },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const xml = await writeSrprojAsync(parsed.project, {
      allowConfirmedLoss: true,
      pathByFileIndex: Object.fromEntries(
        parsed.project.files.map((file) => [file.index, file.sourcePath]),
      ),
    });
    assert.match(xml, /<Project>/u);
  } finally {
    if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
    else Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: originalWorker,
    });
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});
