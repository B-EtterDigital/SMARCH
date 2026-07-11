# Workforce backends

This page explains which agent runners SMARCH can use today, which behavior is only planned, and what an orchestrator must prove before it delegates work. Use it when choosing an executor for a multi-agent run or diagnosing a dispatch failure.

## Current supported path

The supported [SMOA](GLOSSARY.md#smoa) execution workforce is the Codex CLI in headless mode. The orchestrating session owns planning, leases, acceptance criteria, gate selection, arbitration, and final claims. Codex executors receive bounded packets, edit only their assigned files, do not commit, and return evidence for review.

Current invariants:

- execution is opt-in through the literal SMOA trigger;
- the workforce is Codex-only and capped at 10 concurrent executors;
- every packet names its objective, acceptance criteria, owned files, forbidden surfaces, constraints, and evidence;
- shared hot paths stay serialized;
- an unreachable executor is a visible blocker, never a reason to invent a successful run;
- the orchestrator reviews every diff and runs the project gates.

The complete operating contract lives in [SMOA — Sweetspot MoA](SMOA_SWEETSPOT_MOA.md).

## Runner contract

A workforce runner is acceptable only when it can preserve this boundary:

| Concern | Runner must provide |
| --- | --- |
| Input | One explicit task packet, supplied without credentials or unrelated repository context |
| Isolation | A bounded file scope and a stable working directory or worktree |
| Output | Changed-file list, tests actually run, failures, and blockers |
| Failure | Non-zero or structured failure that the orchestrator can distinguish from success |
| Cancellation | A way to stop the executor without corrupting the shared checkout |
| Accounting | Invocation identity and token or cost evidence when the runner exposes it |

The packet shape is validated by [`schemas/workforce-packet-schema.json`](../schemas/workforce-packet-schema.json). A runner adapter may add transport metadata, but it must not weaken the packet.

## Codex CLI backend

The Codex backend launches a non-interactive executor in the repository or an isolated worktree. The orchestrator selects the model and effort, passes the packet, and captures the final structured response. Authentication is the operator's responsibility and must already work before fan-out.

Before a real dispatch, verify all of the following:

```bash
command -v codex
codex --version
```

Those checks prove only that the executable is reachable. A harmless nested smoke run is still required when authentication or model availability is in doubt. Never place tokens, session cookies, or provider credentials in a workforce packet or agent-context log.

## Planned backend abstraction

The UltraVision target includes a pluggable workforce-backend abstraction for runners such as OpenCode or a prompt-mode Claude CLI. That abstraction is not a supported public dispatch surface yet. Until an adapter implements the same packet, isolation, failure, evidence, and accounting contract—and has passing evaluations—do not describe it as available.

Adding a backend requires:

1. an adapter that consumes the workforce packet without changing its semantics;
2. deterministic unavailable, timeout, cancellation, and malformed-output failures;
3. fixture tests for packet transport and output parsing;
4. a seeded evaluation showing that required evidence survives the adapter;
5. documentation of authentication boundaries and local data exposure;
6. Gen3 and security gates passing before the backend is advertised.

## Failure handling

Stop the lane and report the exact blocker when the runner is missing, unauthenticated, unable to reach the requested model, or returns an unparseable result. Do not silently switch providers, lower effort, broaden file scope, or let the executor hold Gen3 control-plane leases.

When a worker times out, preserve its output as evidence, inspect the owned paths for partial edits, and let the orchestrator decide whether to retry, repair, or reject. A retry is a new invocation and needs its own identity in the final accounting.

## Security and privacy

Workforce packets should contain the minimum code and context needed for the task. Provider processing, retention, and residency are governed by the operator's provider agreement, not by SMARCH. See [Privacy, data protection, and residency](PRIVACY.md) for the repository boundary and [Security and swarm gates](SECURITY_AND_SWARM_GATES.md) for required evidence.

<!-- docs-i18n: key=docs.workforce-backends; source=en; media=media/{locale}/workforce-backends/ -->
