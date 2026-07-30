# Contributing to Slim Guard

Slim Guard is a reversible MCP result-delivery runtime. Contributions should
preserve the upstream result, keep unauthorized Tools hidden, and avoid adding
context cost without evidence.

## Set up the repository

```bash
git clone https://github.com/lennney/mcp-slim-guard.git
cd mcp-slim-guard
npm ci
npm run build
npm test
```

Node.js 20 or later is required.

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

Use this commit format:

```text
feat|fix|refactor|docs|chore: short description
```

## Verify the change

Run the smallest checks that prove the behavior:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- <focused-test>
```

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
