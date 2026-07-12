# SWEETSPOT TESTING FRAMEWORK V1 ([STF-v1](../docs/GLOSSARY.md#stf))

This document defines the Sweetspot test architecture, test patterns, and confidence model. Engineers and reviewers need it when they add coverage, choose a test layer, or assess a release gate. Read it before writing a new test suite and when a test strategy leaves a domain risk unclear. Remember to cover behavior at the cheapest layer that can prove it without hiding integration risk.

**A reusable, production-grade testing architecture for full-stack web applications**

Created: March 2026 | Reference Implementation: Acme Studio (~1,460 tests across 56 suites + 10 AI E2E flows)

---

## 1. PHILOSOPHY

The Sweetspot Testing Framework targets the **maximum confidence-per-test ratio**. Instead of chasing 100% line coverage (which is expensive and misleading), STF focuses on **domain coverage** -- ensuring every distinct module, behavior, and integration point is verified through the right test type at the right layer.

### Core Principles

1. **Test behavior, not implementation** -- Assert on what the user/consumer sees, not internal state transitions
2. **Mock at boundaries** -- Only mock what crosses a system boundary (DB, network, browser APIs)
3. **Pure logic gets deepest tests** -- Utility functions, parsers, state machines get exhaustive edge-case coverage
4. **Hooks get renderHook** -- React hooks tested with `renderHook` + `act`, never render a full component tree
5. **Stores get state machine tests** -- Zustand/Redux stores tested via `getState()` after actions
6. **Services get contract tests** -- Verify they call the right API with the right payload
7. **Components get smoke tests** -- Render + assert on visible elements, not internal state
8. **No flaky tests** -- Zero tolerance. Use fake timers, deterministic mocks, no real network

### The Sweetspot Pyramid

```
              /\
             /  \  AI E2E (10 specs, Stagehand)
            /    \  Self-healing browser flows
           /------\
          /        \  Component Integration (8 suites)
         / RTL +    \  Render + click + type + navigate
        / userEvent  \
       /--------------\
      /                \  Integration (12 suites)
     /  Contexts,       \  Contexts, services, store+hook combos
    /   Services         \
   /----------------------\
  /                        \  Unit (26 suites)
 /  Hooks, Stores, Utils,   \  Pure functions, state machines, parsers
/____________________________\
   Backend E2E (8 suites, Deno)
```

---

## 2. ARCHITECTURE

### 2.1 Directory Structure

```
project-root/
  0000testing/
    frontend/
      vitest.config.ts       # Vitest config with path aliases
      setup.ts               # Global mocks (localStorage, matchMedia, etc.)
      08-settings-ui.test.tsx # Numbered test files by domain
      09-analytics-...test.tsx
      ...
      45-performance-image.test.ts
    01-tier-config.test.ts   # Backend Deno E2E tests
    02-suno-enqueue.test.ts
    ...
    08-roadmap-e2e.test.ts
    config.ts                # Shared backend test config
    run.sh                   # Universal test runner
  FINALIZATION/
    100Procent-HC-TestSuite/
      run.sh                 # Comprehensive runner with category targets
      TEST-MANIFEST.md       # Complete test inventory
      frontend/              # Symlinks to actual test files
      backend/               # Symlinks to actual test files
    STF-v1/
      FRAMEWORK.md           # This document
```

### 2.2 Naming Convention

Files are numbered by domain priority:

| Range  | Domain             | Layer         |
|--------|--------------------|---------------|
| 01-07  | Backend E2E        | Integration   |
| 08-17  | Phase 1-13 features| Unit          |
| 18-23  | Infrastructure     | Unit          |
| 24-30  | Generation pipeline| Unit/Integ    |
| 31-33  | Error reporting    | Deep unit     |
| 34-35  | Zustand stores     | State machine |
| 36-37  | Touch & keyboard   | Interaction   |
| 38     | Data/caching hooks | Unit          |
| 39     | TTS markup parser  | Pure logic    |
| 40     | Logger/rate limit  | Infrastructure|
| 41     | Lib core           | Infrastructure|
| 42     | Services           | Contract      |
| 43     | Contexts           | Integration   |
| 44-45  | Audio/perf utils   | Pure logic    |

### 2.3 Numbering Rules

1. **Backend E2E**: 01-07 (Deno runtime)
2. **Frontend unit/integration**: 08+ (Vitest + jsdom)
3. Files are never renumbered -- gaps are OK
4. New files get the next available number
5. Domain grouping takes priority over sequential numbering

---

## 3. INFRASTRUCTURE

### 3.1 Vitest Configuration

```typescript
// 0000testing/frontend/vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [resolve(__dirname, './setup.ts')],
    include: [resolve(__dirname, './**/*.test.{ts,tsx}')],
    testTimeout: 15000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, '../../apps/web/src') },
  },
});
```

**Key decisions:**
- Tests live **outside** `apps/web/` so they don't pollute the source tree
- Path alias `@` resolves to source root -- same as production code
- 15s timeout handles async retry logic (retryQuery tests use real delays)
- jsdom environment for DOM APIs without a real browser

### 3.2 Setup File

The setup file provides:

1. **MockStorage** -- In-memory localStorage/sessionStorage
2. **MockResizeObserver** / **MockIntersectionObserver** -- No-op observers
3. **matchMedia** -- Returns `{ matches: false }` for all queries
4. **requestAnimationFrame** -- Maps to `setTimeout(cb, 0)`
5. **URL.createObjectURL** -- Returns `'blob:mock-url'`
6. **createMockSupabase()** -- Chainable query builder that resolves to `{ data: [], error: null }`
7. **createMockRouter()** -- Mock `navigate` and `location`

**Critical pattern: beforeEach/afterEach lifecycle**
```typescript
beforeEach(() => {
  mockLocalStorage.clear();
  mockSessionStorage.clear();
  // Re-define window properties...
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
```

### 3.3 Module Isolation Pattern

Zustand stores and singletons require fresh imports per test:

```typescript
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  const mod = await import('@/stores/useMyStore');
  store = mod.useMyStore.getState();
  store.reset();
});
```

This prevents state leakage between tests.

---

## 4. TEST PATTERNS

### 4.1 Pure Function Tests (Deepest Coverage)

**When**: Utility functions, parsers, formatters, validators
**Pattern**: Direct import + assert

```typescript
import { parseTTSMarkup, validateMarkup, escapeMarkup } from '@/lib/ttsMarkupParser';

describe('parseTTSMarkup', () => {
  it('creates pause node with correct duration', () => {
    const result = parseTTSMarkup('Hello [pause:500ms] world');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].type).toBe('pause');
    expect(result.nodes[0].duration).toBe(500);
    expect(result.plainText).toBe('Hello   world'); // marker replaced with space
  });

  it('caps pause at 5000ms and reports error', () => {
    const result = parseTTSMarkup('[pause:10s]');
    expect(result.nodes[0].duration).toBe(5000);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain('exceeds maximum');
  });
});
```

**Coverage target**: Every input class (valid, invalid, edge), every output field

### 4.2 Zustand Store Tests (State Machine)

**When**: Zustand stores with actions, selectors, persistence
**Pattern**: `getState()` + action calls + state assertions

```typescript
vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: vi.fn() } }));

describe('useComicUndoStore', () => {
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    const mod = await import('@/stores/useComicUndoStore');
    store = mod.useComicUndoStore.getState();
    store.clear();
  });

  it('pushOperation adds to undo stack and clears redo', () => {
    store.pushOperation({
      type: 'panel.update', description: 'Move panel',
      before: { x: 0 }, after: { x: 100 },
      entityType: 'panel', entityId: 'p1',
    });
    const state = store; // or useComicUndoStore.getState()
    expect(state.undoStack).toHaveLength(1);
    expect(state.canUndo).toBe(true);
    expect(state.redoStack).toHaveLength(0);
  });

  it('LRU evicts at 200 operations', () => {
    for (let i = 0; i < 205; i++) {
      store.pushOperation({ type: 'test', description: `Op ${i}`, ... });
    }
    expect(store.undoStack.length).toBeLessThanOrEqual(200);
  });
});
```

**Coverage target**: Every action, every state transition, persistence roundtrip, eviction/caps

### 4.3 React Hook Tests

**When**: Custom hooks with state, effects, refs
**Pattern**: `renderHook` + `act` + fake timers

```typescript
import { renderHook, act } from '@testing-library/react';

describe('useDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns debounced value after delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: 'hello' } }
    );
    expect(result.current).toBe('hello');

    rerender({ value: 'world' });
    expect(result.current).toBe('hello'); // Not yet

    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe('world'); // Now
  });
});
```

**Coverage target**: Return shape, state changes, cleanup on unmount, edge cases

### 4.4 Service Contract Tests

**When**: Services that call Supabase/APIs
**Pattern**: Mock the client, verify the call shape, test error paths

```typescript
vi.mock('@/lib/supabaseClient', () => {
  const chainable = () => { /* ... */ };
  return { supabase: { from: vi.fn(() => chainable()) } };
});

describe('LoginNotificationService', () => {
  it('skips self-notification', async () => {
    const service = new LoginNotificationService(supabase);
    await service.notifyUserLogin({
      userId: 'admin-id', userName: 'Admin', ...
    });
    expect(supabase.from).not.toHaveBeenCalledWith('notifications');
  });
});
```

### 4.5 Context Provider Tests

**When**: React contexts with providers and consumer hooks
**Pattern**: Render with wrapper, assert on hook return values

```typescript
describe('OfflineContext', () => {
  it('useOffline throws outside provider', () => {
    expect(() => {
      renderHook(() => useOffline());
    }).toThrow();
  });

  it('provides expected shape inside provider', () => {
    const { result } = renderHook(() => useOffline(), {
      wrapper: ({ children }) => <OfflineProvider>{children}</OfflineProvider>,
    });
    expect(result.current).toHaveProperty('isOnline');
    expect(result.current).toHaveProperty('queueMutation');
  });
});
```

### 4.6 Touch/Gesture Hook Tests

**When**: Hooks that return event handlers
**Pattern**: Call returned handlers with synthetic events

```typescript
describe('useLongPress', () => {
  it('fires onLongPress after threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onLongPress, threshold: 200 })
    );

    act(() => {
      result.current.onTouchStart(mockTouchEvent(100, 200));
      vi.advanceTimersByTime(200);
    });

    expect(onLongPress).toHaveBeenCalledWith(
      expect.objectContaining({ x: 100, y: 200 })
    );
  });
});
```

---

## 5. MOCK STRATEGIES

### 5.1 The Supabase Mock (Universal)

Every test file starts with:
```typescript
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}));
```

For tests that need the query builder chain:
```typescript
const chainable = () => {
  const obj: any = {
    select: vi.fn().mockReturnValue(obj),
    insert: vi.fn().mockReturnValue(obj),
    update: vi.fn().mockReturnValue(obj),
    delete: vi.fn().mockReturnValue(obj),
    eq: vi.fn().mockReturnValue(obj),
    order: vi.fn().mockReturnValue(obj),
    limit: vi.fn().mockReturnValue(obj),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: vi.fn((resolve) => resolve({ data: [], error: null })),
  };
  return obj;
};
```

### 5.2 Auth Mocks

```typescript
// Clerk auth
vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: { id: 'test-user', firstName: 'Test' }, isSignedIn: true }),
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue('mock-token') }),
}));

// Also mock the shared package (some hooks import from here)
vi.mock('@clerk/shared/react', () => ({
  useUser: () => ({ user: { id: 'test-user' } }),
}));
```

### 5.3 Router Mocks

```typescript
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/', search: '', hash: '' }),
  useParams: () => ({}),
}));
```

### 5.4 Browser API Mocks

Already provided by `setup.ts`:
- `localStorage` / `sessionStorage`
- `matchMedia`
- `ResizeObserver` / `IntersectionObserver`
- `requestAnimationFrame`
- `URL.createObjectURL`

Add per-file as needed:
```typescript
// AudioContext
globalThis.AudioContext = vi.fn(() => ({
  createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
  createAnalyser: vi.fn(() => ({ connect: vi.fn(), fftSize: 0 })),
  destination: {},
}));

// Canvas
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  drawImage: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
}));
```

### 5.5 Type-Only Module Mocks

For modules that only export types (no runtime code):
```typescript
vi.mock('@/types/qa', () => ({}));
vi.mock('@/types/acme-story-episode', () => ({}));
```

---

## 6. DOMAIN COVERAGE MAP

### Acme Studio Reference Implementation

| Domain | Files | Tested | Tests | Suite Files |
|--------|-------|--------|-------|-------------|
| **Settings UI** | 3 | 3 | 15 | 08 |
| **Analytics** | 7 | 7 | 29 | 09, 10 |
| **Comic features** | 5 | 5 | 25 | 11 |
| **UX hooks** | 4 | 4 | 20 | 12 |
| **Generation hooks** | 4 | 4 | 30 | 13 |
| **Guard hooks** | 2 | 2 | 12 | 14 |
| **Community/QA** | 4 | 4 | 14 | 15 |
| **Utilities** | 4 | 4 | 14 | 16 |
| **Offline/PWA** | 2 | 2 | 10 | 17 |
| **Edge throttle** | 1 | 1 | 22 | 18 |
| **Error pipeline** | 1 | 1 | 40 | 19 |
| **Action state store** | 1 | 1 | 17 | 20 |
| **Compressed storage** | 1 | 1 | 24 | 21 |
| **User tier** | 1 | 1 | 13 | 22 |
| **Utility hooks** | 3 | 3 | 18 | 23 |
| **Sleep timer** | 1 | 1 | 12 | 24 |
| **Gen tier config** | 1 | 1 | 19 | 25 |
| **Notification ctx** | 1 | 1 | 10 | 26 |
| **Global player** | 1 | 1 | 20 | 27 |
| **Streaming gen** | 1 | 1 | 30 | 28 |
| **Generation queue** | 1 | 1 | 26 | 29 |
| **Security utils** | 1 | 1 | 55 | 30 |
| **Error reporting** | 3 | 3 | 19 | 31 |
| **Error infra deep** | 4 | 4 | 42 | 32 |
| **Crash recovery** | 3 | 3 | 27 | 33 |
| **Zustand core** | 4 | 4 | 56 | 34 |
| **Zustand complex** | 3 | 3 | 39 | 35 |
| **Touch gestures** | 5 | 5 | 37 | 36 |
| **Keyboard nav** | 3 | 3 | 48 | 37 |
| **Data hooks** | 6 | 6 | 35 | 38 |
| **TTS parser** | 1 | 1 | 57 | 39 |
| **Logger/rate limit** | 3 | 3 | 45 | 40 |
| **Lib core** | 4 | 4 | 37 | 41 |
| **Services** | 3 | 3 | 35 | 42 |
| **Contexts** | 5 | 5 | 41 | 43 |
| **Audio utils** | 6 | 6 | 50 | 44 |
| **Perf/image utils** | 3 | 3 | 51 | 45 |
| **Backend E2E** | 8 | 8 | ~117 | 01-08 |
| **TOTAL** | **~130** | **~130** | **~1,213** | **46 suites** |

---

## 7. COST MODEL

### 7.1 Time Investment

| Activity | Hours | Notes |
|----------|-------|-------|
| Initial 26 suites (541 tests) | ~8h | Bulk coverage of wired features |
| Error reporting deep dive (88 tests) | ~2h | 4-layer [SSI](../docs/GLOSSARY.md#ssi) architecture |
| Domain expansion (12 files, 555 tests) | ~4h | Stores, hooks, utils, services, contexts |
| Test infrastructure (setup, config, runner) | ~1h | One-time investment |
| STF-v1 documentation | ~1h | This document |
| **Total** | **~16h** | **1,096 frontend + ~117 backend** |

### 7.2 Cost Per Test

- **Average**: ~0.9 min/test (including infrastructure setup)
- **Pure logic tests**: ~0.3 min/test (fast, no mocking overhead)
- **Hook tests**: ~0.8 min/test (renderHook setup, act wrapping)
- **Store tests**: ~0.5 min/test (state machine, reset modules)
- **Service tests**: ~1.2 min/test (mock chains, error paths)
- **E2E tests**: ~5 min/test (real endpoints, network, retry logic)

### 7.3 Execution Cost

```
38 frontend suites: ~18 seconds (parallel Vitest)
8 backend suites:   ~45 seconds (sequential Deno)
Total wall time:    ~63 seconds
```

### 7.4 Maintenance Cost

- **Per feature addition**: 1-3 new tests (~15 min)
- **Per refactor**: Update mocks in affected test files (~30 min)
- **Per dependency upgrade**: Usually zero changes (mocks are stable)

---

## 8. APPLYING STF TO A NEW PROJECT

### Step 1: Bootstrap (30 min)

```bash
mkdir -p 0000testing/frontend
# Copy vitest.config.ts and setup.ts from reference
# Update path alias to match your project structure
```

### Step 2: Audit Your Codebase (1h)

Count files by category:
```bash
find apps/web/src/hooks -name "*.ts" | wc -l    # Hooks
find apps/web/src/stores -name "*.ts" | wc -l   # Stores
find apps/web/src/utils -name "*.ts" | wc -l    # Utils
find apps/web/src/lib -name "*.ts" | wc -l      # Lib
find apps/web/src/services -name "*.ts" | wc -l # Services
find apps/web/src/contexts -name "*.tsx" | wc -l # Contexts
```

### Step 3: Prioritize by ROI

1. **Pure utility functions** (highest ROI: fast to write, high confidence)
2. **Zustand/Redux stores** (state machine testing, no render needed)
3. **Services** (business logic, mock the DB client)
4. **Hooks** (renderHook pattern, moderate setup)
5. **Contexts** (provider/consumer contracts)
6. **Components** (smoke tests only -- render + assert visible text)
7. **Pages** (integration tests, highest setup cost)

### Step 4: Write in Batches by Domain

Group related modules into a single test file:
- All settings hooks → `08-settings-ui.test.tsx`
- All audio utils → `44-audio-utils.test.ts`
- All touch hooks → `36-touch-gesture-hooks.test.ts`

### Step 5: Add Runner Script

```bash
#!/bin/bash
set -euo pipefail
npx vitest run --config 0000testing/frontend/vitest.config.ts
```

### Step 6: CI Integration

```yaml
# GitHub Actions
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - run: pnpm install
    - run: npx vitest run --config 0000testing/frontend/vitest.config.ts
```

---

## 9. ANTI-PATTERNS TO AVOID

1. **Snapshot testing** -- Brittle, noisy diffs, doesn't catch logic bugs
2. **Testing implementation details** -- Don't assert on internal state names
3. **Mocking everything** -- Only mock system boundaries, not sibling modules
4. **Testing getters that just return state** -- Trivial, no value
5. **One test per function** -- Group related assertions to reduce boilerplate
6. **Ignoring flaky tests** -- Fix or delete. Never `skip`.
7. **Testing CSS** -- Visual testing tools exist for this; unit tests are wrong tool
8. **Testing third-party libraries** -- Trust Chakra/React/Zustand to work

---

## 10. THE HONEST TRUTH

### What this framework guarantees:
- Every critical **business logic path** has a test
- Every **state machine** (stores) transitions correctly
- Every **parser** handles valid, invalid, and edge inputs
- Every **hook** returns the right shape and responds to inputs
- Every **service** calls the right API with the right payload
- Every **error path** (retry, rate limit, crash recovery) is verified

### What this framework does NOT guarantee:
- Visual correctness (need Storybook/Chromatic for that)
- End-to-end user flows through the real UI (need Playwright/Cypress)
- Performance under load (need k6/Artillery)
- Accessibility compliance (need axe-core integration)
- Database migration correctness (need separate DB test suite)

### The Sweetspot:
**STF gives you ~80% confidence at ~20% of the cost of "100% coverage".**

The remaining 20% confidence comes from:
- Manual QA for visual/UX
- E2E tests for critical user paths (login → generate → download)
- Production monitoring (error tracking, performance metrics)

---

## APPENDIX A: Complete Test File Index

| # | File | Tests | Domain |
|---|------|-------|--------|
| 01 | tier-config.test.ts | ~15 | Tier configuration (Deno) |
| 02 | suno-enqueue.test.ts | ~18 | Suno enqueue E2E (Deno) |
| 03 | sonauto-enqueue.test.ts | ~12 | Sonauto enqueue E2E (Deno) |
| 04 | processor.test.ts | ~20 | Generation processor E2E (Deno) |
| 05 | pipeline-e2e.test.ts | ~15 | Full pipeline E2E (Deno) |
| 06 | heartmula.test.ts | ~12 | HeartMuLa queue E2E (Deno) |
| 07 | gpu-credits-security.test.ts | ~10 | GPU credits security (Deno) |
| 08 | roadmap-e2e.test.ts | ~15 | Roadmap page E2E (Deno) |
| 08 | settings-ui.test.tsx | 15 | DensitySetting, FontSizeSlider, LocaleSwitcher |
| 09 | analytics-components.test.tsx | 20 | StatsCard, GrowthChart, Heatmap, LiveCount |
| 10 | analytics-services.test.ts | 9 | Export CSV/JSON, milestones |
| 11 | comic-features.test.ts | 25 | ReadTracking, OGMeta, Recommendations, ScrollRestore |
| 12 | ux-hooks.test.ts | 20 | ChunkedData, SwipeToDismiss, EditableState, AsyncOp |
| 13 | generation-hooks.test.ts | 30 | GenSummary, OpProgress, UploadProgress, Inspiration |
| 14 | guard-hooks.test.ts | 12 | ApiKeyGuard, ProjectTypeGuard |
| 15 | community-qa.test.ts | 14 | CommunityProvider, RatingNotification, QANotifs |
| 16 | utilities.test.ts | 14 | CodeSplitting, CardConfig, AudioAnalyze, ResponsiveImg |
| 17 | offline-pwa.test.tsx | 10 | OfflineDownload, ModelSourceBadge |
| 18 | edge-function-throttle.test.ts | 22 | Per-endpoint concurrency, 429 cooldown |
| 19 | error-pipeline.test.ts | 40 | Full error reporting pipeline |
| 20 | action-state-store.test.ts | 17 | Action lifecycle, batch progress, floater |
| 21 | compressed-storage.test.ts | 24 | LZ compression, retry, quota management |
| 22 | user-tier.test.ts | 13 | Tier detection, feature gates |
| 23 | utility-hooks.test.ts | 18 | Various utility hooks |
| 24 | sleep-timer.test.ts | 12 | Timer state machine |
| 25 | generation-tier-config.test.ts | 19 | Tier-based batch sizing |
| 26 | notification-context.test.ts | 10 | NotificationProvider |
| 27 | global-player.test.ts | 20 | Player state, queue, shuffle |
| 28 | streaming-generation.test.ts | 30 | SSE streaming, error recovery |
| 29 | generation-queue.test.ts | 26 | Queue stats, lifecycle |
| 30 | security-utils.test.ts | 55 | XSS sanitize, CSRF, input validation |
| 31 | error-reporting-service.test.ts | 19 | Manual/crash/gen reports, offline queue |
| 32 | error-infra-deep.test.ts | 42 | Breadcrumbs, PendingQueue, ContextCapture |
| 33 | crash-recovery-boundaries.test.ts | 27 | SSI overlay, ErrorBoundary, useBugReports |
| 34 | zustand-stores-core.test.ts | 56 | MusicProvider, ComicUndo, QA, Meditations |
| 35 | zustand-stores-complex.test.ts | 39 | ComicReader, Acme Story, RatingStore |
| 36 | touch-gesture-hooks.test.ts | 37 | LongPress, Swipe, PinchZoom, Momentum |
| 37 | keyboard-nav-hooks.test.ts | 48 | ListNav, ModalKeyboard, CardNav |
| 38 | data-hooks.test.ts | 35 | Debounce, RelativeTime, Visibility, Scroll |
| 39 | tts-markup-parser.test.ts | 57 | Parse, validate, escape, highlight, word/char count |
| 40 | logger-ratelimit.test.ts | 45 | Logger filtering, RateLimitError, retryQuery |
| 41 | lib-core.test.ts | 37 | TierAwareApi, ScalingConfig, PerfMonitor, CodeSplit |
| 42 | services-batch.test.ts | 35 | ActionStateService, CommunityNotifs, LoginNotifs |
| 43 | contexts.test.ts | 41 | Offline, Undo, CustomerView, Product, GlobalStats |
| 44 | audio-utils.test.ts | 50 | MasteringPresets, Converter, Helpers, Templates, Cache |
| 45 | performance-image.test.ts | 51 | PerfMonitor, ImageProcessing, BrowserAudioEnhance |

**Grand Total: 56 suites + 10 AI E2E flows, ~1,460 tests, 0 failures**

---

## 4.7 Component Integration Tests

**When**: Testing user interactions with rendered React components (clicks, typing, keyboard, form submission)
**Pattern**: `renderWithProviders()` + `userEvent` + screen assertions

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('ConfirmDialog', () => {
  it('clicking Confirm calls onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog isOpen={true} onClose={vi.fn()} onConfirm={onConfirm} />);
    await user.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Escape key closes dialog', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog isOpen={true} onClose={onClose} onConfirm={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

**Coverage target**: Every user interaction path, form validation, keyboard shortcuts, loading/disabled states

### 4.8 AI-Powered E2E Tests (Stagehand)

**When**: Multi-page user journeys, visual validation, cross-browser testing
**Pattern**: Stagehand `act()` / `extract()` / `agent()` with Zod schemas

```typescript
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

it('completes a full generation cycle', async () => {
  await stagehand.act('navigate to the Generate page');
  await stagehand.act('enter "My Test Song" as the title');
  await stagehand.act('select "Pop" as the style');
  await stagehand.act('click the Generate button');

  const { status } = await stagehand.extract(
    'the current generation status',
    z.object({ status: z.string() })
  );
  expect(['generating', 'queued', 'processing']).toContain(status.toLowerCase());
});
```

**Key advantage**: Self-healing — AI adapts when UI changes, no brittle CSS selectors

### 4.9 Self-Healing Test Pattern

Stagehand's `enableCaching: true` provides a three-stage lifecycle:
1. **First run**: AI identifies elements via LLM, records actions → stores in `.cache/`
2. **Subsequent runs**: Replays cached DOM paths → no LLM calls → fast + deterministic
3. **On UI change**: Cache miss → AI re-identifies → updates cache automatically

This means E2E tests are "write once, never maintain" — they adapt to UI refactors automatically.

### 4.10 Structured Extraction with Zod

Replace flaky `textContent()` checks with type-safe structured extraction:

```typescript
// ❌ Brittle
const text = await page.locator('.status-badge').textContent();
expect(text).toContain('completed');

// ✅ Self-healing + type-safe
const { status, trackCount } = await stagehand.extract(
  'the generation status and number of completed tracks',
  z.object({ status: z.string(), trackCount: z.number() })
);
expect(status).toBe('completed');
expect(trackCount).toBeGreaterThan(0);
```

---

## 11. E2E ARCHITECTURE (Stagehand + Browserbase)

### 11.1 Why AI-Native E2E

Traditional Playwright/Cypress tests break when class names change, elements move, or the UI redesigns. Stagehand solves this with natural language actions that use AI to locate elements.

### 11.2 Infrastructure Setup

```bash
pnpm add -D @browserbasehq/stagehand zod
```

Environment variables (`.env.test`):
```
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
ANTHROPIC_API_KEY=...
E2E_BASE_URL=http://localhost:5173
E2E_TEST_EMAIL=test@example.com
E2E_TEST_PASSWORD=testpassword
```

### 11.3 Flow Object Model (FOM)

Like Page Object Model but with natural language:

```typescript
class BaseFlow {
  async navigateTo(pageName: string) {
    await this.stagehand.act(`navigate to the ${pageName} page`);
  }
  async assertVisible(element: string) {
    const { visible } = await this.stagehand.extract(
      `is the ${element} visible on the page`,
      z.object({ visible: z.boolean() })
    );
    expect(visible).toBe(true);
  }
}
```

### 11.4 Auth Strategy

Uses Clerk test mode with dedicated test credentials. Auth flow class handles sign-in/sign-out.

### 11.5 CI Pipeline

- **BROWSERBASE env**: Cloud-hosted sessions for CI (headless)
- **LOCAL env**: Local Chromium for development
- Cache files committed to repo for deterministic re-runs

### 11.6 Cost Model

- LLM calls only on first run or UI changes
- Cached runs are free + fast
- ~$0.01-0.05 per uncached action (Claude Sonnet)

---

## 12. AUTONOMOUS TEST RUNNER

### 12.1 Runner Commands

```bash
./0000testing/run.sh frontend      # 46 Vitest suites
./0000testing/run.sh integration   # Component integration tests (files 46-53)
./0000testing/run.sh backend       # 8 Deno backend suites
./0000testing/run.sh e2e           # 10 Stagehand AI E2E flows
./0000testing/run.sh full          # ALL: unit + integration + backend + e2e
./0000testing/run.sh watch         # Watch mode: unit + integration
```

### 12.2 Layer-Aware Exit Codes

Each layer returns its own exit code for CI gating:
- Exit 0 = all tests passed
- Exit 1 = test failures
- CI can gate on specific layers (e.g., block deploy if backend fails)

### 12.3 Execution Times

| Layer | Suites | Tests | Time |
|-------|--------|-------|------|
| Unit (Vitest) | 38 | ~1,096 | ~18s |
| Integration (Vitest) | 8 | ~150 | ~8s |
| Backend E2E (Deno) | 8 | ~117 | ~45s |
| AI E2E (Stagehand) | 10 | ~100 | ~5min (cached) |
| **Total** | **64 + 10** | **~1,460** | **~6min** |

---

## APPENDIX B: Module Coverage by Layer

```
BROWSER E2E (AI-native)
  User Flows (10 specs)       ██████████  100% critical paths
  Visual Validation           ████████░░  AI-driven assertions

COMPONENT INTEGRATION
  Interactive Components      ████████░░  ~40% of components
  Form Flows                  ██████████  100% of forms

UI LOGIC (Unit)
  Hooks (243 files)           ████████░░  ~35% tested
  Contexts (30 files)         ████████░░  ~33% tested

STATE
  Zustand Stores (13 files)   ██████████  ~85% tested

BUSINESS LOGIC (Unit)
  Services (28 files)         ██████░░░░  ~39% tested
  Utils (23 files)            ████████░░  ~57% tested
  Lib (54 files)              ██████░░░░  ~26% tested

BACKEND
  Edge Functions (8 tested)   ██████████  100% E2E coverage
```

---

*STF-v1 -- The Sweetspot Testing Framework*
*Because the best test suite is the one that actually runs, passes, and catches bugs.*
