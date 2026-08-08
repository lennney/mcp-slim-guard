# Slim Guard Agent Contract

This file defines the public repository rules for coding agents. It is a
short operational contract. Human contribution rules remain in
[CONTRIBUTING.md](CONTRIBUTING.md), security reporting remains in
[SECURITY.md](SECURITY.md), and architecture details remain in
[docs/architecture-mcp-slim-guard.md](docs/architecture-mcp-slim-guard.md).

## Scope and source of truth

- Start from the latest `main` and inspect the current worktree before editing.
- Keep one change focused on one user-visible behavior or one maintenance goal.
- Treat existing uncommitted work as user-owned. Do not reset, clean, migrate,
  or overwrite unrelated changes.
- This public repository is not the source for private workbench plans,
  hidden evaluation cases, launch drafts, credentials, or private evidence.
- Do not commit, push, publish, tag, or change external settings unless the
  user explicitly authorizes that action.

## Repository map

- `src/` contains the TypeScript runtime and public exports.
- `tests/` contains unit, integration, policy, fixture, and adversarial tests.
- `scripts/candidate/` contains candidate and package-boundary checks.
- `scripts/integration/` contains protocol, Host, and package smoke checks.
- `scripts/benchmark/` contains measurement tools. Run them only when the
  change affects a measured claim.
- `docs/` contains public architecture, setup, roadmap, and evidence.

Read the relevant source and tests before changing a public interface. Do not
move evaluation or release evidence into runtime modules.

When a directory, command, dependency, public interface, or implementation
rule changes, update this file and the relevant human-facing documentation in
the same change. Keep this file as the source of truth for agent-facing rules.

## Product invariants

Every change must preserve these boundaries:

- Authorization rejects undiscovered and unauthorized Tools.
- A business Tool call reaches the upstream server at most once.
- `read_result` never executes the upstream business Tool.
- Exact upstream results remain recoverable when delivery is projected.
- Delivery, storage, observer, or audit failures return the exact upstream
  result.
- Logs and shareable reports exclude credentials, raw arguments, result bodies,
  local paths, and private capability references.

Authorization and policy failures fail closed. Result-delivery failures fail
open to the exact upstream result.

## Code style

- Use TypeScript strict mode and preserve the existing ESM module layout.
- Use kebab-case file names, `PascalCase` for classes and types, and
  `camelCase` for variables, functions, and fields.
- Use `unknown` at untrusted boundaries. Do not add `any` without a focused
  justification and a test for the boundary behavior.
- Use Prettier for formatting and ESLint for TypeScript source checks. Do not
  hand-format generated files or weaken a rule to hide a warning.
- Keep CLI orchestration, protocol transport, policy checks, recovery storage,
  and evaluation measurement in their existing modules.
- Do not log secrets, credentials, raw Tool arguments, or full result bodies.
  Errors should identify the failed boundary without exposing sensitive data.
- Add or update a focused test with every behavior change. Prefer deterministic
  fixtures and exact assertions over timing or model-dependent assertions.

## Verification matrix

Run the smallest complete set for the changed surface:

- Fast local gate: `npm run validate`.
- Pre-push or release-candidate gate: `npm run ci`.
- Documentation or configuration: `npm run format:check`.
- TypeScript or tests: `npm run build`, `npm run typecheck`, `npm run lint`,
  `npm run format:check`, and `npm test`.
- Repository rules or package metadata: `npm run verify:governance` and
  `npm run verify:package-boundary` when package contents can change.
- CLI, routing, or stdio behavior: add `npm run smoke:protocol` or the
  relevant Host smoke.
- Compression, latency, token, or accuracy claims: run the relevant benchmark
  and include its evidence. Do not infer provider billing from local estimates.

Report exact commands, results, and skipped checks in the pull request. A
passing local check does not authorize a release.

For code review, prioritize correctness and security, then type safety, test
coverage, package boundaries, and documentation consistency. Do not use a
format-only change to hide an unrelated behavior change.

## Git and review

Use the branch, worktree, commit, tag, and pull request rules in
[CONTRIBUTING.md](CONTRIBUTING.md). Keep branches short-lived and commits
focused. Do not include private paths or internal evidence in public history.

Before editing, confirm the branch and worktree. Before handoff, show the
changed files, verification results, and any remaining uncertainty. Stop and
ask for direction when a required credential, external service, or permission
is missing.
