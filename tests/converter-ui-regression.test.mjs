import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readUiSources() {
  const [converter, shell, saveService] = await Promise.all([
    readFile(new URL("components/ProjectConverter.tsx", root), "utf8"),
    readFile(new URL("components/ConverterShell.tsx", root), "utf8"),
    readFile(new URL("lib/output/conversionSave.ts", root), "utf8"),
  ]);
  return { converter, shell, saveService };
}

test("filters compatibility diagnostics for the selected target version", async () => {
  const { converter } = await readUiSources();

  assert.match(
    converter,
    /item\.category === "compatibility" && !includeCompatibility/,
  );
  assert.match(converter, /targetIncludesDiagnostic\(diagnostic, target\)/);
});

test("preserves save results and guards the complete image verification path", async () => {
  const { converter, shell, saveService } = await readUiSources();

  assert.equal((converter.match(/completedSave = await/g) ?? []).length, 1);
  assert.match(converter, /setSaveResult\(completedSave\)/);
  assert.match(converter, /saveInFlightRef\.current/);
  assert.match(
    converter,
    /if \(requiresImages \|\| requiresDimensions\)[\s\S]*?if \(!resolved\) throw[\s\S]*?verifyAndEnrichProjectImages/,
  );
  assert.doesNotMatch(converter, /enrichProjectImageDimensions/);
  assert.match(shell, /result\.mode === "direct"/);
  assert.match(shell, /result\.fileName/);
  assert.match(converter, /prepareConversionOutput\(\{/);
  assert.match(converter, /commitPreparedConversionOutput\(/);
  assert.match(converter, /isBlobFallbackSafe\(prepared\.estimatedBytes\)/);
  assert.match(converter, /preparedSaveRef\.current = \{/);
  assert.match(saveService, /prepareVisionArchive\(\{/);
  assert.match(saveService, /prepareSvpaArchive\(\{/);
});

test("keeps language, parse failure, dimension-only copy, and save-picker busy state explicit", async () => {
  const { converter, shell } = await readUiSources();

  assert.match(converter, /document\.documentElement\.lang = localeByLanguage\[language\]/);
  assert.match(converter, /loaded\?\.parseResult\.ok && loaded\.project/);
  assert.match(converter, /parserAlreadyExplainedFailure/);
  assert.match(converter, /diagnostic\.severity === "error"/);
  assert.match(shell, /summary\.purpose === "dimensions"/);
  assert.match(shell, /imageHelpDimensions/);
  assert.match(shell, /progress\?\.stage === "choosing-save-location"/);
  assert.equal((shell.match(/imageHelpDimensions:/g) ?? []).length, 3);
  assert.equal((shell.match(/successDirect:/g) ?? []).length, 3);
  assert.equal((shell.match(/successDownload:/g) ?? []).length, 3);
});

test("cancels every long operation and clears selected image sources safely", async () => {
  const { converter, shell, saveService } = await readUiSources();

  assert.match(converter, /beginOperation\("loading-project"\)/);
  assert.match(converter, /loadProject\(sourceFile, \{ signal \}\)/);
  assert.match(converter, /beginOperation\("reading-directory"\)/);
  assert.match(converter, /\{ signal, includeFile: isSupportedImagePath \}/);
  assert.match(converter, /beginOperation\("reading-image-zip"\)/);
  assert.match(converter, /beginOperation\("saving"\)/);
  assert.match(converter, /verifyAndEnrichProjectImages[\s\S]*?\{[\s\S]*?signal,/);
  assert.match(converter, /commitPreparedConversionOutput\([\s\S]*?signal,/);
  assert.match(saveService, /writePreparedVisionArchive\(\{[\s\S]*?signal: options\.signal/);
  assert.match(saveService, /writePreparedSvpaArchive\(\{[\s\S]*?signal: options\.signal/);
  assert.match(saveService, /saveBlob\(destination, prepared\.blob, options\.signal\)/);
  assert.match(converter, /operation\?\.controller\.abort\(\)/);
  assert.match(converter, /activeOperationRef\.current\?\.controller\.abort\(\)/);
  assert.match(converter, /selectedImageArchivesRef\.current = new Map\(\)/);
  assert.match(converter, /setSelectedFiles\(\[\]\)/);
  assert.match(converter, /setDirectoryCount\(0\)/);
  assert.match(shell, /onClick=\{onCancel\}/);
  assert.equal((shell.match(/cancel:/g) ?? []).length, 3);
  assert.equal((shell.match(/clearImageSources:/g) ?? []).length, 3);
});

test("localizes permission fallbacks, save picker descriptions, and raw diagnostics", async () => {
  const { converter, shell } = await readUiSources();

  assert.equal((converter.match(/directoryPermissionFallback:/g) ?? []).length, 3);
  assert.equal((converter.match(/savePickerDownloadFallback:/g) ?? []).length, 3);
  assert.equal((converter.match(/helperLoadFailed:/g) ?? []).length, 3);
  assert.equal((converter.match(/helperIntegrityFailed:/g) ?? []).length, 3);
  assert.match(converter, /case "HELPER_LOAD_FAILED": return copy\.helperLoadFailed/);
  assert.match(
    converter,
    /case "HELPER_INTEGRITY_FAILED": return copy\.helperIntegrityFailed/,
  );
  assert.match(converter, /isPermissionFallbackError\(error\)/);
  assert.match(converter, /saveType\(target, operationLanguage\)/);
  assert.match(converter, /satisfies Record<ConverterLanguage, Record<ConverterOutputFormat, string>>/);
  assert.equal((converter.match(/diagnosticTimestampLoss:/g) ?? []).length, 3);
  assert.equal((converter.match(/diagnosticSplitLoss:/g) ?? []).length, 3);
  assert.equal((converter.match(/diagnosticGeometryLoss:/g) ?? []).length, 3);
  assert.equal((converter.match(/diagnosticRoiLoss:/g) ?? []).length, 3);
  assert.doesNotMatch(converter, /SVPA_HELPER_UNSIGNED|helperUnsigned:/);
  assert.doesNotMatch(converter, /trainingSettingsNotMapped|trainingSettingsAdded/);
  assert.doesNotMatch(shell, /尚未签名|not yet signed|아직 서명/);
  assert.match(converter, /if \(language === "en"\) return item\.message/);
  assert.equal((converter.match(/imageDimensionsMismatch:/g) ?? []).length, 3);
  assert.equal((converter.match(/imageFormatUnsupported:/g) ?? []).length, 3);
  assert.match(
    converter,
    /const message = localized \?\?[\s\S]*?language === "en" && item\.message/,
  );
  assert.match(converter, /V2_EXTERNAL_PATH_RELATIVE/);
  assert.match(converter, /relativePathConfirmation/);
});

test("describes project resource limits without claiming that the source is damaged", async () => {
  const { converter } = await readUiSources();

  assert.equal((converter.match(/projectScaleLimit:/g) ?? []).length, 3);
  assert.match(
    converter,
    /case "PROJECT_TEXT_TOO_LARGE":[\s\S]*?case "V1_TEXT_LIMIT_EXCEEDED":[\s\S]*?case "V2_TEXT_LIMIT_EXCEEDED": return copy\.projectScaleLimit/,
  );
  assert.match(
    converter,
    /if \(isProjectScaleLimitCode\(code\)\) return copy\.projectScaleLimit;[\s\S]*?code\.startsWith\("ZIP_"\)/,
  );
  assert.match(
    converter,
    /if \(isProjectScaleLimitCode\(item\.code\)\) \{[\s\S]*?return uiCopy\[language\]\.projectScaleLimit;[\s\S]*?\}[\s\S]*?if \(language === "en"\) return item\.message/,
  );
  assert.match(converter, /ZIP_TEXT_TOO_LARGE/);
  assert.match(converter, /ZIP_TOTAL_TOO_LARGE/);
  assert.match(converter, /这不表示项目文件已损坏/);
  assert.match(converter, /This does not mean the project file is damaged/);
  assert.match(converter, /프로젝트 파일이 손상되었다는 의미는 아닙니다/);
});

test("separates blocking conversion failures from retryable source and I/O errors", async () => {
  const { converter } = await readUiSources();

  assert.match(converter, /hasBlockingRuntimeDiagnostic/);
  assert.match(converter, /!hasBlockingRuntimeDiagnostic/);
  assert.match(converter, /blocking: true,[\s\S]*?retryable: false/u);
  assert.match(
    converter,
    /severity: "warning",[\s\S]*?blocking: false,[\s\S]*?retryable: true/u,
  );
  assert.match(
    converter,
    /return \{ severity: "error", code, blocking: false, retryable: true \}/u,
  );
});

test("uses per-instance heading ids and focuses meaningful state transitions", async () => {
  const { shell } = await readUiSources();

  assert.doesNotMatch(shell, /id="converter-(?:source|images|diagnostics)-heading"/);
  assert.match(shell, /const headingId = useId\(\)/);
  assert.match(shell, /sourceHeadingRef\.current/);
  assert.match(shell, /diagnosticHeadingRef\.current/);
  assert.match(shell, /successHeadingRef\.current/);
  assert.match(shell, /tabIndex=\{-1\}/);
});
