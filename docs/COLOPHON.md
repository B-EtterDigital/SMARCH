# Colophon

SMARCH is planned in public, machine-readable detail by Sweetspot Ultra Plan
([SUP](./GLOSSARY.md#sup)) in [`.UltraVision/`](../.UltraVision/). It is executed by a
mixture-of-agents workforce coordinated through leases and held to SMA Gen3
gates. The repository is typed for humans AND agents: prose explains intent,
while manifests, task records, graphs, gates, and receipts make the same intent
executable and checkable.

## A snapshot of the plan

At the time of writing, `.UltraVision/meta/stats.json` was generated at
`2026-07-10T17:35:42+00:00`. It records 1,694 tasks: 49 done, 1 claimed, 1,643
todo, and 1 obsolete. That is 1,693 active tasks and 2.89% complete. The plan
spans 17 modules, with 1,509 single-module tasks and 185 shared-hot-path tasks;
no task is marked as requiring a paid service.

Those numbers are a snapshot, not marketing copy. Read the current
[stats file](../.UltraVision/meta/stats.json) for today's truth.

## How the machines stay polite

Before an agent edits a brick, it acquires a time-limited lease and records its
intent. Separate modules can move together; shared hot paths serialize. A
collision becomes a conflict record instead of a race, and every lane ends at
evidence-bearing gates. The result is less like a swarm and more like a tiny,
self-reporting build organization.

The repository also seals its own tools in a
[public hash-chain ledger](../registry/public-ledger.generated.json). Anyone can
recompute it from file bytes and Git history with `node tools/gen-public-ledger.mjs`
or verify the committed record with `npm run ledger:verify`. The
[release runbook](./SYNC_RUNBOOK.md) explains how that self-verifying ledger is
kept current.

Every named influence is credited in [INFLUENCES.md](./INFLUENCES.md), because
lineage matters in ideas as much as it does in code.

made with love for creators of all kind.
