"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useEffect,
  useId,
  useRef,
  type RefObject,
} from "react";
import "./converter.css";
import type { ProjectSourceFormat } from "../lib/model/project.ts";
import { APP_VERSION } from "../lib/release.ts";
import type { ProjectOutputFormat } from "./projectCapabilities.ts";
import {
  clamp,
  copy,
  formatBytes,
  formatInteger,
  languageOptions,
  languageTags,
  safePercent,
  type ConverterLanguage as CopyConverterLanguage,
  type LocalizedCopy,
} from "./converterShellCopy.ts";

export type ConverterLanguage = CopyConverterLanguage;

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

export type ConverterSourceFormat = ProjectSourceFormat;

export type ConverterOutputFormat = ProjectOutputFormat;

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
  readonly id: ConverterOutputFormat;
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
  readonly pathTitle?: string;
  readonly status: "missing" | "ambiguous";
  readonly message?: string;
}

export interface ImageSourceBatchSummary {
  readonly id: string;
  readonly kind: "directory" | "files" | "zip";
  readonly label: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ImageMatchSummary {
  readonly state: ImageMatchState;
  /** Whether selected images are packaged or only inspected for missing dimensions. */
  readonly purpose: "package" | "dimensions";
  readonly totalCount: number;
  readonly matchedCount: number;
  readonly missingCount: number;
  readonly ambiguousCount: number;
  readonly matchedBytes?: number;
  readonly directoryCount?: number;
  readonly hasSelectedSources?: boolean;
  readonly canSelectDirectory?: boolean;
  /** Exact number of missing, ambiguous, or blank-path items, even when sampled. */
  readonly issueCount?: number;
  readonly issues?: readonly ImageMatchIssue[];
  readonly sourceBatches?: readonly ImageSourceBatchSummary[];
}

export interface ConverterDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  readonly pathTitle?: string;
}

export interface ConverterConfirmation {
  readonly required: boolean;
  readonly checked: boolean;
  readonly message?: string;
  readonly label?: string;
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
  readonly detailTitle?: string;
}

export interface ConverterSaveResult {
  readonly mode: "direct" | "download";
  readonly fileName: string;
  readonly size?: number;
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
  readonly saveResult?: ConverterSaveResult | null;
  readonly preparedForSave?: boolean;
  readonly canSave?: boolean;
  readonly onSelectFile: (files: readonly File[]) => void;
  readonly onDrop: (files: readonly File[]) => void;
  readonly onTargetChange: (targetId: ConverterOutputFormat) => void;
  readonly onSelectDirectory: () => void;
  readonly onSelectImageFiles: () => void;
  readonly onSelectImageZip: () => void;
  readonly onClearImageSources: () => void;
  readonly onRemoveImageSource: (selectionId: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  readonly onLanguageChange: (language: ConverterLanguage) => void;
  readonly onConfirmationChange: (checked: boolean) => void;
}

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
  saveResult = null,
  preparedForSave = false,
  canSave,
  onSelectFile,
  onDrop,
  onTargetChange,
  onSelectDirectory,
  onSelectImageFiles,
  onSelectImageZip,
  onClearImageSources,
  onRemoveImageSource,
  onSave,
  onCancel,
  onReset,
  onLanguageChange,
  onConfirmationChange,
}: ConverterShellProps) {
  const text = copy[language];
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceHeadingRef = useRef<HTMLParagraphElement>(null);
  const diagnosticHeadingRef = useRef<HTMLHeadingElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastFocusKeyRef = useRef<string | null>(null);
  const isMatching = progress?.stage === "matching" || imageMatch?.state === "matching";
  const isChoosingSaveLocation = progress?.stage === "choosing-save-location";
  const isBusy = status === "inspecting" || status === "saving" || isMatching || isChoosingSaveLocation;
  const selectedOutput = outputs.find((option) => option.selected);
  const saveEnabled =
    (canSave ?? status === "ready") && !isBusy && !selectedOutput?.disabled;
  const firstBlockingDiagnostic = diagnostics.find((item) => item.severity === "error");
  const focusKind = status === "success"
    ? "success"
    : firstBlockingDiagnostic
      ? "diagnostic"
      : source && status !== "inspecting"
        ? "source"
        : null;
  const focusKey = focusKind === "success"
    ? `success:${saveResult?.fileName ?? "result"}`
    : focusKind === "diagnostic"
      ? `diagnostic:${firstBlockingDiagnostic?.code ?? firstBlockingDiagnostic?.message ?? status}`
      : focusKind === "source"
        ? `source:${source?.fileName ?? "project"}`
        : null;

  useEffect(() => {
    if (!focusKey || !focusKind) {
      lastFocusKeyRef.current = null;
      return;
    }
    if (lastFocusKeyRef.current === focusKey) return;
    lastFocusKeyRef.current = focusKey;
    const frame = window.requestAnimationFrame(() => {
      const heading = focusKind === "success"
        ? successHeadingRef.current
        : focusKind === "diagnostic"
          ? diagnosticHeadingRef.current
          : sourceHeadingRef.current;
      heading?.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusKey, focusKind]);

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
          <div className="converter-shell__brand">
            SaigeVision <span>{`v${APP_VERSION}`}</span>
          </div>
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
                    disabled={isBusy || preparedForSave}
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
              onCancel={onCancel}
              diagnosticHeadingRef={diagnosticHeadingRef}
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
                headingRef={sourceHeadingRef}
              />

              {outputs.length > 0 ? (
                <OutputSection
                  outputs={outputs}
                  text={text}
                  name={`${inputId}-output`}
                  disabled={isBusy || preparedForSave || status === "success"}
                  onTargetChange={onTargetChange}
                />
              ) : null}

              {imageMatch ? (
                <ImageSection
                  summary={imageMatch}
                  text={text}
                  language={language}
                  disabled={isBusy || preparedForSave || status === "success"}
                  onSelectDirectory={onSelectDirectory}
                  onSelectImageFiles={onSelectImageFiles}
                  onSelectImageZip={onSelectImageZip}
                  onClearImageSources={onClearImageSources}
                  onRemoveImageSource={onRemoveImageSource}
                />
              ) : null}

              {diagnostics.length > 0 ? (
                <DiagnosticSection
                  diagnostics={diagnostics}
                  text={text}
                  headingRef={diagnosticHeadingRef}
                />
              ) : null}

              {confirmation?.required && status !== "success" ? (
                <ConfirmationSection
                  confirmation={confirmation}
                  text={text}
                  inputId={`${inputId}-confirmation`}
                  disabled={isBusy || preparedForSave}
                  onChange={onConfirmationChange}
                />
              ) : null}

              {progress && !(progress.stage === "matching" && imageMatch) ? (
                <ProgressSection
                  progress={progress}
                  text={text}
                  language={language}
                  onCancel={onCancel}
                />
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
                <SuccessSection
                  text={text}
                  language={language}
                  result={saveResult}
                  onReset={onReset}
                  headingRef={successHeadingRef}
                />
              ) : selectedOutput ? (
                <footer className="converter-card__actions">
                  <button
                    className="converter-button converter-button--primary converter-button--wide"
                    type="button"
                    disabled={!saveEnabled}
                    onClick={onSave}
                  >
                    {preparedForSave
                      ? text.chooseSaveLocation
                      : isChoosingSaveLocation
                      ? text.stages["choosing-save-location"]
                      : status === "saving"
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
        <footer className="converter-shell__legal">
          <a href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">
            {text.thirdPartyNotices}
          </a>
        </footer>
      </div>
    </main>
  );
}

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
  onCancel,
  diagnosticHeadingRef,
}: {
  status: ConverterStatus;
  progress: ConverterProgress | null;
  diagnostics: readonly ConverterDiagnostic[];
  text: LocalizedCopy;
  language: ConverterLanguage;
  onReset: () => void;
  onCancel: () => void;
  diagnosticHeadingRef: RefObject<HTMLHeadingElement | null>;
}) {
  if (status === "unsupported") {
    return (
      <div className="converter-status-result">
        {diagnostics.length > 0 ? (
          <DiagnosticSection
            diagnostics={diagnostics}
            text={text}
            headingRef={diagnosticHeadingRef}
          />
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
          <DiagnosticSection
            diagnostics={diagnostics}
            text={text}
            headingRef={diagnosticHeadingRef}
          />
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
    <ProgressSection
      progress={progress}
      text={text}
      language={language}
      onCancel={onCancel}
    />
  ) : (
    <div className="converter-status-only" role="status" aria-label={text.statusLabel}>
      <span className="converter-spinner" aria-hidden="true" />
      <span>{text.inspecting}</span>
      <button
        className="converter-button converter-button--quiet"
        type="button"
        onClick={onCancel}
      >
        {text.cancel}
      </button>
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
  headingRef,
}: {
  source: ConverterSourceSummary;
  text: LocalizedCopy;
  language: ConverterLanguage;
  isBusy: boolean;
  showReset: boolean;
  onReset: () => void;
  headingRef: RefObject<HTMLParagraphElement | null>;
}) {
  const headingId = useId();
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
    <section className="converter-section converter-source" aria-labelledby={headingId}>
      <div className="converter-source__row">
        <div className="converter-source__icon" aria-hidden="true">✓</div>
        <div className="converter-source__identity">
          <p className="converter-eyebrow" id={headingId} ref={headingRef} tabIndex={-1}>
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
  onTargetChange: (targetId: ConverterOutputFormat) => void;
}) {
  return (
    <fieldset className="converter-section converter-output" aria-live="polite">
      <legend>{text.outputHeading}</legend>
      <div className="converter-output__grid">
        {outputs.map((option) => {
          const format = text.output[option.format];
          const optionDisabled = disabled || option.disabled;
          const descriptionId = `${name}-${option.id}-description`;
          const reasonId = option.disabledReason
            ? `${name}-${option.id}-disabled-reason`
            : undefined;
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
                aria-describedby={[descriptionId, reasonId].filter(Boolean).join(" ")}
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
                <span id={descriptionId}>{option.description ?? format.description}</span>
                {option.disabledReason ? (
                  <small
                    className="converter-output-option__reason"
                    id={reasonId}
                    role="note"
                  >
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
  onClearImageSources,
  onRemoveImageSource,
}: {
  summary: ImageMatchSummary;
  text: LocalizedCopy;
  language: ConverterLanguage;
  disabled: boolean;
  onSelectDirectory: () => void;
  onSelectImageFiles: () => void;
  onSelectImageZip: () => void;
  onClearImageSources: () => void;
  onRemoveImageSource: (selectionId: string) => void;
}) {
  const headingId = useId();
  const isSourceReady = summary.state === "source-ready";
  const isMatching = summary.state === "matching";
  const dimensionsOnly = summary.purpose === "dimensions";
  const retainedIssueCount = summary.issues?.length ?? 0;
  const issueCount = summary.issueCount ?? retainedIssueCount;
  const visibleIssues = summary.issues?.slice(0, MAX_VISIBLE_ITEMS) ?? [];
  const remainingIssues = summary.issues?.slice(MAX_VISIBLE_ITEMS) ?? [];
  const percent = safePercent(summary.matchedCount, summary.totalCount);

  return (
    <section className="converter-section converter-images" aria-labelledby={headingId}>
      <div className="converter-section__heading-row">
        <div>
          <h2 id={headingId}>{text.imageHeading}</h2>
          <p>
            {dimensionsOnly
              ? text.imageHelpDimensions
              : isSourceReady
                ? text.sourceImagesReadyDetail
                : text.imageHelp}
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
            {summary.hasSelectedSources ? (
              <button
                className="converter-button converter-button--quiet converter-image-actions__clear"
                type="button"
                disabled={disabled || isMatching}
                onClick={onClearImageSources}
              >
                {text.clearImageSources}
              </button>
            ) : null}
            <small>{text.imageSourceAlternatives}</small>
          </div>
        ) : null}
      </div>

      {!isSourceReady ? (
        <>
          <div className="converter-match-line">
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
              {dimensionsOnly ? text.imagesIncompleteDimensions : text.imagesIncomplete}
            </p>
          ) : null}
        </>
      ) : null}

      {summary.sourceBatches?.length ? (
        <div className="converter-image-sources">
          <h3>{text.selectedImageSources}</h3>
          <ul>
            {summary.sourceBatches.map((batch) => (
              <li key={batch.id}>
                <span className="converter-image-sources__identity">
                  <strong title={batch.label}>{batch.label}</strong>
                  <small>
                    {batch.kind === "directory"
                      ? text.sourceKindDirectory
                      : batch.kind === "zip"
                        ? text.sourceKindZip
                        : text.sourceKindFiles}
                    {" · "}
                    {text.sourceFileCount(batch.fileCount)}
                    {" · "}
                    {formatBytes(batch.totalBytes, language)}
                  </small>
                </span>
                <button
                  className="converter-button converter-button--quiet converter-image-sources__remove"
                  type="button"
                  aria-label={text.removeImageSource(batch.label)}
                  disabled={disabled || isMatching}
                  onClick={() => onRemoveImageSource(batch.id)}
                >
                  {text.remove}
                </button>
              </li>
            ))}
          </ul>
        </div>
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
          {issueCount > retainedIssueCount ? (
            <p className="converter-issues__limit" role="status">
              {text.issueSampleLimit(retainedIssueCount, issueCount)}
            </p>
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
      <code title={issue.pathTitle ?? issue.path}>{issue.path}</code>
      <span>{issue.message ?? (issue.status === "missing" ? text.missing : text.ambiguous)}</span>
    </li>
  );
}

function DiagnosticSection({
  diagnostics,
  text,
  headingRef,
}: {
  diagnostics: readonly ConverterDiagnostic[];
  text: LocalizedCopy;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const headingId = useId();
  const visible = diagnostics.slice(0, MAX_VISIBLE_ITEMS);
  const remaining = diagnostics.slice(MAX_VISIBLE_ITEMS);
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return (
    <section
      className="converter-section converter-diagnostics"
      aria-labelledby={headingId}
      aria-live={hasError ? "assertive" : "polite"}
    >
      <h2 id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
        {text.diagnostics}
      </h2>
      <ul>
        {visible.map((diagnostic, index) => (
          <DiagnosticRow diagnostic={diagnostic} text={text} key={`${diagnostic.code ?? "diagnostic"}-${index}`} />
        ))}
      </ul>
      {remaining.length > 0 ? (
        <details>
          <summary>{text.showMoreDiagnostics(remaining.length)}</summary>
          <ul>
            {remaining.map((diagnostic, index) => (
              <DiagnosticRow diagnostic={diagnostic} text={text} key={`${diagnostic.code ?? "diagnostic"}-more-${index}`} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function DiagnosticRow({
  diagnostic,
  text,
}: {
  diagnostic: ConverterDiagnostic;
  text: LocalizedCopy;
}) {
  const severityLabel = diagnostic.severity === "error"
    ? text.severityError
    : diagnostic.severity === "warning"
      ? text.severityWarning
      : text.severityInfo;
  return (
    <li className="converter-diagnostic" data-severity={diagnostic.severity}>
      <span className="converter-diagnostic__mark" aria-hidden="true">
        {diagnostic.severity === "error" ? "!" : diagnostic.severity === "warning" ? "!" : "i"}
      </span>
      <span>
        <span className="converter-visually-hidden">{severityLabel}</span>
        <span className="converter-diagnostic__message">{diagnostic.message}</span>
        {diagnostic.code || diagnostic.path ? (
          <small title={diagnostic.pathTitle}>
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
      aria-describedby={`${inputId}-description`}
      aria-live="polite"
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
        <span>{confirmation.label ?? text.confirmationLabel}</span>
      </label>
    </section>
  );
}

function ProgressSection({
  progress,
  text,
  language,
  onCancel,
}: {
  progress: ConverterProgress;
  text: LocalizedCopy;
  language: ConverterLanguage;
  onCancel: () => void;
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
          {progress.detail ? <p title={progress.detailTitle}>{progress.detail}</p> : null}
        </div>
        <div className="converter-work__actions">
          {valueText ? <span>{valueText}</span> : null}
          {progress.stage !== "finalizing" ? (
            <button
              className="converter-button converter-button--quiet converter-work__cancel"
              type="button"
              onClick={onCancel}
            >
              {text.cancel}
            </button>
          ) : null}
        </div>
      </div>
      {hasDeterminateProgress ? (
        <progress className="converter-progress" value={value} max={100} aria-label={text.progressLabel} />
      ) : (
        <progress className="converter-progress" aria-label={text.progressLabel} />
      )}
    </section>
  );
}

function SuccessSection({
  text,
  language,
  result,
  onReset,
  headingRef,
}: {
  text: LocalizedCopy;
  language: ConverterLanguage;
  result: ConverterSaveResult | null;
  onReset: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const detail = result
    ? result.mode === "direct"
      ? text.successDirect
      : text.successDownload
    : text.successFallback;
  return (
    <section className="converter-success" role="status">
      <div className="converter-success__mark" aria-hidden="true">✓</div>
      <div>
        <h2 ref={headingRef} tabIndex={-1}>{text.success}</h2>
        <p>{detail}</p>
        {result?.fileName ? (
          <div className="converter-success__file">
            <code className="converter-success__filename" title={result.fileName}>
              {result.fileName}
            </code>
            {result.size !== undefined ? (
              <span>{formatBytes(result.size, language)}</span>
            ) : null}
          </div>
        ) : null}
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
