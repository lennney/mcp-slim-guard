# Contributing to Slim Guard

Slim Guard is a reversible MCP result-delivery runtime. Contributions should
preserve the upstream result, keep unauthorized Tools hidden, and avoid adding
context cost without evidence.

Bug reports, Host and Server compatibility results, documentation fixes, and
focused code changes are welcome.

## Set up the repository

```bash
git clone https://github.com/lennney/mcp-slim-guard.git
cd mcp-slim-guard
npm ci
npm run build
npm test
```

Node.js 20 or later is required.

## Code style and structure

- Use TypeScript strict mode and the existing ESM module layout.
- Use kebab-case file names, `PascalCase` for classes and types, and
  `camelCase` for variables, functions, and fields.
- Use `unknown` at untrusted boundaries. Do not add `any` without a focused
  justification and a test for the boundary behavior.
- Run Prettier for formatting and ESLint for TypeScript source checks. The
  repository includes `.editorconfig` and `.prettierrc.json`; do not add
  editor-specific formatting exceptions.
- Keep protocol transport, authorization, result recovery, CLI orchestration,
  and evaluation measurement in their existing modules.
- Keep errors and logs free of credentials, raw Tool arguments, full result
  bodies, and local paths.
- Add or update deterministic tests with behavior changes. Keep benchmark and
  provider-dependent checks separate from ordinary unit tests.
- Do not include a pure formatting change with an unrelated behavior change.

The root [AGENTS.md](AGENTS.md) contains the shorter operational contract for
coding agents. It must not duplicate private workbench guidance.

## Choose an issue

- Search existing issues before starting work.
- Use a bug report for reproducible product behavior.
- Use a compatibility report for one Host and upstream MCP Server combination.
- Use a feature request to describe a user problem before proposing a large
  implementation.
- Do not disclose vulnerability details in an issue. Follow
  [SECURITY.md](SECURITY.md).

For a large or breaking change, open an issue before writing the implementation.

## Make a focused change

- Start from the latest `main`.
- Keep the pull request limited to one user-visible behavior.
- Do not include credentials, private paths, result bodies, local artifacts,
  workbench files, internal plans, research notes, or launch drafts.
- Preserve existing public configuration, or describe the required migration
  as a breaking change.
- Avoid new production dependencies unless the change needs them.

## Name branches, commits, and worktrees

Use a short-lived public branch for one reviewable behavior. If an issue or
task number exists, include it immediately after the type and reference it in
the pull request (`#123`) so the hosting service can cross-link it:

```text
feature/123-compact-mode
fix/124-result-recovery
docs/125-host-setup
refactor/126-selector-parser
chore/127-package-boundary
release/0.2.0-alpha.1
hotfix/128-native-schema
```

If there is no issue number, omit it but keep the type and slug. Use lowercase
ASCII letters, numbers, and hyphens; avoid spaces, special characters,
consecutive slashes, and names that look like commit hashes. `backup/` is
reserved for local safety refs and must not be pushed. `private/` is reserved for
local or private-candidate work; it is not the normal public PR prefix.

Commits and pull request titles use the same machine-readable shape:

```text
type(scope): imperative summary
```

Allowed types are `feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `build`,
`ci`, and `chore`. Use stable scopes such as `cli`, `config`, `modes`,
`proxy`, `recovery`, `selector`, `eval`, `package`, `docs`, and `ci`. Mark an
incompatible public change with `!` and explain it with a `BREAKING CHANGE:`
footer. Keep one commit or PR focused on one user-visible behavior; do not use
`misc`, `wip`, or date-only names as the public subject.

Worktree directory names describe their role, not a release promise, for
example `public-handoff` or `private-worktree`. Worktree paths and private
evidence names must not appear in public commits, reports, or pull requests.

Release tags use `vMAJOR.MINOR.PATCH` with an optional prerelease suffix, for
example `v0.2.0-alpha.1`. Create a tag only from a clean, verified release
commit; never tag a dirty worktree or a review branch.

Use this commit format:

```text
type(scope): imperative summary
```

## Verify the change

Use `npm run validate` for the fast local gate. Use `npm run ci` before a
push or release candidate. These commands keep the required checks in one
versioned place.

Run the smallest checks that prove the behavior:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- <focused-test>
```

`npm run ci` adds the build, coverage, governance, and package-boundary checks.

Also run:

- `npm run build` when generated JavaScript or package behavior matters;
- `npm run smoke:protocol` for routing or stdio changes;
- the relevant package smoke for package or installation changes.

Do not run benchmarks for an ordinary change. Run the relevant benchmark when
the pull request changes a token, compression, latency, or accuracy claim.
Maintainers run the full stable suite and frozen-candidate checks at the release
boundary.

## Product invariants

A contribution must preserve these behaviors:

- stdout contains MCP protocol data only;
- unauthorized Tools are absent from discovery and call paths;
- one Slim Guard call executes the selected upstream Tool at most once;
- pass-through delivery preserves the complete upstream result;
- lossy delivery stores one immutable snapshot with an exact recovery
  reference;
- `read_result` never executes the upstream Tool;
- delivery, storage, observer, or audit failure returns the exact upstream
  result;
- logs exclude credentials, arguments, result bodies, and raw capability
  references by default.

Authorization and policy rejection fail closed. Result-delivery failures fail
open to the exact upstream result.

## Open a pull request

Include:

- the user-visible behavior and reason for the change;
- exact verification commands and results;
- compatibility or migration notes;
- a `CHANGELOG.md` entry for a user-visible change;
- README updates for public CLI, API, or configuration changes.

Open a draft pull request when you want early feedback. Mark it ready when the
focused checks pass and the description is complete.

For usage questions, see [SUPPORT.md](SUPPORT.md).
