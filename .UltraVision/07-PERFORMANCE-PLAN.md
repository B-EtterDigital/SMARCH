# 07 — Performance Plan

## Baseline device (named)

**GitHub Actions `ubuntu-latest` runner (2 vCPU, 7 GB RAM)** — if the tools
feel fast there, they feel fast on any dev laptop. Secondary reference: the
operator's Linux workstation (Arch, local NVMe).

## Budgets (per surface, enforced by the M2 bench gate)

| Surface | Budget on baseline |
|---|---|
| `sma scan` on the fixture portfolio (10k files) | < 60 s node · < 6 s via `smarch-core` (M3) |
| `graphify:refresh` one module (code-only AST) | < 30 s |
| `graphify:query` (with M1 embedding re-rank) | < 2 s warm, < 10 s cold index build per 1k nodes |
| MCP server tool response (search/trust/doctor) | < 500 ms |
| `npm run check` full suite | < 120 s |
| Dashboard TTI (local, fixture data) | < 2 s; input latency < 100 ms |
| `sma scan` peak RSS | < 512 MB |

## Adaptive ladder

Degrade gracefully, never fail: scan shards by top-level dir when the file
count exceeds 50k; graphify falls back to AST-cache reconstruction on timeout
(existing behavior, kept); embedding index skips re-rank and warns (substring
+IDF still works) when no local model is available; dashboard virtualizes
ledger tables beyond 500 rows.

## SOTA enhancement tier (headroom → delight)

On strong hardware: `smarch-core` parallel walk + xxhash makes whole-portfolio
rescans feel instant (< 1 s incremental); embedding cache pre-warms in the
background after `scan`; dashboard streams lease-board updates over SSE
instead of polling. All gated on detection; the baseline never pays for it.

## Gates entering CI

M2 adds `tools/evals/bench.mjs` (fixture portfolio, asserts the table above
with 20% headroom) to `.github/workflows/ci.yml`; regressions fail the PR.
