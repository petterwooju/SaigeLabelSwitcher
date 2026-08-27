import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);

async function readText(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), "utf8");
}

function fail(message) {
  throw new Error(`Release verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? "");
  assert(match, `${label} must be an exact major.minor.patch version.`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const packageJson = JSON.parse(await readText("package.json"));
const packageLock = JSON.parse(await readText("package-lock.json"));
const releaseSource = await readText("lib/release.ts");
const postcssSource = await readText("postcss.config.mjs");
const readme = await readText("README.md");
const thirdPartyNotices = await readText("THIRD_PARTY_NOTICES.md");
const workflow = await readText(".github/workflows/ci.yml");
await readText("scripts/verify-release-tag.mjs");
await readText(".openai/hosting.json");

const releaseMatch = /APP_VERSION\s*=\s*"([^"]+)"/u.exec(releaseSource);
assert(releaseMatch, "lib/release.ts must export a literal APP_VERSION.");
const releaseVersion = releaseMatch[1];
const packageVersion = packageJson.version;
parseVersion(packageVersion, "package.json version");

assert(
  releaseVersion === packageVersion,
  `APP_VERSION ${releaseVersion} does not match package.json ${packageVersion}.`,
);
assert(
  packageLock.version === packageVersion &&
    packageLock.packages?.[""]?.version === packageVersion,
  "package-lock.json root versions do not match package.json.",
);
assert(
  packageJson.engines?.node === ">=22.13.0",
  "the supported Node.js floor must remain >=22.13.0.",
);
assert(
  compareVersions(
    parseVersion(process.versions.node, "current Node.js runtime"),
    [22, 13, 0],
  ) >= 0,
  `Node.js ${process.versions.node} is below the supported 22.13.0 floor.`,
);
assert(
  packageJson.dependencies?.next ===
    packageJson.devDependencies?.["@next/eslint-plugin-next"],
  "next and @next/eslint-plugin-next must use the same version.",
);
assert(
  packageJson.dependencies?.tailwindcss === undefined &&
    packageJson.devDependencies?.tailwindcss === undefined &&
    packageJson.dependencies?.["@tailwindcss/postcss"] === undefined &&
    packageJson.devDependencies?.["@tailwindcss/postcss"] === undefined &&
    !/tailwind/iu.test(postcssSource),
  "unused Tailwind packages or PostCSS configuration are still present.",
);

const releaseSurfaceFiles = [
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/SECURITY.md",
  "docs/MVP_SPEC.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "components/ProjectConverter.tsx",
  "components/ConverterShell.tsx",
  "lib/input/v1.ts",
];
for (const relativePath of releaseSurfaceFiles) {
  const source = await readText(relativePath);
  for (const match of source.matchAll(/\bv(0\.0\.\d+)\b/gu)) {
    assert(
      match[1] === packageVersion,
      `${relativePath} still references v${match[1]} instead of v${packageVersion}.`,
    );
  }
}

assert(
  readme.includes("GitHub Pages") &&
    readme.includes("正式生产发布的唯一来源") &&
    readme.includes("Sites 兼容的备用预览") &&
    readme.includes("陈旧备用环境") &&
    readme.includes("不能为单个仓库配置任意 HTTP 响应安全头"),
  "README must document Pages production, stale Sites fallback, and response-header limits.",
);
assert(
  packageJson.scripts?.build?.includes("vinext"),
  "the Sites-compatible Vinext fallback build must remain available.",
);
assert(
  /node:\s*\[\s*["']22\.13\.0["']\s*,\s*["']24["']\s*\]/u.test(workflow),
  "CI must test the Node.js 22.13.0 floor and Node.js 24.",
);
assert(
  workflow.includes("npm run verify:release"),
  "CI must run the release-version gate explicitly.",
);
assert(
  /tags:\s*\n\s*- ["']v\*["']/u.test(workflow) &&
    workflow.includes("fetch-depth: 0") &&
    workflow.includes("if: github.ref_type == 'tag'") &&
    workflow.includes("npm run verify:release:tag"),
  "CI must fetch tag history and run the tag/version/commit release gate.",
);

for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  assert(
    thirdPartyNotices.includes(`| \`${name}\` | \`${version}\` |`),
    `THIRD_PARTY_NOTICES.md does not list production dependency ${name}@${version}.`,
  );
}
assert(
  thirdPartyNotices.includes("仓库根目录目前没有 `LICENSE`") &&
    thirdPartyNotices.includes("仍需仓库所有者明确决定") &&
    thirdPartyNotices.includes("SaigeVisionProjectAssistant.ZipFixer.exe") &&
    thirdPartyNotices.includes("image-size-2.0.3-saige.2.tgz"),
  "third-party notices must retain root-license, helper, and vendored-fork governance.",
);

console.log(
  `Release v${packageVersion} verified (Node.js >=22.13.0; Pages production; Sites fallback).`,
);
