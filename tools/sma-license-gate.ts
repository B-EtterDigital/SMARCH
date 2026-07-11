#!/usr/bin/env node
/**
 * WHAT: Checks whether composed builds obey the repository's license and visibility lattice.
 * WHY: A build must not be released under terms more permissive than its source components.
 * HOW: Resolves component licenses, evaluates each build composition, and records blocking findings.
 * INPUTS: Generated ledgers, build manifests, theft-risk data, and strictness or output options.
 * OUTPUTS: A generated license report and a blocking exit status when gate rules fail.
 * CALLERS: Release checks and maintainers reviewing whether a build may be distributed.
 * Usage: `node tools/sma-license-gate.ts --json`
 */
/**
 * SMA license-lattice gate.
 *
 * Enforces the monotonic rule: a build can never be declared more open, more
 * visible, or more permissively licensed than the bricks it is composed from.
 * "You cannot release as open what was built from something closed."
 *
 * For each build manifest it resolves the component bricks (composition +
 * derived_from), looks up each brick's openness/visibility/license in the
 * license ledger, computes the lattice MEET, and compares it to what the build
 * DECLARES. Any escalation is a violation. It also surfaces theft-risk copies
 * (same source fingerprint under a different origin) from the fingerprint
 * ledger.
 *
 * Report mode by default; --gate exits non-zero on any blocking violation so
 * it can sit in the promote/publish pipeline next to the other gates.
 *
 * Usage:
 *   node tools/sma-license-gate.ts                # report
 *   node tools/sma-license-gate.ts --gate         # fail on block-severity
 *   node tools/sma-license-gate.ts --strict       # treat theft-risk as block
 *   node tools/sma-license-gate.ts --json
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkComposition } from './lib/license-lattice.ts';
import { buildLicenseIndex } from './lib/ledger-resolve.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_LEDGER = resolve(SMA_ROOT, 'registry/license-ledger.generated.json');
const FINGERPRINT_LEDGER = resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json');
const BUILDS_DIR = resolve(SMA_ROOT, 'builds');
const OUT = resolve(SMA_ROOT, 'security/license-gate.generated.json');

const args = parseArgs(process.argv.slice(2));

type LicenseIndex = ReturnType<typeof buildLicenseIndex>;
type CompositionComponent = Parameters<typeof checkComposition>[1][number];
type CompositionResult = ReturnType<typeof checkComposition>;
type Violation = CompositionResult['violations'][number];

interface LicenseGateArgs {
  json?: boolean;
  gate?: boolean;
  strict?: boolean;
  [key: string]: boolean | undefined;
}

interface TheftRecord {
  brick_id: string;
  theft_risk?: boolean;
  copy_of?: string;
  copy_group?: string;
}

interface BuildManifest {
  build?: { id?: string; visibility?: string };
  source?: { project?: string; derived_from_bricks?: Array<{ brick_id?: string }> };
  composition?: {
    brick_refs?: Array<{ brick_id?: string }>;
    optional_bricks?: Array<{ brick_id?: string }>;
  };
  publishing?: {
    visibility?: string;
    license?: string | null;
    openness?: 'closed' | 'source-available' | 'open' | null;
    publishable?: boolean;
    exposed_docs?: string[];
  };
}

interface BuildResult {
  build: string;
  error?: string;
  build_id?: string | null;
  declared?: { visibility: string; license: string | null; publishable: boolean };
  effective?: CompositionResult['effective'];
  component_count?: number;
  unresolved_count?: number;
  ok?: boolean;
  violations: Violation[];
}

interface LicenseReport {
  schema_version: string;
  generated_at: string;
  status: string;
  warning?: string;
  build_count: number;
  blocking_count: number;
  warning_count: number;
  theft_risk_count: number;
  builds: BuildResult[];
  theft_findings: Array<{ brick_id: string; copy_of?: string; copy_group?: string }>;
}

try {
  main();
} catch (err) {
  console.error(`sma-license-gate: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

function main() {
  const builds = collectBuildManifests(BUILDS_DIR);
  if (builds.length === 0 && !existsSync(LICENSE_LEDGER)) {
    const report = emptyReport();
    writeReport(report);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return;
  }

  const ledger = loadLedger();
  const theftByBrick = loadTheft();

  const results = [];
  for (const buildPath of builds) {
    results.push(evaluateBuild(buildPath, ledger, theftByBrick));
  }

  // Registry-wide theft findings (independent of builds).
  const theftFindings = [...theftByBrick.values()]
    .filter((t) => t.theft_risk)
    .map((t) => ({ brick_id: t.brick_id, copy_of: t.copy_of, copy_group: t.copy_group }));

  const blocking = results.flatMap((r) => r.violations.filter((v) => v.severity === 'block'));
  const warnings = results.flatMap((r) => r.violations.filter((v) => v.severity === 'warn'));
  const theftBlocks = args.strict ? theftFindings : [];

  const status = (blocking.length || theftBlocks.length) ? 'failed' : 'passed';
  const report = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    status,
    build_count: results.length,
    blocking_count: blocking.length,
    warning_count: warnings.length,
    theft_risk_count: theftFindings.length,
    builds: results,
    theft_findings: theftFindings,
  };

  writeReport(report);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (args.gate && status === 'failed') process.exit(4);
}

function emptyReport(): LicenseReport {
  return {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    status: 'warn',
    warning: 'nothing to check; run npm run scan to discover manifests, then rerun this gate',
    build_count: 0,
    blocking_count: 0,
    warning_count: 0,
    theft_risk_count: 0,
    builds: [],
    theft_findings: [],
  };
}

function evaluateBuild(buildPath: string, ledger: LicenseIndex, theftByBrick: Map<string, TheftRecord>): BuildResult {
  const rel = relative(SMA_ROOT, buildPath).split(sep).join('/');
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(readFileSync(buildPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { build: rel, error: `unreadable manifest: ${message}`, violations: [{ code: 'MANIFEST_UNREADABLE', severity: 'block', message }] };
  }

  const componentIds = collectComponentIds(manifest);
  const projectHint = manifest.source?.project || manifest.build?.id?.split('.')?.[0];
  const components: CompositionComponent[] = [];
  const unresolved: string[] = [];
  const theftInComposition: Array<{ brick_id: string; copy_of?: string }> = [];
  for (const id of componentIds) {
    const hit = ledger.resolve(id, projectHint);
    const row = hit?.row;
    if (!row) {
      unresolved.push(id);
      // fail-safe: an unknown component is treated as closed/private.
      components.push({ brick_id: id, spdx: null, openness: 'closed', visibility: 'private' });
    } else {
      const openness = row.openness === 'open' || row.openness === 'closed' || row.openness === 'source-available'
        ? row.openness
        : undefined;
      const visibility = row.visibility === 'private' || row.visibility === 'internal' || row.visibility === 'community' || row.visibility === 'public'
        ? row.visibility
        : undefined;
      const rawSpdx = row.spdx;
      const spdx = typeof rawSpdx === 'string' ? rawSpdx : rawSpdx === null ? null : undefined;
      components.push({ brick_id: id, spdx, openness, visibility });
    }
    const theft = theftByBrick.get(row?.brick_id || id);
    if (theft?.theft_risk) theftInComposition.push({ brick_id: id, copy_of: theft.copy_of });
  }

  const publishing = manifest.publishing || {};
  const rawVisibility = publishing.visibility || manifest.build?.visibility;
  const visibility = rawVisibility === 'public' || rawVisibility === 'community' || rawVisibility === 'internal' || rawVisibility === 'private'
    ? rawVisibility
    : 'private';
  const declared: Parameters<typeof checkComposition>[0] = {
    visibility,
    license: publishing.license || null,
    openness: publishing.openness || undefined,
    publishable: Boolean(publishing.publishable),
    has_attribution: hasAttribution(publishing),
  };

  const check = checkComposition(declared, components);
  const violations = [...check.violations];

  if (unresolved.length) {
    violations.push({
      code: 'UNRESOLVED_COMPONENT',
      severity: 'warn',
      message: `${unresolved.length} component brick(s) not found in license ledger; treated as closed. Regenerate the ledger. e.g. ${unresolved.slice(0, 2).join(', ')}`,
    });
  }
  for (const t of theftInComposition) {
    violations.push({
      code: 'THEFT_IN_COMPOSITION',
      severity: args.strict ? 'block' : 'warn',
      message: `component ${t.brick_id} is a copy of ${t.copy_of} with a different declared author — resolve attribution before publishing`,
    });
  }

  return {
    build: rel,
    build_id: manifest.build?.id || null,
    declared: { visibility, license: publishing.license || null, publishable: Boolean(publishing.publishable) },
    effective: check.effective,
    component_count: components.length,
    unresolved_count: unresolved.length,
    ok: check.ok && (!args.strict || theftInComposition.length === 0),
    violations,
  };
}

function collectComponentIds(manifest: BuildManifest): string[] {
  const ids = new Set<string>();
  for (const ref of manifest.composition?.brick_refs || []) if (ref.brick_id) ids.add(ref.brick_id);
  for (const ref of manifest.composition?.optional_bricks || []) if (ref.brick_id) ids.add(ref.brick_id);
  for (const ref of manifest.source?.derived_from_bricks || []) if (ref.brick_id) ids.add(ref.brick_id);
  return [...ids];
}

function hasAttribution(publishing: BuildManifest['publishing']): boolean {
  const docs = (publishing?.exposed_docs || []).join(' ').toLowerCase();
  return /attribution|contributor|credits|authors|notice/.test(docs);
}

// --- ledger loading ---------------------------------------------------------

function loadLedger() {
  if (!existsSync(LICENSE_LEDGER)) {
    throw new Error(`license ledger not found: ${relative(SMA_ROOT, LICENSE_LEDGER)}. Run: node tools/sma-provenance-ledger.ts`);
  }
  const data = JSON.parse(readFileSync(LICENSE_LEDGER, 'utf8'));
  return buildLicenseIndex(data.licenses || []);
}

function loadTheft(): Map<string, TheftRecord> {
  const map = new Map<string, TheftRecord>();
  if (!existsSync(FINGERPRINT_LEDGER)) return map;
  try {
    const data = JSON.parse(readFileSync(FINGERPRINT_LEDGER, 'utf8'));
    for (const fp of data.fingerprints || []) {
      if (fp && typeof fp === 'object' && typeof fp.brick_id === 'string' && fp.copy_group) {
        map.set(fp.brick_id, fp);
      }
    }
  } catch { /* ignore */ }
  return map;
}

function collectBuildManifests(dir: string): string[] {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = resolve(cur, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (entry.isFile() && entry.name.endsWith('.build.sweetspot.json')) out.push(full);
    }
  }
  return out.sort();
}

// --- output -----------------------------------------------------------------

function writeReport(report: LicenseReport): void {
  const stable = { ...report, generated_at: '<generated_at>' };
  if (existsSync(OUT)) {
    try {
      const prev = JSON.parse(readFileSync(OUT, 'utf8'));
      if (JSON.stringify({ ...prev, generated_at: '<generated_at>' }) === JSON.stringify(stable)) return;
    } catch { /* rewrite */ }
  }
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
}

function printReport(report: LicenseReport): void {
  console.log(`SMA license-lattice gate: ${report.status}`);
  if (report.warning) console.log(`WARN — ${report.warning}`);
  console.log(`builds: ${report.build_count} | blocking: ${report.blocking_count} | warnings: ${report.warning_count} | theft-risk: ${report.theft_risk_count}`);
  for (const b of report.builds) {
    const flag = b.ok ? 'OK  ' : 'FAIL';
    console.log(`\n${flag} ${b.build}`);
    console.log(`     declared: visibility=${b.declared?.visibility} license=${b.declared?.license} publishable=${b.declared?.publishable}`);
    if (b.effective) console.log(`     effective (meet): openness=${b.effective.openness} visibility=${b.effective.visibility} license_class=${b.effective.license_class}`);
    for (const v of b.violations || []) {
      console.log(`     [${v.severity.toUpperCase()}] ${v.code}: ${v.message}`);
    }
  }
  if (report.theft_findings.length) {
    console.log(`\nRegistry theft-risk copies (${report.theft_findings.length}):`);
    for (const t of report.theft_findings.slice(0, 15)) {
      console.log(`  ${t.brick_id} copies ${t.copy_of} [group ${t.copy_group}]`);
    }
  }
  console.log(`\nwrote: ${relative(SMA_ROOT, OUT).split(sep).join('/')}`);
}

function parseArgs(list: string[]): LicenseGateArgs {
  const out: LicenseGateArgs = {};
  for (const arg of list) {
    if (!arg.startsWith('--')) continue;
    out[arg.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase())] = true;
  }
  return out;
}
