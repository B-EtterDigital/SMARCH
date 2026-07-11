# [SMOA](../GLOSSARY.md#smoa) module tour

This tour explains Codex integration, workforce routing, and token accounting for multi-agent execution. Orchestrators and workforce maintainers need it before changing dispatch or runner behavior. Read it when a task touches SMOA packets, model execution, review routing, or delivery accounting. Remember that the orchestrator owns strategy and proof while workers stay inside explicit packets.

## Purpose

The SMOA module provides the workforce-backend abstraction used for bounded Codex execution. It may depend on schemas and the registry.

## Owned files

- `tools/sma-codex*.mjs`
- `tools/lib/codex-runner.ts`
- `tools/lib/workforce/**`
- `tools/sma-smoa-token-summary.ts`

## Gates

Run workforce and Codex runner self-tests, a packet validation smoke, the source-size gate, and the strict module Graphify summary. Delivery paths must also produce the required token summary.

## How to work here

Keep provider details behind the workforce interface and reject malformed or overbroad packets. Workers do not change control-plane state, commit, or choose missing architecture.
