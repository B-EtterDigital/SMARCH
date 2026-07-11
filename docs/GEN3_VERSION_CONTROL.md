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

- **Intent-blame** — `sma context-replay` already renders a brick's history
  as decisions, not hunks. Trajectory: `blame` any line to the *intent* that
  produced it and the evidence that proved it.
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
