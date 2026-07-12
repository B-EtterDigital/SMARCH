# Gen3 Version Control — ten years ahead of `git blame`

Git answers *what changed*. It cannot answer the questions that matter in an
AI-swarm codebase: **who intended what, on whose authority, proven how, and
coordinated with whom.** Gen3 is the version-control layer for those
questions — it already exists in this repo; this document names it as one
system and sets its trajectory.

## The unit of change is not a diff

A Gen3 change is an **intent record** with five faces, all already on disk:

| Face | Artifact | Answers |
|---|---|---|
| Intent | `.smarch/agent-context/*.ndjson` (append-only why-log) | why was this touched |
| Claim | lease records (atomic, owner-safe) | who had the right to touch it |
| Proof | evidence journals (`{cmd, exit, output_sha256}` — re-runnable) | how do we know it works |
| Trust | provenance seals + attestations (in-toto/SLSA), public hash-chain ledger | can a stranger verify it |
| Collision | conflict reports (intent-level, not byte-level) | what almost went wrong |

Git stores the bytes underneath. Gen3 stores the *meaning* on top. Neither
replaces the other — but only one of them scales to a hundred agents.

## What "ten years ahead" means concretely

- **Intent-blame** — `sma blame --intent <file>` joins each current line range
  to its `git log -L` history, matching agent-context decision, and proof
  command. It follows whole-file renames, so context recorded against an older
  `.mjs` path remains visible after a `.ts` migration.
- **Agent-native merge** — conflicts surface at claim time (leases) and at
  intent level (conflict reports), before bytes ever collide. Trajectory:
  merge resolution that reads both sides' *why* and proposes the synthesis.
- **Trust-weighted history** — every change carries seals; the public ledger
  makes history self-verifying in a browser with WebCrypto. Trajectory:
  trust tiers as a first-class filter (`show me only canonical-grade
  history`).
- **Evidence-gated integration** — a change without a passing, re-runnable
  proof doesn't merge. `uvp audit-claims` already spot-checks honesty;
  trajectory: continuous claim re-verification as the merge queue.
- **Time-travel over why** — the append-only context log means the question
  "what were we thinking in July?" has a machine-readable answer.

## Intent blame prototype

Run the standalone implementation directly:

```bash
node tools/sma-blame.ts --intent tools/sma-lease.ts
node tools/sma-blame.ts --intent tools/sma-lease.ts --lines 250:293 --json
```

The human view is deliberately honest. A range is attributed only when a
context record names the current file or a Git-discovered historical name and
matches the change commit (or, for older commit-less records, falls within a
two-hour window). Otherwise ACTOR, INTENT, and EVIDENCE say `pre-Gen3 history`.
Passing and failing verification statuses normalize to exit 0 and 1; explicit
evidence-journal exit codes are preserved. JSON adds the full decision
rationale, context source, evidence sources, historical paths, and up to 50
`git log -L` entries per range.

### Real repository transcript

This is a real run against the lease implementation, limited to a dense slice
so the transcript remains reviewable. It demonstrates both honest gaps and the
rename-aware join from `tools/sma-lease.ts` to the campaign record that touched
`tools/sma-lease.mjs`:

```text
$ node tools/sma-blame.ts --intent tools/sma-lease.ts --lines 250:293
Intent blame: tools/sma-lease.ts
LINE-RANGE | LAST CHANGE                             | ACTOR                    | INTENT                                                           | EVIDENCE (cmd+exit)
-----------+-----------------------------------------+--------------------------+------------------------------------------------------------------+-----------------------------------------------------------------
250-257    | 56a3a094 2026-07-10 SMARCH — Sweetspot… | pre-Gen3 history         | pre-Gen3 history                                                 | pre-Gen3 history
258        | 8cec3532 2026-07-12 V-21 wave 18: stri… | pre-Gen3 history         | pre-Gen3 history                                                 | pre-Gen3 history
259-262    | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
263        | 56a3a094 2026-07-10 SMARCH — Sweetspot… | pre-Gen3 history         | pre-Gen3 history                                                 | pre-Gen3 history
264-269    | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
270        | 8cec3532 2026-07-12 V-21 wave 18: stri… | pre-Gen3 history         | pre-Gen3 history                                                 | pre-Gen3 history
271        | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
272-274    | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
275        | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
276-278    | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
279        | 8cec3532 2026-07-12 V-21 wave 18: stri… | pre-Gen3 history         | pre-Gen3 history                                                 | pre-Gen3 history
280-281    | 56a3a094 2026-07-10 SMARCH — Sweetspot… | pre-Gen3 history         | pre-Gen3 history                                                 | pre-Gen3 history
282        | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
283-293    | 6f295d2f 2026-07-11 SMOA wave-6: atomi… | bdd-main@019f4d06        | implemented atomic owner-safe …; why: serialize every acquire …  | node tools/sma-lease.mjs selftest && npm run gen3:self… (exit 0)
```

Umbrella CLI integration note for the orchestrator: register `blame` in
`tools/sma.mjs` and forward all remaining arguments to `tools/sma-blame.ts`.
This executor lane intentionally does not edit the shared umbrella router.

## Design commitments

1. Plain files, append-only, diff-friendly — no daemon, no lock-in; git
   remains the byte substrate.
2. Every layer independently verifiable by a stranger (ledger + seals).
3. Coordination costs nothing when you're alone and saves you when you're
   not (ambient hooks: auto-lease, auto-context).
4. The reference implementation is this repository's own history: 16 waves,
   ~90 agents, zero lost work, every collision recorded and resolved.

*Lineage: Entire's "preserve why," Pierre's code-storage primitives, Zed and
Theo's public framing of the coordination gap — see
[INFLUENCES.md](INFLUENCES.md).*
