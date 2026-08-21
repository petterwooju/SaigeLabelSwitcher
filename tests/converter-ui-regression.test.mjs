import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readUiSources() {
  const [converter, shell] = await Promise.all([
    readFile(new URL("components/ProjectConverter.tsx", root), "utf8"),
    readFile(new URL("components/ConverterShell.tsx", root), "utf8"),
  ]);
  return { converter, shell };
}

test("filters compatibility diagnostics for the selected target version", async () => {
  const { converter } = await readUiSources();

  assert.match(
    converter,
    /item\.category === "compatibility" && !includeCompatibility/,
  );
  assert.match(
    converter,
    /Boolean\(loaded && isCrossVersion\(loaded\.format, target\)\)/,
  );
});

test("preserves save results and guards the complete image verification path", async () => {
  const { converter, shell } = await readUiSources();

  assert.equal((converter.match(/completedSave = await/g) ?? []).length, 4);
  assert.match(converter, /setSaveResult\(completedSave\)/);
  assert.match(converter, /saveInFlightRef\.current/);
  assert.match(
    converter,
    /if \(requiresImages \|\| requiresDimensions\)[\s\S]*?if \(!resolved\) throw[\s\S]*?verifyAndEnrichProjectImages/,
  );
  assert.doesNotMatch(converter, /enrichProjectImageDimensions/);
  assert.match(shell, /result\.mode === "direct"/);
  assert.match(shell, /result\.fileName/);
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
  const { converter, shell } = await readUiSources();

  assert.match(converter, /beginOperation\("loading-project"\)/);
  assert.match(converter, /loadProject\(sourceFile, \{ signal \}\)/);
  assert.match(converter, /beginOperation\("reading-directory"\)/);
  assert.match(converter, /\{ signal, includeFile: isSupportedImagePath \}/);
  assert.match(converter, /beginOperation\("reading-image-zip"\)/);
  assert.match(converter, /beginOperation\("saving"\)/);
  assert.match(converter, /verifyAndEnrichProjectImages[\s\S]*?\{[\s\S]*?signal,/);
  assert.match(converter, /writeVisionArchive\(\{[\s\S]*?signal,/);
  assert.match(converter, /writeSvpaArchive\(\{[\s\S]*?signal,/);
  assert.equal((converter.match(/saveText\([\s\S]*?signal,[\s\S]*?\);/g) ?? []).length >= 2, true);
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
  assert.match(converter, /isPermissionFallbackError\(error\)/);
  assert.match(converter, /saveType\(target, language\)/);
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
  assert.match(converter, /localized \?\? copy\.saveFailed/);
  assert.match(converter, /V2_EXTERNAL_PATH_RELATIVE/);
  assert.match(converter, /relativePathConfirmation/);
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
