import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(packageRoot, "dist");

const replacements = [
  {
    name: "HEIF ispe progress",
    expected: 12,
    before: `      const rawWidth = readUInt32BE(input, ispeBox.offset + 12);
      const rawHeight = readUInt32BE(input, ispeBox.offset + 16);`,
    after: `      const nextOffset = ispeBox.offset + ispeBox.size;
      if (ispeBox.size < 20 || nextOffset <= currentOffset) {
        throw new TypeError("Invalid HEIF, invalid ispe box size");
      }
      const rawWidth = readUInt32BE(input, ispeBox.offset + 12);
      const rawHeight = readUInt32BE(input, ispeBox.offset + 16);`,
  },
  {
    name: "HEIF offset assignment",
    expected: 12,
    before: "      currentOffset = ispeBox.offset + ispeBox.size;",
    after: "      currentOffset = nextOffset;",
  },
  {
    name: "ICNS entry progress",
    expected: 2,
    before: `      const imageHeader = readImageHeader(input, imageOffset);
      const imageSize = getImageSize(imageHeader[0]);
      images.push(imageSize);
      imageOffset += imageHeader[1];`,
    after: `      const imageHeader = readImageHeader(input, imageOffset);
      const imageLength = imageHeader[1];
      if (imageLength < SIZE_HEADER) {
        throw new TypeError("Invalid ICNS, invalid entry length");
      }
      const imageSize = getImageSize(imageHeader[0]);
      images.push(imageSize);
      imageOffset += imageLength;`,
  },
  {
    name: "ICNS bundled entry progress",
    expected: 6,
    before: `      const imageHeader = readImageHeader(input, imageOffset);
      const imageSize2 = getImageSize2(imageHeader[0]);
      images.push(imageSize2);
      imageOffset += imageHeader[1];`,
    after: `      const imageHeader = readImageHeader(input, imageOffset);
      const imageLength = imageHeader[1];
      if (imageLength < SIZE_HEADER2) {
        throw new TypeError("Invalid ICNS, invalid entry length");
      }
      const imageSize2 = getImageSize2(imageHeader[0]);
      images.push(imageSize2);
      imageOffset += imageLength;`,
  },
  {
    name: "ICNS detector entry progress",
    expected: 4,
    before: `      const imageHeader = readImageHeader(input, imageOffset);
      const imageSize = getImageSize2(imageHeader[0]);
      images.push(imageSize);
      imageOffset += imageHeader[1];`,
    after: `      const imageHeader = readImageHeader(input, imageOffset);
      const imageLength = imageHeader[1];
      if (imageLength < SIZE_HEADER2) {
        throw new TypeError("Invalid ICNS, invalid entry length");
      }
      const imageSize = getImageSize2(imageHeader[0]);
      images.push(imageSize);
      imageOffset += imageLength;`,
  },
  {
    name: "JXL partial stream progress",
    expected: 12,
    before: `    partialStreams.push(
      input.slice(jxlpBox.offset + 12, jxlpBox.offset + jxlpBox.size)
    );
    offset = jxlpBox.offset + jxlpBox.size;`,
    after: `    const nextOffset = jxlpBox.offset + jxlpBox.size;
    if (jxlpBox.size < 12 || nextOffset <= offset) {
      throw new TypeError("Invalid JXL, invalid jxlp box size");
    }
    partialStreams.push(
      input.slice(jxlpBox.offset + 12, nextOffset)
    );
    offset = nextOffset;`,
  },
];

const files = await collectBundles(distRoot);
const counts = new Map(replacements.map((item) => [item.name, 0]));

for (const file of files) {
  let source = await readFile(file, "utf8");
  let changed = false;
  for (const replacement of replacements) {
    const matches = source.split(replacement.before).length - 1;
    if (matches === 0) continue;
    counts.set(replacement.name, counts.get(replacement.name) + matches);
    source = source.replaceAll(replacement.before, replacement.after);
    changed = true;
  }
  if (changed) await writeFile(file, source, "utf8");
}

for (const replacement of replacements) {
  const actual = counts.get(replacement.name);
  if (actual !== replacement.expected) {
    throw new Error(
      `${replacement.name}: expected ${replacement.expected} replacements, got ${actual}`,
    );
  }
}

console.log(`Patched ${files.length} image-size bundles.`);

async function collectBundles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectBundles(fullPath));
    else if (/\.(?:cjs|mjs)$/u.test(entry.name)) result.push(fullPath);
  }
  return result;
}
