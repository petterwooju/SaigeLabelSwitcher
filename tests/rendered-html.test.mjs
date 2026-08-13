import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the SaigeVision converter shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SaigeVision 项目转换<\/title>/i);
  assert.match(html, /SaigeVision Project Converter/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/i);
});

test("removes starter assets and keeps the converter client-side", async () => {
  const [page, layout, packageJson, converter] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectConverter.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<ProjectConverter \/>/);
  assert.match(layout, /SaigeVision 项目转换/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(converter, /"use client"/);
  assert.match(converter, /loadProject/);
  assert.match(converter, /requestSaveDestination/);
  assert.match(converter, /writeVisionArchive/);
  assert.match(converter, /writeSvpaArchive/);
});
