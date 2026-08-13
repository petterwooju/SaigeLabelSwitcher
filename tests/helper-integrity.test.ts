import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertHelperIntegrity,
  EXPECTED_HELPER_SHA256,
  EXPECTED_HELPER_SIZE,
  HelperIntegrityError,
} from "../lib/security/helperIntegrity.ts";

const helperUrl = new URL(
  "../public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe",
  import.meta.url,
);

test("the packaged helper matches the pinned release digest", async () => {
  const bytes = await readFile(helperUrl);
  assert.equal(bytes.byteLength, EXPECTED_HELPER_SIZE);
  assert.equal(EXPECTED_HELPER_SHA256.length, 64);
  await assert.doesNotReject(assertHelperIntegrity(new Blob([bytes])));
});

test("helper integrity rejects changed bytes and an unexpected size", async () => {
  const bytes = new Uint8Array(await readFile(helperUrl));
  const changed = bytes.slice();
  changed[changed.length - 1] ^= 1;
  await assert.rejects(
    assertHelperIntegrity(new Blob([changed])),
    (error) => error instanceof HelperIntegrityError,
  );
  await assert.rejects(
    assertHelperIntegrity(new Blob([bytes.subarray(0, bytes.length - 1)])),
    (error) => error instanceof HelperIntegrityError,
  );
});
