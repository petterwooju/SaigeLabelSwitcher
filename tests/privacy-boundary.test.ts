import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const root = new URL(`../${directory}/`, import.meta.url);
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      result.push(
        ...(await sourceFiles(`${directory}/${entry.name}`)),
      );
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      result.push(await readFile(new URL(entry.name, root), "utf8"));
    }
  }
  return result;
}

test("project-processing code has no project-data network channel", async () => {
  const sources = (await Promise.all([
    sourceFiles("components"),
    sourceFiles("lib"),
  ])).flat();
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /\b(?:XMLHttpRequest|WebSocket|sendBeacon)\b/u);
  const fetchCalls = combined.match(/\bfetch\s*\(/gu) ?? [];
  assert.equal(fetchCalls.length, 1, "only the pinned SVPA helper may be fetched");
  assert.match(
    combined,
    /fetch\(\s*`\/downloads\/SaigeVisionProjectAssistant\.ZipFixer\.exe\?sha256=/u,
  );
});

test("worker applies privacy and browser hardening headers", async () => {
  const worker = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  for (const header of [
    "Content-Security-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
    "X-Content-Type-Options",
  ]) {
    assert.match(worker, new RegExp(header));
  }
  assert.match(worker, /frame-ancestors 'none'/u);
  assert.match(worker, /connect-src 'self'/u);
});
