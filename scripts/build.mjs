#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "dist");
const tscEntry = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

if (path.dirname(outputDirectory) !== repositoryRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error(`Refusing to clean unexpected build output: ${outputDirectory}`);
}
fs.rmSync(outputDirectory, { recursive: true, force: true });

const result = spawnSync(process.execPath, [tscEntry], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
