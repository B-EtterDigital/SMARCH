# Why SMARCH

Not "another framework." A bet about where coding is going, and four concrete
mechanisms that pay off *only if the bet is right*. Here is the bet, the
evidence, and the honest edges — decide for yourself.

## The bet

Within a few years, most code in a serious repository will be written and
edited by AI agents, often many at once. That breaks assumptions the current
toolchain was built on:

- **Reuse rots.** Agents generate plausible copies faster than humans can
  review them. A repo becomes a junk drawer of near-duplicates nobody trusts.
- **`git blame` stops answering the real question.** When an agent wrote a
  line, "who and when" is worthless. You need *what did it intend, on whose
  authority, and how do we know it works.*
- **Processes leak.** Codex and Claude spawn deep process trees and orphan
  them on restart. A weaker machine running many agents drowns in strays.
- **Quality erodes silently.** Bulk-generated code passes tests and still
  degrades — dead exports, `any`-creep, duplication, coverage rot — because
  nothing mechanical is holding the line.

If that bet is wrong, you don't need SMARCH. If it's right, you need every
piece of it.

## The four mechanisms

**1. A registry that rejects.** Every reusable module ("brick") carries its
boundaries, security rules, tests, provenance, and clone contract. Promotion
is gated; the registry prefers one canonical brick over a pile of unverified
copies. Reuse stops being a junk drawer because bad bricks don't get in.

**2. Version control that answers *why*.** `sma blame --intent` maps each line
to the intent record and the passing proof that produced it — rename-aware,
honest about pre-Gen3 history. `sma merge propose --from-intents` drafts a
merge from *both sides' intentions*, not just conflicting bytes. Git stores
the bytes; SMARCH stores the meaning on top. (See
[GEN3_VERSION_CONTROL.md](GEN3_VERSION_CONTROL.md).)

**3. Processes that can't outlive their owner (SPL).** Every process gets a
lease and lives only while the lease lives. Orphaned agent trees — codex,
claude, detached watch-loops — are detected across three authority tiers and
reaped safely, audited, never a blind `pkill`. Cross-platform. Monitors are
bounded by construction: an immortal watch-loop is unrepresentable. (See
[SPL_SWEETSPOT_PROCESS_LEASE.md](SPL_SWEETSPOT_PROCESS_LEASE.md).)

**4. A dogma the repo enforces on itself.** Strict TypeScript, type-aware
lint, dead-code and duplication ceilings, a coverage floor — all gated in CI
with a ratchet that only tightens. This repo holds *itself* to the standard it
preaches: strict 0, eslint 0, knip 0, ~70% coverage, every one enforced. A
rule without a gate is an opinion; SMARCH doesn't ship opinions. (See
[CODE_QUALITY.md](CODE_QUALITY.md).)

## Why believe it works

Because it was built the way it argues you should build. This repository's own
history is 30+ multi-agent waves coordinated through its own leases, hardened
by its own adversarial review (which found five real criticals a green board
had hidden), every claim proven by a re-runnable evidence command, and
verifiable by a stranger: recompute the public hash-chain ledger yourself, or
check it live in a browser with WebCrypto. The dogfood is the argument.

## The honest edges

- It is **not** a replacement for git — git remains the byte substrate.
- It is **opinionated**: small bricks, hard boundaries, mechanical gates. If
  your codebase is small and human-authored, that ceremony may not pay off.
- The hosted/federated pieces are deliberately deferred; today it is a
  clone-and-run local control plane plus an MCP server and a self-hostable
  dashboard.
- "Battle-tested" means a year of one operator's AI-swarm development, not a
  decade across thousands of teams. It is a serious candidate, not a law.

## Try it in ten minutes

```bash
git clone https://github.com/B-EtterDigital/SMARCH sma
cd sma && npm install && npm link
sma list                       # every command
sma spl doctor                 # reclaim orphaned agent processes on your box
```

**Already have a project?** Adopt the engine into it in one command — no vendoring, no drift:

```bash
cd your-project && npx github:B-EtterDigital/SMARCH adopt --target .
./sma spl doctor        # the hardened engine, running against your repo
```

New to any of this? The [intro lane](intro/START_HERE.md) takes you from
"what even is a module registry" to your first agent swarm in 18 CI-verified
lessons, no prior experience assumed.
