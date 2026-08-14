import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowedOutputs } from "../components/projectCapabilities.ts";

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
  assert.match(source, /该项目类型当前没有经过真实样本验证的安全转换路径/);
  assert.match(source, /No safe conversion path for this project type/);
  assert.match(source, /이 프로젝트 유형에는 실제 샘플로 검증된 안전한 변환 경로/);
});
