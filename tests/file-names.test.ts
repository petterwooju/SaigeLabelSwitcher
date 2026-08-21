import assert from "node:assert/strict";
import test from "node:test";
import { safeOutputStem } from "../lib/output/fileNames.ts";

test("output stems are portable across Windows and browser downloads", () => {
  assert.equal(safeOutputStem("CON"), "_CON");
  assert.equal(safeOutputStem("nul.txt"), "_nul.txt");
  assert.equal(safeOutputStem("COM1 .txt"), "_COM1 .txt");
  assert.equal(safeOutputStem(' bad<>:"/\\|?*name. '), "bad_________name");
  assert.equal(safeOutputStem("   "), "SaigeVision_Project");
});

test("output stems respect their UTF-8 byte budget without splitting code points", () => {
  const stem = safeOutputStem("项目".repeat(200), 60);
  assert.ok(new TextEncoder().encode(stem).byteLength <= 60);
  assert.ok(stem.length > 0);
  assert.equal(stem.includes("�"), false);
});
