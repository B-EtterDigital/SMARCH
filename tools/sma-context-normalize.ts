#!/usr/bin/env node
/**
 * WHAT: Converts legacy agent-context proof lines into the current event shape.
 * WHY: Older writers produced valid evidence that newer validators cannot consume directly.
 * HOW: Reads one project's brick logs and rewrites only records that need normalization.
 * INPUTS: A project identifier, optional brick identifier, and optional dry-run mode.
 * OUTPUTS: Updated line-delimited event logs or a report of the changes it would make.
 * CALLERS: Context maintenance scripts and operators repairing historical proof records.
 * Usage: `node tools/sma-context-normalize.ts --project sma --dry-run`
 */
/**
 * Normalize legacy proof records in .smarch/agent-context/*.ndjson.
 *
 * Some older/parallel agents wrote proof objects with keys like ts/brick/status.
 * This keeps the evidence but rewrites those lines as valid Gen3 note events.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { env, exit } from 'node:process';
import { KINDS, projectRoot, replaceContextLogIfUnchanged, withContextLogLock } from './lib/context-log.ts';

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

interface CliArgs { brick?: string; dryRun?: boolean; help?: boolean; json?: boolean; project?: string }
interface NormalizeResult { changed_files: string[]; converted_lines: number; dry_run?: boolean; files_checked: number; malformed_lines?: number; ok: boolean; project: string }
interface Verification { command?: string; notes?: string; status?: string }
interface ContextRecord extends Record<string, unknown> { verification?: Verification }

const args = parseArgs(process.argv.slice(2));

try {
  if (args.help || !args.project) {
    usage();
    exit(args.help ? 0 : 2);
  }
  const result = normalizeProject(args.project);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  exit(result.ok ? 0 : 1);
} catch (err: unknown) {
  console.error(`sma-context-normalize: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-context-normalize.ts --project <id> [--brick <id>] [--dry-run] [--json]

Converts legacy proof records in .smarch/agent-context/*.ndjson into valid
Gen3 note events. Valid Gen3 events are left untouched.`);
}

function normalizeProject(projectId: string): NormalizeResult {
  const root = projectRoot(projectId);
  const dir = resolve(root, '.smarch/agent-context');
  if (!existsSync(dir)) {
    return { ok: true, project: projectId, changed_files: [], converted_lines: 0, files_checked: 0 };
  }

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson'))
    .filter((name) => !args.brick || name.replace(/\.ndjson$/, '') === safeBrick(args.brick))
    .sort();

  const changedFiles: string[] = [];
  let convertedLines = 0;
  let malformedLines = 0;

  for (const name of files) {
    const filePath = resolve(dir, name);
    const result = withContextLogLock(filePath, () => {
      const normalized = normalizeFile(filePath, projectId);
      if (normalized.changed && !args.dryRun) replaceContextLogIfUnchanged(filePath, normalized.source, normalized.output);
      return normalized;
    });
    malformedLines += result.malformed;
    convertedLines += result.converted;
    if (!result.changed) continue;
    changedFiles.push(filePath);
  }

  return {
    ok: malformedLines === 0,
    project: projectId,
    dry_run: Boolean(args.dryRun),
    files_checked: files.length,
    changed_files: changedFiles,
    converted_lines: convertedLines,
    malformed_lines: malformedLines,
  };
}

function normalizeFile(filePath: string, projectId: string): { changed: boolean; converted: number; malformed: number; output: string; source: string } {
  const source = readFileSync(filePath, 'utf8');
  const trailing = source.endsWith('\n');
  const out: string[] = [];
  let changed = false;
  let converted = 0;
  let malformed = 0;
  for (const line of source.split('\n')) {
    if (!line.trim()) {
      if (line || trailing) out.push(line);
      continue;
    }
    try {
      const normalized = normalizeLegacyProof(JSON.parse(line) as unknown, line, projectId);
      if (normalized) {
        out.push(JSON.stringify(normalized));
        converted += 1;
        changed = true;
      } else out.push(line);
    } catch {
      malformed += 1;
      out.push(line);
    }
  }
  return { changed, converted, malformed, output: out.join('\n'), source };
}

// eslint-disable-next-line complexity -- Compatibility normalization is an explicit schema precedence ladder documenting legacy-to-modern mapping.
function normalizeLegacyProof(record: unknown, rawLine: string, projectId: string): ContextRecord | null {
  if (!isRecord(record)) return null;
  const modernProof = normalizeModernProofRecord(record);
  if (modernProof) return modernProof;
  if (record.schema_version === '1.0.0' && record.event_id && record.brick_id) return null;
  if (!record.ts || !record.brick || !record.status) return null;

  const brick = legacyString(record.brick);
  const timestamp = isDateTime(record.ts) ? record.ts : new Date().toISOString();
  const proof = Array.isArray(record.proof) ? record.proof.filter(Boolean).map(String) : [];
  const files = Array.isArray(record.files) ? unique(record.files.map(String).filter(Boolean)) : [];
  const gain = record.gain ? ` ${legacyString(record.gain)}` : '';
  const boundary = record.boundary ? legacyString(record.boundary) : '';
  const status = legacyString(record.status).replace(/_/g, ' ');
  const hash = createHash('sha1').update(rawLine).digest('hex').slice(0, 8);

  const event: ContextRecord = {
    schema_version: '1.0.0',
    event_id: `ctx-${String(Date.parse(timestamp) || Date.now())}-${hash}`,
    brick_id: brick,
    project: legacyString(record.project ?? projectId),
    actor_kind: 'agent',
    actor_id: (env.SMA_AGENT ?? env.USER) ?? 'unknown',
    kind: 'note',
    intent: `Record ${brick} ${status || 'proof'}${gain}.`.replace(/\s+/g, ' ').trim(),
    timestamp,
  };

  const rationale = [
    gain ? `Gain: ${String(record.gain)}.` : '',
    boundary,
  ].filter(Boolean).join(' ');
  if (rationale) event.decision_rationale = rationale;
  if (files.length) event.files_touched = files;
  if (proof.length) {
    event.verification = {
      command: proof.join(' && '),
      status: verificationStatus(record.status),
    };
    if (proof.length > 1) event.verification.notes = `${String(proof.length)} proof commands preserved from legacy record.`;
  }

  return event;
}

// eslint-disable-next-line complexity -- Compatibility normalization is an explicit schema precedence ladder documenting legacy-to-modern mapping.
function normalizeModernProofRecord(record: unknown): ContextRecord | null {
  if (!isRecord(record)) return null;
  if (record.schema_version !== '1.0.0' || !record.event_id || !record.brick_id) return null;

  const proof = Array.isArray(record.proof) ? record.proof.filter(Boolean).map(String) : [];
  const invalidKind = typeof record.kind === 'string' && !KINDS.has(record.kind);
  const invalidGain = record.gain_percent !== undefined && typeof record.gain_percent !== 'number';
  const proofish = record.kind === 'verification'
    || proof.length > 0
    || Boolean(record.summary)
    || Boolean(record.proof_boundary);
  if (!proofish || (!invalidKind && !invalidGain)) return null;

  const event: ContextRecord = { ...record };
  if (invalidKind) {
    event.kind = proof.length ? 'proof_recorded' : 'note';
  }

  const gain = normalizeGainPercent(record.gain_percent);
  const rationale = [];
  if (gain === null) {
    delete event.gain_percent;
    if (record.gain_percent !== undefined) {
      rationale.push(`Legacy gain_percent preserved as ${JSON.stringify(record.gain_percent)}.`);
    }
  } else {
    event.gain_percent = gain;
    if (typeof record.gain_percent === 'object') {
      rationale.push(`Legacy gain range ${JSON.stringify(record.gain_percent)} normalized to ${String(gain)}.`);
    }
  }
  if (record.proof_boundary) rationale.push(legacyString(record.proof_boundary));
  if (record.summary) rationale.push(legacyString(record.summary));

  if (proof.length) {
    const existingVerification: Verification = isRecord(event.verification)
      ? event.verification
      : {};
    event.verification = {
      ...existingVerification,
      command: existingVerification.command ?? proof.join(' && '),
      status: verificationStatus((existingVerification.status ?? record.status) ?? 'pass'),
    };
    const notes = [
      existingVerification.notes,
      proof.length > 1 ? `${String(proof.length)} proof commands preserved from malformed proof event.` : '',
      rationale.join(' '),
    ].filter(Boolean).join(' ');
    if (notes) event.verification.notes = notes;
  } else if (rationale.length && !event.decision_rationale) {
    event.decision_rationale = rationale.join(' ');
  }

  return event;
}

function normalizeGainPercent(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isRecord(value)) {
    const direct = Number(value.value ?? value.percent ?? value.gain_percent);
    if (Number.isFinite(direct)) return direct;
    const from = Number(value.from);
    const to = Number(value.to);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return Number((to - from).toFixed(3));
    }
  }
  return null;
}

function verificationStatus(value: unknown): 'blocked' | 'fail' | 'pass' | 'skipped' {
  const normalized = legacyString(value ?? '').toLowerCase();
  if (normalized.includes('fail')) return 'fail';
  if (normalized.includes('block')) return 'blocked';
  if (normalized.includes('skip')) return 'skipped';
  return 'pass';
}

function safeBrick(value: unknown): string {
  return legacyString(value ?? '').replace(/[^a-z0-9._-]/gi, '_');
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && DATETIME_RE.test(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function printResult(result: NormalizeResult): void {
  console.log(`context normalize: ${result.project}`);
  console.log(`files checked: ${String(result.files_checked)}`);
  console.log(`converted lines: ${String(result.converted_lines)}`);
  if (result.malformed_lines) console.log(`malformed lines left: ${String(result.malformed_lines)}`);
  for (const file of result.changed_files) console.log(`changed: ${file}`);
  if (result.dry_run) console.log('dry-run: no files written');
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    const next = list[i + 1];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--project' && next) { out.project = next; i += 1; continue; }
    if (arg === '--brick' && next) { out.brick = next; i += 1; continue; }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function legacyString(value: unknown): string {
  return String(value);
}
