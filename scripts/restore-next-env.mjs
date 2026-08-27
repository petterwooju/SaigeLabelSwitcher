import { writeFile } from "node:fs/promises";

const nextEnvironmentTypes = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";
import "./.next/types/root-params.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

await writeFile(
  new URL("../next-env.d.ts", import.meta.url),
  nextEnvironmentTypes,
  "utf8",
);
