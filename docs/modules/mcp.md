# MCP module tour

This tour explains the server that exposes registry, store, and provenance capabilities to external clients. Server maintainers and integration authors need it before changing a tool contract or Server Card. Read it when a task touches MCP transport, validation, or published operations. Remember that every exposed operation must preserve the same authorization and evidence rules as the underlying command.

## Purpose

The MCP module wraps registry and provenance capabilities in a stable server interface. It may depend on schemas, registry, and provenance.

## Owned files

- `tools/mcp/**`

## Ownership and lane

`sma.gen3.json` maps `tools/mcp/**` to `mcp`; the default lane is `single-module` and the required local gate is `node tools/mcp/selftest.mjs`. Registry, provenance, release, schema, workflow, and `.UltraVision/` changes are outside this module even when an MCP tool exposes them.

The module graph lives at `graphify-out/modules/mcp/graphify-out/graph.json`. Query it with `npm run graphify:query -- --project sma --module mcp -- "How are MCP tools loaded, validated, and routed to registry or provenance operations?"` before broad reads.

## Gates

Run `node tools/mcp/selftest.mjs` and a local client smoke against `npm run mcp:serve`, then run the source-size gate and strict module Graphify summary. Validate error responses as well as successful tool calls.

The performance plan budgets search, trust, and doctor tool responses below 500 ms on the named baseline; `npm run evals:bench` is the measuring command. The current GitHub workflow does not dispatch the MCP self-test or benchmark by affected path, so the registered local gate is not evidence of affected-CI wiring.

## How to work here

Keep transport code thin and call module APIs instead of duplicating registry logic. Version contract changes and avoid logging secrets or full sensitive payloads.

Return real protocol errors with tool name, error code, severity, and safe request context. Expected fixture fallback may be documented, but transport, parse, and downstream operation failures must not disappear into empty catches or ignored promises.
