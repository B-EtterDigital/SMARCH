# [SPE](../docs/GLOSSARY.md#spe) — Sweetspot Performance Eval v1.0

This document defines the performance thresholds, audit sequence, and approved repair patterns for Sweetspot product surfaces. Engineers and reviewers need it before they measure or approve a page, component, or data flow. Read it during implementation, before release, and again after any performance fix. Remember to measure the same path after the fix because an unverified optimization does not pass the performance gate.

## Purpose
Systematic, brutally honest performance auditing framework for every page/component before shipping to production. SPE provides measurable thresholds, a repeatable audit process, and mandatory fix-before-ship gates.

SPE works in harmony with the Sweetspot ecosystem:
- **SSA-v2** → SPE enforces that all data flows through edge functions/RPCs, never N+1 client queries
- **[SSI](../docs/GLOSSARY.md#ssi)** → SPE validates that lazy loading (L1), error boundaries (L2), and tier gating (L3) don't degrade performance
- **[SRS](../docs/GLOSSARY.md#srs)** → SPE ensures no security shortcuts for performance (no `select(*)`, no client-side secrets)
- **[STF-v1](../docs/GLOSSARY.md#stf)** → SPE metrics are testable via STF performance test patterns
- **SSRA** → SPE audit results feed into release readiness checklists

---

## SPE Tooling: Chrome DevTools MCP + Auth Injection

### Setup (One-Time)
Chrome 144+ on Wayland doesn't bind `--remote-debugging-port` in GUI mode. The workaround:

1. **Launch debug Chrome** with `--user-data-dir` (creates separate profile with debug port):
   ```bash
   ~/.local/bin/chrome-debug  # wrapper script that copies session + launches with port 9222
   ```

2. **Install Chrome DevTools MCP** in Claude Code:
   ```bash
   claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest
   ```

3. **Auth injection** (Clerk sign-in token bypasses Google OAuth block in debug Chrome):
   ```bash
   # Generate token via Clerk Backend API
   curl -s -X POST \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" \
     -H "Content-Type: application/json" \
     -d '{"user_id": "USER_ID"}' \
     "https://api.clerk.com/v1/sign_in_tokens"
   ```

   Then inject via Chrome DevTools `evaluate_script`:
   ```javascript
   const res = await window.Clerk.client.signIn.create({
     strategy: 'ticket',
     ticket: '<TOKEN>'
   });
   await window.Clerk.setActive({ session: res.createdSessionId });
   ```

4. **Navigate to page** and collect metrics via `evaluate_script` and `list_network_requests`.

### Why This Works
- Debug Chrome with `--user-data-dir` binds port 9222 (Wayland bug workaround)
- Clerk sign-in token creates a valid session without Google OAuth (which blocks debug browsers)
- Chrome DevTools MCP provides full access: network requests, console, screenshots, DOM, memory, performance traces
- The auth injection is production-safe: uses the same Clerk Backend API that invitation emails use

---

## SPE Audit Process

### Phase 1: Measure (Chrome DevTools / MCP)
Connect via Chrome DevTools MCP and collect raw data for each page:

```
1. Supabase API request count (exclude storage/images)
2. N+1 patterns (any table queried >2x)
3. DOM element count
4. JS heap memory (MB)
5. Image count (total / loaded / failed)
6. Console errors (count + categories)
7. Largest Contentful Paint (ms)
8. Total load time (ms)
9. Bundle chunks loaded (count)
```

### Phase 2: Judge (Against Thresholds)

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Supabase API requests | ≤30 | 31-60 | >60 |
| N+1 patterns | 0 | 1-2 minor | Any >5x |
| DOM elements | ≤5,000 | 5,001-15,000 | >15,000 |
| JS heap memory | ≤100 MB | 101-300 MB | >300 MB |
| Failed images | 0 | 1-3 | >3 |
| Console errors | 0 | 1-2 (non-critical) | Any crash/render error |
| LCP | ≤2,500ms | 2,501-4,000ms | >4,000ms |
| Total load | ≤10s | 11-20s | >20s |

### Phase 3: Fix (Mandatory for Red, Recommended for Yellow)

**Red items are blockers** — must be fixed before shipping.

Fix priority order (highest impact first):
1. **N+1 query patterns** → Module-level batch cache or RPC consolidation
2. **Console crashes** → ErrorBoundary + null-safe access
3. **Excessive requests** → Shared data layer (fetchDashboardStats pattern)
4. **DOM bloat** → Virtualization (IntersectionObserver or react-window)
5. **Memory** → Progressive loading, image lazy loading
6. **Failed images** → Throttled loading, proper error fallbacks

### Phase 4: Verify (Re-measure After Fix)

Re-run Phase 1. Compare before/after. Document:
- Which metrics improved
- Which stayed the same
- Any regressions introduced (ZERO TOLERANCE)

### Phase 5: Document (SPE Report Card)

Create a page-level report card:

```markdown
## SPE Report: [Page Name]
Date: YYYY-MM-DD
Route: /path

| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Supabase requests | X | Y | 🟢/🟡/🔴 |
| ... | ... | ... | ... |

Fixes applied: [list]
Regressions: NONE
```

---

## SPE Patterns (Approved Solutions)

### Pattern 1: Module-Level Batch Cache
**Problem**: Hook called per-component fires individual queries.
**Solution**: First caller fetches ALL data, caches at module level. Subsequent callers read from cache.
**Files**: `useTrackLayers.ts`, `useUserCredits.ts`, `useFeatureCredits.ts`
**TTL**: 15-60 seconds for dynamic data, 5 minutes for config data.

### Pattern 2: Server-Side RPC Consolidation
**Problem**: Multiple contexts independently query the same tables.
**Solution**: Single PostgreSQL RPC function returns all aggregates. Shared via `fetchDashboardStats()` with 500ms dedup + 10s cache.
**File**: `hooks/useDashboardStatsRPC.ts`

### Pattern 3: Progressive Grid Loading
**Problem**: Rendering 200+ items with images floods wsrv.nl (403 rate limit).
**Solution**: Initial visible count = 40. IntersectionObserver (rootMargin: 2000px) loads more on scroll.
**File**: `pages/enhanced-results/constants.ts`

### Pattern 4: Virtualized Table Rows
**Problem**: Table renders all rows even if off-screen.
**Solution**: IntersectionObserver marks rows as visible/invisible. Only visible rows render full content; others render lightweight placeholders.
**File**: `pages/approve/hooks/useTableVirtualization.ts`
**Critical**: Observer must be created BEFORE ref callbacks fire (useEffect timing).

### Pattern 5: Image Proxy Sizing
**Problem**: Full-size image loaded for thumbnail display (300KB → 2KB).
**Solution**: `getImageProxyUrl(url, { width: 56, height: 56 })` via wsrv.nl.
**Rule**: Every `<Image>` displaying at <200px MUST use the proxy with appropriate dimensions.

### Pattern 6: Deferred Background Processing
**Problem**: Edge functions fire on page load (`immediate: true`).
**Solution**: `immediate: false` + 60s startup delay. External cron is primary trigger.
**Rule**: Background processors NEVER fire on mount. Single canonical mount point only.

---

## SPE Integration Points

### With SSA-v2 (Architecture)
- All aggregate data MUST flow through RPCs, not client-side batching
- No `select(*)` — always specify columns
- Client-side caching MUST use module-level dedup, not per-component state

### With SSI (Isolation)
- Lazy-loaded pages (L1) must not degrade LCP — use prefetch for likely routes
- Error boundaries (L2) must catch performance-related crashes (OOM, network timeout)
- Tier gates (L3) should PREVENT loading heavy features for non-eligible users

### With SRS (Security)
- Performance caches MUST NOT leak data across users (scope by userId)
- RPC functions use `SECURITY DEFINER` with `all_my_user_ids()` — never bypass RLS without equivalent scoping
- Image proxy URLs are public — never proxy private/authenticated images through wsrv.nl

### With STF-v1 (Testing)
- Performance thresholds are testable: `expect(supabaseRequests).toBeLessThan(30)`
- N+1 detection can be automated: mock Supabase client, count `.from()` calls per render
- Memory snapshots: `performance.memory.usedJSHeapSize` in CI

---

## SPE Audit History

### 2026-03-23: Dashboard Page
| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Supabase requests | 160 | 43 | 🟢 -73% |
| transcript_versions N+1 | 69 queries | 0 (RPC) | 🟢 |
| DOM elements | 8,769 | 8,769 | 🟢 |
| Memory | 112 MB | 112 MB | 🟢 |
| Console errors | 5 | 0 | 🟢 |

### 2026-03-23: Approve Page
| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Supabase requests | 34 | 34 | 🟢 |
| Virtualization | Broken (empty rows) | Fixed | 🟢 |
| Console errors | 0 | 0 | 🟢 |

### 2026-03-23: Results Page
| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Supabase requests | 89 | 34 | 🟢 -62% |
| stem_library N+1 | 24 | 1 | 🟢 |
| track_cover_variants N+1 | 27 | 1 | 🟢 |
| user_credits N+1 | 13 | 1 | 🟢 |
| DOM elements | 41,204 | 10,099 | 🟡 |
| Memory | 776 MB | 232 MB | 🟡 |
| Failed images | 26 (403s) | 1 | 🟢 |

### 2026-03-24: Topic Network
| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Supabase requests | 162 | 79 | 🟡 |
| track_topics N+1 | 134 | 40 | 🟡 |
| group_topics N+1 | 16 | 2 | 🟢 |
| DOM elements | 43,639 | 43,639 | 🔴 (SVG graph) |

### 2026-03-24: Artwork Studio
| Metric | Value | Status |
|--------|-------|--------|
| Supabase requests | 37 | 🟢 |
| DOM elements | 843 | 🟢 |
| Memory | 41 MB | 🟢 |
| Console errors | 0 (crash is interaction-triggered) | 🟡 |

### 2026-03-24: Activity Page (renamed to /activity/musicmation)
| Metric | Value | Status |
|--------|-------|--------|
| Supabase requests | 30 | 🟢 |
| DOM elements | 1,259 | 🟢 |
| Memory | 41 MB | 🟢 |
| Console errors | 1 (pre-existing activity_log 400) | 🟡 |

### 2026-03-24: Settings Page
| Metric | Value | Status |
|--------|-------|--------|
| Supabase requests | 35 | 🟢 |
| DOM elements | 688 | 🟢 |
| Memory | 49 MB | 🟢 |
| Console errors | 0 | 🟢 |

---

## SPE Checklist (For Every New Page/Feature)

- [ ] Run Chrome DevTools audit (9 metrics)
- [ ] Zero Red items
- [ ] All Yellow items documented with justification
- [ ] No N+1 patterns (any hook used by multiple components MUST batch)
- [ ] Images use wsrv.nl proxy at appropriate dimensions
- [ ] Progressive loading for grids >20 items
- [ ] Module-level cache for shared data hooks
- [ ] Before/after comparison documented
- [ ] Zero regressions on existing pages
