# Provenance Seal + License Lattice

This design explains how SMARCH records creator history, license constraints, and release openness for reusable bricks. Registry maintainers, legal reviewers, and release operators need it before importing or publishing code. Read it when a brick changes source, license, visibility, or distribution terms. Remember that downstream releases may preserve or tighten source restrictions but must not erase them.

A tamper-evident creator trail, a per-brick license/openness axis, and a
monotonic enforcement gate that stops a brick from being **stolen** or
**released as open when its source was closed**.

> Core rule: **a composed build can never be declared more open, more visible,
> or more permissively licensed than the most restrictive brick it derives
> from.** Effective openness/visibility is the MEET (greatest lower bound) of
> the components. You cannot release as open what was built from something closed.

## Why this exists

SMA's manifest schema already described a rich provenance/licensing model, but:

- **~3,148 indexed bricks had zero provenance** — the scanner stripped it, and
  only the 4 curated builds carried authorship.
- **Bricks had no license of their own** — only dependency licenses and a
  build-level `publishing.license`.
- **Visibility was cosmetic** — nothing gated a closed brick from entering a
  public build; `sma-publish` even stamped exported artifacts `community`.
- **Provenance was unsigned plain JSON** — anyone could rewrite `created_by`.

This system populates, enforces, and seals all of that.

## The four mechanisms

### 1. Universal creator trail (`registry/provenance-ledger.generated.json`)

Every brick's authorship is reconstructed from git history:
`created_by` (oldest commit), `touched_by` (recent commits), and a
`contributors` ledger (commit counts + first/last dates per identity). Keyed by
`brick_id`, because 3,146 / 3,148 bricks have no manifest file.

### 2. License as a per-brick axis (`registry/license-ledger.generated.json`)

Each brick resolves to `{ spdx, license_class, openness, visibility,
attribution_required }`. Resolution precedence: brick declaration → project
`package.json` / `LICENSE` → **fail-safe closed** (if openness can't be proven,
it is treated as closed). See `tools/lib/license-lattice.mjs` for the SPDX
classification and the openness/visibility partial orders.

### 3. Content fingerprints + theft detection (`security/brick-fingerprints.generated.json`)

A deterministic, line-ending-stable sha256 over each brick's source is its
identity. When the same fingerprint appears under a **different project and a
different author**, it is flagged `theft_risk` with the canonical origin (the
earliest-created copy). This is how a lifted brick becomes visible.

### 4. Tamper-evident seals (hash chain + optional ed25519 signature)

Each brick gets a seal: an append-only hash chain over its provenance events,
anchored to its content fingerprint.

- Editing history (removing an author, reordering) → **head mismatch**.
- Modifying the source after sealing → **anchor mismatch**.
- Rewriting the ledger wholesale → caught **only if signed** (a forger can
  recompute an unsigned chain; they cannot forge an ed25519 signature).

## Tools

| Tool | Purpose |
|---|---|
| `tools/sma-provenance-ledger.mjs` | Backfill engine. Fingerprints, git-provenance, license-resolves, seals, detects theft. Writes the three ledgers. `--sign`, `--keygen`, `--limit`, `--project`. |
| `tools/sma-license-gate.mjs` | Enforces the lattice over build manifests. Blocks openness/visibility/license escalation. `--gate`, `--strict` (theft ⇒ block). |
| `tools/sma-provenance-verify.mjs` | Recomputes every seal from the ledger, verifies signatures, `--recheck-source` for drift. `--gate`. |
| `tools/lib/license-lattice.mjs` | Pure lattice: `classifyLicense`, `meetOpenness`, `meetVisibility`, `checkComposition`. |
| `tools/lib/provenance-seal.mjs` | Pure crypto: `fingerprintSource`, `computeSeal`, `verifySeal`, ed25519 sign/verify. |

## npm scripts

```bash
npm run provenance:ledger     # backfill the three ledgers (run periodically, like `scan`)
npm run gate:license          # enforce the lattice over builds (exits non-zero on escalation)
npm run provenance:verify     # recompute + verify every seal
npm run provenance:selftest   # unit tests for the lattice + sealing primitives
```

`gate:license` and `provenance:verify` are chained into `gate:all`, so they run
on every `gate:promote`. They verify against the **committed** ledgers; refresh
the ledgers with `provenance:ledger` when bricks change.

## Signing (optional, for authoritative provenance)

```bash
node tools/sma-provenance-ledger.mjs --keygen          # generates security/keys/seal.<id>.{pub,key}.pem
# commit the .pub.pem; the .key.pem is gitignored — never commit it
SMA_SEAL_PRIVATE_KEY=security/keys/seal.<id>.key.pem \
  node tools/sma-provenance-ledger.mjs --sign
```

Verification (`sma-provenance-verify`) reads the public key from
`security/keys/seal.<key_id>.pub.pem`. An unsigned ledger is still
hash-chained and catches inconsistent edits; signing closes the
recompute-forgery gap.

## What the gate blocks (examples)

| Situation | Result |
|---|---|
| build `visibility: public`, one component brick is `private`/closed | `VISIBILITY_ESCALATION` + `OPENNESS_ESCALATION` (block) |
| publishable build to `community`, derives from an unlicensed brick | `CLOSED_SOURCE_PUBLISH` (block) |
| build declares `proprietary` but contains a GPL brick | `COPYLEFT_UNDECLARED` (block) |
| component brick is a `theft_risk` copy of another project's brick | `THEFT_IN_COMPOSITION` (warn; block under `--strict`) |
| component missing from the ledger | treated as **closed** (fail-safe) |

`sma-publish` enforces the same lattice: a blocked publish writes only its
report and **never emits a community-visible artifact**.

## External anchoring — making history un-rewritable

The local seal is tamper-*evident*: it catches edits, but someone who controls
the repo **and** holds the signing key could rewrite the ledger and re-sign it,
with no independent record that the original was different. Closing that gap
needs an **append-only external witness** nobody can rewrite retroactively.

`tools/sma-anchor.mjs` commits every brick's seal to a single **Merkle root** and
publishes only that root — never code, never full provenance. One anchor covers
all bricks; any brick is proven later with a compact inclusion proof
(`--proof <brick_id>`) that discloses no other brick.

```bash
npm run anchor            # compute the Merkle root over all seals (local record)
npm run anchor:verify     # recompute the root and check it matches the anchor
node tools/sma-anchor.mjs --proof <brick_id>   # dispute evidence for one brick
```

Backends (pick per `--backend`):

| backend | witness | cost |
|---|---|---|
| `file` (default) | local self-attested record — integrity only, not un-rewritability | free |
| `rekor` | Sigstore transparency log (append-only public good) | **free** |
| `ots` | OpenTimestamps → Bitcoin | **free** |

**Cost reality:** anchoring the root to Sigstore/Rekor or OpenTimestamps is
**free** — they are public-good logs (Rekor is what npm/PyPI provenance use).
Keyless signing via a mainstream OIDC identity (Google/GitHub/Microsoft) is
free. It only costs money if you need a **private** log or to bind signing to
**WorkOS specifically** (self-host Fulcio/Rekor — one small server), or if you
choose **Solana/Ethereum** instead (per-tx fees). Anchoring the *root* (one
entry per ledger run, not per brick) keeps you far under any fair-use limit.

**What anchoring does NOT do:** it cannot prevent copying (readable source can
always be copied) and cannot validate that a first claim is truthful — it proves
*"this fingerprint existed under this identity at time T,"* making authorship
disputes **decidable**, not impossible. Truthful "author" comes from binding the
signature to a real identity, not from the log.

Submitting to Rekor needs an interactive OIDC login, so `--submit` prints the
exact `cosign sign-blob` command to run in your terminal; commit the returned
bundle next to `registry/anchor.generated.json`.

## Self-maintaining — future bricks need no retro-backfill

The system is wired into SMA's normal lifecycle so new bricks are covered
automatically:

1. **Auto-populate.** `sma-portfolio-refresh.mjs` runs a `provenance` +
   `anchor` phase after every registry scan that produces new bricks. Ledgering
   is **incremental** — a brick whose content fingerprint is unchanged reuses
   its prior provenance + seal, so a refresh only pays the git/seal cost for new
   or edited bricks (a full portfolio has ~all bricks reused in seconds).
2. **Enforce at the door.** `provenance-verify --coverage` fails if any registry
   brick lacks a ledger entry, so a new brick can't slip through unledgered.
   It's folded into `provenance:verify` → `gate:all` → `gate:promote`.
3. **Fail-safe meanwhile.** Until a brick is ledgered, the license gate treats
   it as **closed** — a not-yet-ledgered brick can never be published as open.
4. **CI enforcement.** `sma-ci.mjs` runs `license-gate` and `provenance-verify`
   as blocking steps.

```bash
npm run provenance:refresh   # ledger (incremental) + anchor + verify --coverage, in one shot
```

So the only manual `provenance:ledger` run is the very first backfill (done).
After that, bricks are ledgered as they are scanned, and the gates block
anything unledgered from being promoted or published.

## Roots of trust — what is and isn't guaranteed (read this)

An adversarial audit (2026-07-02) drew a hard line between the *mechanisms*
(sound) and the *trust roots* (only as strong as their inputs). Be honest about
both:

**Enforced / sound**
- The lattice math, seal hash-chain (NUL-framed, injective), ed25519 signing,
  Merkle domain separation, and fingerprint framing are correct.
- **Fail-safe is real**: unknown/undeclared license ⇒ `closed`; an unresolved
  component ⇒ `closed/private`. You cannot accidentally open something.
- **Every export path is now gated** through `tools/lib/export-guard.mjs`
  (clone, release, store, publish). Closed/private source cannot be exported to
  a wider audience without an explicit, audited `--allow-closed`.
- Fingerprints now cover `.min.js`/`.map`/`.wasm`/lockfiles, so a bundled or
  supply-chain backdoor changes the brick's identity.

**Trust boundaries — do NOT over-claim**
- **Policy, not access control.** The export guard stops accidental/automated
  leaks and enforces policy in CI. It cannot stop someone with repo write who
  edits the tools. *Real* protection of closed source is filesystem/git read
  permission on the source repos.
- **Identity is self-asserted.** "Author" is the git commit email (`%ae`),
  which is spoofable. Until signatures are bound to a verified identity, the
  creator trail records claims, not proof.
- **Origin time is forgeable.** `created_at` is the git author date (`%aI`),
  which `GIT_AUTHOR_DATE` can backdate. Origin ordering is only trustworthy once
  bound to an external anchor time.
- **Theft detection is exact-match.** One changed character evades it; it finds
  verbatim copies, not near-duplicates.
- **Seals are tamper-EVIDENT, not tamper-PROOF by default.** Unsigned, a
  repo-writer can recompute a consistent head. Signing + an out-of-band pinned
  key (`security/keys/trusted.json`, checked by `provenance-verify`) + an
  external transparency anchor (Rekor/OTS) are what make it tamper-proof; the
  `file` anchor backend is self-attested and not a witness.

## Hardening status (v2)

| Capability | Status | Where |
|---|---|---|
| ed25519 ledger signing + out-of-band key pin | **DONE** — signed, `trusted.json` pinned, verified | `--sign`, `security/keys/trusted.json`, `provenance-verify` |
| Similarity / near-duplicate theft detection | **DONE** — winnowing + simhash, LSH-bucketed; rename/reformat-invariant | `tools/lib/similarity.mjs`, `tools/sma-similarity-scan.mjs` |
| License evidence (declared-vs-actual) | **DONE** — scans source for SPDX/headers; laundering ⇒ fail-safe closed | `tools/lib/license-evidence.mjs`, `--evidence` |
| Standard formats (in-toto/SLSA, SPDX 2.3, CycloneDX 1.5) | **DONE** — plus a stand-alone verifier needing only the bundle | `tools/sma-attest.mjs`, `tools/sma-attest-verify.mjs` |
| Ownership records + identity aliasing | **DONE** — owner-authorization + alias-aware theft | `registry/owners.json`, `registry/identity-map.json`, `tools/lib/ownership.mjs` |
| Enforcement forcing-function (no unguarded exporter) | **DONE** — CI test fails if a tool loses its guard | `tools/lib/export-coverage-selftest.mjs` |
| Audit-log anchoring | **DONE** — export-audit digest folded into the anchor | `sma-anchor` `audit_digest` |
| Revocation list | **DONE** — revoked key ⇒ verify fails; revoked brick flagged | `security/revocations.json`, `provenance-verify` |
| **Verified identity (Sigstore/OIDC)** | **PARTIAL** — signing + pinning done; binding author to a *verified OIDC identity* still uses git email | roadmap |
| **External witness submission (Rekor/OTS)** | **TO BOUNDARY** — anchor digest + exact command generated; needs `cosign`/`ots` CLI + (Rekor) an OIDC login | `sma-anchor --backend rekor --submit` |
| **Anchor-time origin** | **ROADMAP** — origin still git-date; not yet bound to anchor inclusion time |
| **Federation / dispute protocol** | **ROADMAP** — revocation exists; cross-registry refs + challenge protocol pending |
| **KMS/HSM key custody** | **ROADMAP** — file key today; signer abstraction ready for a KMS hook |

The three items that genuinely need something outside this repo — a public
transparency log submission (network + OIDC), a live federation network, and a
hardware/KMS key store — are wired up to the one-command boundary; everything
else is implemented and tested.

## Data flow

```
external project repos ──(git + source)──▶ sma-provenance-ledger ──▶ 3 generated ledgers
                                                                         │
build.sweetspot.json ──(composition + derived_from)──▶ sma-license-gate ┘  (meet → block escalation)
                                                                         │
committed ledgers ──▶ sma-provenance-verify (recompute + signatures) ────┘  (tamper detection)
```
