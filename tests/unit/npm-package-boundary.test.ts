import { describe, expect, it } from "vitest";
import { verifyNpmPackManifest } from "../../scripts/candidate/verify-npm-package.mjs";

function manifest(paths: string[]) {
  return [
    {
      name: "mcp-slim-guard",
      version: "0.1.1-alpha.1",
      unpackedSize: 1234,
      files: paths.map((path) => ({ path, size: 1, mode: 0o644 })),
    },
  ];
}

const requiredPaths = [
  "LICENSE",
  "README.md",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
];

describe("npm package boundary", () => {
  it("accepts only the public runtime and required package metadata", () => {
    expect(verifyNpmPackManifest(manifest([...requiredPaths, "dist/policies/ssrf.js"]))).toMatchObject({
      package: "mcp-slim-guard",
      files: 8,
      source_maps: 0,
      passed: true,
    });
  });

  it.each([
    ["private root file", "GOAL.md", /outside the public runtime allowlist/i],
    ["source map", "dist/index.js.map", /source maps are not publishable/i],
    ["unexpected dist asset", "dist/private-notes.json", /outside the public runtime allowlist/i],
    ["path traversal", "dist/../GOAL.md", /unsafe path/i],
  ])("rejects a %s", (_label, rejectedPath, expected) => {
    expect(() => verifyNpmPackManifest(manifest([...requiredPaths, rejectedPath]))).toThrow(expected);
  });

  it("requires the public entry points", () => {
    expect(() => verifyNpmPackManifest(manifest(requiredPaths.filter((path) => path !== "dist/cli.js")))).toThrow(
      /required file is missing: dist\/cli\.js/i,
    );
  });
});
