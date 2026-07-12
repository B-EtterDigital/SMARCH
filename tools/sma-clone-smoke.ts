#!/usr/bin/env node
/* Spawn output crosses a runtime process boundary, so its defensive fallback remains required. */
/* CLI dispatch and smoke assertions are flat checklists; complexity counts each independent option and proof guard. */
/* eslint @typescript-eslint/no-unnecessary-condition: "off", complexity: "off" */
/**
 * WHAT: Exercises the complete cross-project clone, import verification, dependency indexing, and propagation path for a build.
 * WHY: A build is not reusable merely because its files copy; the downstream control-plane records must also remain coherent.
 * HOW: Accepts a build identity, creates a temporary target, runs the clone toolchain, and emits a report for release controllers.
 * Usage: `node tools/sma-clone-smoke.ts --help`
 */
/**
 * sma-clone-smoke: end-to-end smoke test for a build's cross-project clone path.
 *
 * Runs the batch-43 sequence as one CLI:
 *   1. Resolve build manifest (from build-index by id, or explicit path)
 *   2. Clone the build into a fresh sandbox (sma-clone --write)
 *   3. Verify imports (sma-import-verify)
 *   4. Rebuild the global dependents index (sma-dependents-index --write)
 *   5. Confirm sandbox is registered as dependent for each brick the build needs
 *   6. Plan-dry-run propagation for each of those bricks (sma-propagate)
 *
 * Emits a smarch.clone-smoke-report.v0 JSON summary. Returns exit code 0 on
 * pass, 1 on any failure. Sandbox is removed by default; use --keep to retain.
 *
 * Usage:
 *   node tools/sma-clone-smoke.ts --build <id>
 *   node tools/sma-clone-smoke.ts --build <id> --sandbox /tmp/foo --keep --json
 *   node tools/sma-clone-smoke.ts --build-manifest path/to/build.sweetspot.json
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTS_ROOT } from "./lib/sma-paths.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
// sma-dependents-index hardcodes ~/DEV/Projects as its scan root,
// so a smoke sandbox must live there for the dependent-registration step to pass.

interface CloneOptions { buildId: string; buildIndex: string; buildManifest: string; json: boolean; keep: boolean; registry: string; sandbox: string }
interface DerivedBrick { brick_id: string; path?: string; required: boolean; role?: string }
interface BuildManifestInput { build?: { id?: string; slug?: string }; source?: { derived_from_bricks?: { brick_id: string; path?: string; required?: boolean; role?: string }[] } }
interface CloneReport { build_id: string; bricks: { required: number; total: number }; completed_at?: string; failures: Record<string, unknown>[]; generated_at: string; manifest_path: string; overall: 'fail' | 'pass'; sandbox: string; schema: string; steps: Record<string, unknown> }
interface ImportVerifyDocument { checks?: (Record<string, unknown> & { code?: string })[]; counts?: { fail?: number; pass?: number; warn?: number }; status?: string }
interface DependentsDocument { summary?: { links?: number; projects?: number; source_bricks?: number } }
interface DependentIndex { dependents?: Record<string, { project_root?: string; target_root?: string }[]> }
interface PropagationReport { fan_out?: PropagationTarget[]; source_brick_id?: string; targets?: PropagationTarget[] }
interface PropagationTarget { action?: string; status?: string; target_root?: string }

function parseArgs(argv: string[]): CloneOptions {
  const o: CloneOptions = {
    buildId: "",
    buildManifest: "",
    sandbox: "",
    keep: false,
    json: false,
    buildIndex: path.join(repoRoot, "builds/build-index.generated.json"),
    registry: ""
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--build" && n) { o.buildId = n; i += 1; }
    else if (a === "--build-manifest" && n) { o.buildManifest = path.resolve(n); i += 1; }
    else if (a === "--sandbox" && n) { o.sandbox = path.resolve(n); i += 1; }
    else if (a === "--build-index" && n) { o.buildIndex = path.resolve(n); i += 1; }
    else if (a === "--registry" && n) { o.registry = path.resolve(n); i += 1; }
    else if (a === "--keep") o.keep = true;
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return o;
}

function printHelp() {
  process.stdout.write(`sma-clone-smoke

End-to-end smoke test for a build's cross-project clone path.

Usage:
  node tools/sma-clone-smoke.ts --build <id>
  node tools/sma-clone-smoke.ts --build-manifest <path>

Options:
  --build <id>            Build id (resolved against build-index)
  --build-manifest <path> Path to a build.sweetspot.json (overrides --build)
  --sandbox <path>        Sandbox directory (default: tmpdir/sma-clone-smoke-<slug>-<ts>)
  --build-index <path>    Override build index path
  --registry <path>       Pass-through to sma-clone --registry
  --keep                  Don't remove the sandbox after the run
  --json                  Print only the JSON report on stdout
  --help                  Show this help
`);
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
}

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function run(cmd: string, args: string[], opts: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error?.message ?? ""
  };
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch {
    // Fall through to the prefixed-output parser.
  }
  // Some tools print human-readable lines before the JSON document. Skip
  // leading lines until one starts with `[` or `{`, then parse the rest.
  const lines = (s || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { return JSON.parse(lines.slice(i).join("\n")); } catch {
        // Continue searching for a later JSON document boundary.
      }
    }
  }
  return null;
}

function rmrf(p: string): void {
  if (!exists(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function resolveBuildManifest(opts: CloneOptions): string {
  if (opts.buildManifest) {
    if (!exists(opts.buildManifest)) {
      throw new Error(`build manifest not found: ${opts.buildManifest}`);
    }
    return opts.buildManifest;
  }
  if (!opts.buildId) throw new Error("Either --build or --build-manifest is required");
  const idx = readJson(opts.buildIndex) as { builds?: { build_id: string; file?: string }[] };
  const entry = (idx.builds ?? []).find((build) => build.build_id === opts.buildId);
  if (!entry) throw new Error(`build not found in index: ${opts.buildId}`);
  if (!entry.file) throw new Error(`build index entry has no file path: ${opts.buildId}`);
  return path.resolve(repoRoot, entry.file);
}

function brickIdsFromManifest(manifest: BuildManifestInput): DerivedBrick[] {
  const list = manifest.source?.derived_from_bricks ?? [];
  return list.map((b) => ({
    brick_id: b.brick_id,
    required: b.required !== false,
    role: b.role,
    path: b.path
  }));
}

function defaultSandbox(slug: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "").replace(/-/g, "").slice(0, 15);
  return path.join(PROJECTS_ROOT, `_sma-smoke-${slug}-${ts}`);
}

type SmokeLog = (message: string) => void;
type SmokeFail = (step: string, message: string, extra?: Record<string, unknown>) => void;

function runCloneStep(opts: CloneOptions, manifestPath: string, sandbox: string, report: CloneReport, log: SmokeLog, fail: SmokeFail): void {
  rmrf(sandbox);
  fs.mkdirSync(sandbox, { recursive: true });
  log("step 1/5 sma-clone --write");
  const cloneArgs = ["tools/sma-clone.ts", "--build-manifest", manifestPath, "--target", sandbox, "--write"];
  if (opts.registry) cloneArgs.push("--registry", opts.registry);
  const result = run("node", cloneArgs, { cwd: repoRoot });
  const placementsPath = path.join(sandbox, ".smarch/placements.json");
  let placementCount = 0;
  if (exists(placementsPath)) {
    const placements = tryParseJson(fs.readFileSync(placementsPath, "utf8")) as { placements?: unknown[] } | null;
    placementCount = Array.isArray(placements?.placements) ? placements.placements.length : 0;
  }
  report.steps.clone = { ok: result.code === 0, exit: result.code, placements_written: placementCount };
  if (result.code !== 0) fail("clone", `sma-clone exit ${String(result.code)}`, { stderr: result.stderr.slice(-600) });
}

function runImportVerifyStep(sandbox: string, report: CloneReport, log: SmokeLog, fail: SmokeFail): void {
  log("step 2/5 sma-import-verify");
  const result = run("node", ["tools/sma-import-verify.ts", "--target", sandbox, "--compact"], { cwd: repoRoot });
  const document = tryParseJson(result.stdout) as ImportVerifyDocument | null;
  const status = document?.status ?? "unknown";
  const placements = (document?.checks ?? []).find((check) => check.code === "placements.summary") ?? {};
  const buildLock = (document?.checks ?? []).find((check) => check.code === "build_lock.resolution") ?? {};
  report.steps.import_verify = {
    ok: status === "pass", exit: result.code, status, pass: document?.counts?.pass ?? 0,
    fail: document?.counts?.fail ?? 0, warn: document?.counts?.warn ?? 0,
    missing_targets: placements.missing_targets ?? null, hash_mismatches: placements.hash_mismatches ?? null,
    release_exact_matches: buildLock.release_exact_matches ?? null,
  };
  if (status !== "pass") fail("import_verify", `import-verify status=${status} (fail=${String(document?.counts?.fail ?? "?")})`);
}

function runDependentsIndexStep(report: CloneReport, log: SmokeLog, fail: SmokeFail): void {
  log("step 3/5 sma-dependents-index --write");
  const result = run("node", ["tools/sma-dependents-index.ts", "--write", "--json"], { cwd: repoRoot });
  const document = (tryParseJson(result.stdout) ?? tryParseJson(result.stdout.split("\n").pop() ?? '')) as DependentsDocument | null;
  report.steps.dependents_index = {
    ok: result.code === 0, exit: result.code, sources: document?.summary?.source_bricks ?? null,
    links: document?.summary?.links ?? null, projects: document?.summary?.projects ?? null,
  };
  if (result.code !== 0) fail("dependents_index", `dependents-index exit ${String(result.code)}`);
}

function verifyDependentRegistration(sandbox: string, requiredBricks: string[], report: CloneReport, log: SmokeLog, fail: SmokeFail): string {
  log("step 4/5 verify sandbox registered as dependent");
  const depIndexPath = path.join(repoRoot, "registry/dependents.generated.json");
  const depIndex: DependentIndex = exists(depIndexPath) ? readJson(depIndexPath) as DependentIndex : { dependents: {} };
  const sandboxAbs = path.resolve(sandbox);
  const registeredFor: string[] = [];
  const missingFor: string[] = [];
  for (const id of requiredBricks) {
    const list = Array.isArray(depIndex.dependents?.[id]) ? depIndex.dependents[id] : [];
    const hit = list.some((dependent) => path.resolve((dependent.target_root ?? dependent.project_root) ?? "") === sandboxAbs);
    (hit ? registeredFor : missingFor).push(id);
  }
  report.steps.dependent_registration = {
    ok: missingFor.length === 0 && requiredBricks.length > 0, registered: registeredFor.length,
    missing: missingFor.length, required: requiredBricks.length, missing_brick_ids: missingFor,
  };
  if (missingFor.length) fail("dependent_registration", `sandbox missing as dependent for ${String(missingFor.length)}/${String(requiredBricks.length)} required bricks`, { missing: missingFor });
  return sandboxAbs;
}

function runPropagationStep(requiredBricks: string[], sandboxAbs: string, report: CloneReport, log: SmokeLog, fail: SmokeFail): void {
  log("step 5/5 sma-propagate dry-run for each required brick");
  const plans: { brick_id: string; exit: number; planned_for_sandbox: boolean; target_count: number }[] = [];
  let plannedCount = 0;
  for (const id of requiredBricks) {
    const result = run("node", ["tools/sma-propagate.ts", "--source-brick", id, "--json"], { cwd: repoRoot });
    const document = tryParseJson(result.stdout);
    const reports = (Array.isArray(document) ? document : document ? [document] : []) as PropagationReport[];
    const propagation = (reports.find((entry) => entry.source_brick_id === id) ?? reports[0]) ?? {};
    const targets = (propagation.fan_out ?? propagation.targets) ?? [];
    const planned = targets.some((target) => path.resolve(target.target_root ?? "") === sandboxAbs && /plan|dry-run|written/.test((target.action ?? target.status) ?? ""));
    if (planned) plannedCount += 1;
    plans.push({ brick_id: id, exit: result.code, planned_for_sandbox: planned, target_count: targets.length });
  }
  const failedCount = requiredBricks.length - plannedCount;
  report.steps.propagation = { ok: failedCount === 0 && plannedCount > 0, planned: plannedCount, failed: failedCount, per_brick: plans };
  if (failedCount > 0 || plannedCount === 0) fail("propagation", `propagation planned for ${String(plannedCount)}/${String(requiredBricks.length)} required bricks`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const log = (msg: string) => { if (!opts.json) process.stderr.write(`[smoke] ${msg}\n`); };

  // --- 1. Resolve manifest -------------------------------------------------
  let manifestPath;
  let manifest: BuildManifestInput;
  try {
    manifestPath = resolveBuildManifest(opts);
    manifest = readJson(manifestPath) as BuildManifestInput;
  } catch (e: unknown) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const buildId = manifest.build?.id ?? opts.buildId;
  const slug = manifest.build?.slug ?? (buildId || "build").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const sandbox = opts.sandbox || defaultSandbox(slug);
  const bricks = brickIdsFromManifest(manifest);
  const requiredBricks = bricks.filter((b) => b.required).map((b) => b.brick_id);
  log(`build: ${buildId}`);
  log(`manifest: ${manifestPath}`);
  log(`sandbox: ${sandbox}`);
  log(`derived bricks: ${String(bricks.length)} (${String(requiredBricks.length)} required)`);

  const report: CloneReport = {
    schema: "smarch.clone-smoke-report.v0",
    generated_at: startedAt,
    build_id: buildId,
    manifest_path: path.relative(repoRoot, manifestPath),
    sandbox,
    bricks: { total: bricks.length, required: requiredBricks.length },
    steps: {},
    overall: "fail",
    failures: []
  };

  const fail = (step: string, message: string, extra: Record<string, unknown> = {}) => {
    report.failures.push({ step, message, ...extra });
  };

  runCloneStep(opts, manifestPath, sandbox, report, log, fail);
  runImportVerifyStep(sandbox, report, log, fail);
  runDependentsIndexStep(report, log, fail);
  const sandboxAbs = verifyDependentRegistration(sandbox, requiredBricks, report, log, fail);
  runPropagationStep(requiredBricks, sandboxAbs, report, log, fail);

  // --- Verdict ------------------------------------------------------------
  report.overall = report.failures.length === 0 ? "pass" : "fail";
  report.completed_at = new Date().toISOString();

  if (!opts.keep) rmrf(sandbox);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
  process.exit(report.overall === "pass" ? 0 : 1);
}

main();
