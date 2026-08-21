import { expect, test, type Page } from "@playwright/test";
import { File as NodeFile } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../../lib/input/loadProject.ts";
import { parseV1Srproj } from "../../lib/input/v1.ts";
import { writeVisionArchive } from "../../lib/output/containers.ts";
import type { FileSystemSaveHandle } from "../../lib/output/save.ts";
import { writeV2VisionProject } from "../../lib/output/v2.ts";
import { parseV2SubvisionProject } from "../../lib/input/v2.ts";

const subvisionFixture = fileURLToPath(
  new URL("../fixtures/native-v2-2.7.8-classification.subvisionproj", import.meta.url),
);
const pagesRoot = resolve(process.cwd(), "out");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

class MemorySaveHandle implements FileSystemSaveHandle {
  private readonly chunks: ArrayBuffer[] = [];

  async createWritable(): Promise<WritableStream<Uint8Array>> {
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        this.chunks.push(copy.buffer);
      },
    });
  }

  blob(): Blob {
    return new Blob(this.chunks, { type: "application/zip" });
  }
}

function pngHeader(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.buffer;
}

async function createVisionFixture(outputPath: string): Promise<void> {
  const jsonText = await readFile(subvisionFixture, "utf8");
  const parsed = parseV2SubvisionProject({ jsonText });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("Unable to prepare the V2 browser fixture.");
  const built = writeV2VisionProject(parsed.project, {
    allowConfirmedLoss: true,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("Unable to build the V2 browser fixture.");
  const handle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: built.imageEntries.map((entry) => {
      const file = parsed.project.files.find(
        (candidate) => candidate.index === entry.fileIndex,
      );
      if (!file?.width || !file.height) {
        throw new Error(`Missing fixture dimensions for file ${entry.fileIndex}.`);
      }
      return {
        fileIndex: entry.fileIndex,
        originalPath: file.sourcePath,
        source: {
          kind: "blob" as const,
          blob: new Blob([pngHeader(file.width, file.height)], {
            type: "image/png",
          }),
        },
      };
    }),
  });
  await writeFile(outputPath, new Uint8Array(await handle.blob().arrayBuffer()));
}

async function routePagesOutput(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const relativePath = pathname.replace(/^[/\\]+/u, "") || "index.html";
    const filePath = resolve(pagesRoot, relativePath);
    if (filePath !== pagesRoot && !filePath.startsWith(`${pagesRoot}${sep}`)) {
      await route.fulfill({ status: 400, body: "Invalid path" });
      return;
    }
    try {
      const body = await readFile(filePath);
      await route.fulfill({
        status: 200,
        body,
        contentType:
          contentTypes.get(extname(filePath).toLowerCase()) ??
          "application/octet-stream",
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
}

test("converts a V2 light project into a non-empty, reloadable V1 download", async ({
  page,
}, testInfo) => {
  await routePagesOutput(page);
  await page.goto("/");
  await page.getByRole("button", { name: "中文" }).click();

  const projectInput = page.locator(
    'input[type="file"][accept*=".subvisionproj"]',
  );
  await projectInput.setInputFiles(subvisionFixture);
  await expect(page.getByText(/已识别.*SaigeVision V2 轻量项目/u)).toBeVisible();

  await page.locator('input[type="radio"][value="srproj"]').check();
  const confirmation = page.locator('input[type="checkbox"]');
  if (await confirmation.isVisible()) {
    await confirmation.check();
  }
  const saveButton = page.getByRole("button", {
    name: /转换并保存.*\.srproj/u,
  });
  await expect(saveButton).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    saveButton.click(),
  ]);
  const outputPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(outputPath);
  const bytes = await readFile(outputPath);

  expect(bytes.byteLength).toBeGreaterThan(100);
  expect(download.suggestedFilename()).toMatch(/\.srproj$/u);
  const parsed = parseV1Srproj({
    xmlText: new TextDecoder().decode(bytes),
    fileName: download.suggestedFilename(),
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("The downloaded .srproj could not be parsed again.");
  }
  expect(parsed.project.project.type).toBe("classification");
  expect(parsed.project.files.length).toBeGreaterThan(0);

  await expect(page.getByRole("heading", { name: "转换完成" })).toBeVisible();
  await expect(page.locator(".converter-success__file")).toContainText(
    download.suggestedFilename(),
  );
  await expect(page.locator(".converter-success__file")).toContainText(/\d+\s(?:B|KB)/u);
});

test("converts a complete V2 project into a non-empty, reloadable SVPA ZIP", async ({
  page,
}, testInfo) => {
  const visionPath = testInfo.outputPath("browser-fixture.visionproj");
  await createVisionFixture(visionPath);
  await routePagesOutput(page);
  await page.goto("/");
  await page.getByRole("button", { name: "中文" }).click();
  await page.locator('input[type="file"][accept*=".visionproj"]').setInputFiles(
    visionPath,
  );
  await expect(page.getByText(/已识别.*SaigeVision V2 完整项目/u)).toBeVisible();
  const confirmation = page.locator('input[type="checkbox"]');
  if (await confirmation.isVisible()) {
    await confirmation.check();
  }

  const saveButton = page.getByRole("button", {
    name: /转换并保存 SVPA\.zip/u,
  });
  await expect(saveButton).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    saveButton.click(),
  ]);
  const outputPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(outputPath);
  const bytes = await readFile(outputPath);
  expect(bytes.byteLength).toBeGreaterThan(6_900_000);

  const outputFile = new NodeFile(
    [bytes] as unknown as ConstructorParameters<typeof NodeFile>[0],
    download.suggestedFilename(),
  ) as unknown as File;
  const loaded = await loadProject(outputFile);
  try {
    expect(loaded.parseResult.ok).toBe(true);
    expect(loaded.format).toBe("v1-svpa");
    expect(loaded.project?.files.length).toBe(2);
  } finally {
    await loaded.close();
  }

  await expect(page.getByRole("heading", { name: "转换完成" })).toBeVisible();
  await expect(page.locator(".converter-success__file")).toContainText(/\d+(?:\.\d+)?\sMB/u);
});
