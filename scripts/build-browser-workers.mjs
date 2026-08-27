import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const outputDirectory = resolve("public/workers");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        "project-parser": resolve("lib/workers/projectParser.worker.ts"),
        "project-writer": resolve("lib/workers/projectWriter.worker.ts"),
      },
      output: {
        format: "es",
        entryFileNames: "[name].worker.js",
        chunkFileNames: "shared-[hash].js",
      },
    },
  },
});
