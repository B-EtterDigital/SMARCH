/**
 * WHAT: Joins line-level Git history with Gen3 intent records and evidence journals.
 * WHY: A byte-level blame cannot explain which agent acted, why it acted, or how the work was proven.
 * HOW: Groups `git blame` lines, reads each range with `git log -L`, follows renamed paths,
 * and correlates the last change with append-only context and evidence records.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const PRE_GEN3 = 'pre-Gen3 history';
const CONTEXT_TIME_WINDOW_MS = 2 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

export interface IntentBlameOptions {
  repoRoot: string;
  file: string;
  lines?: string;
}

interface ChangeRecord {
  commit: string;
  short_commit: string;
  timestamp: string;
  git_actor: string;
  summary: string;
}

interface EvidenceRecord {
  command: string;
  exit_code: number | string | null;
  source: string;
  timestamp?: string;
}

interface IntentBlameRange {
  line_range: string;
  start_line: number;
  end_line: number;
  last_change: ChangeRecord;
  actor: string;
  intent: string;
  decision_rationale: string;
  evidence: EvidenceRecord[];
  evidence_display: string;
  context_source: string | null;
  history: ChangeRecord[];
}

export interface IntentBlameResult {
  schema_version: '1.0.0';
  file: string;
  historical_paths: string[];
  line_filter: string | null;
  ranges: IntentBlameRange[];
}

interface BlamedLine {
  line: number;
  commit: string;
  timestamp: string;
  gitActor: string;
  summary: string;
}

interface BlameGroup extends Omit<BlamedLine, 'line'> {
  start: number;
  end: number;
}

interface LocatedRecord {
  record: JsonRecord;
  source: string;
}

export function buildIntentBlame(options: IntentBlameOptions): IntentBlameResult {
  const repoRoot = gitRoot(options.repoRoot);
  const file = repositoryPath(repoRoot, options.file);
  assertTrackedFile(repoRoot, file);
  const historicalPaths = discoverHistoricalPaths(repoRoot, file);
  const groups = groupBlamedLines(readBlame(repoRoot, file, options.lines));
  const contexts = readContextRecords(repoRoot, historicalPaths);
  const journalEvidence = readEvidenceJournals(repoRoot, historicalPaths);
  const ranges = groups.map((group) => buildRange(
    repoRoot,
    file,
    group,
    contexts,
    journalEvidence,
  ));
  return {
    schema_version: '1.0.0',
    file,
    historical_paths: historicalPaths,
    line_filter: options.lines ?? null,
    ranges,
  };
}

export function renderIntentBlame(result: IntentBlameResult): string {
  const headings = ['LINE-RANGE', 'LAST CHANGE', 'ACTOR', 'INTENT', 'EVIDENCE (cmd+exit)'];
  const rows = result.ranges.map((range) => [
    range.line_range,
    formatChange(range.last_change),
    range.actor,
    tableIntent(range),
    range.evidence_display,
  ]);
  const widths = [10, 39, 24, 64, 64];
  const header = headings.map((heading, index) => fit(heading, widths[index] ?? 20)).join(' | ');
  const divider = widths.map((width) => '-'.repeat(width)).join('-+-');
  const body = rows.map((row) => row.map((value, index) => (
    index === 4 ? fitEvidence(value, widths[index] ?? 20) : fit(value, widths[index] ?? 20)
  )).join(' | '));
  return [`Intent blame: ${result.file}`, header, divider, ...body].join('\n');
}

function buildRange(
  repoRoot: string,
  file: string,
  group: BlameGroup,
  contexts: LocatedRecord[],
  journalEvidence: LocatedRecord[],
): IntentBlameRange {
  const history = readLineHistory(repoRoot, file, group);
  const lastChange = history[0] ?? changeFromBlame(group);
  const context = bestContext(contexts, group.commit, lastChange.timestamp);
  if (!context) return preGen3Range(group, lastChange, history);
  const evidence = [
    ...evidenceFromContext(context),
    ...matchingJournalEvidence(journalEvidence, group.commit, lastChange.timestamp, context.record),
  ];
  const rationale = stringField(context.record, 'decision_rationale');
  const rawIntent = stringField(context.record, 'intent') || PRE_GEN3;
  return {
    line_range: lineRange(group),
    start_line: group.start,
    end_line: group.end,
    last_change: lastChange,
    actor: stringField(context.record, 'actor_id') || PRE_GEN3,
    intent: rationale ? `${rawIntent} — rationale: ${rationale}` : rawIntent,
    decision_rationale: rationale,
    evidence,
    evidence_display: evidence.length ? evidence.map(formatEvidence).join('; ') : 'no evidence journal entry',
    context_source: context.source,
    history,
  };
}

function preGen3Range(
  group: BlameGroup,
  lastChange: ChangeRecord,
  history: ChangeRecord[],
): IntentBlameRange {
  return {
    line_range: lineRange(group),
    start_line: group.start,
    end_line: group.end,
    last_change: lastChange,
    actor: PRE_GEN3,
    intent: PRE_GEN3,
    decision_rationale: PRE_GEN3,
    evidence: [],
    evidence_display: PRE_GEN3,
    context_source: null,
    history,
  };
}

function gitRoot(root: string): string {
  return runGit(resolve(root), ['rev-parse', '--show-toplevel']).trim();
}

function repositoryPath(repoRoot: string, input: string): string {
  if (!input) throw new Error('missing file');
  const absolute = resolve(repoRoot, input);
  const path = relative(repoRoot, absolute).split(sep).join('/');
  if (!path || path === '..' || path.startsWith('../')) {
    throw new Error(`file must be inside repository: ${input}`);
  }
  if (path.includes(':')) throw new Error('file paths containing `:` are not supported by git log -L');
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`file not found: ${path}`);
  return path;
}

function assertTrackedFile(repoRoot: string, file: string): void {
  runGit(repoRoot, ['ls-files', '--error-unmatch', '--', file]);
}

function readBlame(repoRoot: string, file: string, lines?: string): BlamedLine[] {
  const args = ['blame', '--line-porcelain'];
  if (lines) args.push('-L', normalizeLineFilter(lines));
  args.push('--', file);
  const output = runGit(repoRoot, args);
  const result: BlamedLine[] = [];
  let current: Partial<BlamedLine> | null = null;
  for (const line of output.split('\n')) {
    const header = /^([0-9a-f^]{40}) \d+ (\d+)(?: \d+)?$/i.exec(line);
    if (header) {
      const [, commit, finalLine] = header;
      if (commit && finalLine) current = { commit, line: Number(finalLine) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\t')) {
      result.push({
        line: current.line ?? 0,
        commit: current.commit ?? '',
        timestamp: current.timestamp ?? '',
        gitActor: current.gitActor ?? 'unknown',
        summary: current.summary ?? '',
      });
      current = null;
    } else updateBlameMetadata(current, line);
  }
  if (!result.length) throw new Error(`git blame returned no lines for ${file}`);
  return result;
}

function updateBlameMetadata(current: Partial<BlamedLine>, line: string): void {
  if (line.startsWith('author ')) current.gitActor = line.slice(7);
  else if (line.startsWith('author-time ')) current.timestamp = unixTimestamp(line.slice(12));
  else if (line.startsWith('summary ')) current.summary = line.slice(8);
}

function groupBlamedLines(lines: BlamedLine[]): BlameGroup[] {
  const groups: BlameGroup[] = [];
  for (const item of lines) {
    const previous = groups.at(-1);
    if (previous && previous.end + 1 === item.line && previous.commit === item.commit) {
      previous.end = item.line;
      continue;
    }
    groups.push({
      start: item.line,
      end: item.line,
      commit: item.commit,
      timestamp: item.timestamp,
      gitActor: item.gitActor,
      summary: item.summary,
    });
  }
  return groups;
}

function readLineHistory(repoRoot: string, file: string, group: BlameGroup): ChangeRecord[] {
  const spec = `${String(group.start)},${String(group.end)}:${file}`;
  try {
    const output = runGit(repoRoot, [
      'log', '-L', spec, '--no-patch', '-n', '50',
      '--format=%H%x1f%aI%x1f%an%x1f%s',
    ]);
    return output.split('\n').map(parseChange).filter((item): item is ChangeRecord => item !== null);
  } catch {
    return [];
  }
}

function parseChange(line: string): ChangeRecord | null {
  const fields = line.split('\x1f');
  if (fields.length !== 4) return null;
  const [commit = '', timestamp = '', gitActor = '', summary = ''] = fields;
  return { commit, short_commit: shortCommit(commit), timestamp, git_actor: gitActor, summary };
}

function changeFromBlame(group: BlameGroup): ChangeRecord {
  const workingTree = /^0+$/.test(group.commit);
  return {
    commit: group.commit,
    short_commit: workingTree ? 'working' : shortCommit(group.commit),
    timestamp: group.timestamp,
    git_actor: group.gitActor,
    summary: workingTree ? 'working tree' : group.summary,
  };
}

function discoverHistoricalPaths(repoRoot: string, file: string): string[] {
  const paths = new Set([file]);
  const output = runGit(repoRoot, ['log', '--follow', '--name-status', '--format=', '--', file]);
  for (const line of output.split('\n')) {
    const fields = line.split('\t');
    if (/^[RC]\d+$/.test(fields[0] ?? '') && fields.length >= 3) {
      paths.add(normalizeRecordPath(fields[1] ?? ''));
      paths.add(normalizeRecordPath(fields[2] ?? ''));
    }
  }
  return [...paths].filter(Boolean).sort();
}

function readContextRecords(repoRoot: string, paths: string[]): LocatedRecord[] {
  const directory = resolve(repoRoot, '.smarch/agent-context');
  if (!existsSync(directory)) return [];
  const records: LocatedRecord[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!/\.(?:ndjson|jsonl)$/i.test(name)) continue;
    records.push(...readRecordFile(resolve(directory, name), repoRoot));
  }
  return records.filter(({ record }) => fileList(record).some((file) => paths.includes(file)));
}

function readEvidenceJournals(repoRoot: string, paths: string[]): LocatedRecord[] {
  const candidates = [
    ...walkEvidenceFiles(resolve(repoRoot, '.smarch')),
    ...walkEvidenceFiles(resolve(repoRoot, '.UltraVision/meta')),
  ];
  const records = candidates.flatMap((path) => readRecordFile(path, repoRoot));
  return records.filter(({ record }) => recordReferencesPaths(record, paths));
}

function walkEvidenceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'agent-context') files.push(...walkEvidenceFiles(path));
    } else if (/\.(?:json|jsonl|ndjson)$/i.test(entry.name) && /evidence|journal/i.test(path)) {
      files.push(path);
    }
  }
  return files;
}

function readRecordFile(path: string, repoRoot: string): LocatedRecord[] {
  const source = relative(repoRoot, path).split(sep).join('/');
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values.filter(isRecord).map((record) => ({ record, source }));
    } catch {
      return [];
    }
  }
  const records: LocatedRecord[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push({ record: parsed, source: `${source}:${String(index + 1)}` });
    } catch {
      // Intent blame is read-only and best-effort: malformed unrelated journal lines are ignored.
    }
  }
  return records;
}

function bestContext(records: LocatedRecord[], commit: string, timestamp: string): LocatedRecord | null {
  let best: LocatedRecord | null = null;
  let bestScore = 0;
  for (const candidate of records) {
    const score = contextScore(candidate.record, commit, timestamp);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function contextScore(record: JsonRecord, commit: string, timestamp: string): number {
  const recordedCommit = stringField(record, 'commit');
  if (recordedCommit && commitsMatch(recordedCommit, commit)) return 10_000 + contextQuality(record);
  if (recordedCommit) return 0;
  const distance = timeDistance(record, timestamp);
  if (distance === null || distance > CONTEXT_TIME_WINDOW_MS) return 0;
  return 5_000 - Math.floor(distance / 1000) + contextQuality(record);
}

function contextQuality(record: JsonRecord): number {
  let score = 0;
  if (stringField(record, 'decision_rationale')) score += 20;
  if (isRecord(record.verification)) score += 10;
  if (record.kind === 'edit_applied' || record.kind === 'decision_recorded') score += 5;
  return score;
}

function evidenceFromContext(context: LocatedRecord): EvidenceRecord[] {
  const output: EvidenceRecord[] = [];
  const verification = context.record.verification;
  if (isRecord(verification)) {
    const command = stringField(verification, 'command');
    if (command) output.push({
      command,
      exit_code: statusExit(verification.status),
      source: context.source,
      timestamp: stringField(context.record, 'timestamp') || undefined,
    });
  }
  const proof = context.record.proof;
  if (Array.isArray(proof)) {
    for (const command of proof.filter((item): item is string => typeof item === 'string')) {
      output.push({ command, exit_code: null, source: context.source });
    }
  }
  return output;
}

function matchingJournalEvidence(
  records: LocatedRecord[],
  commit: string,
  timestamp: string,
  context: JsonRecord,
): EvidenceRecord[] {
  return records
    .filter(({ record }) => evidenceMatches(record, commit, timestamp, context))
    .map(toEvidenceRecord)
    .filter((item): item is EvidenceRecord => item !== null);
}

function evidenceMatches(record: JsonRecord, commit: string, timestamp: string, context: JsonRecord): boolean {
  const recordedCommit = stringField(record, 'commit');
  if (recordedCommit && commitsMatch(recordedCommit, commit)) return true;
  if (recordedCommit) return false;
  const identities = ['event_id', 'session_id', 'task_id', 'lease_id', 'brick_id'];
  if (identities.some((key) => {
    const expected = stringField(context, key);
    return expected && collectStrings(record).includes(expected);
  })) return true;
  const distance = timeDistance(record, timestamp);
  return distance !== null && distance <= CONTEXT_TIME_WINDOW_MS;
}

function toEvidenceRecord(item: LocatedRecord): EvidenceRecord | null {
  const verification = isRecord(item.record.verification) ? item.record.verification : null;
  const command = evidenceCommand(item.record, verification);
  if (!command) return null;
  return {
    command,
    exit_code: evidenceExit(item.record, verification),
    source: item.source,
    timestamp: evidenceTimestamp(item.record),
  };
}

function evidenceCommand(record: JsonRecord, verification: JsonRecord | null): string {
  return stringField(record, 'command')
    || stringField(record, 'cmd')
    || (verification ? stringField(verification, 'command') : '');
}

function evidenceExit(record: JsonRecord, verification: JsonRecord | null): number | string | null {
  const rawExit = record.exit_code ?? record.exit ?? record.code
    ?? verification?.exit_code ?? verification?.exit;
  return normalizeExit(rawExit, record.status ?? verification?.status);
}

function evidenceTimestamp(record: JsonRecord): string | undefined {
  return stringField(record, 'timestamp') || stringField(record, 'recorded_at') || undefined;
}

function fileList(record: JsonRecord): string[] {
  return Array.isArray(record.files_touched)
    ? record.files_touched.filter((item): item is string => typeof item === 'string').map(normalizeRecordPath)
    : [];
}

function recordReferencesPaths(record: JsonRecord, paths: string[]): boolean {
  return collectStrings(record).some((value) => {
    const normalized = normalizeRecordPath(value);
    return paths.some((path) => normalized === path || value.includes(path));
  });
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectStrings);
}

function normalizeLineFilter(value: string): string {
  const match = /^(\d+)(?:[:,](\d+))?$/.exec(value);
  if (!match) throw new Error(`invalid --lines value: ${value}; expected START:END`);
  const parts = value.split(/[:,]/);
  const start = Number(parts[0]);
  const end = Number(parts.length === 2 ? parts[1] : parts[0]);
  if (start < 1 || end < start) throw new Error(`invalid --lines range: ${value}`);
  return `${String(start)},${String(end)}`;
}

function normalizeRecordPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function timeDistance(record: JsonRecord, timestamp: string): number | null {
  const value = stringField(record, 'timestamp') || stringField(record, 'recorded_at');
  const left = Date.parse(value);
  const right = Date.parse(timestamp);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) : null;
}

function commitsMatch(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

function normalizeExit(value: unknown, status: unknown): number | string | null {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return statusExit(status);
}

function statusExit(status: unknown): number | string | null {
  if (status === 'pass' || status === 'passed' || status === 'success') return 0;
  if (status === 'fail' || status === 'failed' || status === 'error') return 1;
  return typeof status === 'string' ? status : null;
}

function formatEvidence(evidence: EvidenceRecord): string {
  return `${evidence.command} (exit ${String(evidence.exit_code ?? 'unknown')})`;
}

function formatChange(change: ChangeRecord): string {
  const date = change.timestamp ? change.timestamp.slice(0, 10) : 'unknown-date';
  return `${change.short_commit} ${date} ${change.summary}`;
}

function tableIntent(range: IntentBlameRange): string {
  if (!range.decision_rationale || range.decision_rationale === PRE_GEN3) return range.intent;
  const rawIntent = range.intent.split(' — rationale: ')[0];
  return `${clip(rawIntent, 31)}; why: ${clip(range.decision_rationale, 25)}`;
}

function fitEvidence(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  const first = value.split('; ')[0];
  const suffix = / \(exit [^)]+\)$/.exec(first)?.[0] ?? '';
  if (!suffix || suffix.length >= width - 2) return fit(first, width);
  return `${clip(first.slice(0, -suffix.length), width - suffix.length)}${suffix}`.padEnd(width);
}

function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function lineRange(group: BlameGroup): string {
  return group.start === group.end
    ? String(group.start)
    : `${String(group.start)}-${String(group.end)}`;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}

function fit(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function unixTimestamp(value: string): string {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`git ${args[0] ?? ''} failed${stderr ? `: ${stderr}` : ''}`);
  }
}
