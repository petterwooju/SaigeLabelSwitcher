import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../scripts/verify-helper-signature.ps1", import.meta.url);
const helperUrl = new URL(
  "../public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe",
  import.meta.url,
);
const checksumUrl = new URL(
  "../public/downloads/SaigeVisionProjectAssistant.ZipFixer.exe.sha256",
  import.meta.url,
);

test("stable helper verification pins hash, publisher, signature status, and timestamp", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /Get-FileHash\s+-LiteralPath\s+\$resolvedBinary\s+-Algorithm\s+SHA256/u);
  assert.match(source, /Get-AuthenticodeSignature\s+-LiteralPath\s+\$resolvedBinary/u);
  assert.match(
    source,
    /\$signature\.Status\s+-eq\s+\[System\.Management\.Automation\.SignatureStatus\]::Valid/u,
  );
  assert.match(source, /\$signature\.TimeStamperCertificate/u);
  assert.match(source, /ExpectedPublisher is required/u);
  assert.match(
    source,
    /\[System\.StringComparer\]::OrdinalIgnoreCase\.Equals\(\$actualPublisher,\s*\$ExpectedPublisher\.Trim\(\)\)/u,
  );
  assert.match(source, /1\.3\.6\.1\.5\.5\.7\.3\.3/u);
  assert.match(source, /SAIGE_HELPER_EXPECTED_THUMBPRINT/u);
  assert.doesNotMatch(source, /Set-AuthenticodeSignature/u);
});

test("checked-in helper SHA-256 sidecar is synchronized", async () => {
  const [bytes, sidecar] = await Promise.all([
    readFile(helperUrl),
    readFile(checksumUrl, "utf8"),
  ]);
  const match = sidecar.trim().match(
    /^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)$/iu,
  );
  assert.ok(match, "Expected exactly one standard SHA-256 sidecar record.");
  assert.equal(match[2], "SaigeVisionProjectAssistant.ZipFixer.exe");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    match[1]?.toLocaleLowerCase("en-US"),
  );
});
