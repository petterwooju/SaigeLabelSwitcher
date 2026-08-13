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
  type ConverterDiagnostic,
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
  pickDirectoryFiles,
  readWebkitDirectoryFiles,
  supportsFileSystemDirectoryPicker,
  type DirectoryPickerWindow,
  type WebkitDirectoryInput,
} from "../lib/files/directoryPicker.ts";
import {
  createProjectImageReferences,
  matchImageFiles,
  mergePickedDirectoryFiles,
  type ImageMatchReport,
  type SelectedSourceFile,
} from "../lib/files/imageMatcher.ts";
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
import type {
  ProjectDiagnostic,
  ProjectIR,
  ProjectSourceFormat,
} from "../lib/model/project.ts";
import {
  writeSvpaArchive,
  writeVisionArchive,
  type AppLanguage,
  type ContainerProgress,
} from "../lib/output/containers.ts";
import {
  requestSaveDestination,
  SaveCancelledError,
  saveText,
  type SaveFileType,
} from "../lib/output/save.ts";
import { writeSrproj } from "../lib/output/srproj.ts";
import {
  writeV2SubvisionProject,
  writeV2VisionProject,
} from "../lib/output/v2.ts";

const localeByLanguage: Record<ConverterLanguage, AppLanguage> = {
  zh: "zh-CN",
  en: "en-US",
  ko: "ko-KR",
};

const uiCopy = {
  zh: {
    type: "分类 (Classification)",
    training: "训练",
    validation: "验证",
    unassigned: "未划分",
    multiple: "一次只能转换一个项目文件。",
    blocked: "该项目包含目标版本无法安全表示的内容，因此没有生成文件。",
    invalid: "项目文件已损坏或内容不完整，无法安全读取。",
    unsupported: "当前仅开放经过真实样本验证的 Classification 项目转换。",
    emptyProject: "项目中没有图片，当前没有可安全生成的目标格式。",
    detection: "检测 (Detection)",
    segmentation: "分割 (Segmentation)",
    unknownType: "未知类型",
    selectImages: "完整项目需要先选择原图片目录。",
    directoryUnsupported: "当前浏览器不能选择文件夹，请使用桌面版 Edge 或 Chrome。",
    dimensions: "正在读取图片尺寸…",
    imageFailure: "部分图片无法读取或不是受支持的图片格式。",
    saveFailed: "转换未完成，源文件未被修改。",
    confirmation: "目标版本无法保留上方列出的部分源字段；确认后将按已验证的核心字段转换。",
    relativeSubvision: "轻量项目必须引用可用的绝对图片路径；当前项目含相对路径，请改选 .visionproj。",
  },
  en: {
    type: "Classification",
    training: "Training",
    validation: "Validation",
    unassigned: "Unassigned",
    multiple: "Choose exactly one project file at a time.",
    blocked: "The project contains data that cannot be represented safely in the target version.",
    invalid: "The project file is damaged or incomplete and could not be read safely.",
    unsupported: "Only Classification projects verified against real samples are enabled for now.",
    emptyProject: "The project contains no images, so no target format can be created safely.",
    detection: "Detection",
    segmentation: "Segmentation",
    unknownType: "Unknown type",
    selectImages: "Choose the original image folder before creating a complete project.",
    directoryUnsupported: "This browser cannot choose folders. Use desktop Edge or Chrome.",
    dimensions: "Reading image dimensions…",
    imageFailure: "Some files could not be read as supported images.",
    saveFailed: "Conversion did not finish. The source file was not changed.",
    confirmation: "Some source fields listed above cannot be retained in the target version. Confirm to continue with the verified core fields.",
    relativeSubvision: "A lightweight project requires usable absolute image paths. This project contains relative paths; choose .visionproj instead.",
  },
  ko: {
    type: "분류 (Classification)",
    training: "학습",
    validation: "검증",
    unassigned: "미분할",
    multiple: "프로젝트 파일을 한 번에 하나만 선택하세요.",
    blocked: "대상 버전에서 안전하게 표현할 수 없는 데이터가 포함되어 있습니다.",
    invalid: "프로젝트 파일이 손상되었거나 불완전하여 안전하게 읽을 수 없습니다.",
    unsupported: "현재는 실제 샘플로 검증된 Classification 프로젝트만 지원합니다.",
    emptyProject: "프로젝트에 이미지가 없어 안전하게 만들 수 있는 대상 형식이 없습니다.",
    detection: "검출 (Detection)",
    segmentation: "분할 (Segmentation)",
    unknownType: "알 수 없는 유형",
    selectImages: "완전한 프로젝트를 만들기 전에 원본 이미지 폴더를 선택하세요.",
    directoryUnsupported: "이 브라우저는 폴더 선택을 지원하지 않습니다. 데스크톱 Edge 또는 Chrome을 사용하세요.",
    dimensions: "이미지 크기를 읽는 중…",
    imageFailure: "일부 파일을 지원되는 이미지로 읽을 수 없습니다.",
    saveFailed: "변환이 완료되지 않았으며 원본 파일은 변경되지 않았습니다.",
    confirmation: "대상 버전에서 위의 일부 원본 필드를 유지할 수 없습니다. 검증된 핵심 필드로 계속하려면 확인하세요.",
    relativeSubvision: "경량 프로젝트에는 사용 가능한 절대 이미지 경로가 필요합니다. 상대 경로가 포함되어 있으므로 .visionproj를 선택하세요.",
  },
} satisfies Record<ConverterLanguage, Record<string, string>>;

type StableStatus = "idle" | "inspecting" | "ready" | "saving" | "success" | "error" | "unsupported";

interface RuntimeDiagnostic extends ConverterDiagnostic {
  readonly sticky?: boolean;
}

export function ProjectConverter() {
  const [language, setLanguageState] = useState<ConverterLanguage>("zh");
  const [status, setStatus] = useState<StableStatus>("idle");
  const [pendingSource, setPendingSource] = useState<ConverterSourceSummary | null>(null);
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [target, setTarget] = useState<ConverterOutputFormat | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<readonly SelectedSourceFile[]>([]);
  const [confirmationChecked, setConfirmationChecked] = useState(false);
  const [progress, setProgress] = useState<ConverterProgress | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [directoryCount, setDirectoryCount] = useState(0);
  const [directoryMatching, setDirectoryMatching] = useState(false);
  const fallbackDirectoryInput = useRef<HTMLInputElement>(null);
  const loadedRef = useRef<LoadedProject | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const directoryMatchingRef = useRef(false);
  const fallbackDirectoryContextRef = useRef<{
    readonly generation: number;
    readonly loaded: LoadedProject;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      directoryMatchingRef.current = false;
      fallbackDirectoryContextRef.current = null;
      const current = loadedRef.current;
      loadedRef.current = null;
      void current?.close().catch(() => undefined);
    };
  }, []);

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
    () => (project ? allowedOutputs(loaded.format) : []),
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
  const needsConfirmation = Boolean(
    loaded?.parseResult.compatibility.status === "confirmation-required" &&
      isCrossVersion(loaded.format, target),
  );
  const relativeSubvisionPath = Boolean(
    project &&
      target === "subvisionproj" &&
      project.files.some((file) => !isAbsoluteExternalPath(unquotePath(file.sourcePath))),
  );
  const compatibilityBlocked = loaded?.parseResult.compatibility.status === "blocked";
  const projectUnsupported = Boolean(
    status === "unsupported" ||
      compatibilityBlocked ||
      (project && (project.project.type !== "classification" || project.files.length === 0)),
  );
  const imagesReady = !needsImageAccess || embeddedImages || Boolean(matchReport?.canPackage);
  const canSave = Boolean(
    project &&
      target &&
      !projectUnsupported &&
      project.files.length > 0 &&
      imagesReady &&
      !relativeSubvisionPath &&
      (!needsConfirmation || confirmationChecked) &&
      !directoryMatching &&
      status !== "inspecting" && status !== "saving",
  );

  const setLanguage = useCallback((next: ConverterLanguage) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem("saige-converter-language", next);
    } catch {
      // Keep the in-memory choice even when persistence is unavailable.
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    directoryMatchingRef.current = false;
    fallbackDirectoryContextRef.current = null;
    const previous = loadedRef.current;
    loadedRef.current = null;
    void previous?.close().catch(() => undefined);
    setLoaded(null);
    setPendingSource(null);
    setTarget(null);
    setSelectedFiles([]);
    setDirectoryCount(0);
    setConfirmationChecked(false);
    setRuntimeDiagnostics([]);
    setProgress(null);
    setDirectoryMatching(false);
    setStatus("idle");
  }, []);

  const handleFiles = useCallback(
    async (files: readonly File[]) => {
      if (!mountedRef.current) return;
      if (files.length !== 1) {
        setRuntimeDiagnostics([{ severity: "error", code: "INPUT_COUNT_INVALID", message: uiCopy[language].multiple }]);
        setStatus("error");
        return;
      }

      const sourceFile = files[0];
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      directoryMatchingRef.current = false;
      fallbackDirectoryContextRef.current = null;
      const previous = loadedRef.current;
      loadedRef.current = null;
      await previous?.close().catch(() => undefined);
      if (!mountedRef.current || generationRef.current !== generation) return;
      setLoaded(null);
      setPendingSource({
        format: guessedFormat(sourceFile.name),
        fileName: sourceFile.name,
        fileSize: sourceFile.size,
      });
      setTarget(null);
      setSelectedFiles([]);
      setDirectoryCount(0);
      setDirectoryMatching(false);
      setConfirmationChecked(false);
      setRuntimeDiagnostics([]);
      setProgress({ stage: "inspecting" });
      setStatus("inspecting");

      try {
        const next = await loadProject(sourceFile);
        if (!mountedRef.current || generationRef.current !== generation) {
          await next.close().catch(() => undefined);
          return;
        }
        loadedRef.current = next;
        setLoaded(next);
        setPendingSource(null);
        setProgress(null);
        if (!next.parseResult.ok || !next.project) {
          setRuntimeDiagnostics([{ severity: "error", code: "PROJECT_PARSE_FAILED", message: uiCopy[language].invalid }]);
          setStatus("error");
          return;
        }
        const emptyProject = next.project.files.length === 0;
        const blocked = next.parseResult.compatibility.status === "blocked";
        if (next.project.project.type !== "classification" || blocked || emptyProject) {
          setRuntimeDiagnostics([{
            severity: "error",
            code: emptyProject ? "PROJECT_EMPTY" : blocked ? "PROJECT_BLOCKED" : "PROJECT_UNSUPPORTED",
            message: emptyProject
              ? uiCopy[language].emptyProject
              : blocked
                ? uiCopy[language].blocked
                : uiCopy[language].unsupported,
          }]);
          setStatus("unsupported");
          return;
        }
        const formats = allowedOutputs(next.format);
        setTarget(formats[0] ?? null);
        setStatus("ready");
      } catch (error) {
        if (!mountedRef.current || generationRef.current !== generation) return;
        setPendingSource({
          format: guessedFormat(sourceFile.name),
          fileName: sourceFile.name,
          fileSize: sourceFile.size,
        });
        setProgress(null);
        setRuntimeDiagnostics([diagnosticFromError(error, uiCopy[language].invalid)]);
        setStatus("error");
      }
    },
    [language],
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
          diagnosticFromError(error, uiCopy[language].directoryUnsupported),
        ]);
      }
      return;
    }

    directoryMatchingRef.current = true;
    setDirectoryMatching(true);
    setProgress({ stage: "matching" });
    try {
      const picked = await pickDirectoryFiles(window as DirectoryPickerWindow, {
        mode: "read",
        id: "saigevision-project-images",
      });
      if (
        !mountedRef.current ||
        generationRef.current !== generation ||
        loadedRef.current !== currentLoaded
      ) return;
      setSelectedFiles((current) => mergePickedDirectoryFiles(current, picked));
      setDirectoryCount((count) => count + 1);
      setRuntimeDiagnostics((current) => current.filter((item) => item.code !== "DIRECTORY_UNSUPPORTED"));
    } catch (error) {
      if (
        mountedRef.current &&
        generationRef.current === generation &&
        loadedRef.current === currentLoaded &&
        !isAbortError(error)
      ) {
        setRuntimeDiagnostics((current) => [...current, diagnosticFromError(error, uiCopy[language].directoryUnsupported)]);
      }
    } finally {
      if (
        mountedRef.current &&
        generationRef.current === generation &&
        loadedRef.current === currentLoaded
      ) {
        directoryMatchingRef.current = false;
        setDirectoryMatching(false);
        setProgress(null);
      }
    }
  }, [language, project, projectUnsupported]);

  const handleFallbackDirectory = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const context = fallbackDirectoryContextRef.current;
    fallbackDirectoryContextRef.current = null;
    const isCurrent = Boolean(
      context &&
        mountedRef.current &&
        generationRef.current === context.generation &&
        loadedRef.current === context.loaded,
    );
    if (isCurrent && event.currentTarget.files?.length) {
      const picked = readWebkitDirectoryFiles(event.currentTarget.files);
      setSelectedFiles((current) => mergePickedDirectoryFiles(current, picked));
      setDirectoryCount((count) => count + 1);
      setRuntimeDiagnostics((current) => current.filter((item) => item.code !== "DIRECTORY_UNSUPPORTED"));
    }
    event.currentTarget.value = "";
  }, []);

  const save = useCallback(async () => {
    if (!loaded?.project || !target || !canSave || directoryMatchingRef.current) return;
    const generation = generationRef.current;
    const currentLoaded = loaded;
    const isCurrent = () =>
      mountedRef.current &&
      generationRef.current === generation &&
      loadedRef.current === currentLoaded;
    const updateProgress = (next: ConverterProgress) => {
      if (isCurrent()) setProgress(next);
    };
    const originalProject = loaded.project;
    const fileName = outputFileName(originalProject, target);
    let destination;
    try {
      updateProgress({ stage: "choosing-save-location" });
      destination = await requestSaveDestination(fileName, saveType(target));
    } catch (error) {
      if (!isCurrent()) return;
      setProgress(null);
      if (error instanceof SaveCancelledError || isAbortError(error)) return;
      setRuntimeDiagnostics((current) => [...current, diagnosticFromError(error, uiCopy[language].saveFailed)]);
      setStatus("error");
      return;
    }

    if (!isCurrent()) return;
    setStatus("saving");
    setRuntimeDiagnostics((current) => current.filter((item) => item.sticky));
    updateProgress({ stage: "converting" });
    try {
      let workingProject = originalProject;
      let resolved: ResolvedImageSet | undefined;
      if (needsImageAccess) {
        resolved = resolveProjectImages(originalProject, loaded.archive, matchReport ?? undefined);
        if (!resolved.complete) {
          throw new Error(uiCopy[language].selectImages);
        }
      }

      // Classification labels in V2 use a full-image contour. V1 projects often
      // omit dimensions, so imageDimensions.ts enriches them before V2 writing.
      if (target === "visionproj" || target === "subvisionproj") {
        const missingDimensions = workingProject.files.some((file) => !file.width || !file.height);
        if (missingDimensions && !resolved) {
          throw new Error(uiCopy[language].selectImages);
        }
        if (missingDimensions && resolved) {
          const { enrichProjectImageDimensions } = await import("../lib/files/imageDimensions.ts");
          if (!isCurrent()) return;
          const enriched = await enrichProjectImageDimensions(
            workingProject,
            resolved.images,
            ({ completed, total }) => updateProgress({ stage: "reading", current: completed, total, unit: "items", label: uiCopy[language].dimensions }),
          );
          if (!isCurrent()) return;
          if (!enriched.complete) {
            setRuntimeDiagnostics(enriched.issues.map((issue) => ({ severity: "error", code: issue.code, path: shortPath(issue.path), message: issue.message })));
            throw new Error(uiCopy[language].imageFailure);
          }
          workingProject = enriched.project;
        }
      }

      if (target === "subvisionproj") {
        const result = writeV2SubvisionProject(workingProject, {
          externalPaths: externalPathsForProject(originalProject),
        });
        if (!result.ok) throw new WriterDiagnosticsError(result.diagnostics);
        updateProgress({ stage: "finalizing" });
        await saveText(destination, result.jsonText, "application/json;charset=utf-8");
      } else if (target === "visionproj") {
        const result = writeV2VisionProject(workingProject);
        if (!result.ok) throw new WriterDiagnosticsError(result.diagnostics);
        if (!resolved) throw new Error(uiCopy[language].selectImages);
        await writeVisionArchive({
          destination,
          built: result,
          images: resolved.images,
          onProgress: (value) => updateProgress(containerProgress(value)),
        });
      } else if (target === "srproj") {
        updateProgress({ stage: "finalizing" });
        await saveText(
          destination,
          writeSrproj(workingProject, {
            pathForFile: (file) => unquotePath(file.sourcePath),
          }),
          "application/xml;charset=utf-8",
        );
      } else {
        if (!resolved) throw new Error(uiCopy[language].selectImages);
        const pathForFile = (file: ProjectIR["files"][number]) => file.sourcePath;
        const srprojXml =
          loaded.format === "v1-srproj" && loaded.projectXmlText
            ? loaded.projectXmlText
            : writeSrproj(workingProject, { pathForFile });
        await writeSvpaArchive({
          destination,
          project: workingProject,
          srprojXml,
          images: resolved.images,
          language: localeByLanguage[language],
          originalProjectDirectory: loaded.svpaManifest?.OriginalProjectDirectory ?? "",
          onProgress: (value) => updateProgress(containerProgress(value)),
        });
      }
      if (!isCurrent()) return;
      setProgress(null);
      setStatus("success");
    } catch (error) {
      if (!isCurrent()) return;
      setProgress(null);
      if (error instanceof WriterDiagnosticsError) {
        setRuntimeDiagnostics(error.diagnostics.map(toUiDiagnostic));
      } else {
        setRuntimeDiagnostics((current) => [...current, diagnosticFromError(error, uiCopy[language].saveFailed)]);
      }
      setStatus("error");
    }
  }, [canSave, language, loaded, matchReport, needsImageAccess, target]);

  const outputs: readonly ConverterOutputOption[] = projectUnsupported
    ? []
    : outputFormats.map((format, index) => ({
        id: format,
        format,
        selected: target === format,
        recommended: index === 0,
      }));
  const imageMatch = project && needsImageAccess
    ? buildImageSummary(project, embeddedImages, matchReport, directoryCount, directoryMatching)
    : null;
  const diagnostics = [
    ...(loaded?.parseResult.diagnostics ?? []).filter((item) => item.severity !== "info").map(toUiDiagnostic),
    ...runtimeDiagnostics,
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
    projectUnsupported,
  );

  return (
    <>
      <ConverterShell
        language={language}
        status={shellStatus}
        source={loaded ? sourceSummary(loaded, language) : pendingSource}
        outputs={outputs}
        imageMatch={imageMatch}
        diagnostics={diagnostics}
        confirmation={needsConfirmation ? { required: true, checked: confirmationChecked, message: uiCopy[language].confirmation } : null}
        progress={progress}
        canSave={canSave}
        onSelectFile={handleFiles}
        onDrop={handleFiles}
        onTargetChange={(id) => {
          if (projectUnsupported || directoryMatchingRef.current || status === "unsupported") return;
          setTarget(id as ConverterOutputFormat);
          setConfirmationChecked(false);
          setStatus("ready");
          setRuntimeDiagnostics((current) => current.filter((item) => item.sticky));
        }}
        onSelectDirectory={chooseDirectory}
        onConfirmationChange={setConfirmationChecked}
        onLanguageChange={setLanguage}
        onSave={save}
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
    </>
  );
}

function allowedOutputs(format: ProjectSourceFormat): readonly ConverterOutputFormat[] {
  switch (format) {
    case "v1-srproj": return ["visionproj", "subvisionproj", "svpa-zip"];
    case "v1-svpa": return ["visionproj", "subvisionproj"];
    case "v2-visionproj": return ["svpa-zip"];
    case "v2-subvisionproj": return ["svpa-zip", "srproj"];
  }
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
): ImageMatchSummary {
  if (embedded) {
    return { state: "source-ready", totalCount: project.files.length, matchedCount: project.files.length, missingCount: 0, ambiguousCount: 0, directoryCount, canSelectDirectory: false };
  }
  const current = report ?? matchImageFiles(projectImagePaths(project), []);
  const issues: ImageMatchIssue[] = current.matches
    .filter((match) => match.status === "missing" || match.status === "ambiguous")
    .map((match) => ({ path: shortPath(match.projectPath.originalPath), status: match.status as "missing" | "ambiguous" }));
  return {
    state: matching ? "matching" : current.canPackage ? "ready" : directoryCount > 0 ? "incomplete" : "needs-directory",
    totalCount: current.totalCount,
    matchedCount: current.matchedCount,
    missingCount: current.missingCount + current.blankPathCount,
    ambiguousCount: current.ambiguousCount,
    matchedBytes: current.matchedBytes,
    directoryCount,
    canSelectDirectory: true,
    issues,
  };
}

function projectTypeLabel(
  project: ProjectIR,
  copy: (typeof uiCopy)[ConverterLanguage],
): string {
  switch (project.project.type) {
    case "classification": return copy.type;
    case "detection": return copy.detection;
    case "segmentation": return copy.segmentation;
    case "unknown": {
      const rawType = project.project.rawType.trim();
      return rawType ? `${copy.unknownType} · ${rawType}` : copy.unknownType;
    }
  }
}

function externalPathsForProject(project: ProjectIR): Readonly<Record<number, string>> {
  return Object.fromEntries(project.files.map((file) => [file.index, unquotePath(file.sourcePath)]));
}

function unquotePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function isAbsoluteExternalPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === "..")) return false;
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-z]:\//iu.test(normalized) ||
    /^file:\/\//iu.test(normalized)
  );
}

function outputFileName(project: ProjectIR, target: ConverterOutputFormat): string {
  const stem = safeStem(project.project.name);
  if (target === "visionproj") return `${stem}.visionproj`;
  if (target === "subvisionproj") return `${stem}.subvisionproj`;
  if (target === "srproj") return `${stem}.srproj`;
  const now = new Date();
  const stamp = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("") + "_" + [pad(now.getHours()), pad(now.getMinutes())].join("");
  return `${stem}_SVPA_${stamp}.zip`;
}

function safeStem(value: string): string {
  return Array.from(value.normalize("NFC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || '<>:"/\\|?*'.includes(character) ? "_" : character;
  }).join("").replace(/[ .]+$/u, "").trim() || "SaigeVision_Project";
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

function saveType(target: ConverterOutputFormat): SaveFileType {
  if (target === "visionproj") return { description: "SaigeVision V2 complete project", mimeType: "application/zip", extensions: [".visionproj"] };
  if (target === "subvisionproj") return { description: "SaigeVision V2 lightweight project", mimeType: "application/json", extensions: [".subvisionproj"] };
  if (target === "srproj") return { description: "SaigeVision V1 project", mimeType: "application/xml", extensions: [".srproj"] };
  return { description: "SaigeVision V1 complete project package", mimeType: "application/zip", extensions: [".zip"] };
}

function containerProgress(value: ContainerProgress): ConverterProgress {
  return {
    stage: value.stage === "images" || value.stage === "helper" ? "writing-images" : value.stage === "finalizing" ? "finalizing" : "converting",
    current: value.completedBytes,
    total: value.totalBytes,
    unit: "bytes",
    percent: value.percent,
    detail: shortPath(value.currentFile),
  };
}

function toUiDiagnostic(item: ProjectDiagnostic): ConverterDiagnostic {
  return { severity: item.severity, code: item.code, path: shortPath(item.path), message: item.message };
}

function diagnosticFromError(error: unknown, fallback: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "CONVERSION_FAILED",
    message: error instanceof Error && error.message ? error.message : fallback,
  };
}

function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : normalized;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

class WriterDiagnosticsError extends Error {
  readonly diagnostics: readonly ProjectDiagnostic[];
  constructor(diagnostics: readonly ProjectDiagnostic[]) {
    super("The target writer rejected this project.");
    this.name = "WriterDiagnosticsError";
    this.diagnostics = diagnostics;
  }
}
