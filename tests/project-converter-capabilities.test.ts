import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  allowedOutputs,
  hasRelativeExternalPaths,
  targetConfirmationMode,
  targetIncludesDiagnostic,
  targetNeedsConfirmation,
} from "../components/projectCapabilities.ts";

const expected = {
  "v1-srproj": ["visionproj", "subvisionproj", "svpa-zip"],
  "v1-svpa": ["visionproj", "subvisionproj"],
  "v2-visionproj": ["svpa-zip"],
  "v2-subvisionproj": ["svpa-zip", "srproj"],
} as const;

test("Classification and Segmentation share the verified output matrix", () => {
  for (const projectType of ["classification", "segmentation"] as const) {
    for (const [format, outputs] of Object.entries(expected)) {
      assert.deepEqual(
        allowedOutputs(format as keyof typeof expected, projectType),
        outputs,
      );
    }
  }
});

test("Detection and unknown project types expose no conversion target", () => {
  for (const projectType of ["detection", "unknown"] as const) {
    for (const format of Object.keys(expected)) {
      assert.deepEqual(
        allowedOutputs(format as keyof typeof expected, projectType),
        [],
      );
    }
  }
});

test("target-specific path rules keep portable SVPA output available", () => {
  const relativePath = [{
    code: "V2_EXTERNAL_PATH_RELATIVE",
    disposition: "degrade" as const,
  }];
  assert.equal(hasRelativeExternalPaths(["images/a.png"]), true);
  assert.equal(hasRelativeExternalPaths([String.raw`C:\images\a.png`]), false);
  assert.equal(hasRelativeExternalPaths([String.raw`"C:\images\a.png"`]), false);
  assert.equal(targetIncludesDiagnostic(relativePath[0]!, "srproj"), true);
  assert.equal(targetIncludesDiagnostic(relativePath[0]!, "svpa-zip"), false);
  assert.equal(targetConfirmationMode([], "srproj"), "none");
  assert.equal(targetConfirmationMode(relativePath, "srproj"), "relative-path");
  assert.equal(targetConfirmationMode(relativePath, "svpa-zip"), "none");
  assert.equal(targetNeedsConfirmation(relativePath, "srproj"), true);
  assert.equal(targetNeedsConfirmation(relativePath, "svpa-zip"), false);
  const fieldLoss = {
    code: "V2_TIMESTAMP_NOT_IN_V1",
    disposition: "drop" as const,
  };
  assert.equal(targetConfirmationMode([fieldLoss], "srproj"), "loss");
  assert.equal(
    targetConfirmationMode([...relativePath, fieldLoss], "srproj"),
    "mixed",
  );
  assert.equal(
    targetConfirmationMode([...relativePath, fieldLoss], "svpa-zip"),
    "loss",
  );
  assert.equal(
    targetNeedsConfirmation([...relativePath, fieldLoss], "svpa-zip"),
    true,
  );
});

test("ProjectConverter uses the capability matrix for loading and rendering", async () => {
  const source = await readFile(
    new URL("../components/ProjectConverter.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /allowedOutputs\(loaded\.format, project\.project\.type\)/,
  );
  assert.match(
    source,
    /allowedOutputs\(next\.format, next\.project\.project\.type\)/,
  );
  assert.equal((source.match(/allowedOutputs\(/g) ?? []).length, 2);
  assert.doesNotMatch(source, /project\.project\.type !== "classification"/);
  assert.doesNotMatch(source, /Only Classification projects/);
  assert.doesNotMatch(source, /仅开放经过真实样本验证的 Classification/);
  assert.doesNotMatch(source, /Classification 프로젝트만 지원/);
  assert.doesNotMatch(source, /class folder structure/);
  assert.doesNotMatch(source, /类别文件夹结构/);
  assert.doesNotMatch(source, /클래스 폴더 구조/);
  assert.match(source, /v0\.0\.1 仅支持 Classification 和多边形 Segmentation/);
  assert.match(source, /v0\.0\.1 supports only Classification and polygon Segmentation/);
  assert.match(source, /v0\.0\.1은 Classification 및 다각형 Segmentation만 지원/);
  assert.match(source, /disabled: format === "subvisionproj" && projectHasRelativePaths/);
  assert.match(source, /relativePathConfirmation/);
  assert.equal((source.match(/mixedConfirmation:/g) ?? []).length, 3);
  assert.equal((source.match(/mixedConfirmationLabel:/g) ?? []).length, 3);
  assert.match(source, /confirmationMode === "mixed"/);
  assert.match(source, /allowConfirmedLoss: confirmationChecked \|\| !needsConfirmation/);
});
