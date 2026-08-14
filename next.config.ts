import type { NextConfig } from "next";

const isGitHubPagesExport = process.env.GITHUB_PAGES_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isGitHubPagesExport ? { output: "export" as const } : {}),
};

export default nextConfig;
