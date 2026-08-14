import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("creates a complete static GitHub Pages site", async () => {
  const [html, exportedHelper, sourceHelper, checksumText] = await Promise.all([
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
  ]);

  const expectedHash = checksumText.trim().split(/\s+/u)[0];
  const exportedHash = createHash("sha256").update(exportedHelper).digest("hex");

  assert.match(html, /<title>SaigeVision 项目转换<\/title>/iu);
  assert.match(html, /v0\.0\.1/u);
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
  assert.doesNotMatch(html, /localhost|chatgpt\.site/iu);
  assert.equal(exportedHash.toUpperCase(), expectedHash.toUpperCase());
  assert.deepEqual(exportedHelper, sourceHelper);

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
