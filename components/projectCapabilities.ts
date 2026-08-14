import type {
  ProjectDiagnostic,
  ProjectSourceFormat,
  ProjectType,
} from "../lib/model/project.ts";
import { isSupportedProjectType } from "../lib/release.ts";

export type ProjectOutputFormat =
  | "visionproj"
  | "subvisionproj"
  | "srproj"
  | "svpa-zip";

export type TargetConfirmationMode =
  | "none"
  | "loss"
  | "relative-path"
  | "mixed";

type OutputMatrix = Readonly<
  Record<ProjectSourceFormat, readonly ProjectOutputFormat[]>
>;

const VERIFIED_OUTPUTS: OutputMatrix = {
  "v1-srproj": ["visionproj", "subvisionproj", "svpa-zip"],
  "v1-svpa": ["visionproj", "subvisionproj"],
  "v2-visionproj": ["svpa-zip"],
  "v2-subvisionproj": ["svpa-zip", "srproj"],
};

/** Return only conversion paths validated for both the source container and
 * normalized project type. The first item is the UI's recommended default. */
export function allowedOutputs(
  format: ProjectSourceFormat,
  projectType: ProjectType,
): readonly ProjectOutputFormat[] {
  return isSupportedProjectType(projectType) ? VERIFIED_OUTPUTS[format] : [];
}

export function targetIncludesDiagnostic(
  diagnostic: Pick<ProjectDiagnostic, "code">,
  target: ProjectOutputFormat | null,
): boolean {
  return !(target === "svpa-zip" && diagnostic.code === "V2_EXTERNAL_PATH_RELATIVE");
}

export function targetNeedsConfirmation(
  diagnostics: readonly Pick<ProjectDiagnostic, "code" | "disposition">[],
  target: ProjectOutputFormat | null,
): boolean {
  return targetConfirmationMode(diagnostics, target) !== "none";
}

export function targetConfirmationMode(
  diagnostics: readonly Pick<ProjectDiagnostic, "code" | "disposition">[],
  target: ProjectOutputFormat | null,
): TargetConfirmationMode {
  const relevantDiagnostics = diagnostics.filter(
    (diagnostic) =>
      (diagnostic.disposition === "drop" || diagnostic.disposition === "degrade") &&
      targetIncludesDiagnostic(diagnostic, target),
  );
  if (relevantDiagnostics.length === 0) return "none";

  const hasRelativePath = relevantDiagnostics.some(
    (diagnostic) => diagnostic.code === "V2_EXTERNAL_PATH_RELATIVE",
  );
  if (!hasRelativePath) return "loss";

  return relevantDiagnostics.some(
    (diagnostic) => diagnostic.code !== "V2_EXTERNAL_PATH_RELATIVE",
  )
    ? "mixed"
    : "relative-path";
}

export function hasRelativeExternalPaths(paths: readonly string[]): boolean {
  return paths.some((path) => !isAbsoluteExternalPath(unquotePath(path)));
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
