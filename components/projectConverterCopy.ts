import {
  DEFAULT_DIRECTORY_MAX_DEPTH,
  DEFAULT_DIRECTORY_MAX_FILES,
  DEFAULT_DIRECTORY_MAX_TOTAL_BYTES,
} from "../lib/files/directoryPicker.ts";
import {
  DEFAULT_SOURCE_SELECTION_MAX_FILES,
  DEFAULT_SOURCE_SELECTION_MAX_OPEN_ARCHIVES,
  DEFAULT_SOURCE_SELECTION_MAX_TOTAL_BYTES,
} from "../lib/files/sourceSelectionLimits.ts";
import type { ProjectDiagnostic, ProjectIR } from "../lib/model/project.ts";
import type { AppLanguage } from "../lib/output/containers.ts";
import type { SaveFileType } from "../lib/output/save.ts";
import { APP_VERSION } from "../lib/release.ts";
import { targetIncludesDiagnostic } from "./projectCapabilities.ts";
import type {
  ConverterDiagnostic,
  ConverterLanguage,
  ConverterOutputFormat,
} from "./ConverterShell.tsx";

export interface RuntimeDiagnostic {
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

export const localeByLanguage: Record<ConverterLanguage, AppLanguage> = {
  zh: "zh-CN",
  en: "en-US",
  ko: "ko-KR",
};

export const uiCopy = {
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

export function projectTypeLabel(
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

export function saveType(
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

export function toUiDiagnostics(
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

export function toUiRuntimeDiagnostic(
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

export function toUiDiagnostic(
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

export function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : normalized;
}

function formatLimitBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GiB`;
}
