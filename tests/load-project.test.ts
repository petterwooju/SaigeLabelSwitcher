import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";
import {
  BlobWriter,
  TextReader,
  ZipWriter,
} from "@zip.js/zip.js";

import { ArchiveValidationError } from "../lib/archive/zip.ts";
import {
  ProjectLoadError,
  loadProject,
} from "../lib/input/loadProject.ts";

const imagePath = String.raw`C:\dataset\ok.png`;

const srproj = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version>
  <Type>Classification</Type>
  <ClassGroup>
    <NumberOfClasses>1</NumberOfClasses>
    <Class><Name>OK</Name><Color>-16711936</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>1</NumberOfImages>
    <Image>
      <Path>${imagePath}</Path><Width>16</Width><Height>12</Height>
      <SplitState>Training</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>
  </ImageGroup>
</Project>`;

function v2Project(filePath: string): string {
  return JSON.stringify({
    project: {
      projectId: 1,
      projectName: "Synthetic",
      projectType: "cls",
      description: "",
      roiMode: "no",
      classInfos: [
        { classId: 10, classNo: 0, className: "OK", classColor: "#00ff00" },
      ],
      datasets: [
        { datasetId: 20, datasetName: "dataset", description: "" },
      ],
      projectFiles: [
        {
          fileId: 30,
          filePath,
          width: 16,
          height: 12,
          isLabeled: true,
          classId: 10,
          className: "OK",
          datasetId: 20,
          datasetName: "dataset",
          labelDataList: [],
          splitSets: [
            { splitId: 40, splitName: "default", splitType: "train" },
          ],
        },
      ],
    },
  });
}

function browserFile(parts: BlobPart[], name: string): File {
  return new NodeFile(
    parts as unknown as ConstructorParameters<typeof NodeFile>[0],
    name,
  ) as unknown as File;
}

async function makeZip(entries: readonly (readonly [string, string])[]): Promise<Blob> {
  const sink = new BlobWriter("application/zip");
  const writer = new ZipWriter(sink, { useWebWorkers: false });
  for (const [name, text] of entries) {
    await writer.add(name, new TextReader(text));
  }
  await writer.close();
  return sink.getData();
}

function svpaManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ProjectFile: "项目/demo.srproj",
    OriginalProjectDirectory: String.raw`C:\dataset`,
    Entries: [
      {
        OriginalPath: imagePath,
        RelativePath: "图像/dataset/ok.png",
      },
    ],
    ...overrides,
  });
}

function srprojForPaths(paths: readonly string[]): string {
  const images = paths
    .map(
      (path, index) => `    <Image>
      <Path>${escapeXml(path)}</Path><Width>16</Width><Height>12</Height>
      <SplitState>${index % 2 === 0 ? "Training" : "Validation"}</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version><Type>Classification</Type>
  <ClassGroup>
    <NumberOfClasses>1</NumberOfClasses>
    <Class><Name>OK</Name><Color>-16711936</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>${paths.length}</NumberOfImages>
${images}
  </ImageGroup>
</Project>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

test("loads plain srproj XML by content", async () => {
  const file = browserFile([srproj], "demo.srproj");
  const loaded = await loadProject(file);
  assert.equal(loaded.format, "v1-srproj");
  assert.equal(loaded.sourceFile, file);
  assert.equal(loaded.projectXmlText, srproj);
  assert.equal(loaded.projectJsonText, undefined);
  assert.equal(loaded.archive, undefined);
  assert.equal(loaded.parseResult.ok, true);
  assert.equal(loaded.project?.files[0].image.kind, "external");
  await loaded.close();
  await loaded.close();
});

test("loads plain subvision JSON by content", async () => {
  const text = v2Project(String.raw`C:\dataset\ok.png`);
  const loaded = await loadProject(
    browserFile([text], "demo.subvisionproj"),
  );
  assert.equal(loaded.format, "v2-subvisionproj");
  assert.equal(loaded.projectJsonText, text);
  assert.equal(loaded.parseResult.ok, true);
  assert.equal(loaded.project?.source.format, "v2-subvisionproj");
  assert.equal(loaded.project?.files[0].image.kind, "external");
  await loaded.close();
});

test("loads vision ZIP without inflating image bytes", async () => {
  const json = v2Project("images/ok.png");
  const zip = await makeZip([
    ["demo.json", json],
    ["images/ok.png", "not-decoded-image-bytes"],
  ]);
  const loaded = await loadProject(browserFile([zip], "demo.visionproj"));
  assert.equal(loaded.format, "v2-visionproj");
  assert.equal(loaded.projectJsonText, json);
  assert.equal(loaded.parseResult.ok, true);
  assert.ok(loaded.archive);
  const image = loaded.project?.files[0].image;
  assert.equal(image?.kind, "archive");
  if (image?.kind === "archive") {
    assert.equal(image.entryName, "images/ok.png");
    assert.equal(image.bytes, undefined);
  }
  assert.equal(loaded.archive.has("images/ok.png"), true);
  await loaded.close();
  assert.equal(loaded.archive.has("images/ok.png"), false);
});

test("loads a strict SVPA ZIP and binds manifest image entries lazily", async () => {
  const manifest = svpaManifest();
  const zip = await makeZip([
    ["svpa_manifest.json", manifest],
    ["项目/demo.srproj", srproj],
    ["图像/dataset/ok.png", "not-decoded-image-bytes"],
    ["使用说明.txt", "read me"],
  ]);
  const loaded = await loadProject(browserFile([zip], "demo.zip"));
  assert.equal(loaded.format, "v1-svpa");
  assert.equal(loaded.projectXmlText, srproj);
  assert.equal(loaded.svpaManifest?.ProjectFile, "项目/demo.srproj");
  assert.equal(loaded.svpaManifest?.Entries.length, 1);
  assert.equal(loaded.project?.source.format, "v1-svpa");
  const image = loaded.project?.files[0].image;
  assert.equal(image?.kind, "archive");
  if (image?.kind === "archive") {
    assert.equal(image.entryName, "图像/dataset/ok.png");
    assert.equal(image.bytes, undefined);
  }
  await loaded.close();
});

test("normalizes a quoted absolute XML path against manifest Unicode/case/slashes", async () => {
  const quotedPath = '"c:/dataset/./CAFÉ/OK.PNG"';
  const decomposedManifestPath = String.raw`C:\DATASET\café\folder\..\ok.png`;
  const manifest = svpaManifest({
    OriginalProjectDirectory: String.raw`C:\unused`,
    Entries: [
      {
        OriginalPath: decomposedManifestPath,
        RelativePath: "图像/normalized.png",
      },
    ],
  });
  const zip = await makeZip([
    ["svpa_manifest.json", manifest],
    ["项目/demo.srproj", srprojForPaths([quotedPath])],
    ["图像/normalized.png", "image"],
  ]);
  const loaded = await loadProject(browserFile([zip], "quoted.zip"));
  try {
    assert.equal(loaded.parseResult.ok, true);
    assert.equal(
      loaded.svpaManifest?.Entries[0]?.OriginalPath,
      "C:/DATASET/café/ok.png",
    );
    assert.equal(loaded.svpaManifest?.OriginalProjectDirectory, "C:/unused");
    const image = loaded.project?.files[0]?.image;
    assert.deepEqual(image, {
      kind: "archive",
      entryName: "图像/normalized.png",
    });
  } finally {
    await loaded.close();
  }
});

test("resolves relative XML paths against drive and UNC project directories", async (t) => {
  await t.test("Windows drive", async () => {
    const manifest = svpaManifest({
      OriginalProjectDirectory: String.raw`C:\Projects\客户\Demo\.`,
      Entries: [
        {
          OriginalPath: String.raw`c:/projects/客户/demo/images/ok.png`,
          RelativePath: "图像/drive.png",
        },
      ],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srprojForPaths([String.raw`.\images\temp\..\OK.PNG`])],
      ["图像/drive.png", "image"],
    ]);
    const loaded = await loadProject(browserFile([zip], "drive.zip"));
    try {
      assert.equal(loaded.parseResult.ok, true);
      assert.equal(
        loaded.svpaManifest?.OriginalProjectDirectory,
        "C:/Projects/客户/Demo",
      );
      assert.equal(
        loaded.project?.files[0]?.image.kind === "archive"
          ? loaded.project.files[0].image.entryName
          : undefined,
        "图像/drive.png",
      );
      assert.equal(
        loaded.project?.files[0]?.sourcePath,
        "C:/projects/客户/demo/images/ok.png",
      );
    } finally {
      await loaded.close();
    }
  });

  await t.test("UNC share", async () => {
    const manifest = svpaManifest({
      OriginalProjectDirectory: String.raw`\\Server\Share\Root\Project`,
      Entries: [
        {
          OriginalPath: "//server/share/root/images/OK.PNG",
          RelativePath: "图像/unc.png",
        },
      ],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srprojForPaths([String.raw`..\Images\.\ok.png`])],
      ["图像/unc.png", "image"],
    ]);
    const loaded = await loadProject(browserFile([zip], "unc.zip"));
    try {
      assert.equal(loaded.parseResult.ok, true);
      assert.equal(
        loaded.svpaManifest?.OriginalProjectDirectory,
        "//Server/Share/Root/Project",
      );
      assert.equal(
        loaded.project?.files[0]?.image.kind === "archive"
          ? loaded.project.files[0].image.entryName
          : undefined,
        "图像/unc.png",
      );
      assert.equal(
        loaded.project?.files[0]?.sourcePath,
        "//server/share/root/images/OK.PNG",
      );
    } finally {
      await loaded.close();
    }
  });
});

test("allows distinct OriginalPath values to reuse one archive image", async () => {
  const paths = [String.raw`C:\a\one.png`, String.raw`D:\b\two.png`];
  const manifest = svpaManifest({
    OriginalProjectDirectory: "",
    Entries: paths.map((OriginalPath) => ({
      OriginalPath,
      RelativePath: "图像/shared.png",
    })),
  });
  const zip = await makeZip([
    ["svpa_manifest.json", manifest],
    ["项目/demo.srproj", srprojForPaths(paths)],
    ["图像/shared.png", "one physical image"],
  ]);
  const loaded = await loadProject(browserFile([zip], "shared.zip"));
  try {
    assert.equal(loaded.parseResult.ok, true);
    assert.equal(loaded.svpaManifest?.Entries.length, 2);
    assert.deepEqual(
      loaded.project?.files.map((file) =>
        file.image.kind === "archive" ? file.image.entryName : undefined,
      ),
      ["图像/shared.png", "图像/shared.png"],
    );
  } finally {
    await loaded.close();
  }
});

test("normalizes drive and UNC file URLs in SVPA manifests", async () => {
  const fileUrls = [
    ["file:///C:/dataset/%E5%AE%A2%E6%88%B7/ok.png", "C:/dataset/客户/ok.png"],
    ["file://server/share/images/ok.png", "//server/share/images/ok.png"],
  ] as const;
  for (const [storedPath, normalizedPath] of fileUrls) {
    const manifest = svpaManifest({
      OriginalProjectDirectory: "",
      Entries: [{ OriginalPath: storedPath, RelativePath: "图像/ok.png" }],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srprojForPaths([normalizedPath])],
      ["图像/ok.png", "image"],
    ]);
    const loaded = await loadProject(browserFile([zip], "file-url.zip"));
    try {
      assert.equal(loaded.parseResult.ok, true);
      assert.equal(loaded.svpaManifest?.Entries[0]?.OriginalPath, normalizedPath);
    } finally {
      await loaded.close();
    }
  }
});

test("loads a self-contained SVPA that uses the repair helper's raw relative parent mapping", async () => {
  const manifest = svpaManifest({
    OriginalProjectDirectory: "",
    Entries: [{ OriginalPath: "../outside.png", RelativePath: "图像/outside.png" }],
  });
  const zip = await makeZip([
    ["svpa_manifest.json", manifest],
    ["项目/demo.srproj", srprojForPaths(["../outside.png"])],
    ["图像/outside.png", "image"],
  ]);
  const loaded = await loadProject(browserFile([zip], "relative-parent.zip"));
  try {
    assert.equal(loaded.parseResult.ok, true);
    assert.equal(loaded.project?.files[0]?.sourcePath, "../outside.png");
    assert.equal(loaded.project?.files[0]?.image.kind, "archive");
  } finally {
    await loaded.close();
  }
});

test("uses content despite an extension mismatch and adds a warning", async () => {
  const loaded = await loadProject(browserFile([srproj], "actually-xml.visionproj"));
  assert.equal(loaded.format, "v1-srproj");
  assert.equal(loaded.parseResult.ok, true);
  assert.ok(
    loaded.parseResult.diagnostics.some(
      ({ code, severity }) =>
        code === "INPUT_EXTENSION_MISMATCH" && severity === "warning",
    ),
  );
  await loaded.close();
});

test("rejects fake ZIP bytes and does not trust a ZIP-like extension", async () => {
  const brokenZip = browserFile(
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])],
    "fake.visionproj",
  );
  await assert.rejects(
    loadProject(brokenZip),
    (error: unknown) => error instanceof ArchiveValidationError,
  );

  await assert.rejects(
    loadProject(browserFile(["this is not a zip"], "fake.zip")),
    (error: unknown) =>
      error instanceof ProjectLoadError && error.code === "INPUT_FORMAT_UNKNOWN",
  );
});

test("rejects unsafe, conflicting, missing, and unreferenced SVPA mappings", async (t) => {
  await t.test("unsafe ProjectFile", async () => {
    const zip = await makeZip([
      ["svpa_manifest.json", svpaManifest({ ProjectFile: "../escape.srproj" })],
      ["项目/demo.srproj", srproj],
      ["图像/dataset/ok.png", "image"],
    ]);
    await assert.rejects(
      loadProject(browserFile([zip], "unsafe.zip")),
      (error: unknown) =>
        error instanceof ProjectLoadError &&
        error.code === "SVPA_PROJECT_PATH_UNSAFE",
    );
  });

  await t.test("same OriginalPath mapped to conflicting RelativePath", async () => {
    const manifest = svpaManifest({
      Entries: [
        { OriginalPath: imagePath, RelativePath: "图像/dataset/ok.png" },
        {
          OriginalPath: String.raw`c:/DATASET/./OK.PNG`,
          RelativePath: "图像/dataset/other.png",
        },
      ],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srproj],
      ["图像/dataset/ok.png", "image"],
      ["图像/dataset/other.png", "other"],
    ]);
    await assert.rejects(
      loadProject(browserFile([zip], "conflict.zip")),
      (error: unknown) =>
        error instanceof ProjectLoadError &&
        error.code === "SVPA_ORIGINAL_PATH_CONFLICT",
    );
  });

  await t.test("unsafe OriginalPath traversal", async () => {
    const manifest = svpaManifest({
      OriginalProjectDirectory: "",
      Entries: [
        { OriginalPath: String.raw`C:\..\escape.png`, RelativePath: "图像/image.png" },
      ],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srproj],
      ["图像/image.png", "image"],
    ]);
    await assert.rejects(
      loadProject(browserFile([zip], "unsafe-original.zip")),
      (error: unknown) =>
        error instanceof ProjectLoadError &&
        error.code === "SVPA_ORIGINAL_PATH_INVALID",
    );
  });

  await t.test("missing RelativePath", async () => {
    const manifest = svpaManifest({
      Entries: [
        { OriginalPath: imagePath, RelativePath: "图像/dataset/missing.png" },
      ],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srproj],
    ]);
    await assert.rejects(
      loadProject(browserFile([zip], "missing.zip")),
      (error: unknown) =>
        error instanceof ProjectLoadError && error.code === "SVPA_IMAGE_MISSING",
    );
  });

  await t.test("manifest OriginalPath not referenced by XML", async () => {
    const manifest = svpaManifest({
      Entries: [
        { OriginalPath: imagePath, RelativePath: "图像/shared.png" },
        {
          OriginalPath: String.raw`C:\dataset\unused.png`,
          RelativePath: "图像/shared.png",
        },
      ],
    });
    const zip = await makeZip([
      ["svpa_manifest.json", manifest],
      ["项目/demo.srproj", srproj],
      ["图像/shared.png", "image"],
    ]);
    await assert.rejects(
      loadProject(browserFile([zip], "unused.zip")),
      (error: unknown) =>
        error instanceof ProjectLoadError &&
        error.code === "SVPA_MANIFEST_ENTRY_UNUSED",
    );
  });
});

test("requires exactly one root project JSON in a vision archive", async () => {
  const zip = await makeZip([
    ["first.json", v2Project("images/ok.png")],
    ["second.json", v2Project("images/ok.png")],
    ["images/ok.png", "image"],
  ]);
  await assert.rejects(
    loadProject(browserFile([zip], "ambiguous.visionproj")),
    (error: unknown) =>
      error instanceof ProjectLoadError &&
      error.code === "VISION_PROJECT_JSON_COUNT_INVALID",
  );
});

test("loadProject observes an already aborted operation", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(
    loadProject(browserFile(["<Project />"], "cancelled.srproj"), {
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("SVPA manifest rejects excessive JSON nesting before retaining raw fields", async () => {
  let nested: unknown = "leaf";
  for (let index = 0; index < 130; index += 1) nested = { nested };
  const manifest = JSON.stringify({
    ProjectFile: "项目/demo.srproj",
    OriginalProjectDirectory: "",
    Entries: [],
    unknown: nested,
  });
  const zip = await makeZip([
    ["svpa_manifest.json", manifest],
    ["项目/demo.srproj", srproj],
  ]);
  await assert.rejects(
    loadProject(browserFile([zip], "deep.zip")),
    (error: unknown) =>
      error instanceof ProjectLoadError &&
      error.code === "SVPA_MANIFEST_RESOURCE_LIMIT",
  );
});
