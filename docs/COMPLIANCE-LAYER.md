# SMA Compliance Layer (EU GDPR · DSA · CSAM Reg. + Swiss nFADP)

This guide describes the reusable compliance checks for data protection and platform safety in Sweetspot projects. Product owners, security reviewers, and engineers handling regulated data need it before release. Read it while classifying a project, wiring compliance evidence, or reviewing an unresolved legal gate. Remember that the layer records engineering evidence and blockers; it does not substitute for legal review.

A declarative, reusable pre-release compliance gate that ships with SMA so a
project can enforce EU + Swiss data-protection and platform-safety obligations
from day one — not as a late scramble.

## Files

- `tools/lib/compliance-controls.mjs` — the **declarative control catalog**: the
  single source of truth for every obligation (data-subject rights, consent,
  privacy notice, DSA notice-and-action, child-safety taxonomy, CSAM media
  scanning, age assurance, RLS/owner-scoping, service-role hygiene, local-cache
  isolation, breach observability). Each control has a regulation mapping, a
  severity (`blocker` / `required` / `advisory`), a `detect()` evidence probe,
  and a remediation hint. **Add/remove/re-prioritise an obligation = one array
  entry.**
- `tools/sma-compliance-gate.mjs` — the checker. Evaluates the catalog against a
  project and prints a COVERED / PARTIAL / MISSING scorecard with citations.

## Use

```bash
node tools/sma-compliance-gate.mjs --root <project>           # report
node tools/sma-compliance-gate.mjs --root <project> --gate    # fail if a BLOCKER is unmet
node tools/sma-compliance-gate.mjs --root <project> --strict  # fail if any required/blocker unmet
node tools/sma-compliance-gate.mjs --root <project> --json    # machine-readable
```

- `npm run gate:compliance` runs it against the current repo and is part of
  `gate:all` → `gate:promote`, so a release with an unmet **blocker** fails.
- `sma-init-project` prints the direct compliance-gate command in its
  `next_commands` output. A project still has to wire that command into its own
  release workflow; SMARCH itself includes `gate:compliance` in `gate:all`.

## Severity model

- **blocker** — release-stopping. Missing one fails `--gate`. (e.g. right to
  erasure, world-readable RLS, functional reporting, CSAM scan hook.)
- **required** — fails `--strict` but not the hard gate. Honestly-tracked gaps
  that usually need a policy/vendor/infra decision (e.g. age-assurance vendor,
  TURN infra for IP minimization).
- **advisory** — reported, never fails.

## Honesty principle

The gate must never report a false green. Detectors exclude test/mock files and
key on real implementation primitives, not labels. A gap is shown as a gap —
that is the point. Engineering can close blockers; `required` items that depend
on legal/vendor/infra decisions are surfaced so they are decided, not forgotten.

## What it does NOT do

It checks for the **presence of technical controls**. It does not provide legal
certification — a DPO/counsel review, a published privacy policy, DPAs with
sub-processors, and operator enrollment (e.g. CSAM scanning provider / NCMEC)
remain organisational responsibilities. The gate makes those gaps visible.
