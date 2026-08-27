import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("creates a complete static GitHub Pages site", async () => {
  const [
    html,
    exportedHelper,
    sourceHelper,
    checksumText,
    packageText,
    parserWorker,
    writerWorker,
    exportedNotices,
    sourceNotices,
  ] = await Promise.all([
    readFile(new URL("../out/index.html", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../out/downloads/SaigeVisionProjectAssistant.ZipFixer.exe",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "../public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "../public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe.sha256",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(
      new URL("../out/workers/project-parser.worker.js", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../out/workers/project-writer.worker.js", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../out/THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
    readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
  ]);

  const appVersion = JSON.parse(packageText).version;
  const expectedHash = checksumText.trim().split(/\s+/u)[0];
  const exportedHash = createHash("sha256").update(exportedHelper).digest("hex");

  assert.match(html, /<title>SaigeVision 项目转换<\/title>/iu);
  assert.ok(html.includes(`v${appVersion}`));
  assert.match(html, /Classification/u);
  assert.match(html, /Segmentation/u);
  assert.match(
    html,
    /https:\/\/saige-label-switcher-beta\.saigeai\.com\/saigevision-converter-preview\.png/u,
  );
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive"/iu);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/saige-label-switcher-beta\.saigeai\.com"/iu,
  );
  assert.match(html, /Content-Security-Policy/iu);
  assert.match(html, /href="\/THIRD_PARTY_NOTICES\.md"/iu);
  assert.equal(exportedNotices, sourceNotices);
  const cspPosition = html.indexOf('http-equiv="Content-Security-Policy"');
  const firstResourcePosition = Math.min(
    ...[html.indexOf("<script"), html.indexOf("<link")].filter(
      (position) => position >= 0,
    ),
  );
  assert.ok(cspPosition >= 0 && cspPosition < firstResourcePosition);
  assert.doesNotMatch(html, /localhost|chatgpt\.site/iu);
  assert.equal(exportedHash.toUpperCase(), expectedHash.toUpperCase());
  assert.deepEqual(exportedHelper, sourceHelper);
  for (const [name, source] of [
    ["parser", parserWorker],
    ["writer", writerWorker],
  ]) {
    assert.ok(source.length > 1_000, `${name} worker should be bundled`);
    assert.doesNotMatch(source, /(?:from\s+["'][^"']*\.ts["']|\binterface\s+\w+)/u);
  }

  const rootAssetPaths = [
    ...html.matchAll(/(?:href|src)="(\/(?:_next|favicon)[^"]*)"/giu),
  ].map((match) => match[1].split("?", 1)[0]);
  assert.ok(rootAssetPaths.length >= 3);
  for (const assetPath of new Set(rootAssetPaths)) {
    const bytes = await readFile(
      new URL(`../out${assetPath}`, import.meta.url),
    );
    assert.ok(bytes.byteLength > 0, `${assetPath} should not be empty`);
  }
});
