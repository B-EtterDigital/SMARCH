# [SSA-v2](GLOSSARY.md#ssa-v2) Base Rules

This document sets the baseline architecture rules for code that enters a Sweetspot project. Implementers and reviewers need it when they design a brick, service boundary, data path, or user interface. Read it before coding and use it again during review. Remember that evidence at explicit boundaries carries more weight than a claim in prose.

SSA-v2 is the security and architecture boundary for Sweetspot bricks.

**Enforcement:** Selected machine-detectable parts of these rules are wired
into two gates that can block promotion. See `tools/README.gates.md`. The
current rule gate checks production `console.log`, hex colors outside token
files, `select('*')`, and declared source-path existence; the scope-drift gate
compares declared capability with implementation evidence. The remaining rules
still require manifest, test, security, and review evidence and must not be
described as automatically enforced.

- `sma-rule-gate` — runs the rules below against a manifest's source paths
  and refuses to promote on blocking findings.
- `sma-scope-drift` — catches the case where a manifest declares
  capabilities the implementation no longer delivers.

## Rule 0: Minimum Responsible Code

Use the least code that fully solves the feature without making the next likely change harder.

This means:

- no code bloat
- no unused abstractions
- no duplicate wrappers
- no dependency added for a small helper
- no generic framework inside a feature unless the feature truly needs it
- no future-proofing that is not tied to a likely future
- no generated filler that increases review surface

It does not mean:

- code golf
- hiding complexity in unreadable one-liners
- removing names that make behavior clear
- skipping security, tests, observability, or accessibility
- refusing a small adapter that prevents project lock-in

The target is lean, obvious, and farsighted.

## Rule 1: Frontend Is Untrusted

- no secrets in frontend code
- no service-role keys in frontend code
- no direct privileged provider calls from the browser
- no local-only user data that should live server-side

## Rule 2: Server Boundary Is Explicit

- use Edge Functions, RPCs, API gateways, or server-side adapters for privileged work
- validate inputs at the boundary
- return typed, minimal responses
- rate limit expensive and auth-sensitive paths

## Rule 3: Data Access Is Scoped

- explicit columns instead of `select('*')`
- RLS/storage policies for user/private data
- cross-user negative tests where data ownership matters
- `SECURITY DEFINER` only with explicit scoping and `search_path`

## Rule 4: Dependencies Must Earn Their Place

Every dependency should justify:

- why built-in/platform code is not enough
- security and maintenance risk
- bundle/runtime cost
- clone portability

## Rule 5: Files Stay Reviewable

- 400 lines is the target
- 600 lines is the hard limit
- split by responsibility, not by arbitrary line count
- generated/vendor files must be marked as exceptions

The 600-line limit is the SSA review contract. The repository-wide
`source:size:gate` currently protects a separate legacy ceiling for new or
growing files at 1,900 lines; passing that coarse migration gate does not prove
this rule.

## Rule 6: Bricks Expose Ports, Not Project Assumptions

A reusable brick should declare adapters for:

- auth provider
- database/storage provider
- feature flags
- billing/tier checks
- observability
- routes/navigation
- styling/design tokens where relevant

## Rule 7: Evidence Beats Claims

SSA-v2 compliance requires evidence:

- manifest metadata
- validation output
- test commands
- security checks
- review/provenance events

## Rule 8: UI Is Theme-Aware and Clean

Every visible component renders correctly across the project's configured themes and follows design-system primitives — no hardcoded styling shortcuts, no orphaned debug UI.

**Theme-aware:**

- use design tokens / theme variables for color, spacing, typography, radii, shadows
- no hex, `rgb()`, `hsl()`, or named-color literals in component code — those belong only in token-definition files (`theme.ts`, `tailwind.config.*`, design-token sources)
- components render correctly in every configured theme (Acme Studio: light / dark / cyber; bricks must be theme-agnostic — adapt via tokens, not assume a palette)
- honor user accessibility preferences — `prefers-reduced-motion`, high-contrast, font-scale — never hard-code transitions, durations, or font sizes that override them
- icons inherit theme via `currentColor` (stroke/fill), not fixed hex values

**Clean:**

- consistent spacing scale — no `mt-[13px]`-style arbitrary escapes unless the geometry truly demands it
- no inline styles for theme-sensitive properties (color, background, border, shadow)
- no orphaned debug UI in committed code — test borders, color-coded outlines, `console.log` overlays, alpha "TODO" banners
- no copy-pasted theme overrides — lift recurring patterns into a token or shared component
- dark-mode treatment is complete, not partial (a card that themes its background but leaves text hardcoded black is a violation)

**It does not mean:**

- banning one-off pixel values for genuine geometry (canvas math, SVG `viewBox`, animation timing curves)
- preventing product-specific palettes from being defined as tokens (a brick's brand accent token is fine; a brick hardcoding `#FF8A3D` is not)
- forcing all components into a single design system — product-specific surfaces (Acme Story canvas nodes, game UI) can have their own visual language, but must still be theme-aware and respect accessibility prefs
