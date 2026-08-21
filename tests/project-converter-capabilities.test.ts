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
    code: "V2_CLASS_DESCRIPTION_NOT_IN_V1",
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

test("routine V2 audit metadata stays in technical diagnostics without prompting users", () => {
  const routineMetadata = [
    "V2_FILE_TIMESTAMP_NOT_IN_V1",
    "V2_LABEL_TIMESTAMP_NOT_IN_V1",
    "V2_SPLIT_NAME_NOT_IN_V1",
    "V2_DATASET_IDENTITY_NOT_IN_V1",
  ].map((code) => ({ code, disposition: "drop" as const }));

  for (const diagnostic of routineMetadata) {
    assert.equal(targetIncludesDiagnostic(diagnostic, "srproj"), false);
    assert.equal(targetIncludesDiagnostic(diagnostic, "svpa-zip"), false);
  }
  assert.equal(targetConfirmationMode(routineMetadata, "srproj"), "none");
  assert.equal(targetConfirmationMode(routineMetadata, "svpa-zip"), "none");
  assert.equal(targetNeedsConfirmation(routineMetadata, "srproj"), false);
  assert.equal(targetNeedsConfirmation(routineMetadata, "svpa-zip"), false);

  const actionableLoss = {
    code: "V2_CLASS_DESCRIPTION_NOT_IN_V1",
    disposition: "drop" as const,
  };
  const relativePath = {
    code: "V2_EXTERNAL_PATH_RELATIVE",
    disposition: "degrade" as const,
  };
  assert.equal(targetIncludesDiagnostic(actionableLoss, "srproj"), true);
  assert.equal(
    targetConfirmationMode([...routineMetadata, actionableLoss], "srproj"),
    "loss",
  );
  assert.equal(
    targetConfirmationMode([...routineMetadata, relativePath], "srproj"),
    "relative-path",
  );
  assert.equal(
    targetConfirmationMode([...routineMetadata, relativePath], "svpa-zip"),
    "none",
  );
  assert.equal(
    targetConfirmationMode(
      [...routineMetadata, relativePath, actionableLoss],
      "srproj",
    ),
    "mixed",
  );
  assert.equal(
    targetConfirmationMode(
      [...routineMetadata, relativePath, actionableLoss],
      "svpa-zip",
    ),
    "loss",
  );
});

test("verified routine V1 settings stay in technical diagnostics without prompting users", () => {
  const routineNodes = [
    "TrainingParameter",
    "AugmentationParameter",
    "SpecificType",
    "OtherSettings",
    "MultipageParameter",
  ].map((nodeName) => ({
    code: "V1_UNMAPPED_XML_NODE",
    disposition: "drop" as const,
    details: { nodeName },
  }));

  for (const diagnostic of routineNodes) {
    assert.equal(targetIncludesDiagnostic(diagnostic, "visionproj"), false);
    assert.equal(targetIncludesDiagnostic(diagnostic, "subvisionproj"), false);
  }
  assert.equal(targetConfirmationMode(routineNodes, "visionproj"), "none");
  assert.equal(targetConfirmationMode(routineNodes, "subvisionproj"), "none");
  assert.equal(targetNeedsConfirmation(routineNodes, "visionproj"), false);
  assert.equal(targetNeedsConfirmation(routineNodes, "subvisionproj"), false);

  const unknownNode = {
    code: "V1_UNKNOWN_XML_NODE",
    disposition: "drop" as const,
    details: { nodeName: "FutureSetting" },
  };
  assert.equal(targetIncludesDiagnostic(unknownNode, "visionproj"), true);
  assert.equal(targetConfirmationMode([unknownNode], "visionproj"), "loss");
});

test("parser diagnostics apply only to the output targets named in their details", () => {
  const blockedForV2 = {
    code: "V1_SEGMENTATION_OK_CLASS_RESERVED_IN_V2",
    disposition: "block" as const,
    details: { blockedTargets: ["visionproj", "subvisionproj"] },
  };
  const alphaLossForV2 = {
    code: "V1_CLASS_COLOR_ALPHA_NOT_IN_V2",
    disposition: "degrade" as const,
    details: { affectedTargets: ["visionproj", "subvisionproj"] },
  };

  for (const target of ["visionproj", "subvisionproj"] as const) {
    assert.equal(targetIncludesDiagnostic(blockedForV2, target), true);
    assert.equal(targetIncludesDiagnostic(alphaLossForV2, target), true);
    assert.equal(targetNeedsConfirmation([alphaLossForV2], target), true);
  }
  for (const target of ["svpa-zip", "srproj"] as const) {
    assert.equal(targetIncludesDiagnostic(blockedForV2, target), false);
    assert.equal(targetIncludesDiagnostic(alphaLossForV2, target), false);
    assert.equal(targetNeedsConfirmation([alphaLossForV2], target), false);
  }
});

test("ProjectConverter uses the capability matrix for loading and rendering", async () => {
  const source = await readFile(
    new URL("../components/ProjectConverter.tsx", import.meta.url),
    "utf8",
  );
  const saveService = await readFile(
    new URL("../lib/output/conversionSave.ts", import.meta.url),
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
  assert.match(
    source,
    /unsupported: `v\$\{APP_VERSION\} 仅支持 Classification 和多边形 Segmentation/,
  );
  assert.match(
    source,
    /unsupported: `v\$\{APP_VERSION\} supports only Classification and polygon Segmentation/,
  );
  assert.match(
    source,
    /unsupported: `v\$\{APP_VERSION\}은 Classification 및 다각형 Segmentation만 지원/,
  );
  assert.match(source, /disabled: format === "subvisionproj" && projectHasRelativePaths/);
  assert.match(source, /relativePathConfirmation/);
  assert.equal((source.match(/mixedConfirmation:/g) ?? []).length, 3);
  assert.equal((source.match(/mixedConfirmationLabel:/g) ?? []).length, 3);
  assert.match(source, /confirmationMode === "mixed"/);
  assert.match(
    source,
    /prepareConversionOutput\(\{[\s\S]*?allowConfirmedLoss: confirmationChecked \|\| !needsConfirmation/,
  );
  assert.equal(
    (source.match(/allowConfirmedLoss: confirmationChecked \|\| !needsConfirmation/g) ?? []).length,
    1,
  );
  assert.match(
    saveService,
    /target === "srproj"[\s\S]*?writeSrproj\(workingProject,[\s\S]*?allowConfirmedLoss,/,
  );
});
