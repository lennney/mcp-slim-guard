import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("release version", () => {
  it("keeps runtime, npm, lockfile, and MCP metadata synchronized", () => {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const packageLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    const serverManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "server.json"), "utf8"));

    expect(VERSION).toBe(packageManifest.version);
    expect(packageLock.version).toBe(VERSION);
    expect(packageLock.packages[""].version).toBe(VERSION);
    expect(serverManifest.version).toBe(VERSION);
    expect(serverManifest.packages[0].version).toBe(VERSION);
  });
});
