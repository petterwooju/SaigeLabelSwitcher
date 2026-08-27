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
const v1SegmentationFixture = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version>
  <Type>Segmentation</Type>
  <ClassGroup>
    <NumberOfClasses>2</NumberOfClasses>
    <Class><Name>Scratch</Name><Color>-65536</Color></Class>
    <Class><Name>Spot</Name><Color>-16711936</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>2</NumberOfImages>
    <Image>
      <Path>C:\images\defect.png</Path>
      <Width>64</Width><Height>32</Height>
      <SplitState>Training</SplitState>
      <LabelGroup>
        <IsNormal>false</IsNormal><NumberOfLabels>1</NumberOfLabels>
        <Label>
          <ClassIndex>0</ClassIndex><Type>Contours</Type>
          <ContourGroup>
            <Contour Type="Outer">
              <Point X="1" Y="2"/><Point X="20" Y="2"/>
              <Point X="20" Y="18"/><Point X="1" Y="18"/>
            </Contour>
            <Contour Type="Inner">
              <Point X="4" Y="5"/><Point X="8" Y="5"/>
              <Point X="6" Y="9"/>
            </Contour>
          </ContourGroup>
        </Label>
      </LabelGroup>
    </Image>
    <Image>
      <Path>C:\images\normal.png</Path>
      <Width>64</Width><Height>32</Height>
      <SplitState>Validation</SplitState>
      <LabelGroup><IsNormal>true</IsNormal><NumberOfLabels>0</NumberOfLabels></LabelGroup>
    </Image>
  </ImageGroup>
  <MaskingParameter>
    <Type>Simple</Type>
    <RoiRectangle X="0.125" Y="0.25" Width="0.75" Height="0.5" Shape="Rectangle" />
    <RoiSetting>
      <Intensity Min="0" Max="255"/><Expansion Value="0"/>
      <Inversion Value="False"/>
      <Offset Left="100" Right="100" Top="100" Bottom="100"/>
    </RoiSetting>
    <BlindGroup><NumberOfBlinds>0</NumberOfBlinds></BlindGroup>
  </MaskingParameter>
</Project>`;
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
  const mismatchedPath = "C:/fixtures/mismatch.bmp";
  const project = {
    ...parsed.project,
    files: parsed.project.files.map((file, index) =>
      index === 0
        ? {
            ...file,
            sourcePath: mismatchedPath,
            normalizedPath: mismatchedPath,
            fileName: "mismatch.bmp",
            image: { kind: "external" as const, path: mismatchedPath },
          }
        : file,
    ),
  };
  const built = writeV2VisionProject(project, {
    allowConfirmedLoss: true,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("Unable to build the V2 browser fixture.");
  const handle = new MemorySaveHandle();
  await writeVisionArchive({
    destination: { fileName: built.fileName, handle },
    built,
    images: built.imageEntries.map((entry) => {
      const file = project.files.find(
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

async function acknowledgeConfirmationIfPresent(page: Page): Promise<void> {
  const confirmation = page.locator(
    '.converter-confirmation input[type="checkbox"]',
  );
  try {
    await confirmation.waitFor({ state: "visible", timeout: 1_000 });
    await confirmation.check();
  } catch {
    // Compatible targets intentionally render no confirmation control.
  }
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
  await acknowledgeConfirmationIfPresent(page);
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
  await acknowledgeConfirmationIfPresent(page);

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
    const repairedFile = loaded.project?.files.find((file) =>
      file.sourcePath.endsWith("mismatch.bmp"),
    );
    expect(repairedFile?.image.kind).toBe("archive");
    if (repairedFile?.image.kind === "archive") {
      expect(repairedFile.image.entryName).toMatch(/mismatch\.png$/u);
    }
    const manifestEntry = loaded.svpaManifest?.Entries.find((entry) =>
      entry.OriginalPath.endsWith("mismatch.bmp"),
    );
    expect(manifestEntry?.RelativePath).toMatch(/mismatch\.png$/u);
  } finally {
    await loaded.close();
  }

  await expect(page.getByRole("heading", { name: "转换完成" })).toBeVisible();
  await expect(page.locator(".converter-success__file")).toContainText(/\d+(?:\.\d+)?\sMB/u);
});

test("converts V1 Segmentation, ROI and validation split into a reloadable V2 project", async ({
  page,
}, testInfo) => {
  const srprojPath = testInfo.outputPath("segmentation-roi.srproj");
  await writeFile(srprojPath, v1SegmentationFixture, "utf8");
  await routePagesOutput(page);
  await page.goto("/");
  await page.getByRole("button", { name: "中文" }).click();
  await page.locator('input[type="file"][accept*=".srproj"]').setInputFiles(
    srprojPath,
  );
  await expect(page.getByText(/已识别.*SaigeVision V1 项目/u)).toBeVisible();

  const [imageChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "选择图片文件" }).click(),
  ]);
  await imageChooser.setFiles([
    {
      name: "defect.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngHeader(64, 32)),
    },
    {
      name: "normal.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngHeader(64, 32)),
    },
  ]);
  await acknowledgeConfirmationIfPresent(page);

  const saveButton = page.getByRole("button", {
    name: /转换并保存 \.visionproj/u,
  });
  await expect(saveButton).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    saveButton.click(),
  ]);
  const outputPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(outputPath);
  const bytes = await readFile(outputPath);
  expect(bytes.byteLength).toBeGreaterThan(1_000);

  const outputFile = new NodeFile(
    [bytes] as unknown as ConstructorParameters<typeof NodeFile>[0],
    download.suggestedFilename(),
  ) as unknown as File;
  const loaded = await loadProject(outputFile);
  try {
    expect(loaded.format).toBe("v2-visionproj");
    expect(loaded.parseResult.ok).toBe(true);
    expect(loaded.project?.project.type).toBe("segmentation");
    expect(loaded.project?.project.roi).toEqual({
      mode: "simple",
      shape: "rectangle",
      left: 0.125,
      top: 0.25,
      right: 0.875,
      bottom: 0.75,
    });
    expect(loaded.project?.files.map((file) => file.canonicalSplit)).toEqual([
      "training",
      "validation",
    ]);
    expect(loaded.project?.files[0]?.labels[0]?.geometry.contourRoles).toEqual([
      "outer",
      "inner",
    ]);
    expect(loaded.project?.files[1]?.isNormal).toBe(true);
    expect(loaded.projectJsonText).toContain('"splitType":"val"');
    expect(loaded.project?.files.every((file) => file.image.kind === "archive")).toBe(
      true,
    );
  } finally {
    await loaded.close();
  }
});

test("shows selected image batches and removing one recalculates readiness", async ({
  page,
}) => {
  const jsonText = await readFile(subvisionFixture, "utf8");
  const parsed = parseV2SubvisionProject({ jsonText });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("Unable to prepare the image-source fixture.");

  await routePagesOutput(page);
  await page.goto("/");
  await page.getByRole("button", { name: "中文" }).click();
  await page.locator('input[type="file"][accept*=".subvisionproj"]').setInputFiles(
    subvisionFixture,
  );

  const [imageChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "选择图片文件" }).click(),
  ]);
  await imageChooser.setFiles(parsed.project.files.map((file) => ({
    name: file.fileName,
    mimeType: "image/png",
    buffer: Buffer.from(pngHeader(file.width ?? 800, file.height ?? 800)),
  })));
  await acknowledgeConfirmationIfPresent(page);

  await expect(page.getByRole("heading", { name: "已选图片来源" })).toBeVisible();
  await expect(page.getByText("2 个文件")).toBeVisible();
  const saveButton = page.getByRole("button", { name: /转换并保存 SVPA\.zip/u });
  await expect(saveButton).toBeEnabled();

  await page.getByRole("button", { name: /^移除 /u }).click();
  await expect(page.getByRole("heading", { name: "已选图片来源" })).toHaveCount(0);
  await expect(saveButton).toBeDisabled();
  await expect(page.getByText(/缺失 2/u)).toBeVisible();
});
