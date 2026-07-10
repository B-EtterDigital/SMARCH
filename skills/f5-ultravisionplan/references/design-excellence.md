# Design Excellence, i18n Readiness, Performance Tiers

Standards the plan must encode. These shape the vision elevation (Phase 1), the strategy docs (Phase 4), and the `done-when`/`gates` of design, ux, i18n, a11y, and perf tasks.

## UX/UI — top-notch product level

The bar: a product a top studio would ship — distinctive, clever, functional, efficient. Not "clean and generic".

**Direction before components.** `04-DESIGN-LANGUAGE.md` names one specific creative direction rooted in what the product *is* (its domain, its personality, its users) — never "modern minimal SaaS". If the user has taste skills installed (`design-taste-frontend`, `high-end-visual-design`, `minimalist-ui`, `industrial-brutalist-ui`, etc.), reference the fitting one in the doc so frontend agents load it at execution time.

**Anti-generic rules to encode in the design contract:**
- Typography with intent: a real scale, extreme contrast where it earns it, no default-stack sameness.
- Color as a system: calibrated palette with semantic roles and verified contrast (WCAG AA minimum, AAA for body text where feasible).
- Layout with a point of view: asymmetry, density changes, and hierarchy that guides — not three-equal-cards-forever.
- Motion as feedback, not decoration: micro-interactions on state changes, honest loading, respect `prefers-reduced-motion`.
- Empty states, error states, loading states, and edge cases are *designed*, and each gets tasks — polish lives exactly there.

**Clever UI** means mechanisms, not ornament: interface ideas unique to this product that reduce steps, expose power progressively, or make the core loop feel effortless. Name 3–7 signature concepts in the design doc; each becomes tasks (design → build → test → polish).

**Functionality gates for every UI task:** keyboard reachable, focus-visible, screen-reader labeled, hit targets ≥44px on touch, no layout shift on load, works at 320px width and 4K, dark/light both intentional.

## Multilingual readiness (prep, even for monolingual launch)

The product must be one config away from a new language:

- No hardcoded user-facing strings — everything through the i18n layer with stable, namespaced keys. The audit counts violations; the plan generates externalization tasks (usually many C1/C2 — batch them per surface into shards).
- ICU MessageFormat for plurals/gender/selects; no string concatenation of sentence fragments.
- Layouts tolerate +40% text expansion; truncation is designed, not accidental.
- RTL: logical CSS properties (`margin-inline-start`, not `margin-left`), mirrored iconography audit, `dir` plumbing.
- Locale-aware dates, numbers, currencies, sorting via `Intl` (or platform equivalent) — never hand-formatted.
- A pseudo-locale (`en-XA`-style) wired into dev builds, plus a CI check that fails on new hardcoded strings.
- Media/i18n intersection for visual products: text baked into generated images/videos needs a localization strategy (text-free assets + overlays preferred).

## Performance — great on low-tier, spectacular on SOTA

Plan performance as a **ladder**, not a single target:

1. **Baseline (must feel great):** define concrete minimum spec in `07-PERFORMANCE-PLAN.md` — e.g. a 2015-class dual-core laptop, 4GB RAM, integrated graphics, slow disk, 3G-class network for web products. Every budget is measured against *this* machine.
2. **Budgets per surface:** cold start, time-to-interactive, input latency, frame time (60fps baseline where motion exists), memory ceiling, bundle/asset size. Budgets go into task `gates`, and CI perf checks are themselves tasks.
3. **Adaptive quality:** feature-detect (cores, memory, GPU tier, reduced-motion, connection) and degrade gracefully — fewer particles, static instead of video, simpler shadows — without ever degrading *function*.
4. **SOTA enhancement tier:** extra headroom becomes extra delight, explicitly planned: higher-fidelity effects, richer physics/concurrency, higher-res media variants, instant prefetch. These are their own tasks, gated on detection — the baseline never pays for them.
5. **Engineering defaults to encode in tasks:** lazy-load below the fold, code-split by route/module, cache aggressively, virtualize long lists, offload heavy work off the main thread, compress every asset to the plan's codec/size targets.

## Quality & release-readiness (what "done" means everywhere)

- Tested at the right layer: unit for logic, integration for seams, e2e for the critical paths, visual regression for the design system, perf checks for the budgets.
- Telemetry per SMA: every real error captured with area/severity/context; no silent catches; SRS-equivalent audit passes.
- Reliability: retries/timeouts/offline behavior designed for every network call; corrupted-state recovery for persisted data.
- Docs current with evidence; release gates green; `08-QUALITY-RELEASE-PLAN.md` defines it once and every task's `gates` points at real commands.
