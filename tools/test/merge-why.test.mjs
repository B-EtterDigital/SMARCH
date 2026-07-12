import assert from "node:assert/strict";
import test from "node:test";

import { buildMergeWhyProposal, renderMergeWhyMarkdown } from "../lib/merge-why.ts";

/** @typedef {import("../lib/merge-why.ts").MergeWhyEvent} MergeWhyEvent */

/** @param {MergeWhyEvent[]} eventsA @param {MergeWhyEvent[]} eventsB @returns {import("../lib/merge-why.ts").MergeWhyInput} */
function input(eventsA, eventsB) {
  return {
    schemaVersion: "1.0.0",
    proposalId: "proposal-test",
    project: "sma",
    brickId: "resolver",
    generatedAt: "2026-01-03T00:00:00Z",
    sides: [
      {
        label: "A",
        chain_id: "chain-a",
        agent_id: "agent-a",
        started_at: "2026-01-03T00:00:00Z",
        ended_at: "2026-01-03T00:05:00Z",
        events: eventsA,
      },
      {
        label: "B",
        chain_id: "chain-b",
        agent_id: "agent-b",
        started_at: "2026-01-03T00:01:00Z",
        ended_at: "2026-01-03T00:06:00Z",
        events: eventsB,
      },
    ],
  };
}

test("merge-why synthesizes conflict evidence and orders the better-proven chain first", () => {
  const proposal = buildMergeWhyProposal(input(
    [{
      timestamp: "2026-01-03T00:00:00Z",
      event_id: "event-a",
      kind: "decision_recorded",
      intent: "Keep the legacy resolver and add intent annotations.",
      decision_rationale: "Preserve compatibility.",
      files_touched: ["resolver.ts"],
      commit: "aaaa",
      verification: { command: "node --test legacy", status: "pass" },
    }],
    [{
      timestamp: "2026-01-03T00:01:00Z",
      event_id: "event-b1",
      kind: "edit_applied",
      intent: "Replace the legacy resolver with an intent-first resolver.",
      decision_rationale: "Make intent the primary abstraction.",
      files_touched: ["resolver.ts"],
      commit: "bbbb",
      verification: { command: "node --test intent", status: "pass" },
    }, {
      timestamp: "2026-01-03T00:02:00Z",
      event_id: "event-b2",
      kind: "verification_recorded",
      verification: { command: "npx tsc --noEmit", status: "pass" },
    }],
  ));

  assert.equal(proposal.intent_analysis.conflicts.length, 1);
  assert.match(proposal.intent_analysis.conflicts[0].reason, /opposing actions/);
  assert.equal(proposal.recommended_integration_order[0].side, "B");
  assert.equal(proposal.sides[1].evidence.passing_verifications, 2);
  assert.equal(proposal.decision_support_only, true);
  assert.equal(proposal.auto_merge, false);
  assert.equal(proposal.arbiter_decision_required, true);
  const markdown = renderMergeWhyMarkdown(proposal);
  assert.match(markdown, /Keep the legacy resolver/);
  assert.match(markdown, /Replace the legacy resolver/);
  assert.match(markdown, /Decision support only/);
});

test("merge-why keeps missing pre-Gen3 intent honest and never infers agreement", () => {
  const proposal = buildMergeWhyProposal(input([], [{
    timestamp: "2026-01-03T00:01:00Z",
    kind: "legacy_import",
    files_touched: ["resolver.ts"],
  }]));
  const markdown = renderMergeWhyMarkdown(proposal);

  assert.deepEqual(proposal.sides.map((side) => side.intents), [[], []]);
  assert.deepEqual(proposal.intent_analysis, { conflicts: [], overlaps: [] });
  assert.match(markdown, /Intent: not recorded/);
  assert.match(markdown, /None proven by the recorded intent evidence/);
  assert.match(markdown, /never auto-merges/);
  assert.equal(proposal.recommended_integration_order[2].side, "arbiter");
});
