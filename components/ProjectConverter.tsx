"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  ConverterShell,
  type ConverterLanguage,
  type ConverterOutputFormat,
  type ConverterOutputOption,
  type ConverterProgress,
  type ConverterSourceSummary,
  type ConverterStatus,
  type ImageMatchIssue,
  type ImageMatchSummary,
} from "./ConverterShell";
import {
  allowedOutputs,
  hasRelativeExternalPaths,
  targetConfirmationMode,
  targetIncludesDiagnostic,
} from "./projectCapabilities.ts";
import {
  openValidatedZip,
  type OpenArchive,
} from "../lib/archive/zip.ts";
import {
  DirectoryReadError,
  pickDirectoryFiles,
  readWebkitDirectoryFiles,
  supportsFileSystemDirectoryPicker,
  type DirectoryPickerWindow,
  type WebkitDirectoryInput,
} from "../lib/files/directoryPicker.ts";
import {
  createProjectImageReferences,
  matchImageFiles,
  mergeArchiveImageEntries,
  mergePickedDirectoryFiles,
  selectedSourceUsage,
  type ImageMatchReport,
  type SelectedSourceFile,
} from "../lib/files/imageMatcher.ts";
import { assertSourceSelectionUsage } from "../lib/files/sourceSelectionLimits.ts";
import {
  projectHasEmbeddedImages,
  projectImagePaths,
  resolveProjectImages,
  type ResolvedImageSet,
} from "../lib/files/resolveImages.ts";
import {
  loadProject,
  type LoadedProject,
} from "../lib/input/loadProject.ts";
import type { ProjectIR, ProjectSourceFormat } from "../lib/model/project.ts";
import {
  ContainerWriteError,
  type ContainerProgress,
} from "../lib/output/containers.ts";
import {
  isBlobFallbackSafe,
  requestSaveDestination,
  SaveCancelledError,
  type SaveDestination,
  type SaveResult,
} from "../lib/output/save.ts";
import {
  commitPreparedConversionOutput,
  prepareConversionOutput,
  WriterDiagnosticsError,
  type PreparedConversionOutput,
} from "../lib/output/conversionSave.ts";
import { safeOutputStem } from "../lib/output/fileNames.ts";
import { SrprojWriteError } from "../lib/output/srproj.ts";
import {
  addedSelectionId,
  batchLabelFromPaths,
  removeSelectedSourceBatch,
  retainImageMatchIssues,
  statusAfterSuccessfulImageSelection,
  summarizeImageSourceBatches,
  type ImageSourceBatchKind,
  type ImageSourceBatchMetadata,
} from "./imageSourceState.ts";
import {
  localeByLanguage,
  projectTypeLabel,
  saveType,
  shortPath,
  toUiDiagnostic,
  toUiDiagnostics,
  toUiRuntimeDiagnostic,
  uiCopy,
  type RuntimeDiagnostic,
} from "./projectConverterCopy.ts";

type StableStatus = "idle" | "inspecting" | "ready" | "saving" | "success" | "error" | "unsupported";

type OperationKind = "loading-project" | "reading-directory" | "reading-image-zip" | "saving";

interface ActiveOperation {
  readonly kind: OperationKind;
  readonly controller: AbortController;
}

interface PreparedSaveContext {
  readonly generation: number;
  readonly target: ConverterOutputFormat;
  readonly language: ConverterLanguage;
  readonly output: PreparedConversionOutput;
}

export function ProjectConverter() {
  const [language, setLanguageState] = useState<ConverterLanguage>("zh");
  const [status, setStatus] = useState<StableStatus>("idle");
  const [pendingSource, setPendingSource] = useState<ConverterSourceSummary | null>(null);
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [target, setTarget] = useState<ConverterOutputFormat | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<readonly SelectedSourceFile[]>([]);
  const [selectedSourceBatches, setSelectedSourceBatches] = useState<
    readonly ImageSourceBatchMetadata[]
  >([]);
  const [confirmationChecked, setConfirmationChecked] = useState(false);
  const [progress, setProgress] = useState<ConverterProgress | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [directoryMatching, setDirectoryMatching] = useState(false);
  const [savePrepared, setSavePrepared] = useState(false);
  const fallbackDirectoryInput = useRef<HTMLInputElement>(null);
  const imageFilesInput = useRef<HTMLInputElement>(null);
  const imageZipInput = useRef<HTMLInputElement>(null);
  const loadedRef = useRef<LoadedProject | null>(null);
  const selectedFilesRef = useRef<readonly SelectedSourceFile[]>([]);
  const selectedSourceBatchesRef = useRef<readonly ImageSourceBatchMetadata[]>([]);
  const selectedImageArchivesRef = useRef<Map<string, OpenArchive>>(new Map());
  const runtimeDiagnosticsRef = useRef<readonly RuntimeDiagnostic[]>([]);
  const imageZipSequenceRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const finalizingSaveRef = useRef(false);
  const preparedSaveRef = useRef<PreparedSaveContext | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const directoryMatchingRef = useRef(false);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const fallbackDirectoryContextRef = useRef<{
    readonly generation: number;
    readonly loaded: LoadedProject;
  } | null>(null);
  const imageFilesContextRef = useRef<{
    readonly generation: number;
    readonly loaded: LoadedProject;
  } | null>(null);
  const imageZipContextRef = useRef<{
    readonly generation: number;
    readonly loaded: LoadedProject;
  } | null>(null);

  const beginOperation = useCallback((kind: OperationKind): ActiveOperation => {
    activeOperationRef.current?.controller.abort();
    finalizingSaveRef.current = false;
    const operation = { kind, controller: new AbortController() };
    activeOperationRef.current = operation;
    return operation;
  }, []);

  const finishOperation = useCallback((operation: ActiveOperation) => {
    if (activeOperationRef.current === operation) {
      activeOperationRef.current = null;
    }
  }, []);

  const discardPreparedSave = useCallback(() => {
    preparedSaveRef.current = null;
    setSavePrepared(false);
  }, []);

  const commitSelectedFiles = useCallback(
    (next: readonly SelectedSourceFile[], openArchiveCount: number) => {
      assertSourceSelectionUsage(selectedSourceUsage(next, openArchiveCount));
      selectedFilesRef.current = next;
      setSelectedFiles(next);
    },
    [],
  );

  const registerSelectedSourceBatch = useCallback(
    (batch: ImageSourceBatchMetadata) => {
      const next = [
        ...selectedSourceBatchesRef.current.filter((item) => item.id !== batch.id),
        batch,
      ];
      selectedSourceBatchesRef.current = next;
      setSelectedSourceBatches(next);
    },
    [],
  );

  const recoverAfterImageSourceChange = useCallback(() => {
    discardPreparedSave();
    setSaveResult(null);
    const remainingDiagnostics = clearImageSourceDiagnostics(
      runtimeDiagnosticsRef.current,
    );
    runtimeDiagnosticsRef.current = remainingDiagnostics;
    setRuntimeDiagnostics(remainingDiagnostics);
    setStatus((current) =>
      statusAfterSuccessfulImageSelection(
        current,
        Boolean(loadedRef.current?.project) &&
          !remainingDiagnostics.some((diagnostic) => diagnostic.blocking),
      ),
    );
  }, [discardPreparedSave]);

  const commitPickedSourceBatch = useCallback((
    picked: readonly { readonly file: File; readonly relativePath: string }[],
    kind: Exclude<ImageSourceBatchKind, "zip">,
  ) => {
    const previous = selectedFilesRef.current;
    const next = mergePickedDirectoryFiles(previous, picked);
    commitSelectedFiles(next, selectedImageArchivesRef.current.size);
    const selectionId = addedSelectionId(previous, next);
    if (selectionId) {
      const firstName = picked[0]?.file.name ?? "Images";
      const fallback = picked.length > 1
        ? `${firstName} +${picked.length - 1}`
        : firstName;
      registerSelectedSourceBatch({
        id: selectionId,
        kind,
        label: batchLabelFromPaths(
          picked.map((item) => item.relativePath),
          fallback,
        ),
      });
    }
    recoverAfterImageSourceChange();
  }, [commitSelectedFiles, recoverAfterImageSourceChange, registerSelectedSourceBatch]);

  const invalidateActiveOperation = useCallback(() => {
    const operation = activeOperationRef.current;
    activeOperationRef.current = null;
    operation?.controller.abort();
  }, []);

  const cancelOperation = useCallback(() => {
    if (finalizingSaveRef.current) return;
    activeOperationRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const operation = activeOperationRef.current;
      activeOperationRef.current = null;
      operation?.controller.abort();
      generationRef.current += 1;
      directoryMatchingRef.current = false;
      fallbackDirectoryContextRef.current = null;
      imageFilesContextRef.current = null;
      imageZipContextRef.current = null;
      preparedSaveRef.current = null;
      const imageArchives = selectedImageArchivesRef.current;
      selectedImageArchivesRef.current = new Map();
      selectedSourceBatchesRef.current = [];
      void closeOpenArchives(imageArchives.values());
      const current = loadedRef.current;
      loadedRef.current = null;
      void current?.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = localeByLanguage[language];
  }, [language]);

  useEffect(() => {
    runtimeDiagnosticsRef.current = runtimeDiagnostics;
  }, [runtimeDiagnostics]);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem("saige-converter-language");
    } catch {
      // Language persistence is best-effort in storage-restricted contexts.
    }
    if (saved === "zh" || saved === "en" || saved === "ko") {
      setLanguageState(saved);
      return;
    }
    const browserLanguage = navigator.language.toLocaleLowerCase();
    setLanguageState(browserLanguage.startsWith("ko") ? "ko" : browserLanguage.startsWith("en") ? "en" : "zh");
  }, []);

  const project = loaded?.project;
  const outputFormats = useMemo(
    () => (project ? allowedOutputs(loaded.format, project.project.type) : []),
    [loaded, project],
  );
  const requiresImages = target === "visionproj" || target === "svpa-zip";
  const requiresDimensions = Boolean(
    project &&
      (target === "visionproj" || target === "subvisionproj") &&
      project.files.some((file) => !file.width || !file.height),
  );
  const needsImageAccess = requiresImages || requiresDimensions;
  const embeddedImages = Boolean(project && projectHasEmbeddedImages(project));
  const references = useMemo(
    () => (project ? createProjectImageReferences(projectImagePaths(project)) : null),
    [project],
  );
  const matchReport = useMemo(
    () => (references ? matchImageFiles(references, selectedFiles) : null),
    [references, selectedFiles],
  );
  const sourceBatchSummaries = useMemo(
    () => summarizeImageSourceBatches(selectedFiles, selectedSourceBatches),
    [selectedFiles, selectedSourceBatches],
  );
  const directoryCount = selectedSourceBatches.reduce(
    (count, batch) => count + (batch.kind === "directory" ? 1 : 0),
    0,
  );
  const confirmationMode = loaded && isCrossVersion(loaded.format, target)
    ? targetConfirmationMode(loaded.parseResult.diagnostics, target)
    : "none";
  const needsConfirmation = Boolean(
    loaded?.parseResult.compatibility.status === "confirmation-required" &&
      confirmationMode !== "none",
  );
  const projectHasRelativePaths = Boolean(
    project &&
      hasRelativeExternalPaths(project.files.map((file) => file.sourcePath)),
  );
  const relativeSubvisionPath = projectHasRelativePaths && target === "subvisionproj";
  const compatibilityBlocked = Boolean(
    loaded &&
      isCrossVersion(loaded.format, target) &&
      loaded.parseResult.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          targetIncludesDiagnostic(diagnostic, target),
      ),
  );
  const projectUnsupported = Boolean(
    status === "unsupported" ||
      (project && (outputFormats.length === 0 || project.files.length === 0)),
  );
  const imagesReady = !needsImageAccess || embeddedImages || Boolean(matchReport?.canPackage);
  const hasBlockingRuntimeDiagnostic = runtimeDiagnostics.some(
    (diagnostic) => diagnostic.blocking,
  );
  const canSave = Boolean(
    project &&
      target &&
      !projectUnsupported &&
      !compatibilityBlocked &&
      project.files.length > 0 &&
      imagesReady &&
      !relativeSubvisionPath &&
      !hasBlockingRuntimeDiagnostic &&
      (!needsConfirmation || confirmationChecked) &&
      !directoryMatching &&
      status !== "inspecting" && status !== "saving",
  );

  const setLanguage = useCallback((next: ConverterLanguage) => {
    if (preparedSaveRef.current || saveInFlightRef.current) return;
    setLanguageState(next);
    try {
      window.localStorage.setItem("saige-converter-language", next);
    } catch {
      // Keep the in-memory choice even when persistence is unavailable.
    }
  }, []);

  const reset = useCallback(() => {
    invalidateActiveOperation();
    generationRef.current += 1;
    directoryMatchingRef.current = false;
    fallbackDirectoryContextRef.current = null;
    imageFilesContextRef.current = null;
    imageZipContextRef.current = null;
    preparedSaveRef.current = null;
    const imageArchives = selectedImageArchivesRef.current;
    selectedImageArchivesRef.current = new Map();
    void closeOpenArchives(imageArchives.values());
    const previous = loadedRef.current;
    loadedRef.current = null;
    void previous?.close().catch(() => undefined);
    setLoaded(null);
    setPendingSource(null);
    setTarget(null);
    selectedFilesRef.current = [];
    setSelectedFiles([]);
    selectedSourceBatchesRef.current = [];
    setSelectedSourceBatches([]);
    setConfirmationChecked(false);
    setRuntimeDiagnostics([]);
    setSaveResult(null);
    setProgress(null);
    setDirectoryMatching(false);
    setSavePrepared(false);
    setStatus("idle");
  }, [invalidateActiveOperation]);

  const handleFiles = useCallback(
    async (files: readonly File[]) => {
      if (!mountedRef.current) return;
      if (files.length !== 1) {
        invalidateActiveOperation();
        setRuntimeDiagnostics([{ severity: "error", code: "INPUT_COUNT_INVALID" }]);
        setStatus("error");
        return;
      }

      const sourceFile = files[0];
      const operation = beginOperation("loading-project");
      const { signal } = operation.controller;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const isCurrent = () =>
        mountedRef.current &&
        generationRef.current === generation &&
        activeOperationRef.current === operation;
      directoryMatchingRef.current = false;
      fallbackDirectoryContextRef.current = null;
      imageFilesContextRef.current = null;
      imageZipContextRef.current = null;
      preparedSaveRef.current = null;
      const imageArchives = selectedImageArchivesRef.current;
      selectedImageArchivesRef.current = new Map();
      const previous = loadedRef.current;
      loadedRef.current = null;
      setLoaded(null);
      setPendingSource({
        format: guessedFormat(sourceFile.name),
        fileName: sourceFile.name,
        fileSize: sourceFile.size,
      });
      setTarget(null);
      selectedFilesRef.current = [];
      setSelectedFiles([]);
      selectedSourceBatchesRef.current = [];
      setSelectedSourceBatches([]);
      setDirectoryMatching(false);
      setConfirmationChecked(false);
      setRuntimeDiagnostics([]);
      setSaveResult(null);
      setProgress({ stage: "inspecting" });
      setSavePrepared(false);
      setStatus("inspecting");

      try {
        await waitForAbortable(closeOpenArchives(imageArchives.values()), signal);
        if (previous) {
          await waitForAbortable(previous.close().catch(() => undefined), signal);
        }
        throwIfOperationAborted(signal);
        const next = await waitForAbortable(
          loadProject(sourceFile, { signal }),
          signal,
          (lateProject) => lateProject.close().catch(() => undefined),
        );
        if (!isCurrent()) {
          await next.close().catch(() => undefined);
          return;
        }
        loadedRef.current = next;
        setLoaded(next);
        setPendingSource(null);
        setProgress(null);
        if (!next.parseResult.ok || !next.project) {
          const parserAlreadyExplainedFailure = next.parseResult.diagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          );
          setRuntimeDiagnostics(
            parserAlreadyExplainedFailure
              ? []
              : [{ severity: "error", code: "PROJECT_PARSE_FAILED" }],
          );
          setStatus("error");
          return;
        }
        const emptyProject = next.project.files.length === 0;
        const formats = allowedOutputs(next.format, next.project.project.type);
        if (formats.length === 0 || emptyProject) {
          setRuntimeDiagnostics([{
            severity: "error",
            code: emptyProject ? "PROJECT_EMPTY" : "PROJECT_UNSUPPORTED",
          }]);
          setStatus("unsupported");
          return;
        }
        setTarget(formats[0] ?? null);
        setStatus("ready");
      } catch (error) {
        if (!isCurrent()) return;
        if (signal.aborted || isAbortError(error)) {
          setPendingSource(null);
          setProgress(null);
          setRuntimeDiagnostics([]);
          setStatus("idle");
          return;
        }
        setPendingSource({
          format: guessedFormat(sourceFile.name),
          fileName: sourceFile.name,
          fileSize: sourceFile.size,
        });
        setProgress(null);
        setRuntimeDiagnostics([diagnosticFromError(error, "PROJECT_PARSE_FAILED")]);
        setStatus("error");
      } finally {
        finishOperation(operation);
      }
    },
    [beginOperation, finishOperation, invalidateActiveOperation],
  );

  const chooseDirectory = useCallback(async () => {
    const currentLoaded = loadedRef.current;
    if (
      !project ||
      !currentLoaded ||
      currentLoaded.project !== project ||
      projectUnsupported ||
      directoryMatchingRef.current
    ) return;
    const generation = generationRef.current;

    if (!supportsFileSystemDirectoryPicker(window as DirectoryPickerWindow)) {
      const input = fallbackDirectoryInput.current as WebkitDirectoryInput | null;
      if (!input) {
        setRuntimeDiagnostics((current) => [
          ...current.filter((item) => item.code !== "DIRECTORY_UNSUPPORTED"),
          { severity: "error", code: "DIRECTORY_UNSUPPORTED", message: uiCopy[language].directoryUnsupported },
        ]);
        return;
      }
      fallbackDirectoryContextRef.current = { generation, loaded: currentLoaded };
      try {
        input.click();
      } catch (error) {
        fallbackDirectoryContextRef.current = null;
        setRuntimeDiagnostics((current) => [
          ...current.filter((item) => item.code !== "DIRECTORY_UNSUPPORTED"),
          diagnosticFromError(error, "DIRECTORY_UNSUPPORTED"),
        ]);
      }
      return;
    }

    const operation = beginOperation("reading-directory");
    const { signal } = operation.controller;
    const isCurrent = () =>
      mountedRef.current &&
      generationRef.current === generation &&
      loadedRef.current === currentLoaded &&
      activeOperationRef.current === operation;
    directoryMatchingRef.current = true;
    setDirectoryMatching(true);
    setProgress({ stage: "matching" });
    try {
      const picked = await waitForAbortable(
        pickDirectoryFiles(
          window as DirectoryPickerWindow,
          {
            mode: "read",
            id: "saigevision-project-images",
          },
          { signal, includeFile: isSupportedImagePath },
        ),
        signal,
      );
      if (!isCurrent()) return;
      if (picked.length === 0) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          {
            severity: "error",
            code: "DIRECTORY_EMPTY_FILE_LIST",
            message: uiCopy[language].directoryEmpty,
          },
        ));
        return;
      }
      commitPickedSourceBatch(picked, "directory");
    } catch (error) {
      if (!isCurrent()) return;
      if (signal.aborted || isAbortError(error)) return;
      if (isPermissionFallbackError(error)) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(current, {
          severity: "warning",
          code: "DIRECTORY_PERMISSION_FALLBACK",
        }));
        imageFilesContextRef.current = { generation, loaded: currentLoaded };
        try {
          imageFilesInput.current?.click();
        } catch {
          // The visible ordinary-file button remains available when a browser
          // also blocks the programmatic fallback click.
        }
      } else {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          directoryDiagnosticFromError(error, "DIRECTORY_UNSUPPORTED"),
        ));
      }
    } finally {
      if (isCurrent()) {
        directoryMatchingRef.current = false;
        setDirectoryMatching(false);
        setProgress(null);
      }
      finishOperation(operation);
    }
  }, [beginOperation, commitPickedSourceBatch, finishOperation, language, project, projectUnsupported]);

  const handleFallbackDirectory = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const context = fallbackDirectoryContextRef.current;
    fallbackDirectoryContextRef.current = null;
    const isCurrent = Boolean(
      context &&
        mountedRef.current &&
        generationRef.current === context.generation &&
        loadedRef.current === context.loaded,
    );
    if (isCurrent) {
      try {
        const picked = event.currentTarget.files
          ? readWebkitDirectoryFiles(event.currentTarget.files, {
              includeFile: isSupportedImagePath,
            })
          : [];
        if (picked.length === 0) {
          setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
            current,
            {
              severity: "error",
              code: "DIRECTORY_EMPTY_FILE_LIST",
              message: uiCopy[language].directoryEmpty,
            },
          ));
        } else {
          commitPickedSourceBatch(picked, "directory");
        }
      } catch (error) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          directoryDiagnosticFromError(error, "DIRECTORY_UNSUPPORTED"),
        ));
      }
    }
    event.currentTarget.value = "";
  }, [commitPickedSourceBatch, language]);

  const chooseImageFiles = useCallback(() => {
    const currentLoaded = loadedRef.current;
    if (!currentLoaded?.project || projectUnsupported || directoryMatchingRef.current) return;
    imageFilesContextRef.current = {
      generation: generationRef.current,
      loaded: currentLoaded,
    };
    imageFilesInput.current?.click();
  }, [projectUnsupported]);

  const handleImageFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const context = imageFilesContextRef.current;
    imageFilesContextRef.current = null;
    const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
    event.currentTarget.value = "";
    const isCurrent = Boolean(
      context &&
        mountedRef.current &&
        generationRef.current === context.generation &&
        loadedRef.current === context.loaded,
    );
    if (!isCurrent || files.length === 0 || !context?.loaded.project) return;

    try {
      const picked = readWebkitDirectoryFiles(files, {
        includeFile: isSupportedImagePath,
      });
      if (picked.length === 0) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          { severity: "error", code: "DIRECTORY_EMPTY_FILE_LIST" },
        ));
        return;
      }
      const losesDirectories = picked.some((item) => !item.relativePath.includes("/"));
      if (losesDirectories && hasDuplicateProjectBasenames(context.loaded.project)) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          {
            severity: "error",
            code: "IMAGE_FILES_NEED_RELATIVE_PATHS",
            message: uiCopy[language].imageFilesNeedPaths,
          },
        ));
        return;
      }
      commitPickedSourceBatch(picked, "files");
    } catch (error) {
      setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
        current,
        directoryDiagnosticFromError(error, "DIRECTORY_UNSUPPORTED"),
      ));
    }
  }, [commitPickedSourceBatch, language]);

  const chooseImageZip = useCallback(() => {
    const currentLoaded = loadedRef.current;
    if (!currentLoaded?.project || projectUnsupported || directoryMatchingRef.current) return;
    imageZipContextRef.current = {
      generation: generationRef.current,
      loaded: currentLoaded,
    };
    imageZipInput.current?.click();
  }, [projectUnsupported]);

  const handleImageZip = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const context = imageZipContextRef.current;
    imageZipContextRef.current = null;
    const zipFile = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!context || !zipFile || !context.loaded.project) return;
    const operation = beginOperation("reading-image-zip");
    const { signal } = operation.controller;
    const isCurrent = () =>
      mountedRef.current &&
      generationRef.current === context.generation &&
      loadedRef.current === context.loaded &&
      activeOperationRef.current === operation;
    if (!isCurrent()) {
      finishOperation(operation);
      return;
    }

    const selectionId = [
      "image-zip",
      context.generation,
      ++imageZipSequenceRef.current,
    ].join("::");

    directoryMatchingRef.current = true;
    setDirectoryMatching(true);
    setProgress({ stage: "matching" });
    let archive: OpenArchive | undefined;
    try {
      archive = await waitForAbortable(
        openValidatedZip(zipFile, {}, signal),
        signal,
        (lateArchive) => lateArchive.close().catch(() => undefined),
      );
      if (!isCurrent()) {
        await archive.close();
        return;
      }
      const imageEntries = archive.entries
        .filter((entry) => isSupportedImagePath(entry.name))
        .map((entry) => ({
          entryName: entry.name,
          relativePath: entry.name,
          size: entry.uncompressedSize,
        }));
      if (imageEntries.length === 0) {
        await archive.close();
        archive = undefined;
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          {
            severity: "error",
            code: "IMAGE_ZIP_EMPTY",
            message: uiCopy[language].imageZipEmpty,
          },
        ));
        return;
      }
      const retainedArchive = archive;
      const nextFiles = mergeArchiveImageEntries(
        selectedFilesRef.current,
        retainedArchive,
        imageEntries,
        selectionId,
      );
      commitSelectedFiles(nextFiles, selectedImageArchivesRef.current.size + 1);
      selectedImageArchivesRef.current.set(selectionId, retainedArchive);
      registerSelectedSourceBatch({
        id: selectionId,
        kind: "zip",
        label: zipFile.name,
      });
      archive = undefined;
      recoverAfterImageSourceChange();
    } catch (error) {
      await archive?.close().catch(() => undefined);
      if (isCurrent() && !signal.aborted && !isAbortError(error)) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          diagnosticFromError(error, "IMAGE_ZIP_EMPTY"),
        ));
      }
    } finally {
      if (isCurrent()) {
        directoryMatchingRef.current = false;
        setDirectoryMatching(false);
        setProgress(null);
      }
      finishOperation(operation);
    }
  }, [
    beginOperation,
    commitSelectedFiles,
    finishOperation,
    language,
    recoverAfterImageSourceChange,
    registerSelectedSourceBatch,
  ]);

  const clearImageSources = useCallback(() => {
    invalidateActiveOperation();
    directoryMatchingRef.current = false;
    fallbackDirectoryContextRef.current = null;
    imageFilesContextRef.current = null;
    imageZipContextRef.current = null;
    const imageArchives = selectedImageArchivesRef.current;
    selectedImageArchivesRef.current = new Map();
    void closeOpenArchives(imageArchives.values());
    if (fallbackDirectoryInput.current) fallbackDirectoryInput.current.value = "";
    if (imageFilesInput.current) imageFilesInput.current.value = "";
    if (imageZipInput.current) imageZipInput.current.value = "";
    selectedFilesRef.current = [];
    setSelectedFiles([]);
    selectedSourceBatchesRef.current = [];
    setSelectedSourceBatches([]);
    setDirectoryMatching(false);
    setProgress(null);
    recoverAfterImageSourceChange();
  }, [invalidateActiveOperation, recoverAfterImageSourceChange]);

  const removeImageSource = useCallback((selectionId: string) => {
    if (activeOperationRef.current || saveInFlightRef.current) return;
    const previous = selectedFilesRef.current;
    const next = removeSelectedSourceBatch(previous, selectionId);
    if (next.length === previous.length) return;

    const archive = selectedImageArchivesRef.current.get(selectionId);
    const nextArchiveCount = selectedImageArchivesRef.current.size - (archive ? 1 : 0);
    commitSelectedFiles(next, nextArchiveCount);
    if (archive) {
      selectedImageArchivesRef.current.delete(selectionId);
      void archive.close().catch(() => undefined);
    }

    const nextBatches = selectedSourceBatchesRef.current.filter(
      (batch) => batch.id !== selectionId,
    );
    selectedSourceBatchesRef.current = nextBatches;
    setSelectedSourceBatches(nextBatches);
    recoverAfterImageSourceChange();
  }, [commitSelectedFiles, recoverAfterImageSourceChange]);

  const save = useCallback(async () => {
    if (
      !loaded?.project ||
      !target ||
      !canSave ||
      directoryMatchingRef.current ||
      saveInFlightRef.current
    ) return;
    saveInFlightRef.current = true;
    const operation = beginOperation("saving");
    const { signal } = operation.controller;
    let operationLanguage = language;
    setSaveResult(null);
    try {
      const generation = generationRef.current;
      const currentLoaded = loaded;
      const cached = preparedSaveRef.current;
      const preparedContext =
        cached &&
        cached.generation === generation &&
        cached.target === target
          ? cached
          : null;
      operationLanguage = preparedContext?.language ?? language;
      const isCurrent = () =>
        mountedRef.current &&
        generationRef.current === generation &&
        loadedRef.current === currentLoaded &&
        activeOperationRef.current === operation;
      const updateProgress = (next: ConverterProgress) => {
        if (isCurrent()) {
          if (next.stage === "finalizing") finalizingSaveRef.current = true;
          setProgress(next);
        }
      };
      const originalProject = loaded.project;
      const fileName = outputFileName(originalProject, target);
      setStatus("saving");
      setRuntimeDiagnostics((current) => current.filter((item) => item.sticky));
      let prepared = preparedContext?.output;
      let destination: SaveDestination;

      if (prepared) {
        // This is the second, user-activated phase for a large streaming
        // output. All deterministic conversion and helper checks completed on
        // the first click, before the system picker can create a placeholder.
        updateProgress({ stage: "choosing-save-location" });
        destination = await waitForAbortable(
          requestSaveDestination(
            prepared.fileName,
            saveType(target, operationLanguage),
          ),
          signal,
        );
        if (!isCurrent()) return;
      } else {
        updateProgress({ stage: "converting" });
        let workingProject = originalProject;
        let imageOutputPaths: Readonly<Record<number, string>> | undefined;
        let resolved: ResolvedImageSet | undefined = needsImageAccess
          ? resolveProjectImages(
              originalProject,
              loaded.archive,
              matchReport ?? undefined,
            )
          : undefined;
        if (needsImageAccess) {
          if (!resolved?.complete) {
            throw new Error(uiCopy[operationLanguage].selectImages);
          }
        }

        // Complete outputs verify every selected image header and declared size.
        // Lightweight V2 output performs the same check only when it needed
        // source images to recover missing dimensions.
        if (requiresImages || requiresDimensions) {
          if (!resolved) throw new Error(uiCopy[operationLanguage].selectImages);
          const { verifyAndEnrichProjectImages } = await import("../lib/files/imageDimensions.ts");
          if (!isCurrent()) return;
          const enriched = await verifyAndEnrichProjectImages(
            workingProject,
            resolved.images,
            {
              signal,
              repairMismatchedExtensions:
                target === "visionproj" || target === "svpa-zip",
              onProgress: ({ completed, total }) => updateProgress({
                stage: "reading",
                current: completed,
                total,
                unit: "items",
                label: uiCopy[operationLanguage].dimensions,
              }),
            },
          );
          if (!isCurrent()) return;
          if (!enriched.complete) {
            setRuntimeDiagnostics(enriched.issues.map((issue) => ({
              severity: "error",
              code: issue.code,
              path: shortPath(issue.path),
              pathTitle: issue.path,
              message: issue.message,
              blocking: true,
              retryable: false,
            })));
            setProgress(null);
            setStatus("error");
            return;
          }
          workingProject = enriched.project;
          resolved = { ...resolved, images: enriched.resolvedImages };
          imageOutputPaths =
            target === "visionproj"
              ? Object.fromEntries(
                  enriched.resolvedImages.flatMap((image) => {
                    const outputPath = image.source.relativePath?.trim();
                    return outputPath
                      ? [[image.fileIndex, outputPath] as const]
                      : [];
                  }),
                )
              : undefined;
        }

        prepared = await prepareConversionOutput({
          target,
          fileName,
          originalProject,
          workingProject,
          images: resolved?.images,
          imageOutputPaths,
          sourceFormat: loaded.format,
          sourceProjectXmlText: loaded.projectXmlText,
          originalProjectDirectory:
            loaded.svpaManifest?.OriginalProjectDirectory ?? "",
          language: localeByLanguage[operationLanguage],
          allowConfirmedLoss: confirmationChecked || !needsConfirmation,
          signal,
        });
        if (!isCurrent()) return;
        if (!isBlobFallbackSafe(prepared.estimatedBytes)) {
          preparedSaveRef.current = {
            generation,
            target,
            language: operationLanguage,
            output: prepared,
          };
          setSavePrepared(true);
          setProgress(null);
          setStatus("ready");
          return;
        }
        // Small and medium outputs are completely prepared before the browser
        // download starts, so no system-picker placeholder can be left behind.
        destination = { fileName: prepared.fileName };
      }

      throwIfOperationAborted(signal);
      updateProgress({ stage: "converting" });
      const completedSave = await commitPreparedConversionOutput(
        prepared,
        destination,
        {
          signal,
          onProgress: (value) => updateProgress(containerProgress(value)),
        },
      );
      if (!isCurrent()) return;
      if (!Number.isSafeInteger(completedSave.size) || completedSave.size <= 0) {
        throw Object.assign(new Error("The generated project file is empty."), {
          code: "EMPTY_SAVE_RESULT",
        });
      }
      preparedSaveRef.current = null;
      setSavePrepared(false);
      setProgress(null);
      setSaveResult(completedSave);
      setStatus("success");
    } catch (error) {
      const isCurrent =
        mountedRef.current && activeOperationRef.current === operation;
      if (!isCurrent) return;
      setProgress(null);
      if (
        signal.aborted ||
        error instanceof SaveCancelledError ||
        isAbortError(error)
      ) {
        setStatus(loadedRef.current?.project ? "ready" : "idle");
        return;
      }
      if (error instanceof WriterDiagnosticsError) {
        discardPreparedSave();
        setRuntimeDiagnostics(
          error.diagnostics.map((item) => ({
            ...toUiDiagnostic(item, operationLanguage),
            code: item.code,
            blocking: true,
            retryable: false,
          })),
        );
      } else {
        const diagnostic = saveDiagnosticFromError(error);
        if (diagnostic.blocking) discardPreparedSave();
        setRuntimeDiagnostics((current) => [
          ...current,
          diagnostic,
        ]);
      }
      setStatus("error");
    } finally {
      finalizingSaveRef.current = false;
      saveInFlightRef.current = false;
      finishOperation(operation);
    }
  }, [
    beginOperation,
    canSave,
    confirmationChecked,
    discardPreparedSave,
    finishOperation,
    language,
    loaded,
    matchReport,
    needsConfirmation,
    needsImageAccess,
    requiresDimensions,
    requiresImages,
    target,
  ]);

  const outputs: readonly ConverterOutputOption[] = projectUnsupported
    ? []
    : outputFormats.map((format, index) => ({
        id: format,
        format,
        selected: target === format,
        recommended: index === 0,
        disabled: format === "subvisionproj" && projectHasRelativePaths,
        ...(format === "subvisionproj" && projectHasRelativePaths
          ? { disabledReason: uiCopy[language].relativeSubvision }
          : {}),
      }));
  const imageMatch = project && needsImageAccess
    ? buildImageSummary(
        project,
        embeddedImages,
        matchReport,
        directoryCount,
        directoryMatching,
        selectedFiles.length,
        sourceBatchSummaries,
        requiresImages ? "package" : "dimensions",
      )
    : null;
  const diagnostics = [
    ...toUiDiagnostics(
      loaded?.parseResult.diagnostics ?? [],
      language,
      Boolean(loaded && isCrossVersion(loaded.format, target)),
      target,
    ),
    ...runtimeDiagnostics.map((item) => toUiRuntimeDiagnostic(item, language)),
    ...(relativeSubvisionPath
      ? [{
          severity: "error" as const,
          code: "V2_WRITE_EXTERNAL_PATH_ABSOLUTE_REQUIRED",
          message: uiCopy[language].relativeSubvision,
        }]
      : []),
  ];
  const shellStatus = effectiveStatus(
    status,
    project,
    target,
    needsImageAccess,
    imagesReady,
    needsConfirmation,
    confirmationChecked,
    projectUnsupported || compatibilityBlocked,
  );

  return (
    <>
      <ConverterShell
        language={language}
        status={shellStatus}
        source={
          loaded?.parseResult.ok && loaded.project
            ? sourceSummary(loaded, language)
            : status === "inspecting"
              ? pendingSource
              : null
        }
        outputs={outputs}
        imageMatch={imageMatch}
        diagnostics={diagnostics}
        confirmation={needsConfirmation ? {
          required: true,
          checked: confirmationChecked,
          message:
            confirmationMode === "relative-path"
              ? uiCopy[language].relativeV1Path
              : confirmationMode === "mixed"
                ? uiCopy[language].mixedConfirmation
              : uiCopy[language].confirmation,
          ...(confirmationMode === "relative-path"
            ? { label: uiCopy[language].relativePathConfirmation }
            : confirmationMode === "mixed"
              ? { label: uiCopy[language].mixedConfirmationLabel }
              : {}),
        } : null}
        progress={progress}
        saveResult={saveResult}
        preparedForSave={savePrepared}
        canSave={canSave}
        onSelectFile={handleFiles}
        onDrop={handleFiles}
        onTargetChange={(id) => {
          if (projectUnsupported || directoryMatchingRef.current || status === "unsupported") return;
          discardPreparedSave();
          setTarget(id);
          setConfirmationChecked(false);
          setSaveResult(null);
          setStatus("ready");
          setRuntimeDiagnostics((current) => current.filter((item) => item.sticky));
        }}
        onSelectDirectory={chooseDirectory}
        onSelectImageFiles={chooseImageFiles}
        onSelectImageZip={chooseImageZip}
        onClearImageSources={clearImageSources}
        onRemoveImageSource={removeImageSource}
        onConfirmationChange={setConfirmationChecked}
        onLanguageChange={setLanguage}
        onSave={save}
        onCancel={cancelOperation}
        onReset={reset}
      />
      <input
        ref={(node) => {
          fallbackDirectoryInput.current = node;
          if (node) {
            const directoryInput = node as WebkitDirectoryInput;
            directoryInput.webkitdirectory = true;
            directoryInput.directory = true;
          }
        }}
        hidden
        type="file"
        accept="image/*"
        multiple
        onChange={handleFallbackDirectory}
      />
      <input
        ref={imageFilesInput}
        hidden
        type="file"
        accept=".png,.jpg,.jpeg,.bmp,.gif,.webp,image/png,image/jpeg,image/bmp,image/gif,image/webp"
        multiple
        onChange={handleImageFiles}
      />
      <input
        ref={imageZipInput}
        hidden
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        onChange={handleImageZip}
      />
    </>
  );
}

function guessedFormat(fileName: string): ProjectSourceFormat {
  const lower = fileName.toLocaleLowerCase();
  if (lower.endsWith(".visionproj")) return "v2-visionproj";
  if (lower.endsWith(".subvisionproj")) return "v2-subvisionproj";
  if (lower.endsWith(".zip")) return "v1-svpa";
  return "v1-srproj";
}

function isCrossVersion(format: ProjectSourceFormat, target: ConverterOutputFormat | null): boolean {
  const sourceV1 = format === "v1-srproj" || format === "v1-svpa";
  const targetV1 = target === "srproj" || target === "svpa-zip";
  return target !== null && sourceV1 !== targetV1;
}

function effectiveStatus(
  status: StableStatus,
  project: ProjectIR | undefined,
  target: ConverterOutputFormat | null,
  requiresImages: boolean,
  imagesReady: boolean,
  needsConfirmation: boolean,
  confirmationChecked: boolean,
  projectUnsupported: boolean,
): ConverterStatus {
  if (status === "idle" || status === "inspecting" || status === "saving" || status === "success" || status === "unsupported") return status;
  if (status === "error") return "error";
  if (projectUnsupported) return "unsupported";
  if (!project || !target) return "choosing-output";
  if (requiresImages && !imagesReady) return "needs-images";
  if (needsConfirmation && !confirmationChecked) return "needs-confirmation";
  return "ready";
}

function sourceSummary(loaded: LoadedProject, language: ConverterLanguage): ConverterSourceSummary {
  const project = loaded.project;
  if (!project) return { format: loaded.format, fileName: loaded.sourceFile.name, fileSize: loaded.sourceFile.size };
  const splitCounts = new Map<string, number>();
  for (const file of project.files) splitCounts.set(file.canonicalSplit, (splitCounts.get(file.canonicalSplit) ?? 0) + 1);
  const labels = project.files.reduce((count, file) => count + file.labels.length, 0);
  const copy = uiCopy[language];
  const splitSummary = [
    [copy.training, splitCounts.get("training")],
    [copy.validation, splitCounts.get("validation")],
    [copy.unassigned, splitCounts.get("unassigned")],
  ].filter((entry) => entry[1]).map(([name, count]) => `${name} ${count}`).join(" · ");
  return {
    format: loaded.format,
    fileName: loaded.sourceFile.name,
    fileSize: loaded.sourceFile.size,
    projectName: project.project.name,
    projectType: projectTypeLabel(project, copy),
    version: loaded.format.startsWith("v1-") ? "V1 · 0.9" : "V2",
    imageCount: project.files.length,
    classCount: project.classes.length,
    labelCount: labels,
    splitSummary,
  };
}

function buildImageSummary(
  project: ProjectIR,
  embedded: boolean,
  report: ImageMatchReport | null,
  directoryCount: number,
  matching: boolean,
  selectedSourceCount: number,
  sourceBatches: NonNullable<ImageMatchSummary["sourceBatches"]>,
  purpose: ImageMatchSummary["purpose"],
): ImageMatchSummary {
  if (embedded) {
    return { state: "source-ready", purpose, totalCount: project.files.length, matchedCount: project.files.length, missingCount: 0, ambiguousCount: 0, directoryCount, hasSelectedSources: false, canSelectDirectory: false, issueCount: 0, sourceBatches: [] };
  }
  const current = report ?? matchImageFiles(projectImagePaths(project), []);
  const retained = retainImageMatchIssues(current);
  const issues: ImageMatchIssue[] = retained.issues.map((issue) => ({
    path: shortPath(issue.originalPath),
    pathTitle: issue.originalPath,
    status: issue.status,
  }));
  return {
    state: matching ? "matching" : current.canPackage ? "ready" : selectedSourceCount > 0 ? "incomplete" : "needs-directory",
    purpose,
    totalCount: current.totalCount,
    matchedCount: current.matchedCount,
    missingCount: current.missingCount + current.blankPathCount,
    ambiguousCount: current.ambiguousCount,
    matchedBytes: current.matchedBytes,
    directoryCount,
    hasSelectedSources: selectedSourceCount > 0,
    canSelectDirectory: true,
    issueCount: retained.issueCount,
    issues,
    sourceBatches,
  };
}


function outputFileName(project: ProjectIR, target: ConverterOutputFormat): string {
  const stem = safeOutputStem(project.project.name);
  if (target === "visionproj") return `${stem}.visionproj`;
  if (target === "subvisionproj") return `${stem}.subvisionproj`;
  if (target === "srproj") return `${stem}.srproj`;
  const now = new Date();
  const stamp = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("") + "_" + [pad(now.getHours()), pad(now.getMinutes())].join("");
  return `${stem}_SVPA_${stamp}.zip`;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }


function containerProgress(value: ContainerProgress): ConverterProgress {
  return {
    stage: value.stage === "images" || value.stage === "helper" ? "writing-images" : value.stage === "finalizing" ? "finalizing" : "converting",
    current: value.completedBytes,
    total: value.totalBytes,
    unit: "bytes",
    percent: value.percent,
    detail: shortPath(value.currentFile),
    detailTitle: value.currentFile,
  };
}


const IMAGE_SOURCE_DIAGNOSTIC_CODES = new Set([
  "DIRECTORY_UNSUPPORTED",
  "DIRECTORY_EMPTY_FILE_LIST",
  "DIRECTORY_DEPTH_LIMIT",
  "DIRECTORY_FILE_LIMIT",
  "DIRECTORY_SIZE_LIMIT",
  "DIRECTORY_PERMISSION_FALLBACK",
  "IMAGE_FILES_NEED_RELATIVE_PATHS",
  "IMAGE_ZIP_EMPTY",
  "ZIP_TOO_SMALL",
  "ZIP_INVALID",
]);

function clearImageSourceDiagnostics(
  diagnostics: readonly RuntimeDiagnostic[],
): RuntimeDiagnostic[] {
  return diagnostics.filter(
    (item) =>
      !item.code ||
      (!IMAGE_SOURCE_DIAGNOSTIC_CODES.has(item.code) &&
        !item.code.startsWith("IMAGE_") &&
        !item.code.startsWith("ZIP_")),
  );
}

function replaceImageSourceDiagnostic(
  diagnostics: readonly RuntimeDiagnostic[],
  next: RuntimeDiagnostic,
): RuntimeDiagnostic[] {
  return [
    ...clearImageSourceDiagnostics(diagnostics),
    {
      ...next,
      severity: "warning",
      blocking: false,
      retryable: true,
    },
  ];
}

function hasDuplicateProjectBasenames(project: ProjectIR): boolean {
  const names = project.files.map((file) =>
    file.fileName.normalize("NFKC").toLocaleLowerCase("en-US"),
  );
  return new Set(names).size !== names.length;
}

function isSupportedImagePath(value: string): boolean {
  return /\.(?:png|jpe?g|bmp|gif|webp)$/iu.test(value);
}

async function closeOpenArchives(archives: Iterable<OpenArchive>): Promise<void> {
  await Promise.all(
    Array.from(archives, (archive) => archive.close().catch(() => undefined)),
  );
}

function diagnosticFromError(error: unknown, fallbackCode: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "CONVERSION_FAILED",
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
    fallbackCode,
  };
}

function directoryDiagnosticFromError(
  error: unknown,
  fallbackCode: string,
): RuntimeDiagnostic {
  const code = error instanceof DirectoryReadError
    ? error.code
    : error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code.startsWith("DIRECTORY_")) {
    return { severity: "error", code };
  }
  return diagnosticFromError(error, fallbackCode);
}

function saveDiagnosticFromError(error: unknown): RuntimeDiagnostic {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "SAVE_FAILED";
  const deterministic =
    error instanceof SrprojWriteError ||
    error instanceof ContainerWriteError ||
    (error instanceof Error &&
      (error.name === "SrprojWriteError" || error.name === "ContainerWriteError"));
  return {
    severity: "error",
    code,
    blocking: deterministic,
    retryable: !deterministic,
  };
}


function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function isPermissionFallbackError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === "SecurityError" || name === "NotAllowedError";
}

function throwIfOperationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function waitForAbortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  onLateResolve?: (value: T) => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const disposeLateValue = (value: T) => {
      if (!onLateResolve) return;
      void Promise.resolve(onLateResolve(value)).catch(() => undefined);
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
    void pending.then(
      (value) => {
        if (settled) {
          disposeLateValue(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}
