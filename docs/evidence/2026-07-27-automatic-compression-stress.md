# Automatic Compression Stress Fixture

Date: 2026-07-27  
Status: Deterministic secondary evidence

The released automatic Alpha path was exercised with an intentionally extreme
synthetic fixture: 100 authorized Tools and one 8,000-row uniform JSON result.

| Path                      | Normal-path protocol tokens | Advertised Tools | Upstream calls |
| ------------------------- | --------------------------: | ---------------: | -------------: |
| Direct MCP                |                     499,556 |              100 |              1 |
| Slim Guard automatic path |                       1,437 |                3 |              1 |

The normal path was 99.71% smaller in this fixture. The completion marker was
present in the first projection, the upstream Tool ran once, and an explicit
full read reconstructed content with the same SHA-256 as the direct result.

This is a synthetic stress bound, not an expected savings rate. It does not
measure provider billing, caching, model quality, or typical production data.

Reproduce without a model or remote API:

```bash
npm run bench:stress
```

The benchmark uses the production delivery path and deterministic protocol
accounting. Its implementation and fixtures in the public repository are the
source of the reproducible result.
