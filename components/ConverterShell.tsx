"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useId,
  useRef,
} from "react";
import "./converter.css";

export type ConverterLanguage = "zh" | "en" | "ko";

export type ConverterStatus =
  | "idle"
  | "inspecting"
  | "choosing-output"
  | "needs-images"
  | "needs-confirmation"
  | "ready"
  | "saving"
  | "success"
  | "error"
  | "unsupported";

export type ConverterSourceFormat =
  | "v1-srproj"
  | "v1-svpa"
  | "v2-visionproj"
  | "v2-subvisionproj";

export type ConverterOutputFormat =
  | "visionproj"
  | "subvisionproj"
  | "srproj"
  | "svpa-zip";

export interface ConverterSourceSummary {
  readonly format: ConverterSourceFormat;
  readonly fileName: string;
  readonly fileSize?: number;
  readonly projectName?: string;
  readonly projectType?: string;
  readonly version?: string;
  readonly imageCount?: number;
  readonly classCount?: number;
  readonly labelCount?: number;
  readonly splitSummary?: string;
}

export interface ConverterOutputOption {
  readonly id: string;
  readonly format: ConverterOutputFormat;
  readonly selected: boolean;
  readonly recommended?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly title?: string;
  readonly description?: string;
  readonly actionLabel?: string;
}

export type ImageMatchState =
  | "source-ready"
  | "needs-directory"
  | "matching"
  | "incomplete"
  | "ready";

export interface ImageMatchIssue {
  readonly path: string;
  readonly status: "missing" | "ambiguous";
  readonly message?: string;
}

export interface ImageMatchSummary {
  readonly state: ImageMatchState;
  readonly totalCount: number;
  readonly matchedCount: number;
  readonly missingCount: number;
  readonly ambiguousCount: number;
  readonly matchedBytes?: number;
  readonly directoryCount?: number;
  readonly canSelectDirectory?: boolean;
  readonly issues?: readonly ImageMatchIssue[];
}

export interface ConverterDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
}

export interface ConverterConfirmation {
  readonly required: boolean;
  readonly checked: boolean;
  readonly message?: string;
}

export type ConverterProgressStage =
  | "inspecting"
  | "reading"
  | "matching"
  | "choosing-save-location"
  | "converting"
  | "writing-images"
  | "finalizing";

export interface ConverterProgress {
  readonly stage: ConverterProgressStage;
  readonly current?: number;
  readonly total?: number;
  readonly unit?: "items" | "bytes";
  readonly percent?: number;
  readonly label?: string;
  readonly detail?: string;
}

export interface ConverterShellProps {
  readonly language: ConverterLanguage;
  readonly status: ConverterStatus;
  readonly source?: ConverterSourceSummary | null;
  readonly outputs?: readonly ConverterOutputOption[];
  readonly imageMatch?: ImageMatchSummary | null;
  readonly diagnostics?: readonly ConverterDiagnostic[];
  readonly confirmation?: ConverterConfirmation | null;
  readonly progress?: ConverterProgress | null;
  readonly canSave?: boolean;
  readonly onSelectFile: (files: readonly File[]) => void;
  readonly onDrop: (files: readonly File[]) => void;
  readonly onTargetChange: (targetId: string) => void;
  readonly onSelectDirectory: () => void;
  readonly onSelectImageFiles: () => void;
  readonly onSelectImageZip: () => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
  readonly onLanguageChange: (language: ConverterLanguage) => void;
  readonly onConfirmationChange: (checked: boolean) => void;
}

const copy = {
  zh: {
    title: "SaigeVision 项目转换",
    subtitle: "在 V1 与 V2 项目格式之间转换。",
    privacy: "本地处理 · 不上传项目或图片",
    languageLabel: "选择界面语言",
    projectFile: "项目文件",
    selectFile: "选择项目文件",
    dropFile: "或拖放到这里",
    supported: "支持 .srproj、SVPA.zip、.visionproj 和 .subvisionproj",
    inspecting: "正在识别项目版本…",
    identified: "已识别",
    change: "更换",
    projectName: "项目",
    projectType: "类型",
    images: "图片",
    classes: "类别",
    labels: "标注",
    split: "数据划分",
    outputHeading: "转换为",
    recommended: "推荐",
    imageHeading: "项目图片",
    imageHelp: "完整项目需要读取全部原图。图片分散时可继续添加目录。",
    sourceImagesReady: "图片已就绪",
    sourceImagesReadyDetail: "已从源项目读取全部图片，无需另选目录。",
    selectDirectory: "选择图片目录",
    addDirectory: "继续添加目录",
    selectImageFiles: "选择图片文件",
    selectImageZip: "选择图片 ZIP",
    imageSourceAlternatives: "当前浏览器无法读取文件夹时，可选择保留目录结构的图片 ZIP。仅当图片文件名不重复时，才适合直接多选图片文件。",
    imageSourceGroupLabel: "添加项目图片",
    matched: "已匹配",
    missing: "缺失",
    ambiguous: "重名",
    matching: "正在查找项目图片…",
    imagesIncomplete: "图片尚未全部唯一匹配，暂不能生成完整项目。",
    showRemaining: (count: number) => `查看其余 ${count} 项`,
    diagnostics: "转换检查",
    showMoreDiagnostics: (count: number) => `查看其余 ${count} 项`,
    confirmationHeading: "需要确认",
    confirmationDefault: "目标格式无法保留上方列出的部分源字段。",
    confirmationLabel: "我已了解上述字段不会写入目标格式，并继续转换。",
    sourceUnchanged: "源文件不会被修改。",
    saving: "正在保存…",
    retry: "重试保存",
    success: "转换完成",
    successDetail: "项目文件已保存到你选择的位置。",
    another: "转换另一个项目",
    unsupported: "当前项目没有可安全生成的目标格式。",
    genericError: "转换未完成，源文件未被修改。",
    fileInputLabel: "选择一个 SaigeVision 项目文件",
    statusLabel: "转换状态",
    progressLabel: "转换进度",
    countUnit: "项",
    formats: {
      "v1-srproj": "SaigeVision V1 项目",
      "v1-svpa": "SaigeVision V1 完整项目 ZIP",
      "v2-visionproj": "SaigeVision V2 完整项目",
      "v2-subvisionproj": "SaigeVision V2 轻量项目",
    },
    output: {
      visionproj: {
        title: "V2 完整项目",
        description: "包含图片，适合迁移或交付。",
        extension: ".visionproj",
      },
      subvisionproj: {
        title: "V2 轻量项目",
        description: "不包含图片；导入时原图片必须仍在原路径。",
        extension: ".subvisionproj",
      },
      srproj: {
        title: "V1 项目文件",
        description: "仅项目与标注，不包含图片。",
        extension: ".srproj",
      },
      "svpa-zip": {
        title: "V1 完整项目 ZIP",
        description: "包含 .srproj、图片和路径修复工具。",
        extension: "SVPA.zip",
      },
    },
    save: (extension: string) => `转换并保存 ${extension}`,
    stages: {
      inspecting: "正在识别项目版本…",
      reading: "正在读取项目结构…",
      matching: "正在查找项目图片…",
      "choosing-save-location": "请选择保存位置…",
      converting: "正在转换项目结构…",
      "writing-images": "正在写入图片…",
      finalizing: "正在完成项目文件…",
    },
  },
  en: {
    title: "SaigeVision Project Converter",
    subtitle: "Convert projects between SaigeVision V1 and V2.",
    privacy: "Processed locally · Projects and images are never uploaded",
    languageLabel: "Choose interface language",
    projectFile: "Project file",
    selectFile: "Choose project file",
    dropFile: "or drop it here",
    supported: "Supports .srproj, SVPA.zip, .visionproj and .subvisionproj",
    inspecting: "Identifying the project version…",
    identified: "Identified",
    change: "Change",
    projectName: "Project",
    projectType: "Type",
    images: "Images",
    classes: "Classes",
    labels: "Labels",
    split: "Split",
    outputHeading: "Convert to",
    recommended: "Recommended",
    imageHeading: "Project images",
    imageHelp: "A complete project needs every original image. Add more folders if the images are spread across locations.",
    sourceImagesReady: "Images ready",
    sourceImagesReadyDetail: "All images were read from the source project. No folder is needed.",
    selectDirectory: "Choose image folder",
    addDirectory: "Add another folder",
    selectImageFiles: "Choose image files",
    selectImageZip: "Choose image ZIP",
    imageSourceAlternatives: "If this browser cannot read folders, choose an image ZIP that preserves the folder structure. Direct file selection is safe only when image filenames are unique.",
    imageSourceGroupLabel: "Add project images",
    matched: "Matched",
    missing: "Missing",
    ambiguous: "Duplicates",
    matching: "Finding project images…",
    imagesIncomplete: "Every image must have one unique match before a complete project can be created.",
    showRemaining: (count: number) => `Show ${count} more`,
    diagnostics: "Conversion checks",
    showMoreDiagnostics: (count: number) => `Show ${count} more`,
    confirmationHeading: "Confirmation required",
    confirmationDefault: "The target format cannot preserve some source fields listed above.",
    confirmationLabel: "I understand that these fields will not be written to the target format and want to continue.",
    sourceUnchanged: "The source file will not be changed.",
    saving: "Saving…",
    retry: "Try saving again",
    success: "Conversion complete",
    successDetail: "The project file was saved to the location you chose.",
    another: "Convert another project",
    unsupported: "This project has no target format that can be created safely.",
    genericError: "Conversion did not finish. The source file was not changed.",
    fileInputLabel: "Choose one SaigeVision project file",
    statusLabel: "Conversion status",
    progressLabel: "Conversion progress",
    countUnit: "items",
    formats: {
      "v1-srproj": "SaigeVision V1 project",
      "v1-svpa": "SaigeVision V1 complete project ZIP",
      "v2-visionproj": "SaigeVision V2 complete project",
      "v2-subvisionproj": "SaigeVision V2 lightweight project",
    },
    output: {
      visionproj: {
        title: "V2 complete project",
        description: "Includes images for migration or delivery.",
        extension: ".visionproj",
      },
      subvisionproj: {
        title: "V2 lightweight project",
        description: "Does not include images; the originals must remain at their paths when imported.",
        extension: ".subvisionproj",
      },
      srproj: {
        title: "V1 project file",
        description: "Project and annotations only; images are not included.",
        extension: ".srproj",
      },
      "svpa-zip": {
        title: "V1 complete project ZIP",
        description: "Includes the .srproj, images and path repair helper.",
        extension: "SVPA.zip",
      },
    },
    save: (extension: string) => `Convert and save ${extension}`,
    stages: {
      inspecting: "Identifying the project version…",
      reading: "Reading the project structure…",
      matching: "Finding project images…",
      "choosing-save-location": "Choose where to save…",
      converting: "Converting the project structure…",
      "writing-images": "Writing images…",
      finalizing: "Finishing the project file…",
    },
  },
  ko: {
    title: "SaigeVision 프로젝트 변환",
    subtitle: "V1과 V2 프로젝트 형식 사이를 변환합니다.",
    privacy: "로컬 처리 · 프로젝트와 이미지를 업로드하지 않음",
    languageLabel: "인터페이스 언어 선택",
    projectFile: "프로젝트 파일",
    selectFile: "프로젝트 파일 선택",
    dropFile: "또는 여기에 끌어 놓기",
    supported: ".srproj, SVPA.zip, .visionproj, .subvisionproj 지원",
    inspecting: "프로젝트 버전을 확인하는 중…",
    identified: "확인됨",
    change: "변경",
    projectName: "프로젝트",
    projectType: "유형",
    images: "이미지",
    classes: "클래스",
    labels: "라벨",
    split: "데이터 분할",
    outputHeading: "변환 형식",
    recommended: "권장",
    imageHeading: "프로젝트 이미지",
    imageHelp: "전체 프로젝트에는 모든 원본 이미지가 필요합니다. 이미지가 여러 위치에 있으면 폴더를 추가하세요.",
    sourceImagesReady: "이미지 준비 완료",
    sourceImagesReadyDetail: "원본 프로젝트에서 모든 이미지를 읽었습니다. 폴더를 다시 선택할 필요가 없습니다.",
    selectDirectory: "이미지 폴더 선택",
    addDirectory: "다른 폴더 추가",
    selectImageFiles: "이미지 파일 선택",
    selectImageZip: "이미지 ZIP 선택",
    imageSourceAlternatives: "이 브라우저가 폴더를 읽지 못하면 폴더 구조를 유지한 이미지 ZIP을 선택하세요. 이미지 파일명이 모두 고유한 경우에만 파일을 직접 선택할 수 있습니다.",
    imageSourceGroupLabel: "프로젝트 이미지 추가",
    matched: "일치",
    missing: "누락",
    ambiguous: "중복",
    matching: "프로젝트 이미지를 찾는 중…",
    imagesIncomplete: "전체 프로젝트를 만들려면 모든 이미지가 하나의 파일과 정확히 일치해야 합니다.",
    showRemaining: (count: number) => `${count}개 더 보기`,
    diagnostics: "변환 검사",
    showMoreDiagnostics: (count: number) => `${count}개 더 보기`,
    confirmationHeading: "확인 필요",
    confirmationDefault: "대상 형식은 위에 나열된 일부 원본 필드를 보존할 수 없습니다.",
    confirmationLabel: "위 필드가 대상 형식에 기록되지 않음을 이해했으며 변환을 계속합니다.",
    sourceUnchanged: "원본 파일은 변경되지 않습니다.",
    saving: "저장 중…",
    retry: "저장 다시 시도",
    success: "변환 완료",
    successDetail: "선택한 위치에 프로젝트 파일을 저장했습니다.",
    another: "다른 프로젝트 변환",
    unsupported: "이 프로젝트에서 안전하게 만들 수 있는 대상 형식이 없습니다.",
    genericError: "변환이 완료되지 않았습니다. 원본 파일은 변경되지 않았습니다.",
    fileInputLabel: "SaigeVision 프로젝트 파일 하나 선택",
    statusLabel: "변환 상태",
    progressLabel: "변환 진행률",
    countUnit: "개",
    formats: {
      "v1-srproj": "SaigeVision V1 프로젝트",
      "v1-svpa": "SaigeVision V1 전체 프로젝트 ZIP",
      "v2-visionproj": "SaigeVision V2 전체 프로젝트",
      "v2-subvisionproj": "SaigeVision V2 경량 프로젝트",
    },
    output: {
      visionproj: {
        title: "V2 전체 프로젝트",
        description: "이미지를 포함하여 이전 또는 전달에 적합합니다.",
        extension: ".visionproj",
      },
      subvisionproj: {
        title: "V2 경량 프로젝트",
        description: "이미지를 포함하지 않습니다. 가져올 때 원본 이미지가 기존 경로에 있어야 합니다.",
        extension: ".subvisionproj",
      },
      srproj: {
        title: "V1 프로젝트 파일",
        description: "프로젝트와 라벨만 포함하며 이미지는 포함하지 않습니다.",
        extension: ".srproj",
      },
      "svpa-zip": {
        title: "V1 전체 프로젝트 ZIP",
        description: ".srproj, 이미지 및 경로 복구 도구를 포함합니다.",
        extension: "SVPA.zip",
      },
    },
    save: (extension: string) => `변환 후 ${extension} 저장`,
    stages: {
      inspecting: "프로젝트 버전을 확인하는 중…",
      reading: "프로젝트 구조를 읽는 중…",
      matching: "프로젝트 이미지를 찾는 중…",
      "choosing-save-location": "저장 위치를 선택하세요…",
      converting: "프로젝트 구조를 변환하는 중…",
      "writing-images": "이미지를 쓰는 중…",
      finalizing: "프로젝트 파일을 마무리하는 중…",
    },
  },
} satisfies Record<ConverterLanguage, object>;

const languageTags: Record<ConverterLanguage, string> = {
  zh: "zh-CN",
  en: "en",
  ko: "ko",
};

const languageOptions: readonly {
  language: ConverterLanguage;
  label: string;
}[] = [
  { language: "zh", label: "中文" },
  { language: "en", label: "EN" },
  { language: "ko", label: "한국어" },
];

const MAX_VISIBLE_ITEMS = 3;

export function ConverterShell({
  language,
  status,
  source = null,
  outputs = [],
  imageMatch = null,
  diagnostics = [],
  confirmation = null,
  progress = null,
  canSave,
  onSelectFile,
  onDrop,
  onTargetChange,
  onSelectDirectory,
  onSelectImageFiles,
  onSelectImageZip,
  onSave,
  onReset,
  onLanguageChange,
  onConfirmationChange,
}: ConverterShellProps) {
  const text = copy[language];
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const isMatching = progress?.stage === "matching" || imageMatch?.state === "matching";
  const isBusy = status === "inspecting" || status === "saving" || isMatching;
  const selectedOutput = outputs.find((option) => option.selected);
  const saveEnabled =
    (canSave ?? status === "ready") && !isBusy && !selectedOutput?.disabled;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files?.length) {
      onSelectFile(Array.from(event.currentTarget.files));
    }
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!isBusy && event.dataTransfer.files.length) {
      onDrop(Array.from(event.dataTransfer.files));
    }
  }

  return (
    <main
      className="converter-shell"
      lang={languageTags[language]}
      aria-labelledby={`${inputId}-title`}
      aria-busy={isBusy}
    >
      <div className="converter-shell__frame">
        <header className="converter-shell__header">
          <div className="converter-shell__brand">SaigeVision</div>
          <div className="converter-shell__header-actions">
            <div className="converter-shell__privacy">
              <span aria-hidden="true">●</span>
              {text.privacy}
            </div>
            <div
              className="converter-language-switch"
              role="group"
              aria-label={text.languageLabel}
            >
              {languageOptions.map((option) => {
                const isCurrent = option.language === language;
                return (
                  <button
                    className="converter-language-switch__button"
                    type="button"
                    aria-current={isCurrent ? "true" : undefined}
                    aria-pressed={isCurrent}
                    key={option.language}
                    onClick={() => onLanguageChange(option.language)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        <section className="converter-shell__intro">
          <h1 id={`${inputId}-title`}>{text.title}</h1>
          <p>{text.subtitle}</p>
        </section>

        <section className="converter-card">
          {!source && status === "idle" ? (
            <EmptyState
              inputId={inputId}
              fileInput={fileInput}
              text={text}
              onFileChange={handleFileChange}
              onDrop={handleDrop}
            />
          ) : null}

          {!source && status !== "idle" ? (
            <StatusOnly
              status={status}
              progress={progress}
              diagnostics={diagnostics}
              text={text}
              language={language}
              onReset={onReset}
            />
          ) : null}

          {source ? (
            <>
              <SourceSection
                source={source}
                text={text}
                language={language}
                isBusy={isBusy}
                showReset={status !== "success"}
                onReset={onReset}
              />

              {outputs.length > 0 ? (
                <OutputSection
                  outputs={outputs}
                  text={text}
                  name={`${inputId}-output`}
                  disabled={isBusy || status === "success"}
                  onTargetChange={onTargetChange}
                />
              ) : null}

              {imageMatch ? (
                <ImageSection
                  summary={imageMatch}
                  text={text}
                  language={language}
                  disabled={isBusy || status === "success"}
                  onSelectDirectory={onSelectDirectory}
                  onSelectImageFiles={onSelectImageFiles}
                  onSelectImageZip={onSelectImageZip}
                />
              ) : null}

              {diagnostics.length > 0 ? (
                <DiagnosticSection diagnostics={diagnostics} text={text} />
              ) : null}

              {confirmation?.required && status !== "success" ? (
                <ConfirmationSection
                  confirmation={confirmation}
                  text={text}
                  inputId={`${inputId}-confirmation`}
                  disabled={isBusy}
                  onChange={onConfirmationChange}
                />
              ) : null}

              {progress ? (
                <ProgressSection progress={progress} text={text} language={language} />
              ) : null}

              {status === "unsupported" && diagnostics.length === 0 ? (
                <div className="converter-inline-message converter-inline-message--error" role="alert">
                  {text.unsupported}
                </div>
              ) : null}

              {status === "error" && diagnostics.length === 0 ? (
                <div className="converter-inline-message converter-inline-message--error" role="alert">
                  {text.genericError}
                </div>
              ) : null}

              {status === "success" ? (
                <SuccessSection text={text} onReset={onReset} />
              ) : selectedOutput ? (
                <footer className="converter-card__actions">
                  <button
                    className="converter-button converter-button--primary converter-button--wide"
                    type="button"
                    disabled={!saveEnabled}
                    onClick={onSave}
                  >
                    {status === "saving"
                      ? text.saving
                      : status === "error" && saveEnabled
                        ? text.retry
                        : selectedOutput.actionLabel ??
                          text.save(text.output[selectedOutput.format].extension)}
                  </button>
                  <p>{text.sourceUnchanged}</p>
                </footer>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}

interface CopyShape {
  readonly [key: string]: unknown;
}

type LocalizedCopy = (typeof copy)[ConverterLanguage] & CopyShape;

function EmptyState({
  inputId,
  fileInput,
  text,
  onFileChange,
  onDrop,
}: {
  inputId: string;
  fileInput: React.RefObject<HTMLInputElement | null>;
  text: LocalizedCopy;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}) {
  return (
    <div className="converter-empty">
      <h2>{text.projectFile}</h2>
      <div
        className="converter-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <input
          ref={fileInput}
          id={`${inputId}-file`}
          className="converter-visually-hidden"
          type="file"
          accept=".srproj,.visionproj,.subvisionproj,.zip,application/zip,application/xml,text/xml,application/json"
          aria-hidden="true"
          tabIndex={-1}
          onChange={onFileChange}
        />
        <div className="converter-dropzone__glyph" aria-hidden="true">
          <span>↥</span>
        </div>
        <button
          className="converter-button converter-button--primary"
          type="button"
          onClick={() => fileInput.current?.click()}
        >
          {text.selectFile}
        </button>
        <p>{text.dropFile}</p>
        <small>{text.supported}</small>
      </div>
    </div>
  );
}

function StatusOnly({
  status,
  progress,
  diagnostics,
  text,
  language,
  onReset,
}: {
  status: ConverterStatus;
  progress: ConverterProgress | null;
  diagnostics: readonly ConverterDiagnostic[];
  text: LocalizedCopy;
  language: ConverterLanguage;
  onReset: () => void;
}) {
  if (status === "unsupported") {
    return (
      <div className="converter-status-result">
        {diagnostics.length > 0 ? (
          <DiagnosticSection diagnostics={diagnostics} text={text} />
        ) : (
          <div className="converter-inline-message converter-inline-message--error" role="alert">
            {text.unsupported}
          </div>
        )}
        <button className="converter-button converter-button--primary" type="button" onClick={onReset}>
          {text.another}
        </button>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="converter-status-result">
        {diagnostics.length > 0 ? (
          <DiagnosticSection diagnostics={diagnostics} text={text} />
        ) : (
          <div className="converter-inline-message converter-inline-message--error" role="alert">
            {text.genericError}
          </div>
        )}
        <button className="converter-button converter-button--primary" type="button" onClick={onReset}>
          {text.another}
        </button>
      </div>
    );
  }
  return progress ? (
    <ProgressSection progress={progress} text={text} language={language} />
  ) : (
    <div className="converter-status-only" role="status" aria-label={text.statusLabel}>
      <span className="converter-spinner" aria-hidden="true" />
      <span>{text.inspecting}</span>
    </div>
  );
}

function SourceSection({
  source,
  text,
  language,
  isBusy,
  showReset,
  onReset,
}: {
  source: ConverterSourceSummary;
  text: LocalizedCopy;
  language: ConverterLanguage;
  isBusy: boolean;
  showReset: boolean;
  onReset: () => void;
}) {
  const stats = [
    source.projectName
      ? { label: text.projectName, value: source.projectName }
      : null,
    source.projectType
      ? { label: text.projectType, value: source.projectType }
      : null,
    source.imageCount !== undefined
      ? { label: text.images, value: formatInteger(source.imageCount, language) }
      : null,
    source.classCount !== undefined
      ? { label: text.classes, value: formatInteger(source.classCount, language) }
      : null,
    source.labelCount !== undefined
      ? { label: text.labels, value: formatInteger(source.labelCount, language) }
      : null,
    source.splitSummary
      ? { label: text.split, value: source.splitSummary }
      : null,
  ].filter((item): item is { label: string; value: string } => item !== null);

  return (
    <section className="converter-section converter-source" aria-labelledby="converter-source-heading">
      <div className="converter-source__row">
        <div className="converter-source__icon" aria-hidden="true">✓</div>
        <div className="converter-source__identity">
          <p className="converter-eyebrow" id="converter-source-heading">
            {text.identified} · {text.formats[source.format]}
          </p>
          <div className="converter-source__filename" title={source.fileName}>
            {source.fileName}
          </div>
          <p className="converter-source__meta">
            {source.fileSize !== undefined ? formatBytes(source.fileSize, language) : null}
            {source.fileSize !== undefined && source.version ? " · " : null}
            {source.version ?? null}
          </p>
        </div>
        {showReset ? (
          <button
            className="converter-button converter-button--quiet"
            type="button"
            disabled={isBusy}
            onClick={onReset}
          >
            {text.change}
          </button>
        ) : null}
      </div>

      {stats.length > 0 ? (
        <dl className="converter-summary">
          {stats.map((stat, index) => (
            <div key={`${stat.label}-${index}`}>
              <dt>{stat.label}</dt>
              <dd title={stat.value}>{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function OutputSection({
  outputs,
  text,
  name,
  disabled,
  onTargetChange,
}: {
  outputs: readonly ConverterOutputOption[];
  text: LocalizedCopy;
  name: string;
  disabled: boolean;
  onTargetChange: (targetId: string) => void;
}) {
  return (
    <fieldset className="converter-section converter-output">
      <legend>{text.outputHeading}</legend>
      <div className="converter-output__grid">
        {outputs.map((option) => {
          const format = text.output[option.format];
          const optionDisabled = disabled || option.disabled;
          return (
            <label
              className="converter-output-option"
              data-selected={option.selected || undefined}
              data-disabled={optionDisabled || undefined}
              key={option.id}
            >
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={option.selected}
                disabled={optionDisabled}
                onChange={() => onTargetChange(option.id)}
              />
              <span className="converter-output-option__body">
                <span className="converter-output-option__topline">
                  <strong>{option.title ?? format.title}</strong>
                  {option.recommended ? (
                    <span className="converter-badge">{text.recommended}</span>
                  ) : null}
                </span>
                <code>{format.extension}</code>
                <span>{option.description ?? format.description}</span>
                {option.disabledReason ? (
                  <small className="converter-output-option__reason">
                    {option.disabledReason}
                  </small>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ImageSection({
  summary,
  text,
  language,
  disabled,
  onSelectDirectory,
  onSelectImageFiles,
  onSelectImageZip,
}: {
  summary: ImageMatchSummary;
  text: LocalizedCopy;
  language: ConverterLanguage;
  disabled: boolean;
  onSelectDirectory: () => void;
  onSelectImageFiles: () => void;
  onSelectImageZip: () => void;
}) {
  const isSourceReady = summary.state === "source-ready";
  const isMatching = summary.state === "matching";
  const issueCount = summary.issues?.length ?? 0;
  const visibleIssues = summary.issues?.slice(0, MAX_VISIBLE_ITEMS) ?? [];
  const remainingIssues = summary.issues?.slice(MAX_VISIBLE_ITEMS) ?? [];
  const percent = safePercent(summary.matchedCount, summary.totalCount);

  return (
    <section className="converter-section converter-images" aria-labelledby="converter-images-heading">
      <div className="converter-section__heading-row">
        <div>
          <h2 id="converter-images-heading">{text.imageHeading}</h2>
          <p>
            {isSourceReady ? text.sourceImagesReadyDetail : text.imageHelp}
          </p>
        </div>
        {isSourceReady ? (
          <span className="converter-ready-label">
            <span aria-hidden="true">✓</span>
            {text.sourceImagesReady}
          </span>
        ) : summary.canSelectDirectory !== false ? (
          <div
            className="converter-image-actions"
            role="group"
            aria-label={text.imageSourceGroupLabel}
          >
            <button
              className="converter-button converter-button--secondary"
              type="button"
              disabled={disabled || isMatching}
              onClick={onSelectDirectory}
            >
              {summary.directoryCount ? text.addDirectory : text.selectDirectory}
            </button>
            <div className="converter-image-actions__alternatives">
              <button
                className="converter-button converter-button--quiet"
                type="button"
                disabled={disabled || isMatching}
                onClick={onSelectImageZip}
              >
                {text.selectImageZip}
              </button>
              <button
                className="converter-button converter-button--quiet"
                type="button"
                disabled={disabled || isMatching}
                onClick={onSelectImageFiles}
              >
                {text.selectImageFiles}
              </button>
            </div>
            <small>{text.imageSourceAlternatives}</small>
          </div>
        ) : null}
      </div>

      {!isSourceReady ? (
        <>
          <div className="converter-match-line" aria-live="polite">
            <span>
              {text.matched} {formatInteger(summary.matchedCount, language)} / {formatInteger(summary.totalCount, language)}
            </span>
            <span>{text.missing} {formatInteger(summary.missingCount, language)}</span>
            <span>{text.ambiguous} {formatInteger(summary.ambiguousCount, language)}</span>
            {summary.matchedBytes !== undefined ? (
              <span>{formatBytes(summary.matchedBytes, language)}</span>
            ) : null}
          </div>
          <progress
            className="converter-progress"
            value={summary.matchedCount}
            max={Math.max(summary.totalCount, 1)}
            aria-label={text.progressLabel}
          />
          {isMatching ? (
            <p className="converter-images__notice" role="status">
              <span className="converter-spinner" aria-hidden="true" />
              {text.matching}
            </p>
          ) : summary.state === "incomplete" || summary.state === "needs-directory" ? (
            <p className="converter-images__notice converter-images__notice--warning">
              {text.imagesIncomplete}
            </p>
          ) : null}
        </>
      ) : null}

      {issueCount > 0 ? (
        <div className="converter-issues">
          <ul>
            {visibleIssues.map((issue, index) => (
              <IssueRow issue={issue} text={text} key={`${issue.path}-${index}`} />
            ))}
          </ul>
          {remainingIssues.length > 0 ? (
            <details>
              <summary>{text.showRemaining(remainingIssues.length)}</summary>
              <ul>
                {remainingIssues.map((issue, index) => (
                  <IssueRow issue={issue} text={text} key={`${issue.path}-more-${index}`} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      <span className="converter-visually-hidden">
        {formatInteger(percent, language)}%
      </span>
    </section>
  );
}

function IssueRow({
  issue,
  text,
}: {
  issue: ImageMatchIssue;
  text: LocalizedCopy;
}) {
  return (
    <li>
      <code title={issue.path}>{issue.path}</code>
      <span>{issue.message ?? (issue.status === "missing" ? text.missing : text.ambiguous)}</span>
    </li>
  );
}

function DiagnosticSection({
  diagnostics,
  text,
}: {
  diagnostics: readonly ConverterDiagnostic[];
  text: LocalizedCopy;
}) {
  const visible = diagnostics.slice(0, MAX_VISIBLE_ITEMS);
  const remaining = diagnostics.slice(MAX_VISIBLE_ITEMS);
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return (
    <section
      className="converter-section converter-diagnostics"
      aria-labelledby="converter-diagnostics-heading"
      role={hasError ? "alert" : undefined}
      aria-live={hasError ? "assertive" : "polite"}
    >
      <h2 id="converter-diagnostics-heading">{text.diagnostics}</h2>
      <ul>
        {visible.map((diagnostic, index) => (
          <DiagnosticRow diagnostic={diagnostic} key={`${diagnostic.code ?? "diagnostic"}-${index}`} />
        ))}
      </ul>
      {remaining.length > 0 ? (
        <details>
          <summary>{text.showMoreDiagnostics(remaining.length)}</summary>
          <ul>
            {remaining.map((diagnostic, index) => (
              <DiagnosticRow diagnostic={diagnostic} key={`${diagnostic.code ?? "diagnostic"}-more-${index}`} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: ConverterDiagnostic }) {
  return (
    <li className="converter-diagnostic" data-severity={diagnostic.severity}>
      <span className="converter-diagnostic__mark" aria-hidden="true">
        {diagnostic.severity === "error" ? "!" : diagnostic.severity === "warning" ? "!" : "i"}
      </span>
      <span>
        <span className="converter-diagnostic__message">{diagnostic.message}</span>
        {diagnostic.code || diagnostic.path ? (
          <small>
            {[diagnostic.code, diagnostic.path].filter(Boolean).join(" · ")}
          </small>
        ) : null}
      </span>
    </li>
  );
}

function ConfirmationSection({
  confirmation,
  text,
  inputId,
  disabled,
  onChange,
}: {
  confirmation: ConverterConfirmation;
  text: LocalizedCopy;
  inputId: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <section
      className="converter-section converter-confirmation"
      aria-labelledby={`${inputId}-heading`}
    >
      <h2 id={`${inputId}-heading`}>{text.confirmationHeading}</h2>
      <p id={`${inputId}-description`}>
        {confirmation.message ?? text.confirmationDefault}
      </p>
      <label className="converter-confirmation__control" htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          checked={confirmation.checked}
          disabled={disabled}
          aria-describedby={`${inputId}-description`}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span>{text.confirmationLabel}</span>
      </label>
    </section>
  );
}

function ProgressSection({
  progress,
  text,
  language,
}: {
  progress: ConverterProgress;
  text: LocalizedCopy;
  language: ConverterLanguage;
}) {
  const hasDeterminateProgress =
    progress.percent !== undefined ||
    (progress.current !== undefined && progress.total !== undefined && progress.total > 0);
  const value =
    progress.percent !== undefined
      ? clamp(progress.percent, 0, 100)
      : safePercent(progress.current ?? 0, progress.total ?? 0);
  const valueText = progressValueText(progress, text, language);

  return (
    <section className="converter-section converter-work" aria-live="polite" aria-label={text.statusLabel}>
      <div className="converter-work__heading">
        <span className="converter-spinner" aria-hidden="true" />
        <div>
          <strong>{progress.label ?? text.stages[progress.stage]}</strong>
          {progress.detail ? <p>{progress.detail}</p> : null}
        </div>
        {valueText ? <span>{valueText}</span> : null}
      </div>
      {hasDeterminateProgress ? (
        <progress className="converter-progress" value={value} max={100} aria-label={text.progressLabel} />
      ) : (
        <progress className="converter-progress" aria-label={text.progressLabel} />
      )}
    </section>
  );
}

function SuccessSection({ text, onReset }: { text: LocalizedCopy; onReset: () => void }) {
  return (
    <section className="converter-success" role="status">
      <div className="converter-success__mark" aria-hidden="true">✓</div>
      <div>
        <h2>{text.success}</h2>
        <p>{text.successDetail}</p>
      </div>
      <button
        className="converter-button converter-button--primary"
        type="button"
        onClick={onReset}
      >
        {text.another}
      </button>
    </section>
  );
}

function progressValueText(
  progress: ConverterProgress,
  text: LocalizedCopy,
  language: ConverterLanguage,
): string {
  if (progress.current !== undefined && progress.total !== undefined) {
    if (progress.unit === "bytes") {
      return `${formatBytes(progress.current, language)} / ${formatBytes(progress.total, language)}`;
    }
    return `${formatInteger(progress.current, language)} / ${formatInteger(progress.total, language)} ${text.countUnit}`;
  }
  if (progress.percent !== undefined) {
    return `${Math.round(clamp(progress.percent, 0, 100))}%`;
  }
  return "";
}

function formatInteger(value: number, language: ConverterLanguage): string {
  return new Intl.NumberFormat(languageTags[language], { maximumFractionDigits: 0 }).format(value);
}

function formatBytes(bytes: number, language: ConverterLanguage): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${new Intl.NumberFormat(languageTags[language], {
    maximumFractionDigits: value >= 10 || index === 0 ? 0 : 1,
  }).format(value)} ${units[index]}`;
}

function safePercent(current: number, total: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((current / total) * 100, 0, 100);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
