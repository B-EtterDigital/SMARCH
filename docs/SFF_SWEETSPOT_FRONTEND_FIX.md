# [SFF](GLOSSARY.md#sff) — Sweetspot Frontend-Fix

This guide defines the opt-in design-excellence workflow for frontend repairs. Product designers, frontend implementers, and reviewers need it before changing a user-facing surface under this workflow. Read it when a request triggers SFF or a repository already carries its design lock. Remember that the lock governs every later frontend edit until an authorized SFF run changes it.

SFF is SMA's opt-in design-excellence layer. It exists because two failures
were observed in practice: Fable shipping frontend without loading its design
skill stack, and later agents degrading finished designs back to generic
AI-slop. SFF forces the professional process at design time and locks the
result afterward. The bar: a site someone would credibly pay $22k+ for.

Reference implementation: `skills/sweetspot-frontend-fix/SKILL.md`
(installed at `~/.claude/skills/sweetspot-frontend-fix/`).

## Opt-in rule

Triggers only on the literal tokens `SFF`, `/sff`, `Sweetspot Frontend-Fix`,
`frontend fix`. Never self-triggers (same law as [SUP](GLOSSARY.md#sup)/[SMOA](GLOSSARY.md#smoa)). **Standing
exception:** when a repo contains `.sff/DESIGN-LOCK.md`, the Design Lock
rules bind every agent touching frontend surfaces, trigger or not.

## The four rules (full text in the skill)

1. **Fable designs, stack loaded:** design decisions are made only after
   loading `frontend-design:frontend-design`, `design-taste-frontend`,
   `high-end-visual-design`, plus context-dependent skills. Never from
   memory, never delegated.
2. **Anti-slop blacklist:** the 16 empirically-ranked AI tells (Inter-etc.
   display fonts, VibeCode purple, gradients/glows, badge-above-H1, colored
   left card borders, icon-card grids, stat rows, emoji icons, ALL-CAPS
   labels, default-shadcn look, sub-WCAG-AA contrast …) are hard-banned
   unless the lock opts one in with a written reason.
3. **Professional process with a generative engine:** brief → THREE-
   direction tournament from different aesthetic families (judged at
   xhigh; user picks when present; winner + why recorded in the lock) →
   section-level reference images via `imagegen-frontend-web`, implemented
   to match (`image-to-code` discipline) → OKLCH token system → build with
   real copy (`stop-slop`) → mandatory refinement loop, ≥2 rounds of
   Playwright screenshots at 390/768/1440px critiqued against the lock,
   the blacklist, and the Expensive Details craft list (type craft,
   optical polish, motion craft, designed states/edges, identity details).
   Exit requires zero critique items + a named second-read moment.
4. **Design Lock:** `.sff/DESIGN-LOCK.md` records direction, fonts, palette,
   signature, motion language as LOCKED lines — immutable except by Fable
   re-running SFF on explicit user request. All agents compose new UI from
   the locked tokens; unknown patterns return to Fable.

Plus the asset + follow-up pipeline: images/video/animated effects via
Higgsfield (prompted through the director skills; upscaled 2K/4K masters at
`assets/masters/`, AVIF/WebP responsive derivatives served), sound effects
via fal.ai, a mandatory media cost overview approved by the user BEFORE any
paid generation (SMA cost policy), and — once the user approves the design —
a mandatory *offer* of the optional SEO + image-web-opt pass (semantics,
JSON-LD matched to the site's true type, OG cards, sitemap/robots, Core Web
Vitals budget with Lighthouse evidence).

## Reference-Clone Protocol (added 2026-07-05)

For "recreate X one-to-one" briefs the skill now carries a mandatory
capture-first protocol (full text in the skill): drive the reference live
with Playwright; capture motion with CDP `Page.startScreencast` (canvas
captureStream is black in headless; probes install via `addInitScript`
before `goto`); run frame forensics (brightness + inter-frame diff) to find
phase boundaries, strobe rates, and holds; reload N times to catch
randomized intro variants; extract the design SYSTEM (fonts, coords,
timings) into a spec table; and gate the clone by comparing its own
screencast frames against the reference contact sheets per-phase.
Choreography is cloned exactly; identity (logos, imagery, palette, copy) is
always the client's own under the DESIGN-LOCK. Proven on the phantom.land →
Agency-homepage rebuild (5-layer intro: mosaic-mascot strobe, black
beat, card-wall reveal, particle mascot, camera dive — none visible in a
single screenshot).

## Integration

- **Gen3:** `.sff/` is a shared hot path (lease + serialize edits). The
  delivery gate stacks on claims-and-completion; FEATMAP updates unchanged.
- **SMOA:** every frontend `design_spec` embeds the lock excerpt +
  blacklist. Codex reviews code against the lock; Fable reviews screenshots
  against it. Design judgment never moves to the workforce.

<!-- docs-i18n: key=docs.sff-sweetspot-frontend-fix; source=en; media=media/{locale}/sff-sweetspot-frontend-fix/ -->
