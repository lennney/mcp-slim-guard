# Contributing to mcp-slim-guard

Thanks for your interest! This is a small but active project. Here's how to contribute effectively.

## Quick Start

```bash
git clone https://github.com/lennney/mcp-slim-guard.git
cd mcp-slim-guard
npm install
npm run build
npm test              # 402 tests should pass
```

## Development

### Commit Convention

```
type: description

types: feat / fix / docs / chore / refactor / test / ci / perf
```

- Lowercase description, no period at end
- Scope optional: `fix(proxy): preserve extended-thinking blocks`
- Pre-commit hooks (`husky` + `lint-staged`) auto-lint staged files

### Before Submitting a PR

1. **Branch from latest `main`**: `git checkout main && git pull && git checkout -b type/description`
2. **Keep it clean**: Only target files — no `AGENTS.md`, `HANDOVER.md`, `.hermes/`, or other workspace files
3. **Run full pre-push check**:
   ```bash
   npm run build
   npm test
   npx tsc --noEmit
   ```
4. **Update CHANGELOG.md** if the change is user-facing

### PR Workflow

1. Open a **Draft PR** early for feedback
2. Ensure CI passes (lint + build + 402 tests)
3. Update PR body with verification results
4. Mark ready for review when done

## Code Style

- TypeScript strict mode, zero `any`
- 5 prod dependencies max (no new deps without discussion)
- Each policy module independently testable (dependency injection)
- Default: **fail-closed** (deny first)

## Testing

- `npm test` — full suite (vitest)
- `npm run bench` — token/schema/latency/accuracy benchmarks
- Tests live in `tests/`, mirroring `src/` structure

## Questions?

Open a [Discussion](https://github.com/lennney/mcp-slim-guard/discussions) or file an issue.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
