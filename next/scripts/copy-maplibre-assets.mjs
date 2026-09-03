import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(projectRoot, "node_modules", "maplibre-gl", "dist");
const outputDir = join(projectRoot, "public", "maplibre");

await mkdir(outputDir, { recursive: true });
await Promise.all(
  ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"].map((file) =>
    copyFile(join(sourceDir, file), join(outputDir, file)),
  ),
);
