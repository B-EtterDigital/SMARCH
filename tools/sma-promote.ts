#!/usr/bin/env node
/**
 * What: Recomputes each enriched brick's lifecycle status from current evidence.
 * Why: Reuse maturity must reflect semantics, tests, warnings, and context rather than aspiration.
 * How: Reads the candidate inventory and source manifests, then updates manifests unless dry-run is set.
 * Callers: Registry lifecycle workflows run it after enrichment and before publishing decisions.
 * Example: `printf '{"bricks":[]}\n' | node tools/sma-promote.ts --candidates /dev/stdin --dry-run`
 */
/**
 * sma-promote: read each enriched brick and decide status (candidate / canonical).
 *
 * Rules (driven by the SMA SVA/SEV/SRLS/SSC gates):
 *
 *   → candidate  when semantics.{purpose, tags, public_api, clone_steps} are present
 *                 AND filter_score >= 40.
 *
 *   → canonical  when candidate criteria are met AND
 *                  - has at least one test next to the brick (sibling
 *                    __tests__/, *.test.*, *.spec.*)
 *                  - OR brick kind is in {migration_file, supabase_function,
 *                    utility_file, types_module} (kinds whose reuse proof is
 *                    mostly structural rather than test-based)
 *                  AND no high-severity sweetspot warning in the manifest
 *                    (env_incomplete is fine for now; rls_incomplete blocks
 *                    canonical only when data_classes include user_private,
 *                    pii, payment, or credential).
 *
 * Leaves status as `project_bound` when neither criterion is met. Writes the
 * updated manifest in place.
 *
 * Gen-3 context gate (additive):
 *   --context-gate          warn when a brick about to be promoted has no
 *                           active lease (by current agent) and no recent
 *                           agent-context event. Does not block promotion.
 *   --strict-context-gate   same check, but blocks: forces status to
 *                           `project_bound` with reason `context-gate-failed`.
 *   --context-window-minutes <n>
 *                           how recent a context event needs to be (default 1440).
 *   --no-context-gate       explicitly off (the default).
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readActiveLeases, readProjectContextCoverage } from "./lib/gen3-state.ts";
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";

function parseArgs(argv): Record<string, any> {
  const opts = {
    candidates: smaPath("security/reuse_candidates.json"),
    dryRun: false,
    contextGate: false,
    strictContextGate: false,
    contextWindowMinutes: 1440
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--candidates" && n) { opts.candidates = path.resolve(n); i += 1; }
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--context-gate") opts.contextGate = true;
    else if (a === "--strict-context-gate") { opts.contextGate = true; opts.strictContextGate = true; }
    else if (a === "--no-context-gate") opts.contextGate = false;
    else if (a === "--context-window-minutes" && n) { opts.contextWindowMinutes = Number(n); i += 1; }
  }
  return opts;
}

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

async function hasSiblingTest(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (e.name === "__tests__" || e.name === "tests")) return true;
      if (e.isFile() && /\.(test|spec)\.(t|j)sx?$/i.test(e.name)) return true;
    }
  } catch {
    // Missing or unreadable sibling directories mean no test evidence for promotion.
  }
  return false;
}

const structuralKinds = new Set([
  "migration_file", "supabase_function", "utility_file",
  "types_module", "schema_module", "theme_module",
  "script_file", "script_module"
]);

function isSensitive(dataClasses) {
  const s = new Set(dataClasses || []);
  return s.has("user_private") || s.has("pii") || s.has("payment") || s.has("credential") || s.has("admin_only");
}

async function decideStatus(brick, manifest) {
  const sem = manifest.semantics || {};
  const hasAllSemantics = Boolean(
    sem.purpose && sem.tags && sem.tags.length && sem.public_api && sem.public_api.length && sem.clone_steps && sem.clone_steps.length
  );

  if (!hasAllSemantics) return { status: "project_bound", reason: "missing-semantics" };

  if (typeof brick.score === "number" && brick.score < 40) {
    return { status: "project_bound", reason: "low-score" };
  }

  const srcPath = (brick.source_paths || [])[0];
  const abs = srcPath
    ? path.resolve(PROJECTS_ROOT, brick.project || "", srcPath)
    : path.dirname(brick.manifest_path);
  let parentDir = abs;
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) parentDir = path.dirname(abs);
  } catch {
    // Keep the source-derived parent when the candidate path cannot be inspected.
  }

  const hasTests = await hasSiblingTest(parentDir);
  const kind = brick.kind || manifest.brick?.kind || "";

  const sensitive = isSensitive(manifest.classification?.data_classes);
  const warnings = manifest.sweetspot?.ssa_v2?.evidence || [];
  const rlsBlocked = sensitive && (
    manifest.sweetspot?.srls?.status === "unknown" || manifest.sweetspot?.srls?.status === "missing"
  );

  const canonicalEligible = (hasTests || structuralKinds.has(kind)) && !rlsBlocked;

  if (canonicalEligible) return { status: "canonical", reason: "gates-met" };
  return { status: "candidate", reason: "missing-tests-or-rls" };
}

// ── context gate ────────────────────────────────────────────────────────────


function findProjectRoot(brick) {
  const candidate = brick.project ? path.resolve(PROJECTS_ROOT, brick.project) : null;
  if (candidate && existsSync(candidate)) return candidate;
  if (brick.project) {
    try {
      for (const ent of readdirSync(PROJECTS_ROOT)) {
        if (ent.toLowerCase().includes(String(brick.project).toLowerCase())) {
          return path.resolve(PROJECTS_ROOT, ent);
        }
      }
    } catch {
      // An unreadable projects root has no case-insensitive fallback match.
    }
  }
  return null;
}

let cachedLeases = null;
function getLeasesOnce() {
  if (cachedLeases === null) cachedLeases = readActiveLeases();
  return cachedLeases;
}

function checkContextGate(brick, manifest, opts) {
  const brickId = manifest.brick?.id || brick.id;
  const agent = process.env.SMA_AGENT || process.env.USER || "unknown";

  const leases = getLeasesOnce();
  const heldByMe = leases.leases.find(
    (l) => l.resource_kind === "brick" && l.resource_id === brickId && l.agent_id === agent
  );
  if (heldByMe) return { ok: true, reason: `lease ${heldByMe.lease_id}` };

  const projectRoot = findProjectRoot(brick);
  if (!projectRoot) return { ok: false, reason: "project-root-not-resolved" };

  const ctx = readProjectContextCoverage(projectRoot);
  const safeId = String(brickId).replace(/[^a-z0-9._-]/gi, "_");
  const brickEntry = ctx.bricks.find((b) => b.brick_id === safeId);
  if (!brickEntry) return { ok: false, reason: "no-context-events-for-brick" };

  const lastTs = brickEntry.last_event_at ? Date.parse(brickEntry.last_event_at) : 0;
  const cutoff = Date.now() - Number(opts.contextWindowMinutes) * 60 * 1000;
  if (lastTs >= cutoff) return { ok: true, reason: `recent-event:${brickEntry.last_event_at}` };
  return { ok: false, reason: `last-event-too-old:${brickEntry.last_event_at}` };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cands = await readJson(opts.candidates);

  const counts = { canonical: 0, candidate: 0, project_bound: 0, errors: 0 };
  const reasons = {};
  const contextWarnings = [];

  for (const brick of cands.bricks) {
    try {
      const mf = JSON.parse(await fs.readFile(brick.manifest_path, "utf8"));
      let decision = await decideStatus(brick, mf);

      // Apply context gate AFTER the structural decision so we can downgrade
      // a would-be canonical/candidate brick if the gate is strict.
      if (opts.contextGate && decision.status !== "project_bound") {
        const gate = checkContextGate(brick, mf, opts);
        if (!gate.ok) {
          contextWarnings.push({
            brick_id: mf.brick?.id || brick.id,
            project: brick.project,
            attempted_status: decision.status,
            reason: gate.reason,
          });
          if (opts.strictContextGate) {
            decision = { status: "project_bound", reason: `context-gate-failed:${gate.reason}` };
          }
        }
      }

      // Write status
      if (!mf.brick) mf.brick = {};
      mf.brick.status = decision.status;
      mf.brick.last_promotion_check = new Date().toISOString();
      mf.brick.last_promotion_reason = decision.reason;

      if (decision.status === "canonical" || decision.status === "candidate") {
        mf.clone = mf.clone || {};
        if (!mf.clone.readiness || mf.clone.readiness === "blocked" || mf.clone.readiness === "manual_only") {
          mf.clone.readiness = decision.status === "canonical" ? "automatic" : "semi_automatic";
        }
      }

      counts[decision.status] += 1;
      reasons[decision.reason] = (reasons[decision.reason] || 0) + 1;

      if (!opts.dryRun) {
        await fs.writeFile(brick.manifest_path, `${JSON.stringify(mf, null, 2)}\n`);
      }
    } catch (err) {
      counts.errors += 1;
    }
  }

  console.log(JSON.stringify({
    considered: cands.bricks.length,
    results: counts,
    reasons,
    dry_run: opts.dryRun,
    context_gate: opts.contextGate ? (opts.strictContextGate ? "strict" : "warn") : "off",
    context_warning_count: contextWarnings.length,
    context_warnings: contextWarnings.slice(0, 25),
  }, null, 2));
}

main();
