import assert from "node:assert/strict";
import test from "node:test";
import {
  BlobReader,
  BlobWriter,
  TextReader,
  ZipWriter,
} from "@zip.js/zip.js";
import {
  ArchiveValidationError,
  assertSafeArchiveEntryName,
  canonicalArchiveName,
  openValidatedZip,
} from "../lib/archive/zip.ts";
import { ARCHIVE_ENTRY_SEGMENT_MAX_BYTES } from "../lib/security/resourceLimits.ts";

async function makeZip(entries: Array<[string, string]>): Promise<Blob> {
  const sink = new BlobWriter("application/zip");
  const writer = new ZipWriter(sink, { useWebWorkers: false });
  for (const [name, text] of entries) {
    await writer.add(name, new TextReader(text));
  }
  await writer.close();
  return sink.getData();
}

test("validated archive reads safe text", async () => {
  const source = await makeZip([["project/example.json", "{\"ok\":true}"]]);
  const archive = await openValidatedZip(source);
  assert.deepEqual(archive.names(), ["project/example.json"]);
  assert.equal(await archive.readText("PROJECT/example.json"), '{"ok":true}');
  await archive.close();
});

test("validated archive accepts conventional safe directory entries", async () => {
  const sink = new BlobWriter("application/zip");
  const writer = new ZipWriter(sink, { useWebWorkers: false });
  await writer.add("images/", undefined, { directory: true });
  await writer.add("images/example.txt", new TextReader("safe"));
  await writer.close();

  const archive = await openValidatedZip(await sink.getData());
  try {
    assert.deepEqual(archive.names(), ["images/example.txt"]);
    assert.equal(await archive.readText("images/example.txt"), "safe");
  } finally {
    await archive.close();
  }
});

test("validated archive still rejects traversal directory entries", async () => {
  const sink = new BlobWriter("application/zip");
  const writer = new ZipWriter(sink, { useWebWorkers: false });
  await writer.add("../", undefined, { directory: true });
  await writer.close();

  await assert.rejects(
    openValidatedZip(await sink.getData()),
    (error: unknown) =>
      error instanceof ArchiveValidationError &&
      error.code === "ZIP_PATH_TRAVERSAL",
  );
});

test("equivalent archive paths collide case-insensitively", async () => {
  const source = await makeZip([
    ["images/A.png", "a"],
    ["IMAGES/a.png", "b"],
  ]);
  await assert.rejects(
    openValidatedZip(source),
    (error: unknown) =>
      error instanceof ArchiveValidationError && error.code === "ZIP_DUPLICATE_ENTRY",
  );
});

test("unsafe entry paths are rejected", () => {
  for (const name of [
    "../secret",
    "images/../secret",
    "/absolute",
    "C:/drive/file",
    "images/CON.png",
    "images/CON .png",
    "images/trailing. ",
    "images/bad\nname.png",
    `images/${"a".repeat(ARCHIVE_ENTRY_SEGMENT_MAX_BYTES + 1)}.png`,
  ]) {
    assert.throws(() => assertSafeArchiveEntryName(name), ArchiveValidationError);
  }
  assert.doesNotThrow(() => assertSafeArchiveEntryName("图像/class/001.png"));
});

test("validated archive applies the same portable path rules to real entries", async () => {
  for (const name of ["images/CON.png", "images/trailing."]) {
    const source = await makeZip([[name, "unsafe"]]);
    await assert.rejects(openValidatedZip(source), ArchiveValidationError);
  }
});

test("archive opening honors an AbortSignal before central-directory parsing", async () => {
  const source = await makeZip([["project.json", "{}"]]);
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(openValidatedZip(source, {}, controller.signal), {
    name: "AbortError",
  });
});

test("canonical names normalize slash, unicode and case", () => {
  assert.equal(
    canonicalArchiveName("Images\\ＣＡＴ\\A.PNG"),
    canonicalArchiveName("images/CAT/a.png"),
  );
});

test("readBlob preserves entry bytes", async () => {
  const original = new Blob([new Uint8Array([0, 1, 2, 250, 255])]);
  const sink = new BlobWriter("application/zip");
  const writer = new ZipWriter(sink, { useWebWorkers: false });
  await writer.add("images/data.bin", new BlobReader(original), { level: 0 });
  await writer.close();

  const archive = await openValidatedZip(await sink.getData());
  const extracted = await archive.readBlob("images/data.bin");
  assert.deepEqual(
    new Uint8Array(await extracted.arrayBuffer()),
    new Uint8Array(await original.arrayBuffer()),
  );
  await archive.close();
});

test("archive limits entry count, materialization, names, and prefix reads", async () => {
  const source = await makeZip([
    ["data/first.txt", "abcdef"],
    ["data/second.txt", "ghijkl"],
  ]);
  await assert.rejects(
    openValidatedZip(source, { maxEntries: 1 }),
    (error: unknown) =>
      error instanceof ArchiveValidationError && error.code === "ZIP_TOO_MANY_ENTRIES",
  );
  await assert.rejects(
    openValidatedZip(source, { maxEntryNameBytes: 4 }),
    (error: unknown) =>
      error instanceof ArchiveValidationError && error.code === "ZIP_ENTRY_NAME_TOO_LONG",
  );

  const archive = await openValidatedZip(source);
  try {
    await assert.rejects(
      archive.readBlob("data/first.txt", "text/plain", 5),
      (error: unknown) =>
        error instanceof ArchiveValidationError && error.code === "ZIP_BLOB_TOO_LARGE",
    );
    assert.deepEqual(
      Array.from(await archive.readPrefix("data/first.txt", 3)),
      Array.from(new TextEncoder().encode("abc")),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(archive.readPrefix("data/first.txt", 3, controller.signal), {
      name: "AbortError",
    });
  } finally {
    await archive.close();
  }
});

test("archive text rejects invalid UTF-8", async () => {
  const sink = new BlobWriter("application/zip");
  const writer = new ZipWriter(sink, { useWebWorkers: false });
  await writer.add(
    "bad.txt",
    new BlobReader(new Blob([new Uint8Array([0xc3, 0x28])])),
  );
  await writer.close();
  const archive = await openValidatedZip(await sink.getData());
  try {
    await assert.rejects(
      archive.readText("bad.txt"),
      (error: unknown) =>
        error instanceof ArchiveValidationError &&
        error.code === "ZIP_TEXT_INVALID_UTF8",
    );
  } finally {
    await archive.close();
  }
});
