import { readdir, readFile, writeFile } from "node:fs/promises";

const outputDirectory = new URL("../out/", import.meta.url);
const cspPattern =
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/iu;

for (const filePath of await htmlFiles(outputDirectory)) {
  const html = await readFile(filePath, "utf8");
  const match = cspPattern.exec(html);
  if (!match) {
    throw new Error(`Static HTML is missing its CSP meta tag: ${filePath}`);
  }
  const withoutCsp = `${html.slice(0, match.index)}${html.slice(match.index + match[0].length)}`;
  const headIndex = withoutCsp.indexOf("<head>");
  if (headIndex < 0) {
    throw new Error(`Static HTML is missing <head>: ${filePath}`);
  }
  const insertionPoint = headIndex + "<head>".length;
  const hardened = `${withoutCsp.slice(0, insertionPoint)}${match[0]}${withoutCsp.slice(insertionPoint)}`;
  await writeFile(filePath, hardened, "utf8");
}

async function htmlFiles(directoryUrl) {
  const paths = [];
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) {
      paths.push(...await htmlFiles(entryUrl));
    } else if (entry.name.toLocaleLowerCase("en-US").endsWith(".html")) {
      paths.push(entryUrl);
    }
  }
  return paths;
}
