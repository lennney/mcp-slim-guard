import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GENERATED_EVIDENCE_PREFIX = "docs/evidence/";

function git(repositoryRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} exited ${result.status}`);
  return result.stdout;
}

function candidateFiles(repositoryRoot) {
  return git(repositoryRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(GENERATED_EVIDENCE_PREFIX))
    .sort();
}

export function captureCandidateIdentity(repositoryRoot) {
  const packageManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const hash = createHash("sha256");
  const files = candidateFiles(repositoryRoot);
  for (const relativePath of files) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    if (fs.existsSync(absolutePath)) hash.update(fs.readFileSync(absolutePath));
    else hash.update("<deleted>");
    hash.update("\0");
  }
  const status = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  return {
    kind: "working-tree",
    digest: hash.digest("hex"),
    package_version: packageManifest.version,
    git_head: git(repositoryRoot, ["rev-parse", "HEAD"]).trim(),
    dirty: Boolean(status.trim()),
    file_count: files.length,
  };
}
