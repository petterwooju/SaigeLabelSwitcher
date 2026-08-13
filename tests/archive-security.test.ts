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
  for (const name of ["../secret", "images/../secret", "/absolute", "C:/drive/file"]) {
    assert.throws(() => assertSafeArchiveEntryName(name), ArchiveValidationError);
  }
  assert.doesNotThrow(() => assertSafeArchiveEntryName("图像/class/001.png"));
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
