#!/usr/bin/env node
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

  // --- 2. Clone -----------------------------------------------------------
  rmrf(sandbox);
  fs.mkdirSync(sandbox, { recursive: true });
  log("step 1/5 sma-clone --write");
  const cloneArgs = ["tools/sma-clone.ts", "--build-manifest", manifestPath, "--target", sandbox, "--write"];
  if (opts.registry) cloneArgs.push("--registry", opts.registry);
  const cloneRes = run("node", cloneArgs, { cwd: repoRoot });
  const cloneOk = cloneRes.code === 0;
  const placementsPath = path.join(sandbox, ".smarch/placements.json");
  let placementCount = 0;
  if (exists(placementsPath)) {
    const pl = tryParseJson(fs.readFileSync(placementsPath, "utf8")) as { placements?: unknown[] } | null;
    placementCount = Array.isArray(pl?.placements) ? pl.placements.length : 0;
  }
  report.steps.clone = {
    ok: cloneOk,
    exit: cloneRes.code,
    placements_written: placementCount
  };
  if (!cloneOk) {
    fail("clone", `sma-clone exit ${String(cloneRes.code)}`, { stderr: cloneRes.stderr.slice(-600) });
  }

  // --- 3. Import-verify ---------------------------------------------------
  log("step 2/5 sma-import-verify");
  const verifyRes = run("node", ["tools/sma-import-verify.ts", "--target", sandbox, "--compact"], { cwd: repoRoot });
  const verifyDoc = tryParseJson(verifyRes.stdout) as ImportVerifyDocument | null;
  const verifyStatus = verifyDoc?.status ?? "unknown";
  const placementsHealth = (verifyDoc?.checks ?? []).find((check) => check.code === "placements.summary") ?? {};
  const buildLockHealth = (verifyDoc?.checks ?? []).find((check) => check.code === "build_lock.resolution") ?? {};
  report.steps.import_verify = {
    ok: verifyStatus === "pass",
    exit: verifyRes.code,
    status: verifyStatus,
    pass: verifyDoc?.counts?.pass ?? 0,
    fail: verifyDoc?.counts?.fail ?? 0,
    warn: verifyDoc?.counts?.warn ?? 0,
    missing_targets: placementsHealth.missing_targets ?? null,
    hash_mismatches: placementsHealth.hash_mismatches ?? null,
    release_exact_matches: buildLockHealth.release_exact_matches ?? null
  };
  if (verifyStatus !== "pass") {
    fail("import_verify", `import-verify status=${verifyStatus} (fail=${String(verifyDoc?.counts?.fail ?? "?")})`);
  }

  // --- 4. Rebuild dependents index ----------------------------------------
  log("step 3/5 sma-dependents-index --write");
  const depRes = run("node", ["tools/sma-dependents-index.ts", "--write", "--json"], { cwd: repoRoot });
  const depDoc = (tryParseJson(depRes.stdout) ?? tryParseJson(depRes.stdout.split("\n").pop() ?? '')) as DependentsDocument | null;
  report.steps.dependents_index = {
    ok: depRes.code === 0,
    exit: depRes.code,
    sources: depDoc?.summary?.source_bricks ?? null,
    links: depDoc?.summary?.links ?? null,
    projects: depDoc?.summary?.projects ?? null
  };
  if (depRes.code !== 0) fail("dependents_index", `dependents-index exit ${String(depRes.code)}`);

  // --- 5. Confirm sandbox is registered as dependent ----------------------
  log("step 4/5 verify sandbox registered as dependent");
  const depIndexPath = path.join(repoRoot, "registry/dependents.generated.json");
  const depIndex: DependentIndex = exists(depIndexPath) ? readJson(depIndexPath) as DependentIndex : { dependents: {} };
  const dependentsByBrick = depIndex.dependents ?? {};
  const sandboxAbs = path.resolve(sandbox);
  const registeredFor: string[] = [];
  const missingFor: string[] = [];
  for (const id of requiredBricks) {
    const list = Array.isArray(dependentsByBrick[id]) ? dependentsByBrick[id] : [];
    const hit = list.some((d) => {
      const root = (d.target_root ?? d.project_root) ?? "";
      return path.resolve(root) === sandboxAbs;
    });
    if (hit) registeredFor.push(id);
    else missingFor.push(id);
  }
  report.steps.dependent_registration = {
    ok: missingFor.length === 0 && requiredBricks.length > 0,
    registered: registeredFor.length,
    missing: missingFor.length,
    required: requiredBricks.length,
    missing_brick_ids: missingFor
  };
  if (missingFor.length > 0) {
    fail("dependent_registration", `sandbox missing as dependent for ${String(missingFor.length)}/${String(requiredBricks.length)} required bricks`, { missing: missingFor });
  }

  // --- 6. Plan-dry-run propagation ---------------------------------------
  log("step 5/5 sma-propagate dry-run for each required brick");
  const propPlans: { brick_id: string; exit: number; planned_for_sandbox: boolean; target_count: number }[] = [];
  let propPlanned = 0;
  let propFailed = 0;
  for (const id of requiredBricks) {
    const r = run("node", ["tools/sma-propagate.ts", "--source-brick", id, "--json"], { cwd: repoRoot });
    const doc = tryParseJson(r.stdout);
    // sma-propagate emits an array of per-source-brick reports; pick the one for this brick.
    const reports = (Array.isArray(doc) ? doc : doc ? [doc] : []) as PropagationReport[];
    const report = (reports.find((d) => d.source_brick_id === id) ?? reports[0]) ?? {};
    const targets = (report.fan_out ?? report.targets) ?? [];
    const planned = targets.some((t) => {
      const root = t.target_root ?? "";
      const status = (t.action ?? t.status) ?? "";
      return path.resolve(root) === sandboxAbs && /plan|dry-run|written/.test(status);
    });
    if (planned) propPlanned += 1;
    else propFailed += 1;
    propPlans.push({ brick_id: id, exit: r.code, planned_for_sandbox: planned, target_count: targets.length });
  }
  report.steps.propagation = {
    ok: propFailed === 0 && propPlanned > 0,
    planned: propPlanned,
    failed: propFailed,
    per_brick: propPlans
  };
  if (propFailed > 0 || propPlanned === 0) {
    fail("propagation", `propagation planned for ${String(propPlanned)}/${String(requiredBricks.length)} required bricks`);
  }

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
