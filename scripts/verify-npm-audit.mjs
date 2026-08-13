import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const PATCH_TARBALL_SHA256 =
  "D1A78990B854CB3E7D872F7B09858293A962A1A2A87D49FC9BB5E9C72EC7BFD4";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Run this verifier through npm run audit:dependencies.");
}

const result = spawnSync(
  process.execPath,
  [npmCli, "audit", "--json"],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  },
);

if (result.error) {
  throw result.error;
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error(`npm audit did not return JSON. ${result.stderr.trim()}`);
}

if (!report.vulnerabilities) {
  throw new Error(
    `npm audit failed before producing a vulnerability report. ${report.message ?? result.stderr.trim()}`,
  );
}

const vulnerabilities = Object.entries(report.vulnerabilities);
if (vulnerabilities.length > 0) {
  throw new Error(
    `npm audit reported vulnerable packages: ${vulnerabilities
      .map(([name]) => name)
      .sort()
      .join(", ")}`,
  );
}

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (
  lock.packages?.["node_modules/vinext"]?.version !== "1.0.0-beta.2" ||
  lock.packages?.["node_modules/image-size"]?.version !== "2.0.3-saige.2"
) {
  throw new Error("The pinned Vinext/image-size versions changed and must be reviewed.");
}

const patchTarball = await readFile("vendor/image-size-2.0.3-saige.2.tgz");
const patchTarballSha256 = createHash("sha256")
  .update(patchTarball)
  .digest("hex")
  .toUpperCase();
if (patchTarballSha256 !== PATCH_TARBALL_SHA256) {
  throw new Error("The pinned image-size patch tarball digest changed.");
}

const workerSource = await readFile("worker/index.ts", "utf8");
if (/image-optimization|_vinext\/image/u.test(workerSource)) {
  throw new Error("The disabled Vinext image optimizer was reintroduced.");
}

const serverFiles = await collectJavaScriptFiles("dist/server");
const vulnerableParserSignatures = /Invalid ICNS|Invalid HEIF|extractPartialStreams/u;
for (const file of serverFiles) {
  const source = await readFile(file, "utf8");
  if (vulnerableParserSignatures.test(source)) {
    throw new Error(`A vulnerable image-size parser reached the server bundle: ${file}`);
  }
}

console.log(
  "npm audit is clean, the patched image-size package is pinned, and its parsers are absent from the server bundle.",
);

async function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}
