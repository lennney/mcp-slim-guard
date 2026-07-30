import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceSnapshot } from "../../scripts/candidate/create-source-snapshot.mjs";

const temporaryRoots: string[] = [];
const fixedCreatedAt = "2026-07-28T00:00:00.000Z";
const fixedHead = "0123456789abcdef0123456789abcdef01234567";

async function makeRepository(): Promise<string> {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slim-guard-source-snapshot-"));
  temporaryRoots.push(repositoryRoot);
  return repositoryRoot;
}

async function write(repositoryRoot: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function readTarEntries(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const readString = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readString(124, 12).trim() || "0", 8);
    const bodyStart = offset + 512;
    entries.set(entryPath, Buffer.from(tar.subarray(bodyStart, bodyStart + size)));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

async function seedCandidateSource(repositoryRoot: string): Promise<void> {
  await Promise.all([
    write(repositoryRoot, "package.json", '{"name":"fixture"}\n'),
    write(repositoryRoot, "package-lock.json", '{"lockfileVersion":3}\n'),
    write(repositoryRoot, "tsconfig.json", '{"compilerOptions":{}}\n'),
    write(repositoryRoot, "README.md", "# Fixture\n"),
    write(repositoryRoot, "AGENTS.md", "# Private agent rules\n"),
    write(repositoryRoot, "GOAL.md", "# Goal\n"),
    write(repositoryRoot, "HANDOVER.md", "# Handover\n"),
    write(repositoryRoot, "LEARNINGS.md", "# Learnings\n"),
    write(repositoryRoot, "src/index.ts", "export const answer = 42;\n"),
    write(repositoryRoot, "tests/unit/example.test.ts", "test('ok', () => {});\n"),
    write(repositoryRoot, "scripts/integration/smoke.mjs", "console.log('ok');\n"),
    write(repositoryRoot, "docs/architecture.md", "# Architecture\n"),
    write(repositoryRoot, "docs/plans/private.md", "# Private plan\n"),
    write(repositoryRoot, "docs/research/private.md", "# Private research\n"),
    write(repositoryRoot, "docs/marketing/private.md", "# Private launch draft\n"),
    write(repositoryRoot, "docs/superpowers/specs/private.md", "# Private legacy spec\n"),
    write(repositoryRoot, "docs/evidence/2026-07-27-alpha-candidate-freeze.md", "# Private candidate\n"),
    write(repositoryRoot, ".github/workflows/ci.yml", "name: ci\n"),
    write(repositoryRoot, ".husky/pre-commit", "npm test\n"),
    write(repositoryRoot, ".git/config", "private git state\n"),
    write(repositoryRoot, "node_modules/dependency/index.js", "dependency\n"),
    write(repositoryRoot, "dist/index.js", "compiled\n"),
    write(repositoryRoot, "coverage/report.json", "{}\n"),
    write(repositoryRoot, ".artifacts/old/manifest.json", "{}\n"),
    write(repositoryRoot, "mcp-slim-guard/copied-source.ts", "duplicate\n"),
    write(repositoryRoot, "mcp-slim-guard-old.tgz", "old archive\n"),
    write(repositoryRoot, "scripts/benchmark/results/run.json", "{}\n"),
    write(repositoryRoot, "scripts/integration/github-token-smoke.mjs", "credential smoke\n"),
    write(repositoryRoot, ".env", "SECRET=value\n"),
    write(repositoryRoot, "docs/auth-notes.md", "auth notes\n"),
    write(repositoryRoot, "src/session-token.ts", "export default 'token';\n"),
    write(repositoryRoot, "tests/browser-cookie.fixture", "cookie\n"),
    write(repositoryRoot, "scripts/credentials-helper.mjs", "credentials\n"),
    write(repositoryRoot, ".husky/_/husky.sh", "generated\n"),
    write(repositoryRoot, "personal-notes/private.md", "unrelated\n"),
  ]);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("source snapshot", () => {
  it("archives the candidate source allowlist with complete hashes and safe exclusions", async () => {
    const repositoryRoot = await makeRepository();
    await seedCandidateSource(repositoryRoot);

    const result = await createSourceSnapshot({
      repositoryRoot,
      createdAt: fixedCreatedAt,
      gitHead: fixedHead,
      gitStatusPorcelain: " M src/index.ts\nA  tests/unit/new.test.ts\n?? docs/note.md\nUU src/conflict.ts\n",
    });

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    const archivedPaths = manifest.files.map((file: { path: string }) => file.path);

    expect(manifest.schema_version).toBe(1);
    expect(manifest.snapshot_id).toMatch(/^source-[a-f0-9]{16}$/);
    expect(manifest.created_at).toBe(fixedCreatedAt);
    expect(manifest.source).toEqual({
      base_head: fixedHead,
      dirty: true,
      dirty_summary: {
        entries: 4,
        staged: 1,
        worktree: 1,
        untracked: 1,
        conflicted: 1,
      },
    });
    expect(manifest.selection).toMatchObject({
      strategy: "root-allowlist",
      excluded_root_entries: [".artifacts", ".git", "coverage", "dist", "mcp-slim-guard", "node_modules"],
      excluded_root_patterns: ["mcp-slim-guard-*.tgz"],
      symlinks: "excluded",
    });
    expect(archivedPaths).toEqual([...archivedPaths].sort());
    expect(archivedPaths).toEqual(
      expect.arrayContaining([
        ".github/workflows/ci.yml",
        ".husky/pre-commit",
        "README.md",
        "docs/architecture.md",
        "package-lock.json",
        "package.json",
        "scripts/integration/smoke.mjs",
        "src/index.ts",
        "tests/unit/example.test.ts",
        "tsconfig.json",
      ]),
    );
    expect(archivedPaths).not.toEqual(
      expect.arrayContaining([
        ".artifacts/old/manifest.json",
        ".env",
        ".git/config",
        ".husky/_/husky.sh",
        "AGENTS.md",
        "GOAL.md",
        "HANDOVER.md",
        "LEARNINGS.md",
        "coverage/report.json",
        "dist/index.js",
        "docs/auth-notes.md",
        "docs/evidence/2026-07-27-alpha-candidate-freeze.md",
        "docs/marketing/private.md",
        "docs/plans/private.md",
        "docs/research/private.md",
        "docs/superpowers/specs/private.md",
        "mcp-slim-guard-old.tgz",
        "mcp-slim-guard/copied-source.ts",
        "node_modules/dependency/index.js",
        "personal-notes/private.md",
        "scripts/benchmark/results/run.json",
        "scripts/credentials-helper.mjs",
        "scripts/integration/github-token-smoke.mjs",
        "src/session-token.ts",
        "tests/browser-cookie.fixture",
      ]),
    );

    for (const file of manifest.files as Array<{ path: string; bytes: number; sha256: string }>) {
      const contents = await fs.readFile(path.join(repositoryRoot, ...file.path.split("/")));
      expect(file.bytes).toBe(contents.byteLength);
      expect(file.sha256).toBe(sha256(contents));
    }

    const archive = await fs.readFile(result.archivePath);
    expect(manifest.archive).toMatchObject({
      file: "source.tar.gz",
      format: "tar+gzip",
      bytes: archive.byteLength,
      sha256: sha256(archive),
    });

    const tarEntries = readTarEntries(archive);
    expect([...tarEntries.keys()]).toEqual(archivedPaths);
    for (const [relativePath, contents] of tarEntries) {
      expect(contents).toEqual(await fs.readFile(path.join(repositoryRoot, ...relativePath.split("/"))));
    }

    const manifestBytes = await fs.readFile(result.manifestPath);
    const checksums = await fs.readFile(result.checksumsPath, "utf8");
    expect(checksums).toBe(`${sha256(archive)}  source.tar.gz\n${sha256(manifestBytes)}  manifest.json\n`);
  });

  it("refuses to overwrite an existing content-addressed snapshot", async () => {
    const repositoryRoot = await makeRepository();
    await seedCandidateSource(repositoryRoot);
    const options = {
      repositoryRoot,
      createdAt: fixedCreatedAt,
      gitHead: fixedHead,
      gitStatusPorcelain: "",
    };

    const first = await createSourceSnapshot(options);
    const archiveBefore = await fs.readFile(first.archivePath);
    const manifestBefore = await fs.readFile(first.manifestPath);

    await expect(createSourceSnapshot(options)).rejects.toThrow(/already exists/i);
    expect(await fs.readFile(first.archivePath)).toEqual(archiveBefore);
    expect(await fs.readFile(first.manifestPath)).toEqual(manifestBefore);
  });

  it("produces identical source and archive hashes for identical trees", async () => {
    const firstRoot = await makeRepository();
    const secondRoot = await makeRepository();
    await Promise.all([seedCandidateSource(firstRoot), seedCandidateSource(secondRoot)]);

    const [first, second] = await Promise.all([
      createSourceSnapshot({
        repositoryRoot: firstRoot,
        createdAt: fixedCreatedAt,
        gitHead: fixedHead,
        gitStatusPorcelain: "",
      }),
      createSourceSnapshot({
        repositoryRoot: secondRoot,
        createdAt: "2026-07-28T00:01:00.000Z",
        gitHead: "fedcba9876543210fedcba9876543210fedcba98",
        gitStatusPorcelain: " M README.md\n",
      }),
    ]);

    expect(first.manifest.source_fingerprint_sha256).toBe(second.manifest.source_fingerprint_sha256);
    expect(first.manifest.snapshot_id).toBe(second.manifest.snapshot_id);
    expect(first.manifest.archive.sha256).toBe(second.manifest.archive.sha256);
  });
});
