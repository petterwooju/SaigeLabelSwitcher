import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(url = "http://localhost/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(url, { headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the SaigeVision converter shell", async () => {
  const response = await render("https://example.test/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SaigeVision 项目转换<\/title>/i);
  assert.match(html, /SaigeVision Project Converter/);
  assert.match(html, /v0\.0\.1/);
  assert.match(html, /Classification/);
  assert.match(html, /Segmentation/);
  assert.match(html, /https:\/\/example\.test\/saigevision-converter-preview\.png/);
  assert.doesNotMatch(html, /localhost:3000\/saigevision-converter-preview\.png/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive"/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/i);
});

test("ignores spoofed proxy and internal origin headers", async () => {
  const response = await render("https://trusted.example/", {
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
    "x-saigevision-request-origin": "https://evil.example",
  });
  const html = await response.text();
  assert.match(html, /https:\/\/trusted\.example\/saigevision-converter-preview\.png/);
  assert.doesNotMatch(html, /evil\.example/);
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
