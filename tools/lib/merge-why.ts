/**
 * Agent-native merge synthesis. This module only prepares evidence and advice;
 * callers must leave the final integration decision to an arbiter.
 */

interface MergeWhyVerification {
  command?: string;
  status?: string;
  output_path?: string;
  notes?: string;
}

export interface MergeWhyEvent {
  timestamp: string;
  event_id?: string;
  kind?: string;
  session_id?: string;
  agent_id?: string;
  actor_id?: string;
  actor_kind?: string;
  model?: string;
  intent?: string;
  decision_rationale?: string;
  rejected_alternatives?: { alternative?: string; reason?: string }[];
  files_touched?: string[];
  lease_id?: string;
  commit?: string;
  verification?: MergeWhyVerification;
}

export interface MergeWhySideInput {
  label: 'A' | 'B';
  chain_id: string;
  agent_id?: string;
  session_id?: string;
  actor_kind?: string;
  model?: string;
  started_at: string;
  ended_at: string;
  events: MergeWhyEvent[];
}

export interface MergeWhyInput {
  schemaVersion: string;
  proposalId: string;
  project: string;
  brickId: string;
  generatedAt: string;
  sides: [MergeWhySideInput, MergeWhySideInput];
}

interface SideEvidence {
  event_ids: string[];
  event_kinds: string[];
  files_touched: string[];
  lease_ids: string[];
  commits: string[];
  verifications: (MergeWhyVerification & { event_id?: string })[];
  passing_verifications: number;
}

interface MergeWhySide {
  side: 'A' | 'B';
  chain_id: string;
  agent_id?: string;
  session_id?: string;
  actor_kind?: string;
  model?: string;
  started_at: string;
  ended_at: string;
  intents: string[];
  decision_rationales: string[];
  evidence: SideEvidence;
}

interface IntentRelation {
  side_a_intent: string;
  side_b_intent: string;
  reason: string;
  shared_terms: string[];
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'both', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'with', 'while',
]);

const OPPOSING_ACTIONS: readonly (readonly [string, string])[] = [
  ['add', 'remove'], ['allow', 'block'], ['enable', 'disable'], ['include', 'exclude'],
  ['increase', 'decrease'], ['keep', 'replace'], ['merge', 'split'], ['preserve', 'delete'],
  ['retain', 'drop'], ['accept', 'reject'],
];

export function buildMergeWhyProposal(input: MergeWhyInput) {
  const sides = input.sides.map(summarizeSide) as [MergeWhySide, MergeWhySide];
  const intentAnalysis = analyzeIntentRelations(input.sides[0], input.sides[1], sides[0], sides[1]);
  const ordered = orderSides(sides);

  return {
    schema_version: input.schemaVersion,
    document_kind: 'agent_native_merge_synthesis',
    proposal_id: input.proposalId,
    project: input.project,
    brick_id: input.brickId,
    generated_at: input.generatedAt,
    decision_support_only: true,
    auto_merge: false,
    arbiter_decision_required: true,
    sides,
    intent_analysis: intentAnalysis,
    recommended_integration_order: [
      {
        step: 1,
        side: ordered[0].side,
        chain_id: ordered[0].chain_id,
        action: 'Establish the better-evidenced chain as the integration baseline.',
        reason: orderReason(ordered[0], ordered[1]),
      },
      {
        step: 2,
        side: ordered[1].side,
        chain_id: ordered[1].chain_id,
        action: 'Replay the other chain deliberately, preserving compatible intent and evidence.',
        reason: 'Apply merely overlapping goals after the baseline so the arbiter can isolate semantic conflicts.',
      },
      {
        step: 3,
        side: 'arbiter',
        chain_id: 'manual',
        action: 'Resolve every listed intent conflict and rerun both sides\' verification evidence.',
        reason: 'This proposal is decision-support and never authorizes an automatic merge.',
      },
    ],
    arbiter_notes: [
      'An empty conflicts list means the recorded intent evidence shows overlap, not agreement.',
      'Verification counts rank integration order only; they do not select a winning implementation.',
      'The arbiter must inspect the actual diff before integrating either side.',
    ],
  };
}

export type MergeWhyProposal = ReturnType<typeof buildMergeWhyProposal>;

export function renderMergeWhyMarkdown(proposal: MergeWhyProposal) {
  const lines = [
    `# Merge synthesis: ${proposal.brick_id}`,
    '',
    `Proposal: \`${proposal.proposal_id}\`  `,
    `Project: \`${proposal.project}\`  `,
    `Generated: ${proposal.generated_at}  `,
    '**Decision support only. This document never auto-merges.**',
    '',
    '## What each side wanted',
  ];

  for (const side of proposal.sides) appendSideIntent(lines, side);
  appendIntentRelations(lines, 'Intent conflicts', proposal.intent_analysis.conflicts, 'None proven by the recorded intent evidence.');
  appendIntentRelations(lines, 'Mere overlap', proposal.intent_analysis.overlaps, 'None identified.');

  lines.push('', '## Recommended integration order');
  for (const step of proposal.recommended_integration_order) {
    lines.push(`${String(step.step)}. **${step.side}** — ${step.action} ${step.reason}`);
  }

  lines.push('', '## Evidence carried by each side');
  for (const side of proposal.sides) appendSideEvidence(lines, side);

  lines.push('', '## Arbiter guardrails');
  for (const note of proposal.arbiter_notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

function appendSideIntent(lines: string[], side: MergeWhySide) {
  lines.push('', `### Side ${side.side} — ${side.agent_id ?? side.chain_id}`);
  for (const intent of side.intents) lines.push(`- Intent: ${intent}`);
  if (!side.intents.length) lines.push('- Intent: not recorded');
  for (const rationale of side.decision_rationales) lines.push(`- Rationale: ${rationale}`);
  if (!side.decision_rationales.length) lines.push('- Rationale: not recorded');
}

function appendIntentRelations(lines: string[], title: string, relations: IntentRelation[], emptyMessage: string) {
  lines.push('', `## ${title}`);
  if (!relations.length) lines.push(`- ${emptyMessage}`);
  for (const relation of relations) {
    lines.push(`- **A:** ${relation.side_a_intent}`, `  **B:** ${relation.side_b_intent}`, `  **Why:** ${relation.reason}`);
  }
}

function appendSideEvidence(lines: string[], side: MergeWhySide) {
  lines.push('', `### Side ${side.side}`,
    `- Passing verifications: ${String(side.evidence.passing_verifications)}`,
    `- Verification records: ${String(side.evidence.verifications.length)}`,
    `- Event kinds: ${side.evidence.event_kinds.join(', ') || 'none recorded'}`,
    `- Files: ${side.evidence.files_touched.join(', ') || 'none recorded'}`,
    `- Commits: ${side.evidence.commits.join(', ') || 'none recorded'}`);
  for (const verification of side.evidence.verifications) {
    lines.push(`  - [${verification.status ?? 'unknown'}] ${verification.command ?? verification.event_id ?? 'verification evidence'}`);
  }
}

export function runMergeWhySelftest() {
  const sideAIntent = 'Keep the legacy resolver and add intent annotations.';
  const sideBIntent = 'Replace the legacy resolver with an intent-first synthesizer.';
  const proposal = buildMergeWhyProposal({
    schemaVersion: '1.0.0',
    proposalId: 'mp-selftest',
    project: 'synthetic',
    brickId: 'contested-resolver',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sides: [
      {
        label: 'A', chain_id: 'chain-A-agent-one', agent_id: 'agent-one',
        started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z',
        events: [{ timestamp: '2026-01-01T00:00:00.000Z', event_id: 'a1', kind: 'edit_planned',
          intent: sideAIntent, decision_rationale: 'Minimize compatibility risk.', files_touched: ['resolver.ts'],
          verification: { command: 'test legacy', status: 'pass' } }],
      },
      {
        label: 'B', chain_id: 'chain-B-agent-two', agent_id: 'agent-two',
        started_at: '2026-01-01T00:00:30.000Z', ended_at: '2026-01-01T00:02:00.000Z',
        events: [{ timestamp: '2026-01-01T00:00:30.000Z', event_id: 'b1', kind: 'decision_recorded',
          intent: sideBIntent, decision_rationale: 'Make synthesis the primary abstraction.', files_touched: ['resolver.ts'] }],
      },
    ],
  });
  const markdown = renderMergeWhyMarkdown(proposal);
  assertSelftest(markdown.includes(sideAIntent) && markdown.includes(sideBIntent), 'proposal must name both intents');
  assertSelftest(proposal.intent_analysis.conflicts.length === 1, 'opposing resolver intents must be classified as conflict');
  assertSelftest(proposal.decision_support_only && !proposal.auto_merge, 'proposal must never authorize auto-merge');
  assertSelftest(proposal.sides.every((side) => side.decision_rationales.length === 1), 'both rationales must be retained');
  console.log('sma-merge --from-intents selftest: ok');
}

function summarizeSide(input: MergeWhySideInput): MergeWhySide {
  const verifications = input.events.flatMap((event) => event.verification
    ? [{ ...event.verification, ...(event.event_id ? { event_id: event.event_id } : {}) }]
    : []);
  return {
    side: input.label,
    chain_id: input.chain_id,
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.actor_kind ? { actor_kind: input.actor_kind } : {}),
    ...(input.model ? { model: input.model } : {}),
    started_at: input.started_at,
    ended_at: input.ended_at,
    intents: uniqueStrings(input.events.map((event) => event.intent)),
    decision_rationales: uniqueStrings(input.events.map((event) => event.decision_rationale)),
    evidence: {
      event_ids: uniqueStrings(input.events.map((event) => event.event_id)),
      event_kinds: uniqueStrings(input.events.map((event) => event.kind)),
      files_touched: uniqueStrings(input.events.flatMap((event) => event.files_touched ?? [])),
      lease_ids: uniqueStrings(input.events.map((event) => event.lease_id)),
      commits: uniqueStrings(input.events.map((event) => event.commit)),
      verifications,
      passing_verifications: verifications.filter((verification) => verification.status === 'pass').length,
    },
  };
}

function analyzeIntentRelations(sideAInput: MergeWhySideInput, sideBInput: MergeWhySideInput, sideA: MergeWhySide, sideB: MergeWhySide) {
  const conflicts: IntentRelation[] = [];
  const overlaps: IntentRelation[] = [];
  for (const intentA of sideA.intents) {
    for (const intentB of sideB.intents) {
      const termsA = meaningfulTerms(intentA);
      const termsB = meaningfulTerms(intentB);
      const sharedTerms = [...termsA].filter((term) => termsB.has(term)).sort();
      const opposition = opposingAction(intentA, intentB);
      const rejection = rejectedBy(sideAInput.events, intentB) || rejectedBy(sideBInput.events, intentA);
      if ((opposition && sharedTerms.length > 0) || rejection) {
        conflicts.push({
          side_a_intent: intentA,
          side_b_intent: intentB,
          reason: rejection
            ? 'One side recorded the other direction as a rejected alternative.'
            : `The intents share ${sharedTerms.join(', ')} but use opposing actions (${(opposition ?? []).join(' vs ')}).`,
          shared_terms: sharedTerms,
        });
      } else {
        overlaps.push({
          side_a_intent: intentA,
          side_b_intent: intentB,
          reason: sharedTerms.length
            ? `The intents share ${sharedTerms.join(', ')} without a recorded semantic contradiction.`
            : 'The intents target the same contested brick without a recorded semantic contradiction.',
          shared_terms: sharedTerms,
        });
      }
    }
  }
  return { conflicts, overlaps };
}

function rejectedBy(events: MergeWhyEvent[], otherIntent: string) {
  const otherTerms = meaningfulTerms(otherIntent);
  return events.some((event) => (event.rejected_alternatives ?? []).some((rejected) => {
    const shared = [...meaningfulTerms(rejected.alternative ?? '')].filter((term) => otherTerms.has(term));
    return shared.length >= 2;
  }));
}

function opposingAction(left: string, right: string): readonly [string, string] | undefined {
  const leftTerms = meaningfulTerms(left);
  const rightTerms = meaningfulTerms(right);
  return OPPOSING_ACTIONS.find(([a, b]) => (leftTerms.has(a) && rightTerms.has(b)) || (leftTerms.has(b) && rightTerms.has(a)));
}

function meaningfulTerms(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 2 && !STOP_WORDS.has(term)) ?? []);
}

function uniqueStrings(values: (string | undefined)[]) {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function orderSides(sides: [MergeWhySide, MergeWhySide]) {
  return sides.slice().sort((left, right) => {
    const passing = right.evidence.passing_verifications - left.evidence.passing_verifications;
    if (passing !== 0) return passing;
    const evidence = right.evidence.verifications.length - left.evidence.verifications.length;
    if (evidence !== 0) return evidence;
    return Date.parse(left.started_at) - Date.parse(right.started_at);
  });
}

function orderReason(first: MergeWhySide, second: MergeWhySide) {
  if (first.evidence.passing_verifications !== second.evidence.passing_verifications) {
    return `Side ${first.side} carries ${String(first.evidence.passing_verifications)} passing verification(s) vs ${String(second.evidence.passing_verifications)}.`;
  }
  if (first.evidence.verifications.length !== second.evidence.verifications.length) {
    return `Side ${first.side} carries more recorded verification evidence.`;
  }
  return `Evidence is tied, so the earlier chain (${first.side}) is the safer chronological baseline.`;
}

function assertSelftest(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`merge-why selftest failed: ${message}`);
}
