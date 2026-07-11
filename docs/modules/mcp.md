# MCP module tour

This tour explains the server that exposes registry, store, and provenance capabilities to external clients. Server maintainers and integration authors need it before changing a tool contract or Server Card. Read it when a task touches MCP transport, validation, or published operations. Remember that every exposed operation must preserve the same authorization and evidence rules as the underlying command.

## Purpose

The MCP module wraps registry and provenance capabilities in a stable server interface. It may depend on schemas, registry, and provenance.

## Owned files

- `tools/mcp/**`

## Gates

Run the MCP protocol self-tests and a local client smoke, then run the source-size gate and strict module Graphify summary. Validate error responses as well as successful tool calls.

## How to work here

Keep transport code thin and call module APIs instead of duplicating registry logic. Version contract changes and avoid logging secrets or full sensitive payloads.
