#!/usr/bin/env node
/**
 * WHAT: Runs the repository-wide sequence of scans, validators, security checks, coordination checks, and documentation builds.
 * WHY: Integrators need one fail-closed command that proves all required [gates](../docs/GLOSSARY.md#gate) agree before release.
 * HOW: Accepts project and strictness options, invokes the underlying tools, and returns a combined status to automation and controllers.
 * Usage: `node tools/sma-ci.mjs --help`
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTS_ROOT } from "./lib/sma-paths.ts";

const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const defaults = {
  root: PROJECTS_ROOT,
  registry: path.join(smaRoot, "registry", "global-modules.generated.json"),
  wiki: path.join(smaRoot, "wiki"),
  requireContext: false,
  contextStrict: false,
  contextProjects: null,
  requireNoConflicts: false,
  conflictStrict: false,
  conflictProjects: null,
  requireCleanOrLeased: false,
  dirtyStrict: false,
  dirtyProjects: null
};

function parseArgs(argv) {
  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--root" && next) {
      options.root = path.resolve(next);
      i += 1;
    } else if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--wiki" && next) {
      options.wiki = path.resolve(next);
      i += 1;
    } else if (arg === "--require-context") {
      options.requireContext = true;
    } else if (arg === "--context-strict") {
      options.requireContext = true;
      options.contextStrict = true;
    } else if (arg === "--context-projects" && next) {
      options.contextProjects = next.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--require-no-conflicts") {
      options.requireNoConflicts = true;
    } else if (arg === "--conflict-strict") {
      options.requireNoConflicts = true;
      options.conflictStrict = true;
    } else if (arg === "--conflict-projects" && next) {
      options.conflictProjects = next.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--require-clean-or-leased") {
      options.requireCleanOrLeased = true;
    } else if (arg === "--dirty-strict" || arg === "--clean-or-leased-strict") {
      options.requireCleanOrLeased = true;
      options.dirtyStrict = true;
    } else if ((arg === "--dirty-projects" || arg === "--controller-projects") && next) {
      options.dirtyProjects = next.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA CI

Usage:
  node tools/sma-ci.mjs [--root <dir>] [--registry <path>] [--wiki <path>]
                       [--require-context] [--context-strict]
                       [--context-projects <id,id,...>]
                       [--require-no-conflicts] [--conflict-strict]
                       [--conflict-projects <id,id,...>]
                       [--require-clean-or-leased] [--dirty-strict]
                       [--dirty-projects <id,id,...>]

  --require-context    Run sma-context-check check on each project that has
                       modified manifests in git status. Warns by default.
  --context-strict     Same as --require-context but exits non-zero (3) on miss.
  --context-projects   Comma-separated project ids to scope the context-check.
                       Default: every dir under --root that contains .smarch/.
  --require-no-conflicts
                       Run sma-conflict check on each project. Warns by default.
  --conflict-strict    Same as --require-no-conflicts but exits non-zero (3)
                       when unresolved conflict reports remain.
  --conflict-projects  Comma-separated project ids to scope the conflict-check.
                       Default: --context-projects, otherwise every .smarch project.
  --require-clean-or-leased
                       Run controller snapshot dirty-claim/scope check. Warns by default.
  --dirty-strict       Same as --require-clean-or-leased but exits non-zero (4)
                       when dirty files are unleased or outside active lease scope.
  --dirty-projects     Comma-separated project ids to scope the dirty-claim check.
                       Default: --conflict-projects, then --context-projects,
                       otherwise every .smarch project.
`);
      process.exit(0);
    }
  }

  return options;
}

function run(label, script, args) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, [path.join(smaRoot, "tools", script), ...args], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runLeased(label, lease, script, args) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, [
    path.join(smaRoot, "tools", "sma-lease.mjs"),
    "run",
    "--resource-kind", lease.resourceKind,
    "--resource", lease.resource,
    "--intent", lease.intent,
    "--ttl", String(lease.ttlSeconds ?? 900),
    "--renew-every", String(lease.renewEverySeconds ?? 300),
    "--project", lease.project ?? "sma",
    "--",
    process.execPath,
    path.join(smaRoot, "tools", script),
    ...args
  ], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function discoverProjects(root) {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const projDir = path.join(root, ent.name);
      try {
        const sub = readdirSync(projDir);
        if (sub.includes(".smarch")) out.push(ent.name);
      } catch { /* ignore */ }
    }
    return out;
  } catch {
    return [];
  }
}

function runContextCheck(options) {
  const projects = options.contextProjects ?? discoverProjects(options.root);
  if (!projects.length) {
    console.log("\n== context-check ==");
    console.log("(no projects with .smarch/ found; skipping)");
    return;
  }

  console.log("\n== context-check ==");
  let totalMissing = 0;
  for (const projectId of projects) {
    const args = ["check", "--project", projectId];
    if (options.contextStrict) args.push("--strict");
    const res = spawnSync(process.execPath, [path.join(smaRoot, "tools", "sma-context-check.mjs"), ...args], {
      stdio: "inherit"
    });
    if (res.status === 3) {
      totalMissing += 1;
    } else if (res.status !== 0) {
      console.error(`context-check error in ${projectId} (exit ${res.status})`);
      if (options.contextStrict) process.exit(res.status ?? 1);
    }
  }
  if (options.contextStrict && totalMissing) {
    console.error(`\nFAIL: ${totalMissing} project(s) have modified manifests without matching agent-context events`);
    process.exit(3);
  }
  if (totalMissing) {
    console.log(`\nWARN: ${totalMissing} project(s) have modified manifests without matching agent-context events (use --context-strict to gate)`);
  }
}

function runConflictCheck(options) {
  const projects = options.conflictProjects ?? options.contextProjects ?? discoverProjects(options.root);
  if (!projects.length) {
    console.log("\n== conflict-check ==");
    console.log("(no projects with .smarch/ found; skipping)");
    return;
  }

  console.log("\n== conflict-check ==");
  let totalOpen = 0;
  let totalErrors = 0;
  for (const projectId of projects) {
    const res = spawnSync(process.execPath, [
      path.join(smaRoot, "tools", "sma-conflict.mjs"),
      "check",
      "--project",
      projectId,
      "--json"
    ], {
      encoding: "utf8"
    });

    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      totalErrors += 1;
      console.error(`conflict-check error in ${projectId} (exit ${res.status})`);
      if (options.conflictStrict) process.exit(res.status ?? 1);
      continue;
    }

    let result;
    try {
      result = JSON.parse(res.stdout);
    } catch (err) {
      totalErrors += 1;
      console.error(`conflict-check parse error in ${projectId}: ${err.message}`);
      if (res.stdout) process.stdout.write(res.stdout);
      if (options.conflictStrict) process.exit(1);
      continue;
    }

    const open = Number(result.open_conflicts ?? 0);
    totalOpen += open;
    console.log(`project:        ${projectId}`);
    console.log(`open conflicts: ${open}`);
    console.log(`status:         ${result.status ?? (open ? "blocked" : "clear")}`);
    for (const event of result.conflicts ?? []) {
      console.log(`  - ${event.brick_id} ${event.timestamp} ${event.actor_id}: ${event.intent}`);
      if (event.decision_rationale) console.log(`    ${event.decision_rationale}`);
    }
  }

  if (options.conflictStrict && totalOpen) {
    console.error(`\nFAIL: ${totalOpen} unresolved conflict report(s) remain`);
    process.exit(3);
  }
  if (totalOpen) {
    console.log(`\nWARN: ${totalOpen} unresolved conflict report(s) remain (use --conflict-strict to gate)`);
  }
  if (totalErrors) {
    console.log(`\nWARN: ${totalErrors} project(s) could not be checked for unresolved conflicts`);
  }
}

function runDirtyClaimCheck(options) {
  const projects = options.dirtyProjects ?? options.conflictProjects ?? options.contextProjects ?? discoverProjects(options.root);
  if (!projects.length) {
    console.log("\n== dirty-claim-check ==");
    console.log("(no projects with .smarch/ found; skipping)");
    return;
  }

  console.log("\n== dirty-claim-check ==");
  const snapshotArgs = ["--json", "--no-graphs", "--max-status", "12"];
  for (const projectId of projects) snapshotArgs.push("--project", projectId);
  const res = spawnSync(process.execPath, [
    path.join(smaRoot, "tools", "sma-controller-snapshot.mjs"),
    ...snapshotArgs
  ], {
    encoding: "utf8"
  });

  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    console.error(`dirty-claim-check error (exit ${res.status})`);
    if (options.dirtyStrict) process.exit(res.status ?? 1);
    return;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(res.stdout);
  } catch (err) {
    console.error(`dirty-claim-check parse error: ${err.message}`);
    if (res.stdout) process.stdout.write(res.stdout);
    if (options.dirtyStrict) process.exit(1);
    return;
  }

  const dirtyUnleased = snapshot.dirty_unleased_projects ?? [];
  const activeScope = (snapshot.action_items ?? []).filter((item) => item.kind === "active-dirty-scope");
  for (const project of snapshot.projects ?? []) {
    console.log(`project:          ${project.id}`);
    console.log(`status:           ${project.status}`);
    console.log(`dirty files:      ${project.git?.dirty_count ?? 0}`);
    console.log(`active leases:    ${project.active_leases?.length ?? 0}`);
    if (project.status === "dirty-unleased") {
      for (const line of project.git?.sample ?? []) console.log(`  ${line}`);
    }
  }
  for (const item of activeScope) {
    console.log(`active scope:     ${item.project}`);
    console.log(`uncovered paths:  ${item.uncovered_dirty_count ?? item.impact_score ?? 0}`);
    console.log(`claim:            ${item.command}`);
    if (item.next_commands?.conflict) console.log(`conflict:         ${item.next_commands.conflict}`);
  }

  if (options.dirtyStrict && (dirtyUnleased.length || activeScope.length)) {
    console.error(`\nFAIL: ${dirtyUnleased.length} project(s) have unleased dirty files; ${activeScope.length} project(s) have dirty files outside active lease scope`);
    console.error("Claim the work with start-edit/end-edit, clean or split the worktree, or report/resolve a conflict before integration.");
    process.exit(4);
  }
  if (dirtyUnleased.length) {
    console.log(`\nWARN: ${dirtyUnleased.length} project(s) have dirty files without an active Gen3 lease (use --dirty-strict to gate)`);
  }
  if (activeScope.length) {
    console.log(`\nWARN: ${activeScope.length} project(s) have dirty files outside active lease scope (use --dirty-strict to gate)`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  runLeased("scan", {
    resourceKind: "registry-regen",
    resource: "global-modules",
    intent: "ci gen3 registry scan",
    project: "sma",
    ttlSeconds: 900,
    renewEverySeconds: 300
  }, "sma-scan.mjs", ["--root", options.root, "--out", options.registry]);
  run("validate", "sma-validate.mjs", ["--registry", options.registry]);
  run("security", "sma-security-gate.mjs", ["--root", options.root]);
  // Rule + scope-drift gates enforce (block CI on violations). Baseline was
  // cleaned 2026-05-12; if the baseline regresses, fix the regression rather
  // than re-adding --warn-only.
  run("rule-gate", "sma-rule-gate.mjs", ["--all", "--report", "security/rule-gate.generated.json"]);
  run("scope-drift", "sma-scope-drift.mjs", ["--all", "--report", "security/scope-drift.generated.json"]);
  // Provenance/license enforcement: the composition lattice blocks a build from
  // being declared more open than its bricks, and seal verification catches an
  // edited creator trail. Both read the committed ledgers (all-projects
  // namespace), independent of this pipeline's global-modules scan.
  run("license-gate", "sma-license-gate.mjs", ["--gate"]);
  run("provenance-verify", "sma-provenance-verify.mjs", ["--gate"]);
  run("wiki", "sma-wiki.mjs", ["--registry", options.registry, "--out", options.wiki]);

  if (options.requireContext) {
    runContextCheck(options);
  }

  if (options.requireNoConflicts) {
    runConflictCheck(options);
  }

  if (options.requireCleanOrLeased) {
    runDirtyClaimCheck(options);
  }

  console.log("\nSMA CI complete");
}

main();
