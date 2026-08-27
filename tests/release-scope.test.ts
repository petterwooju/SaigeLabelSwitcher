import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowedOutputs } from "../components/projectCapabilities.ts";
import {
  APP_VERSION,
  isSupportedProjectType,
  SUPPORTED_PROJECT_TYPES,
} from "../lib/release.ts";

test("v0.0.3 metadata and visible release label stay in sync", async () => {
  const [packageText, lockText, shellText, readmeText] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../components/ConverterShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as { version?: string };
  const packageLock = JSON.parse(lockText) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };

  assert.equal(APP_VERSION, "0.0.3");
  assert.equal(packageJson.version, APP_VERSION);
  assert.equal(packageLock.version, APP_VERSION);
  assert.equal(packageLock.packages?.[""]?.version, APP_VERSION);
  assert.match(shellText, /`v\$\{APP_VERSION\}`/u);
  assert.ok(readmeText.includes(`当前发布：\`v${APP_VERSION}\``));
});

test("v0.0.3 exposes only Classification and Segmentation", () => {
  assert.deepEqual(SUPPORTED_PROJECT_TYPES, ["classification", "segmentation"]);
  assert.equal(isSupportedProjectType("classification"), true);
  assert.equal(isSupportedProjectType("segmentation"), true);
  assert.equal(isSupportedProjectType("detection"), false);
  assert.equal(isSupportedProjectType("unknown"), false);

  for (const projectType of ["classification", "segmentation"] as const) {
    assert.ok(allowedOutputs("v1-srproj", projectType).length > 0);
    assert.ok(allowedOutputs("v1-svpa", projectType).length > 0);
    assert.ok(allowedOutputs("v2-visionproj", projectType).length > 0);
    assert.ok(allowedOutputs("v2-subvisionproj", projectType).length > 0);
  }
  for (const projectType of ["detection", "unknown"] as const) {
    assert.deepEqual(allowedOutputs("v1-srproj", projectType), []);
    assert.deepEqual(allowedOutputs("v2-subvisionproj", projectType), []);
  }
});
