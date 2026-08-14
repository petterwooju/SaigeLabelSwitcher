import type {
  ProjectSourceFormat,
  ProjectType,
} from "../lib/model/project.ts";

export type ProjectOutputFormat =
  | "visionproj"
  | "subvisionproj"
  | "srproj"
  | "svpa-zip";

type OutputMatrix = Readonly<
  Record<ProjectSourceFormat, readonly ProjectOutputFormat[]>
>;

const VERIFIED_OUTPUTS: OutputMatrix = {
  "v1-srproj": ["visionproj", "subvisionproj", "svpa-zip"],
  "v1-svpa": ["visionproj", "subvisionproj"],
  "v2-visionproj": ["svpa-zip"],
  "v2-subvisionproj": ["svpa-zip", "srproj"],
};

const OUTPUTS_BY_PROJECT_TYPE: Partial<Record<ProjectType, OutputMatrix>> = {
  classification: VERIFIED_OUTPUTS,
  segmentation: VERIFIED_OUTPUTS,
};

/** Return only conversion paths validated for both the source container and
 * normalized project type. The first item is the UI's recommended default. */
export function allowedOutputs(
  format: ProjectSourceFormat,
  projectType: ProjectType,
): readonly ProjectOutputFormat[] {
  return OUTPUTS_BY_PROJECT_TYPE[projectType]?.[format] ?? [];
}
