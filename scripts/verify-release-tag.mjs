import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const exactVersionPattern = /^\d+\.\d+\.\d+$/u;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

export function inspectReleaseTagContext(environment, packageVersion) {
  const ref = environment.GITHUB_REF ?? "";
  const refName = environment.GITHUB_REF_NAME ?? "";
  const refType = environment.GITHUB_REF_TYPE ?? "";
  const refIsTag = ref.startsWith("refs/tags/");
  const eventIsTag = refType === "tag" || refIsTag;

  if (!eventIsTag) return null;

  assert(
    refType === "tag" && refIsTag,
    "GITHUB_REF_TYPE and GITHUB_REF disagree about whether this is a tag event.",
  );
  assert(
    exactVersionPattern.test(packageVersion),
    `package.json version '${packageVersion}' is not an exact major.minor.patch version.`,
  );

  const tagFromRef = ref.slice("refs/tags/".length);
  assert(refName === tagFromRef, "GITHUB_REF_NAME does not match GITHUB_REF.");

  const expectedTag = `v${packageVersion}`;
  assert(
    refName === expectedTag,
    `release tag '${refName}' does not match package.json version '${packageVersion}' (expected '${expectedTag}').`,
  );

  const eventObjectId = environment.GITHUB_SHA ?? "";
  assert(
    objectIdPattern.test(eventObjectId),
    "GITHUB_SHA is missing or is not a complete Git object ID.",
  );

  return { eventObjectId, tagName: refName };
}

export function assertReleaseCommitMatches({
  eventCommit,
  headCommit,
  tagCommit,
}) {
  assert(
    tagCommit === headCommit,
    `tag resolves to ${tagCommit}, but the checked-out commit is ${headCommit}.`,
  );
  assert(
    eventCommit === headCommit,
    `GitHub event resolves to ${eventCommit}, but the checked-out commit is ${headCommit}.`,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Release tag verification failed: ${message}`);
  }
}

function resolveCommit(revision) {
  return execFileSync(
    "git",
    ["rev-parse", "--verify", `${revision}^{commit}`],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  ).trim();
}

async function main() {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const context = inspectReleaseTagContext(process.env, packageJson.version);

  if (!context) {
    console.log("Release tag verification skipped: current ref is not a tag.");
    return;
  }

  const headCommit = resolveCommit("HEAD");
  const tagCommit = resolveCommit(`refs/tags/${context.tagName}`);
  const eventCommit = resolveCommit(context.eventObjectId);
  assertReleaseCommitMatches({ eventCommit, headCommit, tagCommit });

  console.log(
    `Release tag ${context.tagName} matches package.json and commit ${headCommit}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
