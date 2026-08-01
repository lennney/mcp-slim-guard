#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = {
  package: path.join(repositoryRoot, "package.json"),
  lock: path.join(repositoryRoot, "package-lock.json"),
  server: path.join(repositoryRoot, "server.json"),
  glama: path.join(repositoryRoot, "glama.json"),
  issueTemplate: path.join(repositoryRoot, ".github", "ISSUE_TEMPLATE", "compatibility-report.yml"),
};

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function derive(packageManifest, packageLock, serverManifest, glamaTemplate, issueTemplate) {
  const { version } = packageManifest;
  packageLock.version = version;
  packageLock.packages[""].version = version;

  serverManifest.name = packageManifest.mcpName;
  serverManifest.description = packageManifest.description;
  serverManifest.repository = { url: packageManifest.homepage, source: "github" };
  serverManifest.version = version;
  serverManifest.packages[0].identifier = packageManifest.name;
  serverManifest.packages[0].version = version;

  const glamaNamePattern = /(\"name\":\s*)\"[^\"]*\"/;
  const glamaDescriptionPattern = /(\"description\":\s*)\"[^\"]*\"/;
  if (!glamaNamePattern.test(glamaTemplate) || !glamaDescriptionPattern.test(glamaTemplate)) {
    throw new Error("Glama manifest has no managed name or description field.");
  }
  const glamaManifest = glamaTemplate
    .replace(glamaNamePattern, `$1${JSON.stringify(packageManifest.name)}`)
    .replace(glamaDescriptionPattern, `$1${JSON.stringify(packageManifest.description)}`);

  const issueVersionPattern = /(id: slim_guard_version[\s\S]*?placeholder:\s*)[^\r\n]+/;
  if (!issueVersionPattern.test(issueTemplate)) {
    throw new Error("Compatibility Issue Form has no slim_guard_version placeholder.");
  }

  return {
    [files.lock]: serialized(packageLock),
    [files.server]: serialized(serverManifest),
    [files.glama]: glamaManifest,
    [files.issueTemplate]: issueTemplate.replace(issueVersionPattern, `$1${version}`),
  };
}

function main() {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  const requestedVersion = check ? undefined : args[0];
  const packageManifest = json(files.package);

  if (requestedVersion !== undefined) {
    if (!versionPattern.test(requestedVersion)) throw new Error(`Invalid release version: ${requestedVersion}`);
    packageManifest.version = requestedVersion;
    fs.writeFileSync(files.package, serialized(packageManifest));
  } else if (!check) {
    throw new Error("Usage: npm run metadata:set -- <version>");
  }

  const outputs = derive(
    packageManifest,
    json(files.lock),
    json(files.server),
    fs.readFileSync(files.glama, "utf8"),
    fs.readFileSync(files.issueTemplate, "utf8"),
  );

  if (check) {
    const drift = Object.entries(outputs)
      .filter(([file, expected]) => fs.readFileSync(file, "utf8") !== expected)
      .map(([file]) => path.relative(repositoryRoot, file));
    if (drift.length > 0) throw new Error(`Release metadata drift: ${drift.join(", ")}`);
    console.log(`Release metadata synchronized at ${packageManifest.version}.`);
    return;
  }

  for (const [file, content] of Object.entries(outputs)) fs.writeFileSync(file, content);
  console.log(`Release metadata updated to ${packageManifest.version}.`);
  console.log("Review CHANGELOG.md separately; historical release prose is intentionally not generated.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
