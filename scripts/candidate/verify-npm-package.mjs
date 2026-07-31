#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_PACKAGE_NAME = "mcp-slim-guard";
const REQUIRED_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
]);
const ROOT_FILES = new Set(["LICENSE", "README.md", "package.json"]);

function fail(message) {
  throw new Error(`npm package boundary violation: ${message}`);
}

function validatePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("every packed file must have a non-empty path");
  }
  if (value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    fail(`unsafe path: ${value}`);
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`unsafe path: ${value}`);
  }
  if (value.endsWith(".map")) {
    fail(`source maps are not publishable: ${value}`);
  }
  if (ROOT_FILES.has(value)) {
    return;
  }
  if (!value.startsWith("dist/") || (!value.endsWith(".js") && !value.endsWith(".d.ts"))) {
    fail(`path is outside the public runtime allowlist: ${value}`);
  }
}

export function verifyNpmPackManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    fail("expected one npm pack result");
  }

  const candidate = manifest[0];
  if (!candidate || candidate.name !== EXPECTED_PACKAGE_NAME) {
    fail(`expected package ${EXPECTED_PACKAGE_NAME}`);
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    fail("npm pack did not report any files");
  }

  const paths = [];
  const seen = new Set();
  for (const file of candidate.files) {
    validatePath(file?.path);
    if (seen.has(file.path)) {
      fail(`duplicate path: ${file.path}`);
    }
    seen.add(file.path);
    paths.push(file.path);
  }

  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) {
      fail(`required file is missing: ${required}`);
    }
  }

  return {
    package: candidate.name,
    version: candidate.version,
    files: paths.length,
    unpacked_bytes: candidate.unpackedSize,
    source_maps: 0,
    allowed_roots: ["dist/", "LICENSE", "README.md", "package.json"],
    passed: true,
  };
}

function runNpmPackDryRun() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli?.endsWith(".js") ? process.execPath : "npm";
  const args = npmCli?.endsWith(".js")
    ? [npmCli, "pack", "--json", "--dry-run", "--ignore-scripts"]
    : ["pack", "--json", "--dry-run", "--ignore-scripts"];
  const result = spawnSync(command, args, {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && command === "npm",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm pack exited ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function readManifest(manifestPath) {
  if (!manifestPath) {
    return JSON.parse(runNpmPackDryRun());
  }
  return JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8").replace(/^\uFEFF/u, ""));
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (scriptPath === import.meta.url) {
  try {
    const summary = verifyNpmPackManifest(readManifest(process.argv[2]));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
