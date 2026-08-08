import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guidancePath = path.join(root, "AGENTS.md");
const claudePath = path.join(root, "CLAUDE.md");
const copilotPath = path.join(root, ".github", "copilot-instructions.md");
const packagePath = path.join(root, "package.json");

const failures = [];

if (!fs.existsSync(guidancePath)) {
  failures.push("AGENTS.md is missing from the repository root.");
} else {
  const guidance = fs.readFileSync(guidancePath, "utf8");
  const byteLength = Buffer.byteLength(guidance, "utf8");
  if (byteLength > 32 * 1024) {
    failures.push(`AGENTS.md is ${byteLength} bytes; the limit is 32768 bytes.`);
  }

  const requiredHeadings = [
    "## Scope and source of truth",
    "## Repository map",
    "## Product invariants",
    "## Code style",
    "## Verification matrix",
    "## Git and review",
  ];
  for (const heading of requiredHeadings) {
    if (!guidance.includes(heading)) failures.push(`AGENTS.md is missing: ${heading}`);
  }

  const forbiddenPatterns = [
    { label: "private workbench path", pattern: /mcp-slim-guard-workbench/iu },
    { label: "private acceptance notes path", pattern: /(?:^|[`/\\])acceptance[\\/]notes(?:[`/\\]|$)/iu },
    {
      label: "absolute local path",
      pattern: /\b[A-Z]:[\\/][^\n`]*(?:workbench|private|acceptance)[^\n`]*/iu,
    },
    {
      label: "credential assignment",
      pattern: /\b(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*["'][^"']+/iu,
    },
  ];
  for (const { label, pattern } of forbiddenPatterns) {
    if (pattern.test(guidance)) failures.push(`AGENTS.md contains a ${label}.`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    failures.push(`package.json cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (packageJson?.scripts) {
    const commands = [...guidance.matchAll(/`npm run ([a-z0-9:_-]+)`/giu)].map((match) => match[1]);
    for (const command of commands) {
      if (packageJson.scripts[command] === undefined) {
        failures.push(`AGENTS.md references missing npm script: ${command}`);
      }
    }
  }
}

if (!fs.existsSync(claudePath)) failures.push("CLAUDE.md is missing from the repository root.");
else if (fs.readFileSync(claudePath, "utf8").trim() !== "@./AGENTS.md @./README.md") {
  failures.push("CLAUDE.md must remain a thin adapter to AGENTS.md and README.md.");
}

if (!fs.existsSync(copilotPath)) {
  failures.push(".github/copilot-instructions.md is missing.");
} else {
  const copilot = fs.readFileSync(copilotPath, "utf8");
  if (!copilot.includes("AGENTS.md` is the source of truth")) {
    failures.push("Copilot instructions must identify AGENTS.md as the source of truth.");
  }
  if (Buffer.byteLength(copilot, "utf8") > 16 * 1024) {
    failures.push("Copilot instructions exceed the 16384-byte review-context limit.");
  }
}

if (failures.length > 0) {
  console.error("Agent guidance verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Agent guidance verified: AGENTS.md is present, bounded, safe, and references existing npm scripts.");
}
