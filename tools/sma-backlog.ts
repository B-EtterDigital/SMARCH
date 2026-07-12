#!/usr/bin/env node
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-type-conversion, @typescript-eslint/no-base-to-string -- Backlog CLI parsing and diagnostics preserve compatibility with untrusted legacy entries and exact existing coercion. */
/* eslint-disable complexity -- The CLI parser is one explicit option grammar; centralized branches prevent conflicting flag precedence. */
/**
 * WHAT: Creates, lists, closes, aggregates, and counts explicit architecture backlog entries.
 * WHY: Known gaps must remain visible and promotion-blocking instead of disappearing in chat or logs.
 * HOW: Reads per-project backlog files, validates command fields, and rebuilds the portfolio aggregate.
 * INPUTS: A subcommand, project identifier, and entry metadata or filters.
 * OUTPUTS: Updated backlog files, aggregate records, listings, and grouped statistics.
 * CALLERS: Agents, promotion gates, and operators use this whenever work leaves declared debt.
 * @example node tools/sma-backlog.ts stats
 */
/**
 * sma-backlog.ts — manage SMA backlog entries.
 *
 * Per-project backlog lives at <project_root>/.smarch/backlog.json
 * (schema: schemas/backlog.schema.json). Global aggregate is rebuilt by
 *   `sma-backlog.ts aggregate` at registry/backlog.generated.json.
 *
 * Subcommands:
 *   add        --project <id> --title "..." --kind <kind> --severity <s> [--brick X] [--file F]...
 *   list       --project <id> [--severity <s>] [--kind <k>] [--status <st>] [--json]
 *   close      --project <id> --id <entry_id> --resolution "..."
 *   aggregate                       → rebuild global registry/backlog.generated.json
 *   stats      [--project <id>]     → counts by severity/kind/status
 *
 * Backlog entries are required output of any session that:
 *   - clones a brick that isn't fully promoted (typecheck disabled, missing types, etc.)
 *   - leaves any SMA gate at "partial" or "missing"
 *   - touches a file that triggers a scanner warning the agent doesn't fix in-session
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";


const SMA_REGISTRY = smaPath('registry');

interface CliArgs {
  project?: string; title?: string; description?: string; severity?: string; kind?: string;
  brick?: string; package?: string; file: string[]; id?: string; resolution?: string;
  status?: string; effort?: string; costTokens?: string; blocksPromotionTo: string[];
  reuseReceiptId?: string; openedBy?: string; closedBy?: string; json?: boolean; help?: boolean;
}
type BacklogEntry = Record<string, unknown> & {
  id: string; title: string; severity: string; kind: string; status: string;
};
interface Backlog {
  schema_version: string; project: string; generated_at: string; entries: BacklogEntry[];
}

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

if (cmd === 'add') addEntry();
else if (cmd === 'list') listEntries();
else if (cmd === 'close') closeEntry();
else if (cmd === 'aggregate') aggregate();
else if (cmd === 'stats') stats();
else { usage(); exit(2); }

function usage() {
  console.log(`Usage:
  sma-backlog.ts add --project <id> --title "..." --kind <kind> --severity <s> [--brick X] [--file F]...
                  [--description "..."] [--blocks-promotion-to canonical] [--effort 2] [--cost-tokens 5000]
  sma-backlog.ts list --project <id> [--severity <s>] [--kind <k>] [--status <st>] [--json]
  sma-backlog.ts close --project <id> --id <entry_id> --resolution "..."
  sma-backlog.ts aggregate                            → rebuild global registry
  sma-backlog.ts stats [--project <id>]

Kinds: typecheck_disabled, missing_types, dependency_drift, platform_coupling, test_missing,
       rls_missing, env_undeclared, manifest_drift, boundary_violation, supply_chain,
       performance, accessibility, documentation, naming, duplicate_brick, other
Severity: blocker, high, medium, low, nit
`);
}

function projectRoot(projectId: string): string {
  if (existsSync(resolve(PROJECTS_ROOT, projectId))) return resolve(PROJECTS_ROOT, projectId);
  // case-insensitive lookup (e.g. acme-lang vs acme-lang)
  for (const ent of readdirSync(PROJECTS_ROOT)) {
    if (ent.toLowerCase().includes(projectId.toLowerCase())) {
      return resolve(PROJECTS_ROOT, ent);
    }
  }
  throw new Error(`project not found: ${projectId}`);
}

function loadBacklog(projectId: string): Backlog {
  const root = projectRoot(projectId);
  const path = resolve(root, '.smarch/backlog.json');
  if (!existsSync(path)) {
    return { schema_version: '1.0.0', project: projectId, generated_at: new Date().toISOString(), entries: [] };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Backlog;
}

function saveBacklog(projectId: string, data: Backlog): void {
  const root = projectRoot(projectId);
  const dir = resolve(root, '.smarch');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  data.generated_at = new Date().toISOString();
  writeFileSync(resolve(dir, 'backlog.json'), JSON.stringify(data, null, 2) + '\n');
}

function nextId(backlog: Backlog): string {
  const nums = backlog.entries
    .map((e) => Number(String(e.id).replace(/[^\d]/g, '')))
    .filter((n) => !Number.isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `${backlog.project}-${String(max + 1).padStart(3, '0')}`;
}

function addEntry() {
  if (!args.project || !args.title || !args.kind || !args.severity) {
    console.error('add: --project, --title, --kind, --severity required');
    exit(2);
  }
  const backlog = loadBacklog(args.project);
  const id = nextId(backlog);
  const rawEntry = {
    id,
    title: args.title,
    description: args.description ?? '',
    severity: args.severity,
    kind: args.kind,
    scope: {
      brick_id: args.brick,
      package: args.package,
      files: args.file ?? [],
    },
    blocks_promotion_to: args.blocksPromotionTo ?? [],
    linked_to: args.reuseReceiptId ? { reuse_receipt_id: args.reuseReceiptId } : undefined,
    opened_at: new Date().toISOString(),
    opened_by: args.openedBy ?? process.env.USER ?? 'unknown',
    status: 'open',
    estimated_effort_hours: args.effort ? Number(args.effort) : undefined,
    estimated_token_cost: args.costTokens ? Number(args.costTokens) : undefined,
  };
  const entry = Object.fromEntries(
    Object.entries(rawEntry).filter(([, value]) => value !== undefined),
  ) as BacklogEntry;
  backlog.entries.push(entry);
  saveBacklog(args.project, backlog);
  console.log(`opened ${id}: ${args.title}`);
}

function listEntries() {
  const backlog = loadBacklog(requireProject());
  let rows = backlog.entries;
  if (args.severity) rows = rows.filter((e) => e.severity === args.severity);
  if (args.kind) rows = rows.filter((e) => e.kind === args.kind);
  if (args.status) rows = rows.filter((e) => e.status === args.status);
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('(no entries match)'); return; }
  console.log(`${pad('id', 18)} ${pad('sev', 8)} ${pad('kind', 22)} ${pad('status', 12)} title`);
  console.log('-'.repeat(95));
  for (const e of rows) {
    console.log(`${pad(e.id, 18)} ${pad(e.severity, 8)} ${pad(e.kind, 22)} ${pad(e.status, 12)} ${e.title}`);
  }
}

function closeEntry() {
  const project = requireProject();
  const backlog = loadBacklog(project);
  const e = backlog.entries.find((x) => x.id === args.id);
  if (!e) { console.error(`not found: ${args.id}`); exit(1); }
  e.status = 'resolved';
  e.closed_at = new Date().toISOString();
  e.closed_by = args.closedBy ?? process.env.USER ?? 'unknown';
  e.resolution = args.resolution ?? '';
  saveBacklog(project, backlog);
  console.log(`closed ${args.id}`);
}

function aggregate() {
  const all: (BacklogEntry & { project: string })[] = [];
  for (const ent of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const path = resolve(PROJECTS_ROOT, ent.name, '.smarch/backlog.json');
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, 'utf8')) as Backlog;
    for (const e of data.entries) all.push({ project: data.project, ...e });
  }
  const out: Record<string, unknown> = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    total: all.length,
    by_severity: bucket(all, 'severity'),
    by_kind: bucket(all, 'kind'),
    by_status: bucket(all, 'status'),
    by_project: bucket(all, 'project'),
    entries: all,
  };
  if (!existsSync(SMA_REGISTRY)) mkdirSync(SMA_REGISTRY, { recursive: true });
  const outPath = resolve(SMA_REGISTRY, 'backlog.generated.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`aggregated ${all.length} entries → ${outPath}`);
}

function stats() {
  const data = args.project
    ? { entries: loadBacklog(args.project).entries.map((e) => ({ project: args.project, ...e })) }
    : (() => {
        const all: (BacklogEntry & { project: string })[] = [];
        for (const ent of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const path = resolve(PROJECTS_ROOT, ent.name, '.smarch/backlog.json');
          if (!existsSync(path)) continue;
          const d = JSON.parse(readFileSync(path, 'utf8')) as Backlog;
          for (const e of d.entries) all.push({ project: d.project, ...e });
        }
        return { entries: all };
      })();
  console.log(`Total entries: ${data.entries.length}`);
  console.log('By severity:', bucket(data.entries, 'severity'));
  console.log('By kind:    ', bucket(data.entries, 'kind'));
  console.log('By status:  ', bucket(data.entries, 'status'));
}

function requireProject(): string {
  if (!args.project) throw new Error('--project is required');
  return args.project;
}

function bucket<T extends Record<string, unknown>>(arr: T[], key: keyof T): Record<string, number> {
  return arr.reduce<Record<string, number>>((counts, entry) => {
    const value = String(entry[key]);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function pad(s: unknown, n: number): string { return String(s ?? '').slice(0, n).padEnd(n); }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { file: [], blocksPromotionTo: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--description') out.description = argv[++i];
    else if (a === '--severity') out.severity = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
    else if (a === '--brick') out.brick = argv[++i];
    else if (a === '--package') out.package = argv[++i];
    else if (a === '--file') out.file.push(argv[++i]);
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--resolution') out.resolution = argv[++i];
    else if (a === '--status') out.status = argv[++i];
    else if (a === '--effort') out.effort = argv[++i];
    else if (a === '--cost-tokens') out.costTokens = argv[++i];
    else if (a === '--blocks-promotion-to') out.blocksPromotionTo.push(argv[++i]);
    else if (a === '--reuse-receipt-id') out.reuseReceiptId = argv[++i];
    else if (a === '--opened-by') out.openedBy = argv[++i];
    else if (a === '--closed-by') out.closedBy = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
