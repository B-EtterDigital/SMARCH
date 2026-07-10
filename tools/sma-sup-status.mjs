#!/usr/bin/env node
// SUP (Sweetspot Ultra Plan) portfolio roll-up.
// Reads .UltraVision/meta/ artifacts from registered project roots and writes
// wiki/sup/SUP_STATUS.generated.md (+ --json to stdout).
//
// Project registration: wiki/sup/projects.json
//   { "projects": [ { "id": "acme-factory", "root": "/abs/path/to/repo" } ] }
// or ad hoc: node tools/sma-sup-status.mjs --roots /path/a,/path/b
//
// SUP is opt-in (docs/SUP_SWEETSPOT_ULTRA_PLAN.md): a project without
// .UltraVision/ is reported as "no SUP plan", never treated as a gap.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const rootsArg = args.find((a) => a.startsWith("--roots"));

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

let projects = [];
if (rootsArg) {
  const list = (rootsArg.includes("=") ? rootsArg.split("=")[1] : args[args.indexOf(rootsArg) + 1]) || "";
  projects = list.split(",").filter(Boolean).map((r) => ({ id: basename(resolve(r)), root: resolve(r) }));
} else {
  const cfg = readJson(join(SMA_ROOT, "wiki", "sup", "projects.json"));
  projects = cfg?.projects ?? [];
}

if (projects.length === 0) {
  console.log("[sup:status] no projects registered.");
  console.log("Register SUP-planned repos in wiki/sup/projects.json:");
  console.log('  { "projects": [ { "id": "acme-factory", "root": "/home/.../acme-factory" } ] }');
  console.log("or run with --roots /path/a,/path/b");
  process.exit(0);
}

const rows = [];
for (const p of projects) {
  const uv = join(p.root, ".UltraVision");
  if (!existsSync(uv)) {
    rows.push({ id: p.id, root: p.root, sup: false });
    continue;
  }
  const stats = readJson(join(uv, "meta", "stats.json"));
  const validation = readJson(join(uv, "meta", "validation-report.json"));
  const state = readJson(join(uv, "meta", "pipeline-state.json"));
  const t = stats?.totals ?? {};
  const phases = state?.phases ?? {};
  const phase = Object.entries(phases).filter(([, v]) =>
    v?.status === "done" || v?.status === "approved").map(([k]) => k).pop() ?? "?";
  rows.push({
    id: p.id, root: p.root, sup: true,
    tasks: t.tasks ?? 0, done: t.done ?? 0,
    percent: t.percent_complete ?? 0,
    remaining_h: Math.round((t.est_minutes_remaining ?? 0) / 60),
    paid: stats?.paid_tasks ?? 0,
    validator: validation ? (validation.pass ? "PASS" : "FAIL") : "n/a",
    validated_at: validation?.generated ?? null,
    mode: state?.mode ?? "?", last_phase: phase,
    generated: stats?.generated ?? null,
  });
}

const planned = rows.filter((r) => r.sup);
const totals = planned.reduce((a, r) => ({
  tasks: a.tasks + r.tasks, done: a.done + r.done, remaining_h: a.remaining_h + r.remaining_h,
  paid: a.paid + r.paid,
}), { tasks: 0, done: 0, remaining_h: 0, paid: 0 });

if (asJson) {
  console.log(JSON.stringify({ generated: new Date().toISOString(), rows, totals }, null, 2));
}

const md = [];
md.push("# SUP Portfolio Status");
md.push("");
md.push(`> Generated ${new Date().toISOString()} by \`npm run sup:status\`. SUP is opt-in — see docs/SUP_SWEETSPOT_ULTRA_PLAN.md.`);
md.push("");
md.push(`**${planned.length}/${rows.length} registered project(s) SUP-planned** · ${totals.tasks} tasks · ${totals.done} done · ~${totals.remaining_h}h remaining · ${totals.paid} paid task(s) pending approval`);
md.push("");
md.push("| Project | Mode | Phase | Tasks | Done | % | Remaining | Paid | Validator | Stats age |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  if (!r.sup) { md.push(`| ${r.id} | — | no SUP plan | | | | | | | |`); continue; }
  md.push(`| ${r.id} | ${r.mode} | ${r.last_phase} | ${r.tasks} | ${r.done} | ${r.percent}% | ~${r.remaining_h}h | ${r.paid} | ${r.validator} | ${r.generated ?? "?"} |`);
}
md.push("");
md.push("Refresh a project's numbers inside that repo first: `uvp stats && uvp render` (stale stats here mean stale source files there).");

const outDir = join(SMA_ROOT, "wiki", "sup");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "SUP_STATUS.generated.md"), md.join("\n") + "\n");
if (!asJson) {
  console.log(`[sup:status] ${planned.length}/${rows.length} project(s) planned · ${totals.tasks} tasks · ${totals.done} done`);
  console.log(`[sup:status] wrote wiki/sup/SUP_STATUS.generated.md`);
}
