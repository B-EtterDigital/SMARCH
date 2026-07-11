#!/usr/bin/env node
/**
 * What: Checks curated-build source against the declared reusable-source rules.
 * Why: A brick must not be promoted while its implementation violates required safeguards.
 * How: Reads one or more manifests and source trees, then prints or writes findings and status.
 * Callers: Build promotion and continuous-integration workflows invoke this gate.
 * Example: `node tools/sma-rule-gate.ts --help`
 */
// sma-rule-gate.ts — SSA-v2 rule gate.
// Refuses to promote a brick whose source violates one or more declared rules.
// Designed to be called from sma-build-promote.ts and from CI.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { resolveProjectRoot as canonicalResolveProjectRoot, PROJECTS_ROOT } from "./lib/project-paths.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  projectsRoot: process.env.SMA_PROJECTS_ROOT ?? PROJECTS_ROOT,
  reportDir: path.resolve(repoRoot, "security"),
};

interface ManifestInput {
  build?: { id?: string; runtimes?: string[] };
  source?: { project?: string; paths?: string[] };
}

interface RuleContext {
  manifest: ManifestInput;
  projectRoot: string;
  declaredSourcePaths: string[];
  sourceFiles: string[];
}

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

interface RuleCheckResult {
  findings: Finding[];
  truncated?: boolean;
}

interface RuleDefinition {
  id: string;
  severity: 'block' | 'warn';
  description: string;
  applies: (manifest: ManifestInput) => boolean;
  check: (context: RuleContext) => RuleCheckResult | Promise<RuleCheckResult>;
}

interface CliOptions {
  projectsRoot: string;
  manifest?: string;
  all?: boolean;
  report?: string;
  json?: boolean;
  warnOnly?: boolean;
  help?: boolean;
}

interface RuleReport {
  id: string;
  severity: 'block' | 'warn';
  description?: string;
  status: 'pass' | 'block' | 'warn' | 'skipped';
  reason?: string;
  findings: Finding[];
  totalFindings: number;
  truncated?: boolean;
}

interface ManifestReport {
  manifest: string;
  build_id?: string;
  project?: string;
  projectRoot: string | null;
  blockingFindings: number;
  warningFindings: number;
  rules: RuleReport[];
}

interface CombinedReport {
  generated_at: string;
  status: 'warn' | 'checked';
  manifests: number;
  blocking: number;
  warning: number;
  warnings: string[];
  reports: ManifestReport[];
}

// ---------------------------------------------------------------------------
// Rule registry. Each rule declares: id, severity, applies(manifest) -> bool,
// check(ctx) -> { findings: [{file, line, snippet}], summary }
// ---------------------------------------------------------------------------

const RULES: RuleDefinition[] = [
  {
    id: "R1.no-prod-console-log",
    severity: "block",
    description: "No console.log() in production source files. Use a logger or strip.",
    applies: (_manifest: ManifestInput) => true,
    async check(ctx: RuleContext) {
      const findings: Finding[] = [];
      for (const file of ctx.sourceFiles) {
        if (isScript(file) || isLogger(file) || isTest(file)) continue;
        const text = await safeRead(file);
        if (!text) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (/\bconsole\.log\s*\(/.test(line) && !isInJsdocExample(lines, i)) {
            findings.push({ file: rel(file, ctx.projectRoot), line: i + 1, snippet: line.trim().slice(0, 160) });
          }
        }
      }
      return { findings };
    },
  },
  {
    id: "R8.no-hex-outside-tokens",
    severity: "warn",
    description: "No hex color literals outside theme/token files (SS Rule 8).",
    applies: (manifest: ManifestInput) => isUiBrick(manifest),
    async check(ctx: RuleContext) {
      const findings: Finding[] = [];
      const re = /#[0-9a-fA-F]{6}\b/;
      for (const file of ctx.sourceFiles) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        if (isTokenFile(file) || isDataFile(file) || isTest(file)) continue;
        const text = await safeRead(file);
        if (!text) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            findings.push({ file: rel(file, ctx.projectRoot), line: i + 1, snippet: lines[i].trim().slice(0, 160) });
            if (findings.length > 500) return { findings, truncated: true };
          }
        }
      }
      return { findings };
    },
  },
  {
    id: "SS8.no-select-star",
    severity: "block",
    description: "No select('*') in production query code (SS Rule 3 / SS8).",
    applies: (_manifest: ManifestInput) => true,
    async check(ctx: RuleContext) {
      const findings: Finding[] = [];
      for (const file of ctx.sourceFiles) {
        if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
        if (isTest(file)) continue;
        const text = await safeRead(file);
        if (!text) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (/\.select\(\s*['"`]\*['"`]\s*\)/.test(lines[i])) {
            findings.push({ file: rel(file, ctx.projectRoot), line: i + 1, snippet: lines[i].trim().slice(0, 160) });
          }
        }
      }
      return { findings };
    },
  },
  {
    id: "source-paths-exist",
    severity: "block",
    description: "Every declared source.paths[] entry must exist on disk.",
    applies: () => true,
    check(ctx: RuleContext) {
      const findings: Finding[] = [];
      if (!ctx.projectRoot) return { findings };
      for (const p of ctx.declaredSourcePaths) {
        const abs = path.join(ctx.projectRoot, p);
        if (!existsSync(abs)) {
          findings.push({ file: p, line: 0, snippet: "declared source path is missing on disk" });
        }
      }
      return { findings };
    },
  },
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `sma-rule-gate — SSA-v2 rule gate for curated builds.

Usage:
  node tools/sma-rule-gate.ts --manifest <path>          gate a single brick
  node tools/sma-rule-gate.ts --all                       gate every build under builds/
  node tools/sma-rule-gate.ts --manifest <path> --json    machine-readable output

Options:
  --manifest <path>       Path to a build.sweetspot.json manifest
  --all                   Run against every *.build.sweetspot.json under builds/
  --projects-root <path>  Where underlying project repos live
                          (default: $SMA_PROJECTS_ROOT or ~/DEV/Projects)
  --report <path>         Write findings JSON to file
  --json                  Print findings JSON to stdout instead of a summary
  --warn-only             Exit 0 even on blocking findings (for first-pass adoption)
  --help                  This text.

Exit codes:
  0  no blocking findings
  1  one or more blocking findings
  2  configuration / IO error
`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const manifests = await resolveManifests(opts);

  const reports: ManifestReport[] = [];
  for (const manifestPath of manifests) {
    const report = await gateOne(manifestPath, opts);
    reports.push(report);
  }

  const combined: CombinedReport = {
    generated_at: new Date().toISOString(),
    status: reports.length === 0 ? "warn" : "checked",
    manifests: reports.length,
    blocking: reports.reduce((a, r) => a + r.blockingFindings, 0),
    warning: reports.reduce((a, r) => a + r.warningFindings, 0),
    warnings: reports.length === 0
      ? ["nothing to check; run npm run scan to discover manifests, then rerun this gate"]
      : [],
    reports,
  };

  if (opts.report) {
    await fs.mkdir(path.dirname(opts.report), { recursive: true });
    await fs.writeFile(opts.report, JSON.stringify(combined, null, 2));
  } else if (opts.json) {
    process.stdout.write(JSON.stringify(combined, null, 2) + "\n");
  } else {
    printSummary(combined);
  }

  if (combined.status === "warn" && (opts.report || opts.json)) {
    console.error("[rule-gate] WARN — nothing to check; run npm run scan to discover manifests, then rerun this gate");
  }

  if (combined.blocking > 0 && !opts.warnOnly) process.exit(1);
}

async function gateOne(manifestPath: string, opts: CliOptions): Promise<ManifestReport> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ManifestInput;
  const projectRoot = resolveProjectRoot(manifest, opts.projectsRoot);
  const declaredSourcePaths = manifest.source?.paths ?? [];
  const sourceFiles = projectRoot ? await collectSourceFiles(projectRoot, declaredSourcePaths) : [];

  const ruleReports: RuleReport[] = [];
  let blocking = 0, warning = 0;
  for (const rule of RULES) {
    if (!rule.applies(manifest)) continue;
    if (!projectRoot) {
      ruleReports.push({ id: rule.id, severity: rule.severity, status: "skipped", reason: "project root not resolved", findings: [], totalFindings: 0 });
      continue;
    }
    const ctx: RuleContext = { manifest, projectRoot, declaredSourcePaths, sourceFiles };
    const { findings, truncated } = await rule.check(ctx);
    const status = findings.length === 0 ? "pass" : (rule.severity === "block" ? "block" : "warn");
    ruleReports.push({ id: rule.id, severity: rule.severity, description: rule.description, status, findings: findings.slice(0, 25), totalFindings: findings.length, truncated });
    if (status === "block") blocking += findings.length;
    if (status === "warn") warning += findings.length;
  }

  return {
    manifest: path.relative(repoRoot, manifestPath),
    build_id: manifest.build?.id,
    project: manifest.source?.project,
    projectRoot: projectRoot ? path.relative(os.homedir(), projectRoot) : null,
    blockingFindings: blocking,
    warningFindings: warning,
    rules: ruleReports,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { projectsRoot: DEFAULTS.projectsRoot };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], n = argv[i + 1];
    if (a === "--manifest") { out.manifest = n; i += 1; }
    else if (a === "--all") { out.all = true; }
    else if (a === "--projects-root") { out.projectsRoot = n; i += 1; }
    else if (a === "--report") { out.report = n; i += 1; }
    else if (a === "--json") { out.json = true; }
    else if (a === "--warn-only") { out.warnOnly = true; }
    else if (a === "--help" || a === "-h") { out.help = true; }
  }
  return out;
}

async function resolveManifests(opts: CliOptions): Promise<string[]> {
  if (opts.manifest) return [path.resolve(opts.manifest)];
  if (opts.all) {
    const root = path.resolve(repoRoot, "builds");
    return walkManifests(root);
  }
  return [];
}

async function walkManifests(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && full.endsWith(".build.sweetspot.json")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function resolveProjectRoot(manifest: ManifestInput, _projectsRoot: string): string | null {
  // Delegated to tools/lib/project-paths.ts — the canonical resolver
  // that handles the curated override map (e.g. acme-desktop → acme-desktop)
  // and case-insensitive fallback. Register new external projects there.
  return canonicalResolveProjectRoot(manifest.source?.project);
}

async function collectSourceFiles(projectRoot: string, declaredPaths: string[]): Promise<string[]> {
  const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx"]);
  const files: string[] = [];
  for (const decl of declaredPaths) {
    const abs = path.join(projectRoot, decl);
    if (!existsSync(abs)) continue;
    const stat = await fs.stat(abs);
    if (stat.isFile()) { files.push(abs); continue; }
    await walkDir(abs, (file: string) => {
      const ext = path.extname(file);
      if (exts.has(ext)) files.push(file);
    });
  }
  return files;
}

async function walkDir(dir: string, onFile: (file: string) => void): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".next" || e.name === "build") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkDir(full, onFile);
    else if (e.isFile()) onFile(full);
  }
}

async function safeRead(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}

function rel(file: string, root: string | null): string { return root ? path.relative(root, file) : file; }

function isScript(file: string): boolean { return file.includes('/scripts/'); }
function isLogger(file: string): boolean { return /\/(logger|AgentLogger|debug)\.(ts|tsx|js|mjs)$/.test(file); }
function isTest(file: string): boolean { return /\.(test|spec)\.(ts|tsx|js|mjs)$|\/__tests__\/|\/0000testing\//.test(file); }
function isTokenFile(file: string): boolean { return /\/(theme|themes|tokens|design-tokens|colorTokens|comicColorTokenSets|comicThemeModes)/.test(file) || file.includes('tailwind.config.'); }
function isDataFile(file: string): boolean { return file.includes('/data/') || /Template[s]?\.(ts|tsx)$/.test(file); }
function isUiBrick(manifest: ManifestInput): boolean {
  const runtimes = manifest.build?.runtimes ?? [];
  return runtimes.includes("browser") || runtimes.includes("electron");
}
function isInJsdocExample(lines: string[], i: number): boolean {
  for (let j = i; j >= 0 && j > i - 12; j -= 1) {
    if (lines[j].includes('@example')) return true;
    if (/^\s*\*\/\s*$/.test(lines[j])) return false;
  }
  return false;
}

function printSummary(combined: CombinedReport): void {
  if (combined.status === "warn") {
    console.log("[rule-gate] WARN — nothing to check; run npm run scan to discover manifests, then rerun this gate");
    return;
  }
  const verdict = combined.blocking === 0 ? "PASS" : "BLOCK";
  console.log(`[rule-gate] ${verdict} — ${String(combined.manifests)} manifest(s), ${String(combined.blocking)} blocking, ${String(combined.warning)} warning`);
  for (const r of combined.reports) {
    const v = r.blockingFindings === 0 ? "✓" : "✗";
    console.log(`  ${v} ${r.build_id ?? r.manifest}`);
    if (!r.projectRoot) {
      console.log(`      (project root not resolved — source-aware rules skipped)`);
    }
    for (const rule of r.rules) {
      if (rule.status === "pass" || rule.status === "skipped") continue;
      const tag = rule.status === "block" ? "BLOCK" : "WARN ";
      console.log(`      [${tag}] ${rule.id}: ${String(rule.totalFindings)} finding(s)`);
      for (const f of rule.findings.slice(0, 3)) {
        console.log(`              ${f.file}:${String(f.line)}  ${f.snippet}`);
      }
      if (rule.totalFindings > 3) console.log(`              ... and ${String(rule.totalFindings - 3)} more`);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[rule-gate] error:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
