import type { ProjectType } from "./model/project.ts";

export const APP_VERSION = "0.0.2" as const;

export const SUPPORTED_PROJECT_TYPES = [
  "classification",
  "segmentation",
] as const satisfies readonly ProjectType[];

export type SupportedProjectType = (typeof SUPPORTED_PROJECT_TYPES)[number];

export function isSupportedProjectType(
  type: ProjectType,
): type is SupportedProjectType {
  return SUPPORTED_PROJECT_TYPES.some((supported) => supported === type);
}
