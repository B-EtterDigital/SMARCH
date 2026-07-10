# 04 — Design Language

Applies to: the V-18 web dashboard, generated wiki/dashboard surfaces, the
demo assets (V-13), and the public visual identity of README/docs. CLI output
styling (colors, tables) follows the same voice. Design authority: Fable 5
under SMOA (design decisions never delegated to executors).

## Creative direction — "Blueprint Ledger"

SMARCH is about *evidence*: contracts, seals, leases, provenance. The visual
language is an engineering blueprint crossed with an auditor's ledger —
technical drawing precision, stamped verdicts, append-only history made
visible. Never "modern minimal SaaS"; the aesthetic argument is that
coordination infrastructure should look like the engineering document it is.

## Systems

- **Type:** IBM Plex Mono for data/ledger surfaces (tabular numerals on),
  Space Grotesk for headings/UI chrome, system sans fallback. Fluid scale via
  `clamp()`; min body 14px on dashboards; WCAG 2.2 AA contrast at every step.
- **Color (dark-first):** ink `#0E1420` ground, blueprint grid lines at 6-8%
  white, cyan `#5FD4F4` structural accents, amber `#F4B860` = active lease,
  green `#7BC97B` = verified/pass stamp, red `#E5484D` = conflict/fail stamp,
  paper `#F3EFE6` for the light theme ground. Verdict colors are never
  decorative — they mean exactly one thing each (a11y: verdicts always pair
  icon+label, never color alone).
- **Spacing:** 4px base grid; ledger rows 40px; blueprint sections framed by
  1px rule + corner ticks (drawing-border motif), not drop shadows.
- **Motion:** functional only — lease board rows flip on state change
  (150ms), conflict strip pulses once on new conflict (no loops), graph nodes
  settle with spring damping. `prefers-reduced-motion` collapses all of it to
  opacity fades.

## Signature mechanisms (3–7, the clever-UI budget)

1. **The Lease Board** — live departures-board of active leases: agent,
   brick, intent, TTL countdown; rows flip when acquired/released.
2. **Stamped verdicts** — gate results render as rubber-stamp chips (PASS /
   FAIL / WAIVED) with a subtle stamp-press animation on first paint.
3. **Provenance ribbon** — a brick page shows its creator trail as a
   wax-seal chain; hovering a seal reveals the attestation JSON.
4. **Conflict heat strip** — a 30-day sparkline strip of collisions per
   module; clicking opens the conflict ledger filtered to that module.
5. **Brick wall** — the registry grid renders as a literal wall; brick size
   maps to reuse count, mortar gaps to trust tier.

## Dark/light

Dark is canonical (blueprint on ink); light is "paper blueprint" (ink lines
on paper ground) — both themes ship day one on the dashboard, toggle stamped
into `:root[data-theme]`.

## Component inventory pointer

`inventories/dash.ui-component.json` (created at P6; grows with the M3
dashboard build-out).
