# P10 — SRS Integration & Observability

## Overview

Ensure every new intelligence service is fully instrumented with SRS. Every error path, every degradation, every fallback reports through the existing SRS infrastructure.

## Compliance

- **DO NOT add LaunchDarkly, Highlight.io, Sentry, or any external error monitoring — use SRS**
- All observability routes through `observabilityService.ts` facade
- PHI/PII sanitized before any SRS reporting

## Tasks (38)

### Breadcrumb Coverage (12 tasks)

- [ ] P10-001: Add breadcrumbs to confidenceRouter: provider-selected, provider-switch, exploration-triggered
- [ ] P10-002: Add breadcrumbs to segmentClassifier: segment-classified (sampled 10%), entity-extracted
- [ ] P10-003: Add breadcrumbs to vocabularyLearner: correction-logged, word-promoted, word-rejected
- [ ] P10-004: Add breadcrumbs to providerBenchmarker: metric-recorded, anomaly-detected, regression-detected
- [ ] P10-005: Add breadcrumbs to campaignManager: campaign-created, session-linked, campaign-completed
- [ ] P10-006: Add breadcrumbs to costOptimizer: budget-warning, provider-downgraded, budget-exceeded
- [ ] P10-007: Add breadcrumbs to consensusEngine: consensus-started, provider-disagreement, merged
- [ ] P10-008: Add breadcrumbs to synthesisEngine: summary-generated, report-created
- [ ] P10-009: Add breadcrumbs to providerScout: evaluation-started, evaluation-completed
- [ ] P10-010: All breadcrumbs use `observabilityService.addBreadcrumb()` — never raw SRS
- [ ] P10-011: Breadcrumb data never contains PHI/PII (run through srsPrivacy filter)
- [ ] P10-012: Breadcrumb rate: max 100/session to prevent flooding

### Error Capture (10 tasks)

- [ ] P10-013: Every `catch` block in intelligence services calls `observabilityService.captureError()`
- [ ] P10-014: Error context includes: service name, operation, provider (if applicable)
- [ ] P10-015: Classification errors: severity `warning` (non-critical feature)
- [ ] P10-016: Consensus errors: severity `warning` (fallback to single provider)
- [ ] P10-017: Cost tracking errors: severity `info` (data loss, not functionality loss)
- [ ] P10-018: Provider routing errors: severity `critical` (affects core transcription)
- [ ] P10-019: Vocabulary sync errors: severity `warning` (local data still works)
- [ ] P10-020: Synthesis errors: severity `info` (nice-to-have feature)
- [ ] P10-021: Edge Function errors: captured with request context (action, payload size)
- [ ] P10-022: Rate-limit SRS reporting from intelligence layer: max 30 errors/minute

### Deterministic Error Codenames (4 tasks)

- [ ] P10-023: Add intelligence-specific adjectives to srsCodenames: "COGNITIVE", "ANALYTICAL", "NEURAL", "ADAPTIVE", "PREDICTIVE"
- [ ] P10-024: Add intelligence-specific nouns: "ROUTER", "CLASSIFIER", "BENCHMARKER", "OPTIMIZER", "CONSENSUS"
- [ ] P10-025: Ensure new codenames don't collide with existing ~2500 combinations
- [ ] P10-026: Test codename generation for all new error fingerprints

### Health Monitoring (6 tasks)

- [ ] P10-027: Add intelligence layer health check to app startup diagnostics
- [ ] P10-028: Health check verifies: DB connectivity, metric cache, dictionary loaded
- [ ] P10-029: Report intelligence layer status in app status bar (if enabled)
- [ ] P10-030: Track intelligence layer latency overhead (should be <10ms total)
- [ ] P10-031: Alert if intelligence layer adds >50ms latency (regression detection)
- [ ] P10-032: Implement circuit breaker: disable intelligence layer if it causes 3+ errors in 5 minutes

### Privacy Compliance (6 tasks)

- [ ] P10-033: All transcription text in SRS reports sanitized through srsPrivacy
- [ ] P10-034: Provider metrics never contain transcription content (only aggregate numbers)
- [ ] P10-035: Vocabulary entries sanitized: PHI words blocked from learning (existing check)
- [ ] P10-036: Consensus results: individual provider outputs never logged (only agreement scores)
- [ ] P10-037: Campaign titles sanitized (user may include patient names)
- [ ] P10-038: Synthesis summaries: action items sanitized before SRS (may contain PHI)

## Acceptance Criteria

- [ ] 100% catch block coverage in all intelligence services
- [ ] Breadcrumbs fire for all key operations
- [ ] No PHI/PII in any SRS report
- [ ] Circuit breaker disables intelligence on repeated failures
- [ ] Intelligence layer overhead < 10ms
- [ ] All SRS calls use observabilityService facade
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass
