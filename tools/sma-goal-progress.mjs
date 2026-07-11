#!/usr/bin/env node
/**
 * WHAT: Reports progress toward the configured generation-three work-hour goal.
 * WHY: Append-only work evidence needs a consistent rollup for dashboards and status reports.
 * HOW: Aggregates agent-context events by project and renders text, structured data, or a page fragment.
 * INPUTS: Goal hours, optional project filters, output format, and optional output path.
 * OUTPUTS: A progress report on standard output or in the requested file.
 * CALLERS: The generation-three dashboard and operators tracking evidence-backed progress.
 * Usage: `node tools/sma-goal-progress.mjs --hours 100 --project sma --json`
 */
/**
 * sma-goal-progress.mjs — 100h SMA Gen3 goal-progress telemetry.
 *
 * Reads append-only .smarch/agent-context logs and produces the same report the
 * Gen3 dashboard renders by default.
 */

import { SMA_ROOT, projectsPath } from "./lib/sma-paths.ts";
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import {
  buildGoalProgressReport,
  renderGoalProgressSection,
  runGoalProgressSelfTest,
} from './lib/gen3-goal-progress.mjs';


const args = parseArgs(argv.slice(2));

try {
  if (args.help || args.h) {
    usage();
    exit(0);
  }
  if (args.selftest) {
    const report = runGoalProgressSelfTest();
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`goal-progress selftest ok: ${report.summary.failed_then_passed_count} fail→pass recovery, ${report.summary.srs_signal_count} SRS signal`);
    exit(0);
  }
  const report = buildGoalProgressReport({
    projects: projectArgs(),
    hours: Number(args.hours ?? args.goalHours ?? 100),
    projectFilter: asArray(args.project),
  });
  if (args.html) {
    const html = renderGoalProgressSection(report);
    if (args.out) writeFileSync(resolve(args.out), html);
    else console.log(html);
    exit(0);
  }
  if (args.out) writeFileSync(resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  else if (args.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
} catch (err) {
  console.error(`sma-goal-progress: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-goal-progress.mjs [--hours 100] [--project <id>]... [--json] [--out <path>]
  sma-goal-progress.mjs --html [--hours 100] [--project <id>]... [--out <path>]
  sma-goal-progress.mjs --selftest [--json]

Without --project, the command reads SMA itself and Acme Desktop when available. The
dashboard uses this layer by default and accepts --no-goal-progress to opt out.
`);
}

function projectArgs() {
  const projects = [{ id: 'sma', root: SMA_ROOT }];
  const acmeDesktopRoot = projectsPath('acme-desktop');
  projects.push({ id: 'acme-desktop', root: acmeDesktopRoot });
  return projects;
}

function printSummary(report) {
  const s = report.summary || {};
  console.log('SMA Gen3 Goal Progress');
  console.log(`window:       ${report.window_hours}h (${report.window_start} → ${report.window_end})`);
  console.log(`events:       ${s.event_count} across ${s.project_count} project(s), ${s.module_count} module bucket(s)`);
  console.log(`proof:        ${s.proof_coverage_percent}% coverage, ${s.pass_count}/${s.verification_count} pass, ${s.failed_then_passed_count} fail→pass`);
  console.log(`hardening:    ${s.hardening_score_percent}% (${s.srs_signal_count} SRS, ${s.graph_signal_count} graph, ${s.collision_signal_count} collision signals)`);
  console.log(`parallel:     ${s.current_agents_supported} current agent baseline → ${s.future_agents_target} future target`);
  const top = (report.modules || []).slice(0, 8);
  if (top.length) {
    console.log('modules:');
    for (const module of top) {
      console.log(`  - ${module.project}/${module.id}: ${module.event_count} events, ${module.pass_count} pass, ${module.fail_count} fail, ${module.completion_count} done`);
    }
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    if (key === 'project') out.project = [...asArray(out.project), next];
    else out[key] = next;
    i += 1;
  }
  return out;
}
