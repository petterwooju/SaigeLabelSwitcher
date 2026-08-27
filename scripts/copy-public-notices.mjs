import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../THIRD_PARTY_NOTICES.md", import.meta.url);
const destinationDirectory = new URL("../public/", import.meta.url);
const destination = new URL("THIRD_PARTY_NOTICES.md", destinationDirectory);

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
