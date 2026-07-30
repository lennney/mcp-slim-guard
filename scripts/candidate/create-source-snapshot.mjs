import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);

const ROOT_FILES = Object.freeze([
  ".gitignore",
  ".lintstagedrc",
  ".prettierrc",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE",
  "README.md",
  "README_CN.md",
  "SECURITY.md",
  "eslint.config.js",
  "glama.json",
  "package-lock.json",
  "package.json",
  "server.json",
  "smithery.yaml",
  "tsconfig.json",
  "vitest.config.ts",
]);

const ROOT_DIRECTORIES = Object.freeze([".github", ".husky", "docs", "scripts", "src", "tests"]);
const EXCLUDED_ROOT_ENTRIES = Object.freeze([
  ".artifacts",
  ".git",
  "coverage",
  "dist",
  "mcp-slim-guard",
  "node_modules",
]);
const EXCLUDED_PREFIXES = Object.freeze([
  ".husky/_",
  "docs/evidence/2026-07-26-alpha-candidate-dogfood.json",
  "docs/evidence/2026-07-26-alpha-candidate-dogfood.md",
  "docs/evidence/2026-07-26-model-selection-pilot.json",
  "docs/evidence/2026-07-26-model-selection-pilot.md",
  "docs/evidence/2026-07-27-alpha-candidate-freeze.json",
  "docs/evidence/2026-07-27-alpha-candidate-freeze.md",
  "docs/evidence/2026-07-28-host-adoption-checkpoint.md",
  "docs/evidence/2026-07-28-host-native-acceptance.md",
  "docs/geo",
  "docs/marketing",
  "docs/plans",
  "docs/research",
  "docs/superpowers",
  "docs/templates",
  "scripts/add-okf-frontmatter.py",
  "scripts/benchmark/results",
]);
const EXCLUDED_ROOT_PATTERNS = Object.freeze(["mcp-slim-guard-*.tgz"]);
const SENSITIVE_FILENAME_MARKERS = Object.freeze([".env", "auth", "cookie", "credential", "secret", "token"]);
const SENSITIVE_FILENAME_PATTERN = /(?:auth|cookie|credential|secret|token)/iu;
const TAR_BLOCK_SIZE = 512;

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function normalizeRelativePath(value) {
  return toPosixPath(value).replace(/^\.\/+/u, "");
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSensitiveFilename(filename) {
  const lower = filename.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || SENSITIVE_FILENAME_PATTERN.test(lower);
}

export function shouldExcludePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return true;
  }

  const [rootEntry] = normalized.split("/");
  if (EXCLUDED_ROOT_ENTRIES.includes(rootEntry) || /^mcp-slim-guard-.*\.tgz$/iu.test(rootEntry)) {
    return true;
  }

  if (EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true;
  }

  return normalized.split("/").some(isSensitiveFilename);
}

async function statIfPresent(absolutePath) {
  try {
    return await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function collectDirectory(repositoryRoot, relativeDirectory, outputRoot, paths) {
  if (shouldExcludePath(relativeDirectory)) {
    return;
  }

  const absoluteDirectory = path.join(repositoryRoot, ...relativeDirectory.split("/"));
  if (isPathWithin(outputRoot, absoluteDirectory)) {
    return;
  }

  const stat = await statIfPresent(absoluteDirectory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }

  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));

  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (shouldExcludePath(relativePath)) {
      continue;
    }

    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    if (isPathWithin(outputRoot, absolutePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectDirectory(repositoryRoot, relativePath, outputRoot, paths);
    } else if (entry.isFile()) {
      paths.push(relativePath);
    }
  }
}

async function collectCandidatePaths(repositoryRoot, outputRoot) {
  const paths = [];

  for (const relativePath of ROOT_FILES) {
    if (shouldExcludePath(relativePath)) {
      continue;
    }
    const absolutePath = path.join(repositoryRoot, relativePath);
    const stat = await statIfPresent(absolutePath);
    if (stat?.isFile() && !stat.isSymbolicLink() && !isPathWithin(outputRoot, absolutePath)) {
      paths.push(relativePath);
    }
  }

  for (const relativeDirectory of ROOT_DIRECTORIES) {
    await collectDirectory(repositoryRoot, relativeDirectory, outputRoot, paths);
  }

  return [...new Set(paths)].sort(comparePaths);
}

function normalizedFileMode(stat) {
  return stat.mode & 0o111 ? 0o755 : 0o644;
}

async function freezeCandidateFiles(repositoryRoot, relativePaths) {
  const files = [];

  for (const relativePath of relativePaths) {
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Candidate source changed while snapshotting: ${relativePath}`);
    }
    const contents = await fs.readFile(absolutePath);
    files.push({
      path: relativePath,
      bytes: contents.byteLength,
      mode: normalizedFileMode(stat),
      sha256: hash(contents),
      contents,
    });
  }

  return files;
}

function fingerprintFiles(files) {
  const digest = createHash("sha256");
  digest.update("mcp-slim-guard-source-snapshot-v1\0");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.mode.toString(8));
    digest.update("\0");
    digest.update(String(file.bytes));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\n");
  }
  return digest.digest("hex");
}

function writeString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) {
    throw new Error(`Tar header value is too long: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeString(buffer, offset, length, encoded);
}

function splitTarPath(relativePath) {
  if (Buffer.byteLength(relativePath, "utf8") <= 100) {
    return { name: relativePath, prefix: "" };
  }

  let separator = relativePath.lastIndexOf("/");
  while (separator > 0) {
    const prefix = relativePath.slice(0, separator);
    const name = relativePath.slice(separator + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
    separator = relativePath.lastIndexOf("/", separator - 1);
  }

  throw new Error(`Source path cannot be represented in a ustar archive: ${relativePath}`);
}

function createTarHeader(file) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(file.path);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, file.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.bytes);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createArchive(files) {
  const chunks = [];
  for (const file of files) {
    chunks.push(createTarHeader(file), file.contents);
    const padding = (TAR_BLOCK_SIZE - (file.bytes % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function summarizeGitStatus(statusPorcelain) {
  const summary = {
    entries: 0,
    staged: 0,
    worktree: 0,
    untracked: 0,
    conflicted: 0,
  };
  const conflictStatuses = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

  for (const line of statusPorcelain.split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    const status = line.slice(0, 2);
    if (status === "!!") {
      continue;
    }
    summary.entries += 1;
    if (status === "??") {
      summary.untracked += 1;
    } else if (conflictStatuses.has(status)) {
      summary.conflicted += 1;
    } else {
      if (status[0] !== " ") {
        summary.staged += 1;
      }
      if (status[1] !== " ") {
        summary.worktree += 1;
      }
    }
  }

  return summary;
}

async function readGitSourceState(repositoryRoot, options) {
  const gitHead =
    options.gitHead ??
    (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
      })
    ).stdout.trim();
  const gitStatusPorcelain =
    options.gitStatusPorcelain ??
    (
      await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      })
    ).stdout;

  if (!/^[a-f0-9]{40,64}$/iu.test(gitHead)) {
    throw new Error(`Unable to record a valid base HEAD for source snapshot: ${gitHead}`);
  }

  const dirtySummary = summarizeGitStatus(gitStatusPorcelain);
  return {
    base_head: gitHead.toLowerCase(),
    dirty: dirtySummary.entries > 0,
    dirty_summary: dirtySummary,
  };
}

async function assertDirectoryDoesNotExist(directory) {
  const stat = await statIfPresent(directory);
  if (stat) {
    throw new Error(`Source snapshot already exists and will not be overwritten: ${directory}`);
  }
}

async function removeOwnedTemporaryDirectory(outputRoot, temporaryDirectory) {
  if (path.dirname(temporaryDirectory) !== outputRoot) {
    throw new Error(`Refusing to remove unexpected temporary path: ${temporaryDirectory}`);
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

export async function createSourceSnapshot(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const rootStat = await statIfPresent(repositoryRoot);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Repository root does not exist: ${repositoryRoot}`);
  }

  const outputRoot = path.resolve(options.outputRoot ?? path.join(repositoryRoot, ".artifacts", "source-snapshots"));
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Invalid snapshot creation time: ${createdAt}`);
  }

  const source = await readGitSourceState(repositoryRoot, options);
  const relativePaths = await collectCandidatePaths(repositoryRoot, outputRoot);
  if (relativePaths.length === 0) {
    throw new Error("Candidate source allowlist did not select any files");
  }
  const frozenFiles = await freezeCandidateFiles(repositoryRoot, relativePaths);
  const sourceFingerprint = fingerprintFiles(frozenFiles);
  const snapshotId = `source-${sourceFingerprint.slice(0, 16)}`;
  const archive = createArchive(frozenFiles);
  const archiveSha256 = hash(archive);
  const targetDirectory = path.join(outputRoot, snapshotId);

  await fs.mkdir(outputRoot, { recursive: true });
  await assertDirectoryDoesNotExist(targetDirectory);

  const manifest = {
    schema_version: 1,
    snapshot_id: snapshotId,
    created_at: createdAt,
    source,
    selection: {
      strategy: "root-allowlist",
      root_files: [...ROOT_FILES],
      root_directories: [...ROOT_DIRECTORIES],
      excluded_root_entries: [...EXCLUDED_ROOT_ENTRIES],
      excluded_root_patterns: [...EXCLUDED_ROOT_PATTERNS],
      excluded_prefixes: [...EXCLUDED_PREFIXES],
      sensitive_filename_markers: [...SENSITIVE_FILENAME_MARKERS],
      symlinks: "excluded",
    },
    files: frozenFiles.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      mode: file.mode.toString(8).padStart(4, "0"),
      sha256: file.sha256,
    })),
    source_fingerprint_sha256: sourceFingerprint,
    archive: {
      file: "source.tar.gz",
      format: "tar+gzip",
      bytes: archive.byteLength,
      sha256: archiveSha256,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const checksums = Buffer.from(`${archiveSha256}  source.tar.gz\n${hash(manifestBytes)}  manifest.json\n`, "utf8");
  const temporaryDirectory = await fs.mkdtemp(path.join(outputRoot, `.${snapshotId}.tmp-`));

  try {
    await Promise.all([
      fs.writeFile(path.join(temporaryDirectory, "source.tar.gz"), archive, { flag: "wx" }),
      fs.writeFile(path.join(temporaryDirectory, "manifest.json"), manifestBytes, { flag: "wx" }),
      fs.writeFile(path.join(temporaryDirectory, "SHA256SUMS"), checksums, { flag: "wx" }),
    ]);
    await fs.rename(temporaryDirectory, targetDirectory);
  } catch (error) {
    await removeOwnedTemporaryDirectory(outputRoot, temporaryDirectory);
    if (await statIfPresent(targetDirectory)) {
      throw new Error(`Source snapshot already exists and will not be overwritten: ${targetDirectory}`, {
        cause: error,
      });
    }
    throw error;
  }

  return {
    directory: targetDirectory,
    archivePath: path.join(targetDirectory, "source.tar.gz"),
    manifestPath: path.join(targetDirectory, "manifest.json"),
    checksumsPath: path.join(targetDirectory, "SHA256SUMS"),
    manifest,
  };
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (scriptPath === import.meta.url) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const result = await createSourceSnapshot({ repositoryRoot });
    process.stdout.write(
      `${JSON.stringify(
        {
          snapshot_id: result.manifest.snapshot_id,
          directory: result.directory,
          source_fingerprint_sha256: result.manifest.source_fingerprint_sha256,
          archive_sha256: result.manifest.archive.sha256,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
