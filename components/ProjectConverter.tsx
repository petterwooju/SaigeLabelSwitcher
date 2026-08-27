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
  DEFAULT_DIRECTORY_MAX_DEPTH,
  DEFAULT_DIRECTORY_MAX_FILES,
  DEFAULT_DIRECTORY_MAX_TOTAL_BYTES,
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
import {
  assertSourceSelectionUsage,
  DEFAULT_SOURCE_SELECTION_MAX_FILES,
  DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES,
  DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES,
} from "../lib/files/sourceSelectionLimits.ts";
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
import { APP_VERSION } from "../lib/release.ts";
import {
  type AppLanguage,
  type ContainerProgress,
} from "../lib/output/containers.ts";
import {
  isBlobFallbackSafe,
  requestSaveDestination,
  SaveCancelledError,
  type SaveDestination,
  type SaveFileType,
  type SaveResult,
} from "../lib/output/save.ts";
import {
  commitPreparedConversionOutput,
  prepareConversionOutput,
  WriterDiagnosticsError,
  type PreparedConversionOutput,
} from "../lib/output/conversionSave.ts";
import { safeOutputStem } from "../lib/output/fileNames.ts";

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
    projectScaleLimit: "这不表示项目文件已损坏；文件规模或复杂度超过当前安全处理上限，暂时无法在浏览器中转换。",
    unsupported: `v${APP_VERSION} 仅支持 Classification 和多边形 Segmentation；该项目类型留待后续版本。`,
    emptyProject: "项目中没有图片，当前没有可安全生成的目标格式。",
    detection: "检测 (Detection)",
    segmentation: "分割 (Segmentation)",
    unknownType: "未知类型",
    selectImages: "完整项目需要先选择原图片目录。",
    directoryUnsupported: "当前浏览器不能选择文件夹，请使用桌面版 Edge 或 Chrome，或改用图片 ZIP。",
    directoryPermissionFallback: "无法读取该文件夹的权限，已改为普通图片文件选择。若项目含同名图片，请改用保留目录结构的图片 ZIP。",
    directoryEmpty: "当前浏览器没有向页面提供所选目录中的文件。请改用图片 ZIP；也可在桌面版 Edge 或 Chrome 中选择目录。",
    directoryDepthLimit: `所选目录超过最大扫描深度（${DEFAULT_DIRECTORY_MAX_DEPTH} 层）。`,
    directoryFileLimit: `所选目录包含超过 ${DEFAULT_DIRECTORY_MAX_FILES.toLocaleString("zh-CN")} 个候选图片。`,
    directorySizeLimit: `所选目录候选图片总大小超过 ${formatLimitBytes(DEFAULT_DIRECTORY_MAX_TOTAL_BYTES)}。`,
    imageFilesNeedPaths: "该项目含有同名图片，直接多选文件会丢失所属目录，无法安全匹配。请改用图片 ZIP，或在桌面版 Edge/Chrome 中选择目录。",
    imageZipEmpty: "所选 ZIP 中没有找到受支持的图片。请保留原图片目录结构后重新压缩。",
    sourceFileLimit: `累计选择的图片来源超过 ${DEFAULT_SOURCE_SELECTION_MAX_FILES.toLocaleString("zh-CN")} 个文件上限。请清空后选择更精确的目录或 ZIP。`,
    sourceSizeLimit: `累计选择的图片来源超过 ${formatLimitBytes(DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES)} 上限。请清空后缩小选择范围。`,
    sourceArchiveLimit: `累计打开的图片 ZIP 超过 ${DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES} 个上限。请清空后合并 ZIP 再选择。`,
    unmappedSourceField: "这个 V1 设置没有经过验证的 V2 对应字段，转换时不会写入目标项目。",
    diagnosticTimestampLoss: "目标格式不会保留源项目中的部分时间戳或内部标识字段。",
    diagnosticSplitLoss: "目标格式会规范化数据划分，部分划分名称、标识或多重归属无法保留。",
    diagnosticGeometryLoss: "目标格式无法完整保留部分标注几何信息。",
    diagnosticRoiLoss: "此 ROI 模式、形状或参数没有经过验证的跨版本映射。当前仅支持未启用和 Simple Rectangle。",
    diagnosticCompatibilityError: "该兼容性问题会阻止安全转换。",
    diagnosticCompatibilityWarning: "目标格式无法完整保留此项源信息。",
    diagnosticSecurityError: "项目包含不安全或超出限制的内容，已停止处理。",
    diagnosticValidationError: "项目内容无效或不完整，无法安全处理。",
    diagnosticValidationWarning: "项目内容存在需要注意的问题。",
    dimensions: "正在读取图片尺寸…",
    imageDimensionsMismatch: "项目记录的图片尺寸与实际图片不一致，已停止转换。",
    imageFormatUnsupported: "图片不是已验证支持的 PNG、JPEG、BMP、GIF 或 WebP 格式。",
    imageFormatMismatch: "图片扩展名或 MIME 类型与实际文件格式不一致。",
    imageTooLarge: "图片尺寸超过安全处理上限。",
    imageReadFailed: "无法安全读取部分项目图片。",
    saveFailed: "转换未完成，源文件未被修改。",
    helperLoadFailed: "无法读取路径修复工具。请检查网络连接后重试。",
    helperIntegrityFailed: "路径修复工具校验失败。请刷新页面后重试。",
    savePickerDownloadFallback: "无法打开系统保存位置选择器，已改用浏览器下载。",
    blobFallbackTooLarge: "项目过大，当前浏览器无法安全地在内存中完成下载。请使用最新版桌面 Edge 或 Chrome。",
    confirmation: "目标版本无法保留上方列出的部分源字段；确认后将按已验证的核心字段转换。",
    relativeSubvision: "轻量项目必须引用可用的绝对图片路径；当前项目含相对路径，请改选 .visionproj。",
    relativeV1Path: "导出的 .srproj 会保留相对图片路径；如果文件位置改变，V1 可能找不到原图片。",
    relativePathConfirmation: "我了解导出的 .srproj 会保留相对图片路径，文件位置改变后 V1 可能需要重新定位图片。",
    mixedConfirmation: "导出的 .srproj 会保留相对图片路径，文件位置改变后 V1 可能找不到原图片；同时，上方列出的其他源字段不会写入目标格式。",
    mixedConfirmationLabel: "我了解相对路径风险以及上方其他字段不会写入目标格式，并继续转换。",
  },
  en: {
    type: "Classification",
    training: "Training",
    validation: "Validation",
    unassigned: "Unassigned",
    multiple: "Choose exactly one project file at a time.",
    blocked: "The project contains data that cannot be represented safely in the target version.",
    invalid: "The project file is damaged or incomplete and could not be read safely.",
    projectScaleLimit: "This does not mean the project file is damaged. Its size or complexity exceeds the current safe processing limit, so it cannot yet be converted in the browser.",
    unsupported: `v${APP_VERSION} supports only Classification and polygon Segmentation; this project type is planned for a later release.`,
    emptyProject: "The project contains no images, so no target format can be created safely.",
    detection: "Detection",
    segmentation: "Segmentation",
    unknownType: "Unknown type",
    selectImages: "Choose the original image folder before creating a complete project.",
    directoryUnsupported: "This browser cannot choose folders. Use desktop Edge or Chrome, or choose an image ZIP.",
    directoryPermissionFallback: "Folder permission was unavailable, so ordinary image-file selection has opened instead. If the project has duplicate filenames, use an image ZIP that preserves folders.",
    directoryEmpty: "This browser did not provide any files from the selected folder. Choose an image ZIP instead, or select the folder in desktop Edge or Chrome.",
    directoryDepthLimit: `The selected folder exceeds the maximum scan depth of ${DEFAULT_DIRECTORY_MAX_DEPTH}.`,
    directoryFileLimit: `The selected folder contains more than ${DEFAULT_DIRECTORY_MAX_FILES.toLocaleString("en-US")} candidate images.`,
    directorySizeLimit: `The candidate images in the selected folder exceed ${formatLimitBytes(DEFAULT_DIRECTORY_MAX_TOTAL_BYTES)}.`,
    imageFilesNeedPaths: "This project contains duplicate image filenames. Direct file selection loses their folders and cannot be matched safely. Choose an image ZIP, or select the folder in desktop Edge/Chrome.",
    imageZipEmpty: "No supported images were found in the selected ZIP. Preserve the original image folder structure and create the ZIP again.",
    sourceFileLimit: `Selected image sources exceed the cumulative ${DEFAULT_SOURCE_SELECTION_MAX_FILES.toLocaleString("en-US")}-file limit. Clear them and choose a more precise folder or ZIP.`,
    sourceSizeLimit: `Selected image sources exceed the cumulative ${formatLimitBytes(DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES)} limit. Clear them and narrow the selection.`,
    sourceArchiveLimit: `More than ${DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES} image ZIPs are open. Clear them and combine the ZIPs before selecting again.`,
    unmappedSourceField: "This V1 setting has no verified V2 equivalent and will not be written to the target project.",
    diagnosticTimestampLoss: "The target format does not preserve some source timestamps or internal identifiers.",
    diagnosticSplitLoss: "The target format normalizes dataset splits, so some split names, identifiers, or multiple memberships cannot be preserved.",
    diagnosticGeometryLoss: "The target format cannot fully preserve some annotation geometry.",
    diagnosticRoiLoss: "This ROI mode, shape, or setting has no verified cross-version mapping. Only disabled ROI and Simple Rectangle are currently supported.",
    diagnosticCompatibilityError: "This compatibility issue prevents a safe conversion.",
    diagnosticCompatibilityWarning: "The target format cannot fully preserve this source information.",
    diagnosticSecurityError: "The project contains unsafe content or exceeds a safety limit, so processing stopped.",
    diagnosticValidationError: "The project content is invalid or incomplete and cannot be processed safely.",
    diagnosticValidationWarning: "The project content has an issue that needs attention.",
    dimensions: "Reading image dimensions…",
    imageDimensionsMismatch: "A recorded image size does not match the actual file, so conversion stopped.",
    imageFormatUnsupported: "An image is not a verified PNG, JPEG, BMP, GIF, or WebP file.",
    imageFormatMismatch: "An image extension or MIME type does not match its actual file format.",
    imageTooLarge: "An image exceeds the safe dimension limit.",
    imageReadFailed: "Some project images could not be read safely.",
    saveFailed: "Conversion did not finish. The source file was not changed.",
    helperLoadFailed: "The path repair helper could not be loaded. Check the network connection and try again.",
    helperIntegrityFailed: "The path repair helper failed its integrity check. Refresh the page and try again.",
    savePickerDownloadFallback: "The system save-location picker was unavailable, so the browser download fallback will be used.",
    blobFallbackTooLarge: "This project is too large for a safe in-memory browser download. Use the latest desktop Edge or Chrome.",
    confirmation: "Some source fields listed above cannot be retained in the target version. Confirm to continue with the verified core fields.",
    relativeSubvision: "A lightweight project requires usable absolute image paths. This project contains relative paths; choose .visionproj instead.",
    relativeV1Path: "The exported .srproj keeps relative image paths. V1 may not find the images if the file is moved.",
    relativePathConfirmation: "I understand that the exported .srproj keeps relative image paths and V1 may require the images to be relocated after the file is moved.",
    mixedConfirmation: "The exported .srproj keeps relative image paths, so V1 may not find the images if the file is moved. The other source fields listed above will also not be written to the target format.",
    mixedConfirmationLabel: "I understand both the relative-path risk and that the other listed fields will not be written to the target format, and want to continue.",
  },
  ko: {
    type: "분류 (Classification)",
    training: "학습",
    validation: "검증",
    unassigned: "미분할",
    multiple: "프로젝트 파일을 한 번에 하나만 선택하세요.",
    blocked: "대상 버전에서 안전하게 표현할 수 없는 데이터가 포함되어 있습니다.",
    invalid: "프로젝트 파일이 손상되었거나 불완전하여 안전하게 읽을 수 없습니다.",
    projectScaleLimit: "프로젝트 파일이 손상되었다는 의미는 아닙니다. 파일 크기나 복잡도가 현재 안전 처리 한도를 초과하여 아직 브라우저에서 변환할 수 없습니다.",
    unsupported: `v${APP_VERSION}은 Classification 및 다각형 Segmentation만 지원합니다. 이 프로젝트 유형은 이후 버전에서 지원할 예정입니다.`,
    emptyProject: "프로젝트에 이미지가 없어 안전하게 만들 수 있는 대상 형식이 없습니다.",
    detection: "검출 (Detection)",
    segmentation: "분할 (Segmentation)",
    unknownType: "알 수 없는 유형",
    selectImages: "완전한 프로젝트를 만들기 전에 원본 이미지 폴더를 선택하세요.",
    directoryUnsupported: "이 브라우저는 폴더 선택을 지원하지 않습니다. 데스크톱 Edge 또는 Chrome을 사용하거나 이미지 ZIP을 선택하세요.",
    directoryPermissionFallback: "폴더 읽기 권한을 사용할 수 없어 일반 이미지 파일 선택으로 전환했습니다. 프로젝트에 중복 파일명이 있으면 폴더 구조를 유지한 이미지 ZIP을 사용하세요.",
    directoryEmpty: "이 브라우저가 선택한 폴더의 파일을 페이지에 전달하지 않았습니다. 이미지 ZIP을 선택하거나 데스크톱 Edge/Chrome에서 폴더를 선택하세요.",
    directoryDepthLimit: `선택한 폴더가 최대 검색 깊이(${DEFAULT_DIRECTORY_MAX_DEPTH}단계)를 초과합니다.`,
    directoryFileLimit: `선택한 폴더에 후보 이미지가 ${DEFAULT_DIRECTORY_MAX_FILES.toLocaleString("ko-KR")}개보다 많습니다.`,
    directorySizeLimit: `선택한 폴더의 후보 이미지 총크기가 ${formatLimitBytes(DEFAULT_DIRECTORY_MAX_TOTAL_BYTES)}를 초과합니다.`,
    imageFilesNeedPaths: "이 프로젝트에는 이름이 같은 이미지가 있습니다. 파일 직접 선택은 폴더 정보를 잃어 안전하게 일치시킬 수 없습니다. 이미지 ZIP을 선택하거나 데스크톱 Edge/Chrome에서 폴더를 선택하세요.",
    imageZipEmpty: "선택한 ZIP에서 지원되는 이미지를 찾지 못했습니다. 원본 이미지 폴더 구조를 유지하여 다시 압축하세요.",
    sourceFileLimit: `선택한 이미지 소스가 누적 ${DEFAULT_SOURCE_SELECTION_MAX_FILES.toLocaleString("ko-KR")}개 파일 제한을 초과합니다. 지운 후 더 정확한 폴더 또는 ZIP을 선택하세요.`,
    sourceSizeLimit: `선택한 이미지 소스가 누적 ${formatLimitBytes(DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES)} 제한을 초과합니다. 지운 후 선택 범위를 줄이세요.`,
    sourceArchiveLimit: `열린 이미지 ZIP이 누적 ${DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES}개 제한을 초과합니다. 지운 후 ZIP을 합쳐 다시 선택하세요.`,
    unmappedSourceField: "이 V1 설정에는 검증된 V2 대응 필드가 없어 대상 프로젝트에 기록되지 않습니다.",
    diagnosticTimestampLoss: "대상 형식은 원본 프로젝트의 일부 타임스탬프 또는 내부 식별자를 보존하지 않습니다.",
    diagnosticSplitLoss: "대상 형식에서 데이터 분할을 정규화하므로 일부 분할 이름, 식별자 또는 다중 소속을 보존할 수 없습니다.",
    diagnosticGeometryLoss: "대상 형식은 일부 라벨 도형 정보를 완전히 보존할 수 없습니다.",
    diagnosticRoiLoss: "이 ROI 모드, 도형 또는 설정에는 검증된 버전 간 매핑이 없습니다. 현재 비활성 ROI와 Simple Rectangle만 지원합니다.",
    diagnosticCompatibilityError: "이 호환성 문제로 인해 안전하게 변환할 수 없습니다.",
    diagnosticCompatibilityWarning: "대상 형식은 이 원본 정보를 완전히 보존할 수 없습니다.",
    diagnosticSecurityError: "프로젝트에 안전하지 않거나 제한을 초과한 내용이 있어 처리를 중지했습니다.",
    diagnosticValidationError: "프로젝트 내용이 유효하지 않거나 불완전하여 안전하게 처리할 수 없습니다.",
    diagnosticValidationWarning: "프로젝트 내용에 확인이 필요한 문제가 있습니다.",
    dimensions: "이미지 크기를 읽는 중…",
    imageDimensionsMismatch: "프로젝트에 기록된 이미지 크기와 실제 파일이 일치하지 않아 변환을 중지했습니다.",
    imageFormatUnsupported: "이미지가 검증된 PNG, JPEG, BMP, GIF 또는 WebP 형식이 아닙니다.",
    imageFormatMismatch: "이미지 확장자 또는 MIME 유형이 실제 파일 형식과 일치하지 않습니다.",
    imageTooLarge: "이미지 크기가 안전 처리 한도를 초과합니다.",
    imageReadFailed: "일부 프로젝트 이미지를 안전하게 읽을 수 없습니다.",
    saveFailed: "변환이 완료되지 않았으며 원본 파일은 변경되지 않았습니다.",
    helperLoadFailed: "경로 복구 도구를 읽지 못했습니다. 네트워크 연결을 확인한 후 다시 시도하세요.",
    helperIntegrityFailed: "경로 복구 도구 무결성 검사에 실패했습니다. 페이지를 새로 고친 후 다시 시도하세요.",
    savePickerDownloadFallback: "시스템 저장 위치 선택기를 열 수 없어 브라우저 다운로드 방식으로 전환했습니다.",
    blobFallbackTooLarge: "이 프로젝트는 브라우저 메모리 다운로드로 안전하게 처리하기에는 너무 큽니다. 최신 데스크톱 Edge 또는 Chrome을 사용하세요.",
    confirmation: "대상 버전에서 위의 일부 원본 필드를 유지할 수 없습니다. 검증된 핵심 필드로 계속하려면 확인하세요.",
    relativeSubvision: "경량 프로젝트에는 사용 가능한 절대 이미지 경로가 필요합니다. 상대 경로가 포함되어 있으므로 .visionproj를 선택하세요.",
    relativeV1Path: "내보낸 .srproj는 상대 이미지 경로를 유지합니다. 파일을 이동하면 V1에서 원본 이미지를 찾지 못할 수 있습니다.",
    relativePathConfirmation: "내보낸 .srproj가 상대 이미지 경로를 유지하며, 파일을 이동한 뒤 V1에서 이미지를 다시 지정해야 할 수 있음을 이해합니다.",
    mixedConfirmation: "내보낸 .srproj는 상대 이미지 경로를 유지하므로 파일을 이동하면 V1에서 원본 이미지를 찾지 못할 수 있습니다. 또한 위에 나열된 다른 원본 필드는 대상 형식에 기록되지 않습니다.",
    mixedConfirmationLabel: "상대 경로 위험과 위에 나열된 다른 필드가 대상 형식에 기록되지 않음을 모두 이해했으며 변환을 계속합니다.",
  },
} satisfies Record<ConverterLanguage, Record<string, string>>;

type StableStatus = "idle" | "inspecting" | "ready" | "saving" | "success" | "error" | "unsupported";

interface RuntimeDiagnostic {
  readonly severity: ConverterDiagnostic["severity"];
  readonly code: string;
  readonly path?: string;
  readonly pathTitle?: string;
  readonly message?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly fallbackCode?: string;
  readonly sticky?: boolean;
  /** Prevent saving until the source, target, or project state changes. */
  readonly blocking?: boolean;
  /** The same operation can reasonably be attempted again without edits. */
  readonly retryable?: boolean;
}

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
  const [confirmationChecked, setConfirmationChecked] = useState(false);
  const [progress, setProgress] = useState<ConverterProgress | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [directoryCount, setDirectoryCount] = useState(0);
  const [directoryMatching, setDirectoryMatching] = useState(false);
  const [savePrepared, setSavePrepared] = useState(false);
  const fallbackDirectoryInput = useRef<HTMLInputElement>(null);
  const imageFilesInput = useRef<HTMLInputElement>(null);
  const imageZipInput = useRef<HTMLInputElement>(null);
  const loadedRef = useRef<LoadedProject | null>(null);
  const selectedFilesRef = useRef<readonly SelectedSourceFile[]>([]);
  const selectedImageArchivesRef = useRef<Map<string, OpenArchive>>(new Map());
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
    setDirectoryCount(0);
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
      setDirectoryCount(0);
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
      commitSelectedFiles(
        mergePickedDirectoryFiles(selectedFilesRef.current, picked),
        selectedImageArchivesRef.current.size,
      );
      setDirectoryCount((count) => count + 1);
      setRuntimeDiagnostics(clearImageSourceDiagnostics);
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
  }, [beginOperation, commitSelectedFiles, finishOperation, language, project, projectUnsupported]);

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
          commitSelectedFiles(
            mergePickedDirectoryFiles(selectedFilesRef.current, picked),
            selectedImageArchivesRef.current.size,
          );
          setDirectoryCount((count) => count + 1);
          setRuntimeDiagnostics(clearImageSourceDiagnostics);
        }
      } catch (error) {
        setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
          current,
          directoryDiagnosticFromError(error, "DIRECTORY_UNSUPPORTED"),
        ));
      }
    }
    event.currentTarget.value = "";
  }, [commitSelectedFiles, language]);

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
      commitSelectedFiles(
        mergePickedDirectoryFiles(selectedFilesRef.current, picked),
        selectedImageArchivesRef.current.size,
      );
      setRuntimeDiagnostics(clearImageSourceDiagnostics);
    } catch (error) {
      setRuntimeDiagnostics((current) => replaceImageSourceDiagnostic(
        current,
        directoryDiagnosticFromError(error, "DIRECTORY_UNSUPPORTED"),
      ));
    }
  }, [commitSelectedFiles, language]);

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
        openValidatedZip(zipFile),
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
      archive = undefined;
      setRuntimeDiagnostics(clearImageSourceDiagnostics);
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
  }, [beginOperation, commitSelectedFiles, finishOperation, language]);

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
    setDirectoryCount(0);
    setDirectoryMatching(false);
    setProgress(null);
    setSaveResult(null);
    setRuntimeDiagnostics(clearImageSourceDiagnostics);
    if (loadedRef.current?.project) setStatus("ready");
  }, [invalidateActiveOperation]);

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
        setRuntimeDiagnostics((current) => [
          ...current,
          saveDiagnosticFromError(error),
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
  purpose: ImageMatchSummary["purpose"],
): ImageMatchSummary {
  if (embedded) {
    return { state: "source-ready", purpose, totalCount: project.files.length, matchedCount: project.files.length, missingCount: 0, ambiguousCount: 0, directoryCount, hasSelectedSources: false, canSelectDirectory: false };
  }
  const current = report ?? matchImageFiles(projectImagePaths(project), []);
  const issues: ImageMatchIssue[] = current.matches
    .filter((match) => match.status === "missing" || match.status === "ambiguous")
    .map((match) => ({
      path: shortPath(match.projectPath.originalPath),
      pathTitle: match.projectPath.originalPath,
      status: match.status as "missing" | "ambiguous",
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

function saveType(
  target: ConverterOutputFormat,
  language: ConverterLanguage,
): SaveFileType {
  const descriptions = {
    zh: {
      visionproj: "SaigeVision V2 完整项目",
      subvisionproj: "SaigeVision V2 轻量项目",
      srproj: "SaigeVision V1 项目",
      "svpa-zip": "SaigeVision V1 完整项目包",
    },
    en: {
      visionproj: "SaigeVision V2 complete project",
      subvisionproj: "SaigeVision V2 lightweight project",
      srproj: "SaigeVision V1 project",
      "svpa-zip": "SaigeVision V1 complete project package",
    },
    ko: {
      visionproj: "SaigeVision V2 전체 프로젝트",
      subvisionproj: "SaigeVision V2 경량 프로젝트",
      srproj: "SaigeVision V1 프로젝트",
      "svpa-zip": "SaigeVision V1 전체 프로젝트 패키지",
    },
  } satisfies Record<ConverterLanguage, Record<ConverterOutputFormat, string>>;
  if (target === "visionproj") return { description: descriptions[language][target], mimeType: "application/zip", extensions: [".visionproj"] };
  if (target === "subvisionproj") return { description: descriptions[language][target], mimeType: "application/json", extensions: [".subvisionproj"] };
  if (target === "srproj") return { description: descriptions[language][target], mimeType: "application/xml", extensions: [".srproj"] };
  return { description: descriptions[language][target], mimeType: "application/zip", extensions: [".zip"] };
}

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

function toUiDiagnostics(
  diagnostics: readonly ProjectDiagnostic[],
  language: ConverterLanguage,
  includeCompatibility: boolean,
  target: ConverterOutputFormat | null,
): ConverterDiagnostic[] {
  const result: ConverterDiagnostic[] = [];
  for (const item of diagnostics) {
    if (item.category === "compatibility" && !includeCompatibility) continue;
    if (!targetIncludesDiagnostic(item, target)) {
      continue;
    }
    if (item.severity === "info") continue;
    result.push(toUiDiagnostic(item, language));
  }
  return result;
}

function toUiRuntimeDiagnostic(
  item: RuntimeDiagnostic,
  language: ConverterLanguage,
): ConverterDiagnostic {
  const copy = uiCopy[language];
  const localized = runtimeMessageForCode(item.code, copy) ??
    (item.fallbackCode ? runtimeMessageForCode(item.fallbackCode, copy) : undefined);
  const message = localized ??
    (language === "en" && item.message ? item.message : copy.saveFailed);
  return {
    severity: item.severity,
    code: item.code,
    path: item.path,
    pathTitle: item.pathTitle,
    message,
  };
}

function runtimeMessageForCode(
  code: string,
  copy: (typeof uiCopy)[ConverterLanguage],
): string | undefined {
  switch (code) {
    case "INPUT_COUNT_INVALID": return copy.multiple;
    case "PROJECT_TEXT_TOO_LARGE":
    case "V1_TEXT_LIMIT_EXCEEDED":
    case "V2_TEXT_LIMIT_EXCEEDED": return copy.projectScaleLimit;
    case "PROJECT_PARSE_FAILED":
    case "INPUT_FORMAT_UNKNOWN": return copy.invalid;
    case "PROJECT_EMPTY": return copy.emptyProject;
    case "PROJECT_UNSUPPORTED": return copy.unsupported;
    case "DIRECTORY_UNSUPPORTED": return copy.directoryUnsupported;
    case "DIRECTORY_PERMISSION_FALLBACK": return copy.directoryPermissionFallback;
    case "DIRECTORY_EMPTY_FILE_LIST": return copy.directoryEmpty;
    case "DIRECTORY_DEPTH_LIMIT": return copy.directoryDepthLimit;
    case "DIRECTORY_FILE_LIMIT": return copy.directoryFileLimit;
    case "DIRECTORY_SIZE_LIMIT": return copy.directorySizeLimit;
    case "IMAGE_FILES_NEED_RELATIVE_PATHS": return copy.imageFilesNeedPaths;
    case "IMAGE_ZIP_EMPTY": return copy.imageZipEmpty;
    case "IMAGE_SOURCE_FILE_LIMIT": return copy.sourceFileLimit;
    case "IMAGE_SOURCE_SIZE_LIMIT": return copy.sourceSizeLimit;
    case "IMAGE_SOURCE_ARCHIVE_LIMIT": return copy.sourceArchiveLimit;
    case "IMAGE_SOURCE_USAGE_INVALID": return copy.imageReadFailed;
    case "IMAGE_DIMENSIONS_MISMATCH": return copy.imageDimensionsMismatch;
    case "IMAGE_FORMAT_UNSUPPORTED": return copy.imageFormatUnsupported;
    case "IMAGE_FORMAT_MISMATCH": return copy.imageFormatMismatch;
    case "IMAGE_DIMENSIONS_TOO_LARGE": return copy.imageTooLarge;
    case "IMAGE_SOURCE_MISSING":
    case "IMAGE_SOURCE_DUPLICATE":
    case "IMAGE_SOURCE_READ_FAILED":
    case "IMAGE_HEADER_INVALID":
    case "IMAGE_DIMENSIONS_INVALID": return copy.imageReadFailed;
    case "SAVE_PICKER_DOWNLOAD_FALLBACK": return copy.savePickerDownloadFallback;
    case "BLOB_FALLBACK_TOO_LARGE": return copy.blobFallbackTooLarge;
    case "EMPTY_SAVE_RESULT": return copy.saveFailed;
    case "HELPER_LOAD_FAILED": return copy.helperLoadFailed;
    case "HELPER_INTEGRITY_FAILED": return copy.helperIntegrityFailed;
    case "SAVE_FAILED": return copy.saveFailed;
    default:
      if (isProjectScaleLimitCode(code)) return copy.projectScaleLimit;
      return code.startsWith("ZIP_") ? copy.invalid : undefined;
  }
}

const ZIP_PROJECT_SCALE_LIMIT_CODES = new Set([
  "ZIP_BLOB_TOO_LARGE",
  "ZIP_ENTRY_NAME_TOO_LONG",
  "ZIP_ENTRY_NAMES_TOO_LARGE",
  "ZIP_ENTRY_TOO_LARGE",
  "ZIP_PREFIX_TOO_LARGE",
  "ZIP_TEXT_TOO_LARGE",
  "ZIP_TOO_MANY_ENTRIES",
  "ZIP_TOTAL_TOO_LARGE",
]);

function isProjectScaleLimitCode(code: string): boolean {
  return ZIP_PROJECT_SCALE_LIMIT_CODES.has(code) ||
    /^(?:V1|V2|PROJECT)_[A-Z0-9_]*(?:LIMIT_EXCEEDED|TOO_LARGE)$/u.test(code);
}

function toUiDiagnostic(
  item: ProjectDiagnostic,
  language: ConverterLanguage,
): ConverterDiagnostic {
  const isUnmappedV1 =
    item.code === "V1_UNMAPPED_XML_NODE" ||
    item.code === "V1_UNKNOWN_XML_NODE" ||
    item.code === "V1_UNKNOWN_XML_ATTRIBUTE";
  return {
    severity: item.severity,
    code: item.code,
    path: shortPath(item.path),
    pathTitle: item.path,
    message: isUnmappedV1
      ? uiCopy[language].unmappedSourceField
      : localizedProjectDiagnosticMessage(item, language),
  };
}

function localizedProjectDiagnosticMessage(
  item: ProjectDiagnostic,
  language: ConverterLanguage,
): string {
  if (item.code === "V2_EXTERNAL_PATH_RELATIVE") {
    return uiCopy[language].relativeV1Path;
  }
  if (isProjectScaleLimitCode(item.code)) {
    return uiCopy[language].projectScaleLimit;
  }
  if (language === "en") return item.message;
  const copy = uiCopy[language];
  if (/TIMESTAMP|FIELD_REBUILT|ENTITY_IDS_REBUILT|CONTOUR_ID_REBUILT/u.test(item.code)) {
    return copy.diagnosticTimestampLoss;
  }
  if (/SPLIT/u.test(item.code)) return copy.diagnosticSplitLoss;
  if (/ROI/u.test(item.code)) return copy.diagnosticRoiLoss;
  if (/GEOMETRY|BITMAP|CONTOUR|OUT_OF_BOUNDS/u.test(item.code)) {
    return copy.diagnosticGeometryLoss;
  }
  if (item.category === "security") return copy.diagnosticSecurityError;
  if (item.category === "compatibility") {
    return item.severity === "error"
      ? copy.diagnosticCompatibilityError
      : copy.diagnosticCompatibilityWarning;
  }
  return item.severity === "error"
    ? copy.diagnosticValidationError
    : copy.diagnosticValidationWarning;
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
  return { severity: "error", code, blocking: false, retryable: true };
}

function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : normalized;
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

function formatLimitBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GiB`;
}
