---
name: sweetspot-frontend-fix
description: Sweetspot Frontend-Fix (SFF) — SMA's opt-in design-excellence layer. Forces Fable 5 to do frontend design ITSELF with its full design skill stack loaded (never delegated, never from memory), bans every empirically-known AI-slop tell, runs a professional brief→direction→tokens→build→screenshot-verify process, and writes a repo DESIGN-LOCK that binds every future agent so the design cannot be degraded. Trigger: literal SFF, /sff, Sweetspot Frontend-Fix, or "frontend fix" — never self-trigger. EXCEPTION: when a repo contains .sff/DESIGN-LOCK.md, the Design Lock rules of this skill bind ANY agent touching frontend surfaces, no trigger needed. Optional layer of SMA Gen3; SMOA frontend design_specs must derive from the lock when present.
---

# Sweetspot Frontend-Fix (SFF)

## Why This Exists

Two observed failures: Fable ships frontend without loading its
design skills (defaults = slop), and later agents flatten finished designs
back to generic. SFF fixes both: it **forces the process** at design time and
**locks the result** afterward. The bar is a site someone would credibly pay
$22k+ for — distinctive, modern, intentional. "Works and looks fine" fails.

## Activation

- Literal opt-in: `SFF`, `/sff`, `Sweetspot Frontend-Fix`, `frontend fix`.
  Never self-trigger on task difficulty (same law as SUP/SMOA).
- **Standing exception — the lock binds everyone:** if the repo contains
  `.sff/DESIGN-LOCK.md`, every agent editing frontend surfaces must follow
  §Design Lock below, trigger or not. A missing lock is not a gap.
- Under SMOA: SFF governs how Fable authors `design_spec`s; executors get
  the lock excerpt embedded in their packet.

## Rule 1 — Fable Designs, With Its Stack Loaded (No Exceptions)

Design is never done from memory and never delegated. Before ANY design
decision, Fable loads via the Skill tool, in this order:

1. `frontend-design:frontend-design` — Anthropic's official skill
   (~131k stars): commit to an aesthetic direction before code; distinctive,
   anti-generic typography and color.
2. `design-taste-frontend` — anti-slop brief-reading + audit-first redesigns.
3. `high-end-visual-design` — the exact fonts/spacing/shadows/animation that
   read expensive; blocks cheap defaults.
4. Context-dependent: `redesign-existing-projects` (existing UI),
   `gpt-taste` (GSAP scroll/motion-heavy), `minimalist-ui` /
   `industrial-brutalist-ui` (when the chosen family matches), `stop-slop`
   (all UI copy), `dataviz` (any chart), `imagegen-frontend-web` (design
   reference images first).

Skipping the stack = protocol violation. A dispatched packet is not "design
by Fable" — packets carry decisions already made; the skills inform the
deciding, so they load in Fable's own context before the spec is written.

## Rule 2 — The Anti-Slop Blacklist (Hard Bans)

Empirical basis: 1,590 Show HN landing pages; 54% carried ≥2 tells. These
patterns are BANNED unless the DESIGN-LOCK explicitly opts one in with a
written reason:

**Type:** Inter/Roboto/Arial/Space Grotesk as display faces; the
Space Grotesk + Instrument Serif combo; serif-italic single accent words in
an otherwise-sans hero.
**Color:** lavender/violet "VibeCode purple" accents; purple/blue gradients
and gradient text; cyan-on-dark; teal default accent; large colored glows;
dark mode as unconsidered default (34% of slop pages); body text below
WCAG AA (functional failure, auto-REJECT).
**Layout:** centered hero + badge chip above the H1; 3–4px colored left
borders on cards (the single most reliable tell); grids of identical
icon-top feature cards; numbered 1-2-3 step rows; stat banner rows;
emoji-as-iconography; ALL-CAPS section labels everywhere; blinking status
dots; container-soup (cards in cards in cards); default-shadcn look;
unconsidered glassmorphism.
**Motion:** none at all, or fade-in-everything on scroll. Motion must be
specified per element with purpose and easing.

The tells co-occur — one found means audit for the rest.

## Rule 3 — The Process (Professional, Not Prompt-to-Output)

Speed without direction is waste, faster. Every SFF engagement runs:

1. **Brief** — product, audience, emotional tone, 2–3 named real-world
   references (Dribbble/Mobbin/Awwwards caliber). Redesigns start with an
   audit of what exists (per `redesign-existing-projects`).
2. **Direction tournament (never one idea)** — draft THREE genuinely
   different direction concepts from different aesthetic families:
   editorial / terminal / warm / data-dense / cinematic / playful / glass /
   brutalist / indie (or named remixes). Each concept is a tight spec —
   fonts (display + body, none banned), a palette with a point of view
   (warm earth, black + one bright, cream-and-pink, grey-and-blue —
   anything but the LLM default), one strong layout primitive as the
   signature, one signature interaction. Judge them against the brief at
   xhigh; when the user is present, show all three one-liners and let them
   pick. Record winner + one-line why in the lock. A single unconsidered
   direction is the root cause of convergent design — the tournament is
   what buys distinctiveness.
3. **Reference images before code** — generate section-level design
   reference images for the winning direction via `imagegen-frontend-web`
   (one image per section, big/readable), then implement to match them
   (`image-to-code` discipline). Diffusion output is off-distribution for
   code models — designing to an image breaks the statistical centering
   that produces slop. Skip only for micro-tasks (single component) where
   the lock already fully constrains the look.
4. **Tokens** — full system as CSS custom properties (OKLCH preferred):
   color scale, type scale, spacing, radii, shadows, motion durations +
   easings. No hardcoded values downstream of the tokens.
5. **Build** — Fable implements design-defining surfaces itself; under
   SMOA, remaining surfaces go to codex with the lock embedded (§SMOA).
   Real copy only — lorem ipsum and placeholder-sounding copy are slop
   (write it under `stop-slop`). Real imagery or generated art direction,
   never gray boxes.
6. **Refinement loop (mandatory ≥2 rounds)** — the first render is a
   draft, never the deliverable. Each round: screenshot via Playwright at
   390 / 768 / 1440px + key states → Fable critiques its own render
   against the lock, the blacklist, and the Expensive Details list below →
   fix → re-render. Exit only when a round produces zero critique items
   AND the second-read test passes: at least one moment of surprise/
   delight beyond the first scroll. No screenshots = gate not passed =
   work not done.

## Reference-Clone Protocol (1:1 Recreations)

When the brief is "recreate X one-to-one" (an award site, a signature
interaction, a motion sequence), eyeballing the reference fails — the craft
lives in sub-second layers no static screenshot shows. Proven on the
phantom.land-style agency clone: the intro contained a pixel-mosaic
mascot strobe, a hard-cut black beat, a card-wall reveal, a particle mascot,
and a camera dive — five layers, all invisible to a single screenshot, some
randomized per load. The protocol:

1. **Frame-capture the reference, don't describe it.** Drive the live site
   with Playwright. Static states: `page.screenshot` bursts (~70–300ms
   apart). Motion: CDP `Page.startScreencast` (via
   `context().newCDPSession(page)`) captures EVERY composited frame
   (~60fps, jpeg, ack each frame) — canvas `captureStream`/MediaRecorder
   gives black frames in headless; screencast is the reliable path. Install
   probes with `addInitScript` BEFORE `goto` — an MCP roundtrip after load
   misses the intro entirely.
2. **Forensics, not vibes.** Decode frames to disk; compute per-frame
   brightness + inter-frame diff (PIL/numpy) to find phase boundaries,
   strobe rates, hold durations, easing shapes. Montage phases into contact
   sheets for design review. Log `document.body.innerText` + img srcs every
   ~100ms alongside for DOM-layer events (loaders, counters, overlays).
3. **Hunt the randomization.** Reload N times (fresh query strings; watch
   storage flags) — signature intros often pick random variants (colorways,
   tile sets, image order). One capture = one variant, not the design.
4. **Extract the system, not the pixels.** From the same session pull
   computed styles (fonts, sizes, colors), UI copy, layout coordinates, and
   easing timings into a spec table. The clone implements the SYSTEM with
   the client's brand substituted (their logo/mascot/palette), never a
   pixel-copy of someone else's assets or trademarks.
5. **Gate the clone against the reference frames.** The refinement loop
   compares OUR CDP screencast/screenshots side-by-side with the reference
   contact sheets at the same timestamps/states — per-phase, not just the
   rest state. A phase missing from the clone (a strobe beat, a hold, a
   fade) is a REJECT even if the rest state matches.
6. **Fidelity vs. identity split:** choreography, timing, and interaction
   physics are cloned exactly; identity (logos, imagery, type, palette,
   copy) is always the client's own, governed by the DESIGN-LOCK like any
   SFF build.

## The Expensive Details (the last 10% that reads $22k)

Checked every refinement round; these separate "clean" from "crafted":

- **Type craft:** fluid scale via `clamp()`; tightened letter-spacing on
  large display text (`-0.02em`-ish); `text-wrap: balance` on headings;
  tabular numerals for data; real typographic quotes and em-dashes; widow
  control on hero copy.
- **Optical polish:** optical (not just mathematical) alignment; icons
  vertically centered to x-height; consistent border radii from the token
  scale; shadows in layered pairs tinted toward the palette (never pure
  black); hairline borders at 1px with reduced opacity.
- **Motion craft:** custom cubic-bezier easings (never default
  `ease-in-out` everywhere); staggered reveals (60–90ms steps); hover
  states that transform (not just recolor); one signature interaction from
  the direction spec; `prefers-reduced-motion` honored everywhere.
- **States & edges:** designed hover/focus-visible/active/disabled for
  every interactive element; designed empty, loading (skeleton matching
  layout, no spinner-only), and error states; custom `::selection` color;
  styled scrollbars where the direction calls for it; focus rings on-palette.
- **Identity details:** favicon + og-image matching the direction; dark
  mode only as a *designed* variant (never auto-inverted); print/`@media`
  sanity on content pages.
- **Density with intent:** generous negative space OR deliberate density —
  chosen per direction, never the uncommitted middle.

## Asset Pipeline (Higgsfield-First, Cost-Gated)

Real sites need real assets. SFF actively generates them — never gray
boxes, never stock-photo clichés — through the connected tools:

- **Images (photos, art direction, textures, og-image):** Higgsfield
  `generate_image`, prompted through `banana-pro-director-2.0` for
  photoreal/character work or `imagegen-frontend-web` for design comps.
  When unsure which model fits, `models_explore(action:'recommend')`
  first. Post-process in-pipeline: `remove_background` for cutouts,
  `outpaint_image` for aspect fills, `upscale_image` to 2K/4K masters.
- **Video (hero loops, product motion, background plates):** Higgsfield
  `generate_video`, prompted through `cinema-worldbuilder-pro-2.0`
  (scenes) or `product-motion-director` (product/ad motion); `reframe`
  for aspect variants, `upscale_video` for masters.
- **Animated effects (UI-adjacent motion, reveals, ambient loops):**
  prefer CSS/GSAP from the motion tokens first (crisp, free, tiny);
  Higgsfield video/`animation_actions` only for effects code can't do —
  organic motion, particles-on-film, character animation.
- **Sound effects (ui-sfx, ambience):** generate via **fal.ai** (current
  SFX model per fal's catalog; needs `FAL_KEY`), not Higgsfield audio —
  user-standing choice. Keep UI sounds short, quiet, and opt-in
  (muted-by-default policy in the lock).

**High-res masters, web-optimized delivery (both, always):**
- Masters live at `assets/masters/` untouched: upscaled 2K/4K images,
  full-res video. Never served directly, never deleted — they are the
  re-export source.
- Web derivatives are generated from masters: AVIF + WebP fallback at
  responsive widths (~640/1280/1920/2560) via `<picture>`/`srcset+sizes`;
  hero image preloaded, below-fold lazy-loaded with LQIP/blur-up; video as
  AV1/H.265 + poster frame, `preload="none"` below fold. Fingerprinted
  filenames for far-future caching.

**Cost overview BEFORE generation (hard gate, per SMA cost policy —
"paid acceleration stays opt-in"):** no paid media call runs until the
user approves a batch. Present a media plan first:

```
| Asset | Tool/model | Count | Est. cost |
| hero video loop | Higgsfield <model> | 1 | ~N credits |
| section imagery | Higgsfield <model> | 6 | ~N credits |
| ui-sfx set      | fal.ai <model>     | 8 | ~$X |
Balance: <Higgsfield balance tool result> | Total est: <credits + USD>
```

Pull live numbers: Higgsfield `balance` + per-model credit costs from
`models_explore`; fal.ai per-generation pricing from its model page. Never
guess silently — mark unknown rates `unavailable — <reason>`. Regenerations
count against the approved batch; a new batch needs a new approval.

## Post-Approval Phase — SEO + Image Web-Opt (Offer, Don't Assume)

The moment the user approves the design, OFFER this as an optional
follow-up (one sentence, no pressure — it is not part of the design gate):

> "Design approved — want the SEO + image-optimization pass? It makes the
> site rank and load as well as it looks."

If accepted, run the full pass, tuned to **what the site actually is**:

- **Semantics & metadata:** one `<h1>` per page, landmark structure,
  unique title + meta description per page (written under `stop-slop`,
  intent-matched, not keyword-stuffed), canonical URLs, clean slugs.
- **Structured data:** JSON-LD matched to the site's true type —
  Organization / Product + Offer / Article / LocalBusiness /
  SoftwareApplication / FAQ / Breadcrumb — validated, not boilerplate.
- **Social surface:** OG + Twitter cards per page with the
  direction-matched og-image from the asset pipeline.
- **Crawl plumbing:** `sitemap.xml`, `robots.txt`, 404 page in the design
  language, redirect hygiene.
- **Performance = ranking:** Core Web Vitals budget (LCP < 2.5s, CLS <
  0.1, INP < 200ms) verified via Playwright/Lighthouse; the image
  derivative pipeline above is a prerequisite, plus font subsetting +
  `preload`, `fetchpriority="high"` on the LCP element, zero layout-shift
  media (explicit dimensions everywhere).
- **Image SEO:** descriptive filenames, alt text written as description
  (not stuffing), `loading`/`decoding` attributes.
- Evidence at delivery: Lighthouse scores + validated structured-data
  output attached, same fail-loudly rules as everything else.

## Rule 4 — The Design Lock (`.sff/DESIGN-LOCK.md`)

The output contract that makes the design tamper-proof. Written by Fable at
the end of every SFF engagement; lives at repo root `.sff/DESIGN-LOCK.md`:

```markdown
# DESIGN-LOCK — <project> (SFF v1, <date>)
Direction: <family + one-line intent>          ## LOCKED
Tournament: <winner> over <runner-up A>, <runner-up B> — <one-line why>
Signature interaction: <name + description>    ## LOCKED
Fonts: display <name> / body <name>            ## LOCKED
Palette: <tokens + hex/oklch>                  ## LOCKED
Layout primitive / signature: <description>    ## LOCKED
Motion language: <durations, easings, what animates and why>
Opted-in exceptions to the SFF blacklist: <none | item + reason>
Do-not-do (project-specific): <list>
Verified: <screenshot paths + date>
```

Binding rules for **every** agent, every session, every model:
- Before editing any frontend surface, read the lock. Match it.
- LOCKED lines are immutable except by Fable running SFF again on explicit
  user request. "Improving" the design outside SFF is a violation —
  including swaps to banned defaults, palette drift, font substitution,
  spacing flattening, or deleting motion.
- New components must be composed from the locked tokens and primitive.
  An agent that needs a pattern the lock doesn't cover returns the question
  to Fable; it does not invent.
- Gen3: the lock is a shared hot path — treat edits to `.sff/` like edits
  to agent docs (lease + serialized).
- SMOA: every frontend `design_spec` embeds the relevant lock excerpt +
  blacklist; codex reviewers check code against the lock (correctness),
  Fable checks screenshots against it (design).

## Delivery Gate

An SFF engagement is complete only with: three-direction tournament recorded
(winner + why in the lock) + tokens in code + ≥2 refinement rounds with
screenshots at 3 breakpoints attached + zero unopted blacklist hits +
Expensive Details pass (each category confirmed or N/A'd with reason) +
second-read moment identified by name + media cost overview presented and
paid generations kept within the approved batch + high-res masters archived
with web derivatives serving + `.sff/DESIGN-LOCK.md` written/updated +
FEATMAP updated if features changed. After user approval of the design, the
SEO + image-web-opt offer must have been made (accepting it is optional;
offering it is not). Standard SMA claims-and-completion applies on top. If
SMOA is active, the run also owes the SMOA token summary.

## Sources (research basis)

Anthropic frontend-design skill; Adrian Krebs' 16-tell analysis of 1,590
Show HN pages (developersdigest.tech); rohitg00/awesome-claude-design (9
aesthetic families + anti-slop kit); impeccable.style/slop;
wilwaldon/Claude-Code-Frontend-Design-Toolkit (screenshot loop, token
systems, motion pipeline); Julian Oczkowski's 7-skill professional design
process; pasqualepillitteri 18-skill UI/UX guide.
