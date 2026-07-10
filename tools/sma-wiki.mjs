#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachFeatureCluster, featureClusterForBrick as featureClusterFor } from "./lib/feature-clusters.mjs";
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaults = {
  registry: smaPath("registry/global-modules.generated.json"),
  state: smaPath("wiki/SMA_STATE.generated.json"),
  out: smaPath("wiki")
};

function parseArgs(argv) {
  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--state" && next) {
      options.state = path.resolve(next);
      i += 1;
    } else if (arg === "--out" && next) {
      options.out = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA wiki generator

Usage:
  node tools/sma-wiki.mjs --registry registry/global-modules.generated.json --state wiki/SMA_STATE.generated.json --out wiki
`);
      process.exit(0);
    }
  }

  return options;
}

function slugify(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mdTableRow(values) {
  return `| ${values.map((value) => String(value ?? "").replaceAll("\n", " ")).join(" | ")} |`;
}

async function readManifest(brick) {
  if (!brick.manifest_path) {
    return null;
  }

  try {
    return JSON.parse(await fs.readFile(brick.manifest_path, "utf8"));
  } catch {
    return null;
  }
}

async function maybeReadJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function gateRows(manifest) {
  const gates = manifest?.sweetspot || {};
  return Object.entries(gates).map(([name, gate]) => mdTableRow([
    name,
    gate.status || "",
    gate.score ?? "",
    gate.notes || "",
    Array.isArray(gate.evidence) ? gate.evidence.join("; ") : ""
  ])).join("\n");
}

function listLines(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "- Not declared";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function provenanceLines(manifest) {
  const events = [
    manifest?.provenance?.created_by,
    ...(manifest?.provenance?.touched_by || []),
    ...(manifest?.provenance?.reviewed_by || [])
  ].filter(Boolean);

  if (events.length === 0) {
    return "- Not recorded";
  }

  return events.map((event) => {
    const actor = [event.actor_kind, event.provider, event.model || event.actor_id].filter(Boolean).join(" / ");
    return `- ${actor}: ${event.role} at ${event.timestamp || "unknown time"} - ${event.summary || "No summary"}`;
  }).join("\n");
}

function envRows(manifest) {
  const vars = manifest?.security?.env?.variables || [];

  if (vars.length === 0) {
    return "| None | | | |\n";
  }

  return vars.map((envVar) => mdTableRow([
    envVar.name,
    envVar.scope,
    (envVar.required_in || []).join(", "),
    (envVar.forbidden_in || []).join(", ")
  ])).join("\n");
}

function dependencyRows(manifest) {
  const dependencies = manifest?.supply_chain?.dependencies || [];

  if (dependencies.length === 0) {
    return "| None | | | |\n";
  }

  return dependencies.map((dependency) => mdTableRow([
    dependency.name,
    dependency.version || "",
    dependency.license || "",
    dependency.risk || "",
    dependency.purpose || ""
  ])).join("\n");
}

function brickMarkdown(brick, manifest) {
  const models = brick.models?.length ? brick.models.join(", ") : "Not recorded";
  const dataClasses = brick.data_classes?.length ? brick.data_classes.join(", ") : "Not declared";
  const findings = manifest?.security?.vulnerability_findings || {};
  const codeBudget = manifest?.quality?.code_budget || {};

  return `# ${brick.name}

## Purpose

${brick.id} is a ${brick.kind || "brick"} from ${brick.project || "unknown project"}.

## Trust

| Field | Value |
|-------|-------|
| Brick id | ${brick.id} |
| Project | ${brick.project || "unknown"} |
| Status | ${brick.status || "unknown"} |
| Hierarchy | ${manifest?.hierarchy?.level || "Not declared"} |
| Brick group | ${brick.brick_group || manifest?.hierarchy?.group_id || "Not declared"} |
| Feature area | ${brick.feature_cluster?.name || "General / Shared"} |
| Score | ${brick.score ?? 0} |
| Clone readiness | ${brick.clone_readiness || "unknown"} |
| Health | ${brick.health?.status || "unknown"} |
| Validation errors | ${brick.health?.error_count ?? 0} |
| Validation warnings | ${brick.health?.warning_count ?? 0} |
| Risk | ${brick.risk || "unknown"} |
| Data classes | ${dataClasses} |
| Models recorded | ${models} |

## Code Budget

| Field | Value |
|-------|-------|
| Status | ${codeBudget.status || "Not declared"} |
| Feature lines | ${codeBudget.feature_lines ?? "Not declared"} |
| File count | ${codeBudget.file_count ?? "Not declared"} |
| Dependency count | ${codeBudget.dependency_count ?? "Not declared"} |
| Notes | ${codeBudget.notes || "Not declared"} |

## Source

| Field | Value |
|-------|-------|
| Manifest | ${brick.manifest_path || ""} |
| Source paths | ${(brick.source_paths || []).join(", ") || "Not declared"} |
| Owner | ${manifest?.owner?.primary || "Not declared"} |

## Boundaries

| Field | Value |
|-------|-------|
| Owned paths | ${(manifest?.boundaries?.owned_paths || []).join(", ") || "Not declared"} |
| Public paths | ${(manifest?.boundaries?.public_paths || []).join(", ") || "Not declared"} |
| Private paths | ${(manifest?.boundaries?.private_paths || []).join(", ") || "Not declared"} |
| Forbidden imports | ${(manifest?.boundaries?.forbidden_imports || []).join(", ") || "Not declared"} |

## Supply Chain

| Dependency | Version | License | Risk | Purpose |
|------------|---------|---------|------|---------|
${dependencyRows(manifest)}

## Gates

| Gate | Status | Score | Notes | Evidence |
|------|--------|-------|-------|----------|
${gateRows(manifest) || "| Not declared | | | | |"}

## Public API

${listLines(manifest?.interfaces?.public_api)}

## Adapter Points

${listLines(manifest?.interfaces?.adapters)}

## Clone Steps

${listLines(manifest?.clone?.install_steps)}

## Known Traps

${listLines(manifest?.clone?.known_traps)}

## Env Contract

| Variable | Scope | Required In | Forbidden In |
|----------|-------|-------------|--------------|
${envRows(manifest)}

## RLS Contract

| Field | Value |
|-------|-------|
| Required | ${manifest?.security?.rls?.required ?? "unknown"} |
| Status | ${manifest?.security?.rls?.status || "unknown"} |
| Matrix | ${manifest?.security?.rls?.matrix_path || "Not declared"} |

## Vulnerability Findings

| Severity | Count |
|----------|-------|
| Critical | ${findings.critical ?? 0} |
| High | ${findings.high ?? 0} |
| Medium | ${findings.medium ?? 0} |
| Low | ${findings.low ?? 0} |

## Provenance

${provenanceLines(manifest)}

## How To Use This Page

1. Check status and clone readiness.
2. Open the manifest before copying.
3. Review data classes and risk.
4. Run the checks listed in the manifest.
5. Add a new provenance event after adapting this brick.

## Known Missing Data

If this page is thin, the manifest needs more detail. The wiki is only as good as the brick metadata.

`;
}

function catalogMarkdown(bricks) {
  const rows = bricks.map((brick) => {
    const slug = slugify(brick.id);
    return mdTableRow([
      `[${brick.name}](bricks/${slug}.md)`,
      brick.project || "",
      brick.id,
      brick.kind || "",
      brick.status || "",
      brick.score ?? 0,
      brick.clone_readiness || "",
      brick.health?.status || "",
      brick.risk || "",
      brick.feature_cluster?.name || "General / Shared",
      brick.models?.join(", ") || ""
    ]);
  });

  return `# Brick Catalog

Generated from the SMA registry.

Visual overview: [Brick Wall](BRICK_WALL.generated.html)

Feature overview: [Feature Clusters](FEATURE_CLUSTERS.generated.html)

| Brick | Project | ID | Kind | Status | Score | Clone | Health | Risk | Feature Area | Models |
|-------|---------|----|------|--------|-------|-------|--------|------|--------------|--------|
${rows.join("\n")}

`;
}

function countBy(items, getKey) {
  const counts = new Map();

  for (const item of items) {
    const key = getKey(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function optionList(values) {
  return values.map(([value]) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
}

function shortPath(brick) {
  const [first] = brick.source_paths || [];
  return first || brick.manifest_path || "";
}

function brickTone(brick) {
  if (brick.health?.status === "fail" || brick.risk === "critical") {
    return "danger";
  }

  if (brick.health?.warning_count > 0 || brick.status === "project_bound" || brick.risk === "high") {
    return "review";
  }

  if (brick.status === "canonical" && brick.health?.status === "ok") {
    return "ready";
  }

  return "steady";
}

function featureClusters(bricks) {
  const byId = new Map();

  for (const brick of bricks) {
    const cluster = brick.feature_cluster || featureClusterFor(brick);
    const current = byId.get(cluster.id) || {
      ...cluster,
      bricks: [],
      warning_count: 0,
      error_count: 0,
      score_total: 0,
      risk_counts: {},
      status_counts: {},
      kind_counts: {},
      project_counts: {}
    };

    current.bricks.push(brick);
    current.warning_count += brick.health?.warning_count || 0;
    current.error_count += brick.health?.error_count || 0;
    current.score_total += brick.score || 0;
    current.risk_counts[brick.risk || "unknown"] = (current.risk_counts[brick.risk || "unknown"] || 0) + 1;
    current.status_counts[brick.status || "unknown"] = (current.status_counts[brick.status || "unknown"] || 0) + 1;
    current.kind_counts[brick.kind || "unknown"] = (current.kind_counts[brick.kind || "unknown"] || 0) + 1;
    current.project_counts[brick.project || "unknown"] = (current.project_counts[brick.project || "unknown"] || 0) + 1;
    byId.set(cluster.id, current);
  }

  return [...byId.values()].map((cluster) => ({
    ...cluster,
    count: cluster.bricks.length,
    average_score: cluster.bricks.length ? Math.round(cluster.score_total / cluster.bricks.length) : 0
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function countsLine(counts) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

function brickWallHtml(registry, bricks) {
  const projects = registry.projects || [];
  const totalWarnings = projects.reduce((sum, project) => sum + (project.warning_count || 0), 0);
  const totalErrors = projects.reduce((sum, project) => sum + (project.error_count || 0), 0);
  const avgScore = bricks.length ? Math.round(bricks.reduce((sum, brick) => sum + (brick.score || 0), 0) / bricks.length) : 0;
  const byKind = countBy(bricks, (brick) => brick.kind);
  const byStatus = countBy(bricks, (brick) => brick.status);
  const byHealth = countBy(bricks, (brick) => brick.health?.status);
  const byRisk = countBy(bricks, (brick) => brick.risk);
  const byCluster = countBy(bricks, (brick) => brick.feature_cluster?.name);
  const byProject = countBy(bricks, (brick) => brick.project);
  const projectName = projects.length === 1 ? projects[0].id : "SMA Registry";
  const dominantStatus = byStatus[0]?.[0] || "unknown";
  const wallRows = bricks.map((brick) => {
    const slug = slugify(brick.id);
    const pathLabel = shortPath(brick);
    const tone = brickTone(brick);
    const warnings = brick.health?.warning_count ?? 0;
    const errors = brick.health?.error_count ?? 0;

    return `      <a class="brick ${tone}" href="bricks/${slug}.md" data-name="${escapeHtml(`${brick.name} ${brick.id} ${brick.project || ""} ${pathLabel} ${brick.feature_cluster?.name || ""}`.toLowerCase())}" data-project="${escapeHtml(brick.project || "unknown")}" data-kind="${escapeHtml(brick.kind || "unknown")}" data-status="${escapeHtml(brick.status || "unknown")}" data-health="${escapeHtml(brick.health?.status || "unknown")}" data-risk="${escapeHtml(brick.risk || "unknown")}" data-cluster="${escapeHtml(brick.feature_cluster?.name || "General / Shared")}">
        <span class="studs" aria-hidden="true"></span>
        <span class="brick-top">
          <span class="kind">${escapeHtml(brick.kind || "brick")}</span>
          <span class="score">${escapeHtml(brick.score ?? 0)}</span>
        </span>
        <strong>${escapeHtml(brick.name)}</strong>
        <span class="path">${escapeHtml(pathLabel)}</span>
        <span class="meta">
          <span>${escapeHtml(brick.status || "unknown")}</span>
          <span>${escapeHtml(brick.project || "unknown")}</span>
          <span>${escapeHtml(brick.feature_cluster?.name || "General / Shared")}</span>
          <span>${escapeHtml(brick.health?.status || "unknown")}</span>
          <span>${warnings} warn</span>
          <span>${errors} err</span>
        </span>
      </a>`;
  }).join("\n");
  const kindBars = byKind.slice(0, 10).map(([kind, count]) => {
    const width = bricks.length ? Math.max(6, Math.round((count / bricks.length) * 100)) : 0;
    return `        <div class="bar-row"><span>${escapeHtml(kind)}</span><b style="width:${width}%"></b><em>${count}</em></div>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(projectName)} Brick Wall</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f6f7f9;
      --ink: #17191d;
      --muted: #626a73;
      --line: #d9dde3;
      --panel: #ffffff;
      --coal: #23262b;
      --teal: #0f766e;
      --green: #517a3d;
      --wine: #9f2f45;
      --gold: #b28b12;
      --steel: #667085;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.45;
    }
    a { color: inherit; }
    header {
      padding: 34px max(18px, calc((100vw - 1280px) / 2)) 24px;
      background: linear-gradient(180deg, #ffffff 0%, #eef1f4 100%);
      border-bottom: 1px solid var(--line);
    }
    .kicker {
      margin: 0 0 10px;
      color: var(--teal);
      font-size: 12px;
      font-weight: 750;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      max-width: 780px;
      margin: 0;
      font-size: 42px;
      line-height: 1.08;
      letter-spacing: 0;
    }
    .lead {
      max-width: 860px;
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 18px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 24px;
    }
    .metric {
      min-height: 84px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
      box-shadow: 0 12px 30px rgba(23, 25, 29, 0.06);
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 30px;
      line-height: 1;
    }
    main { padding: 24px max(18px, calc((100vw - 1280px) / 2)) 42px; }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 4;
      display: grid;
      grid-template-columns: minmax(180px, 1fr) repeat(6, minmax(120px, 165px));
      gap: 10px;
      align-items: center;
      padding: 12px 0;
      background: rgba(246, 247, 249, 0.96);
      backdrop-filter: blur(8px);
    }
    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--ink);
      padding: 0 12px;
      font: inherit;
    }
    .summary {
      display: grid;
      grid-template-columns: minmax(220px, 360px) 1fr;
      gap: 16px;
      margin: 12px 0 20px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 16px;
    }
    .panel h2 {
      margin: 0 0 12px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 110px 1fr 42px;
      gap: 10px;
      align-items: center;
      margin: 8px 0;
      color: var(--muted);
      font-size: 13px;
    }
    .bar-row b {
      display: block;
      height: 10px;
      min-width: 6px;
      border-radius: 4px;
      background: linear-gradient(90deg, var(--teal), var(--wine));
    }
    .bar-row em {
      color: var(--ink);
      font-style: normal;
      text-align: right;
    }
    .status-line {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .status-line li {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: #f8f9fb;
      color: var(--muted);
      font-size: 13px;
    }
    .wall-head {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: end;
      margin: 10px 0 14px;
    }
    .wall-head h2 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
    }
    .visible-count {
      color: var(--muted);
      font-size: 14px;
    }
    .brick-wall {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(238px, 1fr));
      gap: 12px;
      align-items: stretch;
    }
    .brick {
      position: relative;
      min-height: 174px;
      overflow: hidden;
      border: 1px solid rgba(23, 25, 29, 0.12);
      border-radius: 8px;
      padding: 46px 14px 14px;
      background: #ffffff;
      color: var(--ink);
      text-decoration: none;
      box-shadow: 0 14px 28px rgba(23, 25, 29, 0.08);
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
    }
    .brick:hover {
      transform: translateY(-2px);
      border-color: rgba(23, 25, 29, 0.24);
      box-shadow: 0 18px 34px rgba(23, 25, 29, 0.12);
    }
    .brick .studs {
      position: absolute;
      inset: 0 0 auto;
      height: 34px;
      opacity: 0.2;
      background-image: radial-gradient(circle, #ffffff 0 5px, transparent 5.5px);
      background-size: 34px 24px;
      background-position: 12px 9px;
      pointer-events: none;
    }
    .brick.ready { background: linear-gradient(180deg, #f7fcfa 0%, #ffffff 58%); border-top: 6px solid var(--green); }
    .brick.review { background: linear-gradient(180deg, #fffaf0 0%, #ffffff 58%); border-top: 6px solid var(--gold); }
    .brick.danger { background: linear-gradient(180deg, #fff4f5 0%, #ffffff 58%); border-top: 6px solid var(--wine); }
    .brick.steady { background: linear-gradient(180deg, #f3fbfa 0%, #ffffff 58%); border-top: 6px solid var(--teal); }
    .brick-top {
      position: absolute;
      left: 14px;
      right: 14px;
      top: 12px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    .kind {
      max-width: 150px;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      font-weight: 780;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
      letter-spacing: 0;
    }
    .score {
      min-width: 36px;
      border-radius: 8px;
      background: var(--coal);
      color: #ffffff;
      font-size: 12px;
      font-weight: 760;
      line-height: 24px;
      text-align: center;
    }
    .brick strong {
      display: block;
      min-height: 48px;
      font-size: 18px;
      line-height: 1.18;
      letter-spacing: 0;
    }
    .path {
      display: -webkit-box;
      min-height: 38px;
      overflow: hidden;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      word-break: break-word;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 12px;
    }
    .meta span {
      border: 1px solid rgba(23, 25, 29, 0.1);
      border-radius: 8px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.7);
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
    }
    .empty {
      display: none;
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 28px;
      background: #ffffff;
      color: var(--muted);
      text-align: center;
    }
    @media (max-width: 840px) {
      h1 { font-size: 32px; }
      .toolbar { position: static; grid-template-columns: 1fr 1fr; }
      .toolbar input { grid-column: 1 / -1; }
      .summary { grid-template-columns: 1fr; }
      .wall-head { align-items: start; flex-direction: column; }
    }
    @media (max-width: 520px) {
      .toolbar { grid-template-columns: 1fr; }
      .brick-wall { grid-template-columns: 1fr; }
      .metric strong { font-size: 26px; }
    }
  </style>
</head>
<body>
  <header>
    <p class="kicker">Sweetspot Modular Architecture</p>
    <h1>${escapeHtml(projectName)} Brick Wall</h1>
    <p class="lead">A compact inventory of indexed bricks, styled as a serious brick wall: visible status, score, risk, ownership path, and health at a glance.</p>
    <div class="metrics">
      <div class="metric"><span>Total Bricks</span><strong>${bricks.length}</strong></div>
      <div class="metric"><span>Average Score</span><strong>${avgScore}</strong></div>
      <div class="metric"><span>Warnings</span><strong>${totalWarnings}</strong></div>
      <div class="metric"><span>Errors</span><strong>${totalErrors}</strong></div>
      <div class="metric"><span>Main Status</span><strong>${escapeHtml(dominantStatus)}</strong></div>
    </div>
  </header>
  <main>
    <div class="toolbar" aria-label="Brick filters">
      <input id="search" type="search" placeholder="Search brick, id, or path">
      <select id="project"><option value="">All projects</option>${optionList(byProject)}</select>
      <select id="cluster"><option value="">All feature areas</option>${optionList(byCluster)}</select>
      <select id="kind"><option value="">All kinds</option>${optionList(byKind)}</select>
      <select id="status"><option value="">All statuses</option>${optionList(byStatus)}</select>
      <select id="health"><option value="">All health</option>${optionList(byHealth)}</select>
      <select id="risk"><option value="">All risk</option>${optionList(byRisk)}</select>
    </div>
    <section class="summary" aria-label="Registry summary">
      <div class="panel">
        <h2>Kind Mix</h2>
${kindBars || "        <p>No bricks indexed.</p>"}
      </div>
      <div class="panel">
      <h2>Registry Signals</h2>
        <ul class="status-line">
          <li><a href="FEATURE_CLUSTERS.generated.html">Feature clusters</a></li>
          ${byStatus.map(([status, count]) => `<li>${escapeHtml(status)}: ${count}</li>`).join("\n          ")}
          ${byHealth.map(([health, count]) => `<li>${escapeHtml(health)} health: ${count}</li>`).join("\n          ")}
          ${byRisk.map(([risk, count]) => `<li>${escapeHtml(risk)} risk: ${count}</li>`).join("\n          ")}
        </ul>
      </div>
    </section>
    <div class="wall-head">
      <h2>All Bricks</h2>
      <span class="visible-count"><span id="visible-count">${bricks.length}</span> visible of ${bricks.length}</span>
    </div>
    <section class="brick-wall" id="brick-wall" aria-label="Brick overview">
${wallRows || '      <div class="empty" style="display:block">No bricks indexed yet.</div>'}
    </section>
    <p class="empty" id="empty">No bricks match these filters.</p>
  </main>
  <script>
    const controls = {
      search: document.getElementById("search"),
      project: document.getElementById("project"),
      cluster: document.getElementById("cluster"),
      kind: document.getElementById("kind"),
      status: document.getElementById("status"),
      health: document.getElementById("health"),
      risk: document.getElementById("risk")
    };
    const bricks = Array.from(document.querySelectorAll(".brick"));
    const visibleCount = document.getElementById("visible-count");
    const empty = document.getElementById("empty");

    function matches(brick) {
      const text = controls.search.value.trim().toLowerCase();
      if (text && !brick.dataset.name.includes(text)) return false;
      if (controls.project.value && brick.dataset.project !== controls.project.value) return false;
      if (controls.cluster.value && brick.dataset.cluster !== controls.cluster.value) return false;
      if (controls.kind.value && brick.dataset.kind !== controls.kind.value) return false;
      if (controls.status.value && brick.dataset.status !== controls.status.value) return false;
      if (controls.health.value && brick.dataset.health !== controls.health.value) return false;
      if (controls.risk.value && brick.dataset.risk !== controls.risk.value) return false;
      return true;
    }

    function update() {
      let visible = 0;
      for (const brick of bricks) {
        const show = matches(brick);
        brick.hidden = !show;
        if (show) visible += 1;
      }
      visibleCount.textContent = String(visible);
      empty.style.display = visible === 0 ? "block" : "none";
    }

    for (const control of Object.values(controls)) {
      control.addEventListener("input", update);
    }
  </script>
</body>
</html>
`;
}

function featureClustersHtml(registry, bricks) {
  const clusters = featureClusters(bricks);
  const projectName = (registry.projects || []).length === 1 ? registry.projects[0].id : "SMA Registry";
  const largest = Math.max(1, ...clusters.map((cluster) => cluster.count));
  const cards = clusters.map((cluster) => {
    const width = Math.max(5, Math.round((cluster.count / largest) * 100));
    const topBricks = cluster.bricks
      .slice()
      .sort((a, b) => (b.health?.warning_count || 0) - (a.health?.warning_count || 0) || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((brick) => `<li><a href="bricks/${slugify(brick.id)}.md">${escapeHtml(brick.name)}</a><span>${escapeHtml(brick.project || "unknown")} / ${escapeHtml(shortPath(brick))}</span></li>`)
      .join("\n");

    return `      <article class="cluster" id="${escapeHtml(cluster.id)}" data-name="${escapeHtml(`${cluster.name} ${cluster.description}`.toLowerCase())}">
        <div class="cluster-head">
          <div>
            <p class="eyebrow">Feature Area</p>
            <h2>${escapeHtml(cluster.name)}</h2>
          </div>
          <strong>${cluster.count}</strong>
        </div>
        <p>${escapeHtml(cluster.description)}</p>
        <div class="meter"><b style="width:${width}%"></b></div>
        <dl>
          <div><dt>Average score</dt><dd>${cluster.average_score}</dd></div>
          <div><dt>Warnings</dt><dd>${cluster.warning_count}</dd></div>
          <div><dt>Errors</dt><dd>${cluster.error_count}</dd></div>
          <div><dt>Risk</dt><dd>${escapeHtml(countsLine(cluster.risk_counts) || "unknown")}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(countsLine(cluster.status_counts) || "unknown")}</dd></div>
          <div><dt>Projects</dt><dd>${escapeHtml(countsLine(cluster.project_counts) || "unknown")}</dd></div>
          <div><dt>Shape</dt><dd>${escapeHtml(countsLine(cluster.kind_counts) || "unknown")}</dd></div>
        </dl>
        <h3>Key bricks</h3>
        <ul class="brick-list">
${topBricks || "          <li>No bricks listed.</li>"}
        </ul>
      </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(projectName)} Feature Clusters</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f6f7f9;
      --ink: #17191d;
      --muted: #626a73;
      --line: #d9dde3;
      --panel: #ffffff;
      --coal: #23262b;
      --teal: #0f766e;
      --wine: #9f2f45;
      --gold: #b28b12;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.45;
    }
    a { color: inherit; }
    header {
      padding: 34px max(18px, calc((100vw - 1280px) / 2)) 24px;
      background: linear-gradient(180deg, #ffffff 0%, #eef1f4 100%);
      border-bottom: 1px solid var(--line);
    }
    .kicker, .eyebrow {
      margin: 0 0 8px;
      color: var(--teal);
      font-size: 12px;
      font-weight: 760;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      max-width: 820px;
      margin: 0;
      font-size: 42px;
      line-height: 1.08;
      letter-spacing: 0;
    }
    .lead {
      max-width: 880px;
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 18px;
    }
    main { padding: 24px max(18px, calc((100vw - 1280px) / 2)) 42px; }
    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
    }
    .nav a {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 9px 12px;
      font-weight: 680;
      text-decoration: none;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: 12px 0;
      background: rgba(246, 247, 249, 0.96);
      backdrop-filter: blur(8px);
    }
    input {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--ink);
      padding: 0 12px;
      font: inherit;
    }
    .clusters {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
      gap: 14px;
      align-items: start;
    }
    .cluster {
      border: 1px solid var(--line);
      border-top: 6px solid var(--teal);
      border-radius: 8px;
      background: var(--panel);
      padding: 16px;
      box-shadow: 0 14px 30px rgba(23, 25, 29, 0.07);
    }
    .cluster-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
    }
    h2 {
      margin: 0;
      font-size: 22px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    .cluster-head strong {
      min-width: 48px;
      border-radius: 8px;
      background: var(--coal);
      color: #ffffff;
      line-height: 34px;
      text-align: center;
    }
    .cluster p {
      min-height: 62px;
      margin: 12px 0;
      color: var(--muted);
    }
    .meter {
      height: 10px;
      overflow: hidden;
      border-radius: 4px;
      background: #edf0f3;
      margin: 8px 0 12px;
    }
    .meter b {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--teal), var(--gold));
    }
    dl {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 0;
    }
    dl div {
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    dt {
      color: var(--muted);
      font-size: 11px;
      font-weight: 740;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    dd {
      margin: 3px 0 0;
      font-weight: 730;
      overflow-wrap: anywhere;
    }
    h3 {
      margin: 16px 0 8px;
      font-size: 15px;
      letter-spacing: 0;
    }
    .brick-list {
      display: grid;
      gap: 7px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .brick-list li {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfcfd;
    }
    .brick-list a {
      display: block;
      color: var(--ink);
      font-weight: 730;
      text-decoration: none;
    }
    .brick-list span {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 620px) {
      h1 { font-size: 32px; }
      .clusters { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <p class="kicker">Sweetspot Modular Architecture</p>
    <h1>${escapeHtml(projectName)} Feature Clusters</h1>
    <p class="lead">Product-facing groups that show which bricks belong together. Use this before opening individual brick pages.</p>
  </header>
  <main>
    <nav class="nav" aria-label="Dashboard navigation">
      <a href="DASHBOARD.generated.html">Dashboard</a>
      <a href="BRICK_WALL.generated.html">Brick Wall</a>
      <a href="BRICK_CATALOG.generated.md">Catalog</a>
    </nav>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search feature area or description">
    </div>
    <section class="clusters" id="clusters">
${cards || '      <article class="cluster"><h2>No feature clusters yet</h2><p>Add manifests and regenerate the wiki.</p></article>'}
    </section>
  </main>
  <script>
    const search = document.getElementById("search");
    const clusters = Array.from(document.querySelectorAll(".cluster[data-name]"));
    search.addEventListener("input", () => {
      const value = search.value.trim().toLowerCase();
      for (const cluster of clusters) {
        cluster.hidden = value && !cluster.dataset.name.includes(value);
      }
    });
  </script>
</body>
</html>
`;
}

async function projectMetadata(projects) {
  const byId = new Map();

  for (const project of projects) {
    if (!project.root) {
      continue;
    }

    const metaPath = path.join(project.root, ".sweetspot", "project.json");

    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      byId.set(project.id, meta);
    } catch {
      // Project metadata is optional for external registries.
    }
  }

  return byId;
}

function projectStatus(project, meta) {
  const securityGate = meta?.sma?.security_gate || project.security_gate;

  if (securityGate?.status === "blocked") {
    return "security_blocked";
  }

  if ((project.error_count || 0) > 0 || (project.health_counts?.fail || 0) > 0) {
    return "validation_blocked";
  }

  if ((project.warning_count || 0) > 0 || (project.health_counts?.warn || 0) > 0) {
    return "indexed_with_warnings";
  }

  if ((project.brick_count || 0) > 0) {
    return "indexed_clean";
  }

  return "not_indexed";
}

function projectTone(status) {
  if (status.includes("blocked")) return "danger";
  if (status.includes("warnings")) return "review";
  if (status === "indexed_clean") return "ready";
  return "steady";
}

function scoreTone(score) {
  if (score >= 85) return "ready";
  if (score >= 70) return "review";
  return "danger";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatCoverageUnits(value) {
  const numeric = Number(value || 0);

  if (Number.isInteger(numeric)) {
    return formatNumber(numeric);
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(numeric);
}

function scannerReadinessCards(scanner) {
  const projects = scanner?.readiness?.projects || [];

  return projects.map((entry) => {
    const readiness = entry.readiness || {};
    const compliance = entry.compliance_report || {};
    const metrics = readiness.metrics || {};
    const tone = scoreTone(readiness.score || 0);
    const reasons = (readiness.reasons || []).slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");

    return `      <article class="scanner-brick scanner-brick--${tone}">
        <div class="scanner-studs"><span></span><span></span><span></span><span></span></div>
        <div class="scanner-brick-head">
          <p>${escapeHtml(entry.project)}</p>
          <strong>${readiness.score || 0}<small>/${escapeHtml(readiness.grade || "F")}</small></strong>
        </div>
        <h3>${escapeHtml(readiness.label || "unknown")}</h3>
        <dl>
          <div><dt>Blocked clone</dt><dd>${metrics.blocked_clone_count || 0}</dd></div>
          <div><dt>Drift</dt><dd>${metrics.drift_count || 0}</dd></div>
          <div><dt>Boundary hits</dt><dd>${metrics.boundary_violation_count || 0}</dd></div>
          <div><dt>Coupling</dt><dd>${metrics.same_group_coupling_count || 0}</dd></div>
          <div><dt>Env gaps</dt><dd>${metrics.env_gap_count || 0}</dd></div>
          <div><dt>Compliance</dt><dd>${compliance.score || metrics.compliance_score || 0}/${escapeHtml(compliance.grade || "F")}</dd></div>
          <div><dt>Unmanifested</dt><dd>${metrics.unmanifested_count || 0}</dd></div>
        </dl>
        <ul>${reasons || "<li>No major penalties recorded.</li>"}</ul>
      </article>`;
  }).join("\n");
}

function scannerQueueCards(queue) {
  return (queue || []).slice(0, 12).map((entry) => `      <article class="queue-card queue-card--${escapeHtml(entry.severity || "medium")}">
        <div class="queue-rank">#${entry.rank}</div>
        <p class="queue-project">${escapeHtml(entry.project)}</p>
        <h3>${escapeHtml(entry.path)}</h3>
        <p class="queue-copy">${escapeHtml(entry.first_action || entry.strategy || "Review this file and split by the listed seams.")}</p>
        <dl>
          <div><dt>Theme</dt><dd>${escapeHtml(entry.theme || "unknown")}</dd></div>
          <div><dt>Lines</dt><dd>${formatNumber(entry.lines)}</dd></div>
          <div><dt>Slices</dt><dd>${entry.expected_slices || 0}</dd></div>
          <div><dt>Severity</dt><dd>${escapeHtml(entry.severity || "unknown")}</dd></div>
        </dl>
      </article>`).join("\n");
}

function boundaryRows(scanner) {
  const rows = scanner?.boundary_report?.top_violations || [];

  return rows.slice(0, 18).map((entry) => `        <li>
          <strong>${escapeHtml(entry.kind || "violation")}</strong>
          <span>${escapeHtml(entry.project || "")}</span>
          <code>${escapeHtml(entry.file || entry.path || "")}</code>
          <em>${escapeHtml(entry.specifier || entry.target || "")}</em>
        </li>`).join("\n");
}

function cloneRiskCards(scanner) {
  const rows = scanner?.clone_preflight?.highest_risk_bricks || [];

  return rows.slice(0, 10).map((entry) => `      <article class="risk-card risk-card--${escapeHtml(entry.effective_status || "manual_review")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <dl>
          <div><dt>Status</dt><dd>${escapeHtml(entry.effective_status || "unknown")}</dd></div>
          <div><dt>Blockers</dt><dd>${(entry.blocker_codes || []).length}</dd></div>
          <div><dt>Warnings</dt><dd>${(entry.warning_codes || []).length}</dd></div>
          <div><dt>Tokens</dt><dd>${formatNumber(entry.raw_source_tokens)}</dd></div>
        </dl>
      </article>`).join("\n");
}

function envContractCards(scanner) {
  const rows = scanner?.env_contract_report?.highest_gap_bricks || [];

  return rows.slice(0, 8).map((entry) => `      <article class="env-card env-card--${escapeHtml(entry.effective_status || "manual_review")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <ul>${(entry.undeclared_env_refs || []).slice(0, 4).map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>
      </article>`).join("\n");
}

function complianceProjectCards(scanner) {
  const rows = scanner?.readiness?.projects || [];

  return rows.slice(0, 8).map((entry) => {
    const compliance = entry.compliance_report || {};
    const tone = scoreTone(compliance.score || 0);
    const weakest = (compliance.weakest_dimensions || []).slice(0, 2).map((dimension) => `${dimension.label} ${dimension.coverage_rate}%`).join(" · ");

    return `      <article class="gap-card gap-card--${tone}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${compliance.score || 0}<small>/${escapeHtml(compliance.grade || "F")}</small></h3>
        <code>${formatNumber(compliance.trackable_brick_count || 0)} trackable bricks</code>
        <p>${escapeHtml(weakest || "No active compliance gaps.")}</p>
      </article>`;
  }).join("\n");
}

function complianceDimensionRows(scanner) {
  const dimensions = Object.entries(scanner?.compliance_report?.dimensions || {})
    .filter(([, dimension]) => Number(dimension?.total_count || 0) > 0)
    .sort((a, b) => Number(a[1]?.coverage_rate || 0) - Number(b[1]?.coverage_rate || 0) || String(a[0]).localeCompare(String(b[0])));

  return dimensions.slice(0, 9).map(([, dimension]) => `        <li>
          <strong>${escapeHtml(dimension.label || "dimension")}</strong>
          <span>${formatCoverageUnits(dimension.coverage_units ?? dimension.ready_count)}/${formatNumber(dimension.total_count || 0)}</span>
          <div class="compliance-bar"><b style="width:${Math.max(6, Number(dimension.coverage_rate || 0))}%"></b></div>
          <em>${dimension.coverage_rate || 0}%</em>
        </li>`).join("\n");
}

function complianceGapCards(scanner) {
  const rows = scanner?.compliance_report?.highest_gap_bricks || [];

  return rows.slice(0, 10).map((entry) => `      <article class="gap-card gap-card--${escapeHtml(entry.effective_status || "manual_review")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <ul>${(entry.missing_dimensions || []).slice(0, 4).map((dimension) => `<li>${escapeHtml(String(dimension).replaceAll("_", " "))}</li>`).join("")}</ul>
      </article>`).join("\n");
}

function buildCandidateCards(scanner, limit = 8) {
  const rows = scanner?.build_report?.top_candidates || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = Number(entry.confidence_score || 0) >= 90 ? "ready" : Number(entry.confidence_score || 0) >= 75 ? "review" : "danger";
    const sources = (entry.detection_sources || []).slice(0, 4).join(" · ");
    const recurrence = Number(entry.recurrent_project_count || 0);

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.candidate_key || "build candidate")}</h3>
        <code>${escapeHtml(entry.dominant_feature_cluster || entry.dominant_domain || entry.recurrence_key || "mixed")}</code>
        <dl>
          <div><dt>Confidence</dt><dd>${entry.confidence_score || 0}/${escapeHtml(entry.confidence_label || "unknown")}</dd></div>
          <div><dt>Bricks</dt><dd>${formatNumber(entry.brick_count || 0)}</dd></div>
          <div><dt>Reuse</dt><dd>${formatNumber(recurrence)}</dd></div>
          <div><dt>Signals</dt><dd>${formatNumber((entry.detection_sources || []).length)}</dd></div>
        </dl>
        <p>${escapeHtml(entry.why || sources || "Grouped by repeated architectural signals.")}</p>
      </article>`;
  }).join("\n");
}

function buildFamilyRows(scanner, limit = 10) {
  const rows = scanner?.build_report?.candidate_signatures || [];

  return rows.slice(0, limit).map((entry) => `        <li>
          <strong>${escapeHtml(entry.recurrence_key || entry.dominant_feature_cluster || "build family")}</strong>
          <span>${escapeHtml(entry.project || "")}</span>
          <code>${escapeHtml(entry.dominant_domain || entry.dominant_path_root || entry.dominant_group || "mixed")}</code>
          <em>${formatNumber(entry.brick_count || 0)} bricks · ${escapeHtml((entry.detection_sources || []).join(" / ") || "signals")}</em>
        </li>`).join("\n");
}

function releaseTone(trustLevel, verificationStatus) {
  if (["high", "strong"].includes(String(trustLevel || "").toLowerCase()) || ["verified", "canonical"].includes(String(verificationStatus || "").toLowerCase())) return "ready";
  if (["medium"].includes(String(trustLevel || "").toLowerCase()) || ["candidate"].includes(String(verificationStatus || "").toLowerCase())) return "review";
  return "danger";
}

function buildVerificationTone(entry) {
  const suggested = String(entry?.suggested_build_status || "").toLowerCase();
  if (suggested === "canonical" || entry?.publish_ready) return "ready";
  if (suggested === "verified" || Number(entry?.readiness_score || 0) >= 75) return "review";
  return "danger";
}

function curatedBuildCards(stateSnapshot, limit = 8) {
  const rows = stateSnapshot?.build_plane?.curated_builds || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = buildVerificationTone(entry);
    const releaseState = entry.release_count
      ? `${entry.latest_channel || "channel?"} · ${entry.latest_release_status || "status?"}`
      : "manifest only";
    const blocker = entry.verification_top_blockers?.[0] || entry.private_publish_top_blockers?.[0] || entry.promotion_blockers?.[0];
    const laneState = entry.private_publish_status
      ? `publish ${entry.private_publish_status}`
      : entry.promotion_priority
        ? `promotion ${entry.promotion_priority}`
        : "lane pending";
    const qualityLine = entry.readiness_score
      ? `readiness ${formatNumber(entry.readiness_score || 0)} · publish ${formatNumber(entry.publishability_score || 0)} · ${laneState}`
      : releaseState;

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.source_project || "unknown project")}</p>
        <h3>${escapeHtml(entry.name || entry.artifact_id || "curated build")}</h3>
        <code>${escapeHtml(entry.artifact_id || "")}</code>
        <dl>
          <div><dt>Version</dt><dd>${escapeHtml(entry.version || "0.0.0")}</dd></div>
          <div><dt>Bricks</dt><dd>${formatNumber(entry.required_brick_ref_count || entry.brick_ref_count || 0)}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(entry.promotion_desired_status || entry.suggested_build_status || entry.status || "candidate")}</dd></div>
          <div><dt>Update</dt><dd>${entry.update_ready ? "ready" : "pending"}</dd></div>
        </dl>
        <p>${escapeHtml(`${qualityLine} · ${releaseState}`)}</p>
        ${blocker ? `<p>${escapeHtml(`${blocker.rule_id || blocker.code}: ${blocker.summary || blocker.message || "Finding recorded."}`)}</p>` : ""}
      </article>`;
  }).join("\n");
}

function releaseArtifactCards(stateSnapshot, limit = 6) {
  const rows = stateSnapshot?.release_plane?.top_build_releases || [];

  return rows.slice(0, limit).map((entry) => {
    const latest = entry.latest_release || {};
    const trust = latest.trust_summary || {};
    const tone = releaseTone(trust.trust_level, trust.verification_status);

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml((entry.source_projects || []).join(" · ") || "unknown project")}</p>
        <h3>${escapeHtml(entry.artifact_id || "release artifact")}</h3>
        <code>${escapeHtml(latest.path || "")}</code>
        <dl>
          <div><dt>Version</dt><dd>${escapeHtml(latest.version || "0.0.0")}</dd></div>
          <div><dt>Channel</dt><dd>${escapeHtml(latest.channel || "unknown")}</dd></div>
          <div><dt>Trust</dt><dd>${escapeHtml(trust.trust_level || "unknown")}</dd></div>
          <div><dt>Checks</dt><dd>${formatNumber(trust.check_counts?.total || 0)}</dd></div>
        </dl>
        <p>${escapeHtml(`${trust.verification_status || "unverified"} · ${latest.status || "draft"}`)}</p>
      </article>`;
  }).join("\n");
}

function privatePublishCards(stateSnapshot, limit = 6) {
  const rows = stateSnapshot?.publish_plane?.bundles || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = entry.publish_safe ? "ready" : entry.decision?.status === "blocked" ? "danger" : "review";
    const blocker = entry.top_blockers?.[0] || entry.top_warnings?.[0];
    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.artifact?.type || "artifact")}</p>
        <h3>${escapeHtml(entry.artifact?.original_id || entry.artifact?.community_id || "publish bundle")}</h3>
        <code>${escapeHtml(entry.bundle_path || "")}</code>
        <dl>
          <div><dt>Status</dt><dd>${escapeHtml(entry.decision?.status || "unknown")}</dd></div>
          <div><dt>Visibility</dt><dd>${escapeHtml(entry.publishing_visibility || "unknown")}</dd></div>
          <div><dt>Safe</dt><dd>${entry.publish_safe ? "yes" : "no"}</dd></div>
          <div><dt>Findings</dt><dd>${formatNumber(entry.decision?.counts?.blocker || 0)} blocker</dd></div>
        </dl>
        ${blocker ? `<p>${escapeHtml(`${blocker.rule_id || blocker.code}: ${blocker.summary || blocker.message || "Finding recorded."}`)}</p>` : ""}
      </article>`;
  }).join("\n");
}

function installEvidenceCards(stateSnapshot) {
  const rows = stateSnapshot?.install_plane?.targets || [];

  return rows.slice(0, 8).map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.target_root || "target")}</p>
        <h3>${formatNumber(entry.selected_build_count || 0)} build${entry.selected_build_count === 1 ? "" : "s"} installed</h3>
        <code>${escapeHtml((entry.build_ids || []).join(" · ") || "no selected builds recorded")}</code>
        <ul>
          <li>${formatNumber(entry.resolved_brick_count || 0)} resolved bricks</li>
          <li>${formatNumber(entry.imports_count || 0)} total imports</li>
          <li>${formatNumber(entry.placement_count || 0)} placements</li>
          <li>${formatNumber(entry.update_event_count || 0)} journal events</li>
        </ul>
      </article>`).join("\n");
}

function remediationActionCards(scanner) {
  const rows = scanner?.remediation_report?.top_actions || [];

  return rows.slice(0, 12).map((entry) => `      <article class="action-card action-card--${escapeHtml(entry.category || "boundary")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || entry.path || "action")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <span class="action-tag">${escapeHtml(String(entry.category || "action").replaceAll("_", " "))}</span>
        <p>${escapeHtml(entry.first_action || entry.why || "Review this action.")}</p>
      </article>`).join("\n");
}

function remediationProjectPlans(scanner) {
  const rows = scanner?.remediation_report?.project_action_plans || [];

  return rows.slice(0, 6).map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>Top Moves</h3>
        <ul>${(entry.actions || []).map((action) => `<li>${escapeHtml(action.first_action || action.path || action.name || action.category || "action")}</li>`).join("")}</ul>
      </article>`).join("\n");
}

function qualityQueueCards(rows, limit = 8) {
  return toArray(rows).slice(0, limit).map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.path || entry.brick_name || entry.brick_id || "quality hotspot")}</h3>
        <code>${escapeHtml(entry.first_action || entry.why || "Review hotspot")}</code>
        <ul>
          <li>priority: ${formatNumber(entry.priority_score || 0)}</li>
          <li>smell hits: ${formatNumber(entry.total_matches || 0)}</li>
          <li>score: ${formatNumber(entry.smell_score || 0)}</li>
          <li>dominant: ${escapeHtml(toArray(entry.top_types).slice(0, 2).map((item) => `${item.label || item.key} x${formatNumber(item.count || 0)}`).join(" · ") || "none recorded")}</li>
        </ul>
      </article>`).join("\n");
}

function qualityProjectCards(stateSnapshot, limit = 8) {
  return toArray(stateSnapshot?.projects)
    .filter((entry) => Number(entry?.code_quality_report?.hotspot_file_count || 0) > 0)
    .sort((left, right) =>
      Number(left?.code_quality_report?.score || 100) - Number(right?.code_quality_report?.score || 100)
      || Number(right?.code_quality_report?.hotspot_file_count || 0) - Number(left?.code_quality_report?.hotspot_file_count || 0)
      || String(left?.project || "").localeCompare(String(right?.project || ""))
    )
    .slice(0, limit)
    .map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${formatNumber(entry.code_quality_report?.score || 0)}/${escapeHtml(entry.code_quality_report?.grade || "A")} quality</h3>
        <ul>
          <li>hotspot files: ${formatNumber(entry.code_quality_report?.hotspot_file_count || 0)}</li>
          <li>smell hits: ${formatNumber(entry.code_quality_report?.total_smell_count || 0)}</li>
          <li>duplicate clusters: ${formatNumber(entry.code_quality_report?.duplicate_cluster_count || 0)}</li>
          <li>quality backlog: ${formatNumber(entry.remediation_counts?.quality || 0)}</li>
        </ul>
      </article>`).join("\n");
}

function duplicateCards(scanner) {
  const clusters = scanner?.duplicate_clusters || [];

  return clusters.slice(0, 10).map((cluster) => `      <article class="duplicate-card">
        <p>${escapeHtml(cluster.stem || "cluster")}</p>
        <h3>${cluster.count} overlap${cluster.count === 1 ? "" : "s"}</h3>
        <span>${cluster.projects.length} project${cluster.projects.length === 1 ? "" : "s"}</span>
        <ul>${cluster.bricks.slice(0, 4).map((brick) => `<li>${escapeHtml(brick.project)} · ${escapeHtml(brick.name || brick.id)}</li>`).join("")}</ul>
      </article>`).join("\n");
}

function tokenCards(scanner) {
  const rows = scanner?.token_economics?.top_token_heavy_bricks || [];

  return rows.slice(0, 8).map((entry) => {
    const raw = Number(entry.raw_source_tokens || 0);
    const summary = Number(entry.summary_tokens || entry.estimated_summary_tokens || 0);
    const ratio = raw ? Math.max(6, Math.round((summary / raw) * 100)) : 0;

    return `      <article class="token-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <div class="token-bar"><b style="width:${ratio}%"></b></div>
        <dl>
          <div><dt>Raw</dt><dd>${formatNumber(raw)}</dd></div>
          <div><dt>Summary</dt><dd>${formatNumber(summary)}</dd></div>
          <div><dt>Savings</dt><dd>${formatNumber(entry.estimated_savings_tokens || Math.max(0, raw - summary))}</dd></div>
          <div><dt>Files</dt><dd>${entry.file_count || 0}</dd></div>
        </dl>
      </article>`;
  }).join("\n");
}

function titleLabel(value) {
  const text = String(value || "unknown")
    .replace(/::/g, " / ")
    .replace(/[._/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "Unknown";

  return text.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function buildCandidateSource(stateSnapshot, scanner) {
  const scannerRows = scanner?.build_report?.top_candidates || [];
  if (scannerRows.length > 0) {
    return scannerRows;
  }
  return stateSnapshot?.trust?.build_candidates || [];
}

function canonicalizationState(stateSnapshot, scanner) {
  return stateSnapshot?.trust?.canonicalization || scanner?.canonicalization || {};
}

function capabilityFamilies(stateSnapshot, scanner) {
  const families = new Map();

  for (const entry of buildCandidateSource(stateSnapshot, scanner)) {
    const key = entry.recurrence_key || [entry.dominant_feature_cluster, entry.dominant_domain].filter(Boolean).join("::") || entry.candidate_key || entry.name || "mixed";
    const current = families.get(key) || {
      key,
      label: titleLabel(key),
      feature: entry.dominant_feature_cluster || "mixed",
      domain: entry.dominant_domain || "mixed",
      projects: new Set(),
      occurrence_count: 0,
      total_brick_count: 0,
      max_confidence_score: 0,
      confidence_total: 0,
      detection_sources: new Set(),
      examples: []
    };

    current.projects.add(entry.project || "unknown");
    current.occurrence_count += 1;
    current.total_brick_count += Number(entry.brick_count || 0);
    current.max_confidence_score = Math.max(current.max_confidence_score, Number(entry.confidence_score || 0));
    current.confidence_total += Number(entry.confidence_score || 0);
    for (const source of entry.detection_sources || []) {
      current.detection_sources.add(source);
    }
    if (current.examples.length < 4) {
      current.examples.push({
        name: entry.name || entry.candidate_key || "build candidate",
        project: entry.project || "unknown",
        brick_count: Number(entry.brick_count || 0),
        confidence_score: Number(entry.confidence_score || 0),
        why: entry.why || "",
        path: (entry.sample_paths || [])[0] || ""
      });
    }

    families.set(key, current);
  }

  return [...families.values()]
    .map((entry) => ({
      ...entry,
      project_count: entry.projects.size,
      average_confidence_score: entry.occurrence_count ? Math.round(entry.confidence_total / entry.occurrence_count) : 0,
      projects: [...entry.projects].sort(),
      detection_sources: [...entry.detection_sources]
    }))
    .sort((a, b) => b.project_count - a.project_count || b.occurrence_count - a.occurrence_count || b.max_confidence_score - a.max_confidence_score || a.label.localeCompare(b.label));
}

function topSummaryItems(summary, limit = 3) {
  return Object.entries(summary || {})
    .filter(([, value]) => Number(value || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);
}

function canonicalTargetTone(entry) {
  if (entry?.promotion_stage === "promote_now" && !(entry?.blocker_reasons || []).includes("contains_project_bound_members")) {
    return "ready";
  }
  if (entry?.promotion_stage === "stabilize_then_promote" || Number(entry?.priority_score || 0) >= 150) {
    return "review";
  }
  return "danger";
}

function capabilityFamilyCards(stateSnapshot, scanner, limit = 12) {
  return capabilityFamilies(stateSnapshot, scanner).slice(0, limit).map((entry) => {
    const tone = entry.max_confidence_score >= 90 ? "ready" : entry.max_confidence_score >= 75 ? "review" : "danger";
    const examples = entry.examples.slice(0, 3).map((example) => `<li>${escapeHtml(example.project)} · ${escapeHtml(example.name)} · ${formatNumber(example.brick_count)} bricks</li>`).join("");

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.feature || "mixed")} / ${escapeHtml(entry.domain || "mixed")}</p>
        <h3>${escapeHtml(entry.label)}</h3>
        <code>${escapeHtml(entry.key)}</code>
        <dl>
          <div><dt>Projects</dt><dd>${formatNumber(entry.project_count)}</dd></div>
          <div><dt>Occurrences</dt><dd>${formatNumber(entry.occurrence_count)}</dd></div>
          <div><dt>Bricks</dt><dd>${formatNumber(entry.total_brick_count)}</dd></div>
          <div><dt>Confidence</dt><dd>${entry.average_confidence_score}/100</dd></div>
        </dl>
        <ul>${examples || "<li>No concrete build examples recorded.</li>"}</ul>
      </article>`;
  }).join("\n");
}

function canonicalTargetCards(stateSnapshot, scanner, limit = 12) {
  const rows = canonicalizationState(stateSnapshot, scanner).top_targets || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = canonicalTargetTone(entry);
    const blockers = (entry.blocker_reasons || []).slice(0, 4).map((reason) => `<li>${escapeHtml(titleLabel(reason))}</li>`).join("");
    const evidence = entry.evidence_summary || {};
    const blockerSummary = topSummaryItems(entry.blocker_summary, 3).map(([key, value]) => `${titleLabel(key)}: ${formatNumber(value)}`).join(" · ");

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.project || "unknown")} · ${escapeHtml(entry.target_type || "target")}</p>
        <h3>${escapeHtml(entry.name || entry.target_id || "canonicalization target")}</h3>
        <code>${escapeHtml(entry.target_id || "")}</code>
        <dl>
          <div><dt>Priority</dt><dd>${formatNumber(entry.priority_score || 0)}</dd></div>
          <div><dt>Stage</dt><dd>${escapeHtml(entry.promotion_stage || "unknown")}</dd></div>
          <div><dt>Confidence</dt><dd>${escapeHtml(entry.confidence_label || "unknown")}</dd></div>
          <div><dt>Evidence</dt><dd>${formatNumber(evidence.brick_count || evidence.duplicate_count || 0)}</dd></div>
        </dl>
        <p>${escapeHtml(evidence.why || blockerSummary || "Target generated from overlap, build recurrence, and promotion pressure.")}</p>
        <ul>${blockers || "<li>No explicit blocker reasons recorded.</li>"}</ul>
      </article>`;
  }).join("\n");
}

function projectCanonicalizationCards(stateSnapshot, limit = 6) {
  const rows = stateSnapshot?.projects || [];

  return rows
    .filter((entry) => (entry.canonicalization?.top_targets || []).length > 0)
    .slice(0, limit)
    .map((entry) => {
      const targets = (entry.canonicalization?.top_targets || []).slice(0, 3).map((target) => `<li>${escapeHtml(target.name || target.target_id || "target")} · ${escapeHtml(target.promotion_stage || "unknown")}</li>`).join("");

      return `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "unknown")}</p>
        <h3>${escapeHtml(entry.canonicalization?.bottleneck_stage || "canonicalization backlog")}</h3>
        <code>${formatNumber((entry.canonicalization?.top_targets || []).length)} target${(entry.canonicalization?.top_targets || []).length === 1 ? "" : "s"} in focus</code>
        <ul>${targets || "<li>No project-level targets queued.</li>"}</ul>
      </article>`;
    }).join("\n");
}

function canonicalizationReasonList(stateSnapshot, scanner) {
  const reasons = canonicalizationState(stateSnapshot, scanner).reasons || [];

  return reasons.slice(0, 8).map((reason) => `        <li>
          <strong>${escapeHtml(titleLabel(reason.code || "reason"))}</strong>
          <span>${escapeHtml(reason.message || "No explanation recorded.")}</span>
          <em>${formatNumber(reason.current || 0)} now · ${formatNumber(reason.threshold || 0)} threshold</em>
        </li>`).join("\n");
}

function proofSurfaceCards(stateSnapshot, scanner, totals, projectCount) {
  const buildPlane = stateSnapshot?.build_plane || {};
  const releasePlane = stateSnapshot?.release_plane || {};
  const releaseSummary = releasePlane.summary || {};
  const buildSummary = releaseSummary.build || {};
  const installPlane = stateSnapshot?.install_plane || {};
  const canonicalization = canonicalizationState(stateSnapshot, scanner);
  const tokenEconomics = scanner?.token_economics || {};
  const tokenReduction = tokenEconomics.raw_source_tokens
    ? Math.round(((tokenEconomics.raw_source_tokens - (tokenEconomics.estimated_summary_tokens || 0)) / tokenEconomics.raw_source_tokens) * 100)
    : 0;

  const cards = [
    {
      tone: "ready",
      label: "Portfolio Proof",
      title: `${formatNumber(totals.brick_count || 0)} indexed bricks across ${formatNumber(projectCount)} projects`,
      copy: `${formatNumber(totals.status_counts?.candidate || 0)} candidate bricks and ${formatNumber(totals.status_counts?.canonical || 0)} canonical bricks already exist in the registry.`,
      link: "PROOF.generated.html",
      action: "Open proof surface"
    },
    {
      tone: Number(scanner?.build_report?.average_confidence_score || 0) >= 80 ? "ready" : "review",
      label: "Build Registry",
      title: `${formatNumber(scanner?.build_report?.candidate_count || 0)} build candidates with ${formatNumber(scanner?.build_report?.recurrent_family_count || 0)} recurrent families`,
      copy: `${formatNumber(scanner?.build_report?.detected_brick_count || 0)} bricks already participate in mined multi-brick capabilities.`,
      link: "BUILD_REGISTRY.generated.html",
      action: "Open build registry"
    },
    {
      tone: buildPlane.released_curated_build_count > 0 ? "review" : "danger",
      label: "Delivery Plane",
      title: `${formatNumber(buildPlane.curated_manifest_count || 0)} curated builds, ${formatNumber(buildSummary.artifact_count || 0)} build release artifacts`,
      copy: `${formatNumber(buildPlane.verification_ready_count || 0)} builds are verification-ready and ${formatNumber(buildPlane.publish_ready_count || 0)} are publish-ready.`,
      link: "CAPABILITIES.generated.html",
      action: "Open capability map"
    },
    {
      tone: Number(canonicalization.counts?.build_target_count || 0) > 0 || Number(canonicalization.counts?.brick_target_count || 0) > 0 ? "review" : "steady",
      label: "Canonicalization",
      title: `${formatNumber(canonicalization.counts?.build_target_count || 0)} build targets and ${formatNumber(canonicalization.counts?.brick_target_count || 0)} brick targets queued`,
      copy: `${formatNumber(installPlane.target_count || 0)} install target${installPlane.target_count === 1 ? "" : "s"} and ${formatNumber(tokenReduction)}% estimated token reduction show the next leverage layer.`,
      link: "CANONICALIZATION.generated.html",
      action: "Open target board"
    }
  ];

  return cards.map((card) => `      <article class="build-card build-card--${card.tone}">
        <p>${escapeHtml(card.label)}</p>
        <h3>${escapeHtml(card.title)}</h3>
        <p>${escapeHtml(card.copy)}</p>
        <a class="project-link" href="${card.link}">${escapeHtml(card.action)}</a>
      </article>`).join("\n");
}

function surfaceNav(activeHref) {
  const links = [
    { href: "DASHBOARD.generated.html", label: "Dashboard" },
    { href: "PROOF.generated.html", label: "Proof" },
    { href: "BUILD_REGISTRY.generated.html", label: "Build Registry" },
    { href: "CAPABILITIES.generated.html", label: "Capabilities" },
    { href: "CANONICALIZATION.generated.html", label: "Canonicalization" },
    { href: "BRICK_WALL.generated.html", label: "Brick Wall" },
    { href: "FEATURE_CLUSTERS.generated.html", label: "Feature Clusters" },
    { href: "BRICK_CATALOG.generated.md", label: "Catalog" },
    { href: "PROJECT_HEALTH.generated.md", label: "Project Health" },
    { href: "SMA_STATE.generated.json", label: "State JSON" }
  ];

  return `<nav class="nav" aria-label="Wiki navigation">
${links.map((link) => `      <a${link.href === activeHref ? ' class="active"' : ""} href="${link.href}">${escapeHtml(link.label)}</a>`).join("\n")}
    </nav>`;
}

function surfaceMetricGrid(metrics) {
  return `<div class="metrics">
${metrics.map((metric) => `      <div class="metric">
        <span>${escapeHtml(metric.label)}</span>
        <strong>${escapeHtml(metric.value)}</strong>
        ${metric.note ? `<small>${escapeHtml(metric.note)}</small>` : ""}
      </div>`).join("\n")}
    </div>`;
}

function surfacePageHtml({ title, lead, activeHref, metrics, sections }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f6f7f9;
      --ink: #17191d;
      --muted: #626a73;
      --line: #d9dde3;
      --panel: #ffffff;
      --coal: #23262b;
      --teal: #0f766e;
      --green: #517a3d;
      --wine: #9f2f45;
      --gold: #b28b12;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.45;
    }
    a { color: inherit; }
    header {
      padding: 34px max(18px, calc((100vw - 1280px) / 2)) 24px;
      background: linear-gradient(180deg, #ffffff 0%, #eef1f4 100%);
      border-bottom: 1px solid var(--line);
    }
    .kicker {
      margin: 0 0 10px;
      color: var(--teal);
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
    }
    h1 {
      max-width: 820px;
      margin: 0;
      font-size: 42px;
      line-height: 1.08;
    }
    .lead {
      max-width: 900px;
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 18px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 24px;
    }
    .metric, .panel, .scanner-band {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #ffffff;
      box-shadow: 0 12px 30px rgba(23, 25, 29, 0.06);
    }
    .metric {
      min-height: 92px;
      padding: 14px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 30px;
      line-height: 1;
    }
    .metric small {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    main { padding: 24px max(18px, calc((100vw - 1280px) / 2)) 42px; }
    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
    }
    .nav a {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 9px 12px;
      font-weight: 680;
      text-decoration: none;
    }
    .nav a.active {
      background: #1f252d;
      border-color: #1f252d;
      color: #ffffff;
    }
    .scanner-stack {
      display: grid;
      gap: 18px;
    }
    .scanner-band {
      padding: 18px;
    }
    .scanner-band-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: end;
      margin-bottom: 14px;
    }
    .scanner-band-head p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      max-width: 860px;
    }
    .scanner-band-head strong {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      border-radius: 999px;
      background: #1f252d;
      color: #ffffff;
      padding: 10px 14px;
      font-size: 26px;
      line-height: 1;
    }
    .scanner-band-head strong small {
      font-size: 13px;
      opacity: 0.72;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(260px, 380px) 1fr;
      gap: 16px;
    }
    .panel { padding: 16px; }
    .panel h2 {
      margin: 0 0 12px;
      font-size: 20px;
    }
    .status-line {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .status-line li {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: #f8f9fb;
      color: var(--muted);
      font-size: 13px;
    }
    .build-grid, .plan-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }
    .build-card, .plan-card {
      position: relative;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fbfcfd;
      padding: 16px;
      overflow: hidden;
    }
    .build-card::after, .plan-card::after {
      content: "";
      position: absolute;
      inset: auto 0 0 0;
      height: 7px;
      background: linear-gradient(90deg, var(--teal), var(--gold));
      opacity: 0.92;
    }
    .build-card--ready::after { background: linear-gradient(90deg, #3d8f59, #7fbe56); }
    .build-card--review::after { background: linear-gradient(90deg, #b28b12, #d3af37); }
    .build-card--danger::after { background: linear-gradient(90deg, #9f2f45, #d35267); }
    .build-card p, .plan-card p {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .build-card h3, .plan-card h3 {
      margin: 0 0 10px;
      font-size: 18px;
      line-height: 1.18;
      overflow-wrap: anywhere;
    }
    .build-card ul, .plan-card ul, .boundary-list {
      margin: 10px 0 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 13px;
    }
    dl {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 0;
    }
    dl div {
      border-top: 1px solid var(--line);
      padding: 8px 0 0;
    }
    dt {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    dd {
      margin: 3px 0 0;
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .boundary-list {
      display: grid;
      gap: 10px;
      list-style: none;
      padding-left: 0;
    }
    .boundary-list li {
      display: grid;
      gap: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      padding: 10px 12px;
    }
    .boundary-list strong {
      font-size: 13px;
    }
    .boundary-list span, .boundary-list em, code {
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      overflow-wrap: anywhere;
    }
    code {
      display: inline-block;
      border-radius: 6px;
      background: #eef1f4;
      padding: 2px 6px;
    }
    .project-link {
      display: inline-block;
      margin-top: 12px;
      color: var(--teal);
      font-weight: 760;
      text-decoration: none;
    }
    @media (max-width: 880px) {
      h1 { font-size: 32px; }
      .grid { grid-template-columns: 1fr; }
      .scanner-band-head { align-items: start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <p class="kicker">Sweetspot Modular Architecture</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(lead)}</p>
${surfaceMetricGrid(metrics)}
  </header>
  <main>
    ${surfaceNav(activeHref)}
    <section class="scanner-stack">
${sections.join("\n")}
    </section>
  </main>
</body>
</html>
`;
}

function proofSurfaceHtml(registry, stateSnapshot = null) {
  const scanner = registry.scanner_report || {};
  const totals = stateSnapshot?.totals || {};
  const trust = stateSnapshot?.trust || {};
  const qualityReport = trust.code_quality_report || scanner.code_quality_report || {};
  const buildPlane = stateSnapshot?.build_plane || {};
  const promotionPlane = stateSnapshot?.promotion_plane || {};
  const publishPlane = stateSnapshot?.publish_plane || {};
  const releasePlane = stateSnapshot?.release_plane || {};
  const installPlane = stateSnapshot?.install_plane || {};
  const releaseSummary = releasePlane.summary || {};
  const buildSummary = releaseSummary.build || {};
  const proofDeck = proofSurfaceCards(stateSnapshot, scanner, totals, (registry.projects || []).length);
  const buildDeck = buildCandidateCards(scanner, 6);
  const curatedDeck = curatedBuildCards(stateSnapshot, 4);
  const releaseDeck = releaseArtifactCards(stateSnapshot, 4);
  const familyDeck = capabilityFamilyCards(stateSnapshot, scanner, 6);
  const qualityDeck = qualityQueueCards(trust.quality_queue || scanner.remediation_report?.quality_queue || [], 6);
  const canonicalization = canonicalizationState(stateSnapshot, scanner);

  return surfacePageHtml({
    title: "SMARCH Proof Surface",
    lead: "Live evidence that the scanner is indexing real code, mining multi-brick capabilities, and beginning to accumulate release, provenance, and update surfaces instead of only static inventory.",
    activeHref: "PROOF.generated.html",
    metrics: [
      { label: "Projects", value: formatNumber(totals.project_count || (registry.projects || []).length) },
      { label: "Bricks", value: formatNumber(totals.brick_count || (registry.bricks || []).length) },
      { label: "Canonical", value: formatNumber(totals.status_counts?.canonical || 0), note: "Bricks already trusted highest" },
      { label: "Build Candidates", value: formatNumber(scanner.build_report?.candidate_count || 0), note: `${formatNumber(scanner.build_report?.recurrent_family_count || 0)} recurrent families` },
      { label: "Curated Builds", value: formatNumber(buildPlane.curated_manifest_count || 0), note: `${formatNumber(buildPlane.update_ready_build_count || 0)} update-ready` },
      { label: "Build Ready", value: formatNumber(buildPlane.verification_ready_count || 0), note: `${formatNumber(buildPlane.publish_ready_count || 0)} publish-ready` },
      { label: "Promotion Ready", value: formatNumber(promotionPlane.summary?.auto_promotable_count || buildPlane.promotion_ready_count || 0), note: `${formatNumber(promotionPlane.summary?.build_count || 0)} tracked` },
      { label: "Private Bundles", value: formatNumber(publishPlane.summary?.bundle_count || 0), note: `${formatNumber(publishPlane.summary?.publish_safe_count || 0)} safe` },
      { label: "Build Releases", value: formatNumber(buildSummary.artifact_count || 0), note: `${formatNumber(buildSummary.published_artifact_count || 0)} published` },
      { label: "Install Targets", value: formatNumber(installPlane.target_count || 0), note: `${formatNumber(installPlane.selected_build_count || 0)} selected builds tracked` },
      { label: "Readiness", value: `${formatNumber(trust.readiness?.average_score || scanner.readiness?.average_score || 0)}/${escapeHtml(trust.readiness?.average_grade || scanner.readiness?.average_grade || "F")}`, note: "Hard truth, not marketing" },
      { label: "Quality", value: `${formatNumber(qualityReport.average_score || qualityReport.score || 0)}/${escapeHtml(qualityReport.average_grade || qualityReport.grade || "A")}`, note: `${formatNumber(qualityReport.hotspot_file_count || 0)} hotspot files` }
    ],
    sections: [
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>What Is Already Real</h2>
            <p>These are the proof surfaces worth showing externally because they come directly from the current registry and state snapshot, not hand-waved roadmap copy.</p>
          </div>
          <strong>${formatNumber(scanner.build_report?.candidate_count || 0)}<small>builds seen</small></strong>
        </div>
        <div class="build-grid">
${proofDeck || "          <article class='build-card'><h3>No proof surfaces generated yet</h3></article>"}
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Representative Capability Proof</h2>
            <p>The strongest current evidence is repeated capability clusters, then curated manifests, then release artifacts. That is the path from scanner signal to a true SMARCH build plane.</p>
          </div>
          <strong>${formatNumber(scanner.build_report?.average_confidence_score || 0)}<small>/100 avg</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Highest Confidence Build Candidates</h2>
            <div class="build-grid">
${buildDeck || "              <article class='build-card'><h3>No build candidates yet</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Curated And Released Builds</h2>
            <div class="build-grid">
${curatedDeck || releaseDeck ? `${curatedDeck}${curatedDeck && releaseDeck ? "\n" : ""}${releaseDeck}` : "              <article class='build-card'><h3>No curated or released builds yet</h3></article>"}
            </div>
          </div>
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Hard Truths That Still Block Scale</h2>
            <p>The proof surface is only useful if it also shows what still prevents safe mass reuse. This keeps the story honest for teams and for your own roadmap.</p>
          </div>
          <strong>${formatNumber(canonicalization.counts?.project_work_bottleneck_count || 0)}<small>project bottlenecks</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Recurring Capabilities</h2>
            <div class="build-grid">
${familyDeck || "              <article class='build-card'><h3>No recurring capability families yet</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Current Constraints</h2>
            <ul class="status-line">
              <li>compliance: ${formatNumber(trust.compliance?.average_score || 0)}/${escapeHtml(trust.compliance?.average_grade || "F")}</li>
              <li>quality: ${formatNumber(qualityReport.average_score || qualityReport.score || 0)}/${escapeHtml(qualityReport.average_grade || qualityReport.grade || "A")}</li>
              <li>env gaps: ${formatNumber(trust.remediation_counts?.env_contract || 0)}</li>
              <li>RLS backlog: ${formatNumber(trust.remediation_counts?.rls_contract || 0)}</li>
              <li>boundary backlog: ${formatNumber(trust.remediation_counts?.boundary || 0)}</li>
              <li>quality backlog: ${formatNumber(trust.remediation_counts?.quality || 0)}</li>
              <li>hotspot files: ${formatNumber(qualityReport.hotspot_file_count || 0)}</li>
              <li>smell hits: ${formatNumber(qualityReport.total_smell_count || 0)}</li>
              <li>duplicate clusters: ${formatNumber(qualityReport.duplicate_cluster_count || 0)}</li>
              <li>releases published: ${formatNumber(buildSummary.published_artifact_count || 0)}</li>
              <li>verification-ready curated builds: ${formatNumber(buildPlane.verification_ready_count || 0)}</li>
              <li>publish-ready curated builds: ${formatNumber(buildPlane.publish_ready_count || 0)}</li>
              <li>promotion-ready curated builds: ${formatNumber(promotionPlane.summary?.auto_promotable_count || buildPlane.promotion_ready_count || 0)}</li>
              <li>private publish-safe bundles: ${formatNumber(publishPlane.summary?.publish_safe_count || 0)}</li>
              <li>install targets: ${formatNumber(installPlane.target_count || 0)}</li>
            </ul>
            <ul class="boundary-list" style="margin-top:16px;">
${canonicalizationReasonList(stateSnapshot, scanner) || "              <li><strong>No canonicalization blockers recorded.</strong></li>"}
            </ul>
          </div>
          <div class="panel">
            <h2>Code Quality Control</h2>
            <div class="plan-grid">
${qualityDeck || "              <article class='plan-card'><h3>No quality hotspots queued</h3></article>"}
            </div>
          </div>
        </div>
      </section>`
    ]
  });
}

function buildRegistryHtml(registry, stateSnapshot = null) {
  const scanner = registry.scanner_report || {};
  const buildPlane = stateSnapshot?.build_plane || {};
  const promotionPlane = stateSnapshot?.promotion_plane || {};
  const publishPlane = stateSnapshot?.publish_plane || {};
  const releasePlane = stateSnapshot?.release_plane || {};
  const releaseSummary = releasePlane.summary || {};
  const buildSummary = releaseSummary.build || {};

  return surfacePageHtml({
    title: "SMARCH Build Registry",
    lead: "A registry view over mined build candidates, curated capability manifests, and release-backed build artifacts. This is the clearest bridge from scanner output to something teams can actually adopt.",
    activeHref: "BUILD_REGISTRY.generated.html",
    metrics: [
      { label: "Build Candidates", value: formatNumber(scanner.build_report?.candidate_count || 0) },
      { label: "Recurrent Builds", value: formatNumber(scanner.build_report?.recurrent_candidate_count || 0) },
      { label: "Families", value: formatNumber(scanner.build_report?.recurrent_family_count || 0) },
      { label: "Avg Confidence", value: formatNumber(scanner.build_report?.average_confidence_score || 0), note: "Scanner-side confidence only" },
      { label: "Curated Builds", value: formatNumber(buildPlane.curated_manifest_count || 0) },
      { label: "Released Builds", value: formatNumber(buildPlane.released_curated_build_count || 0) },
      { label: "Update Ready", value: formatNumber(buildPlane.update_ready_build_count || 0) },
      { label: "Verification Ready", value: formatNumber(buildPlane.verification_ready_count || 0) },
      { label: "Publish Ready", value: formatNumber(buildPlane.publish_ready_count || 0), note: `${formatNumber(buildPlane.average_publishability_score || 0)}/100 avg` },
      { label: "Promotion Ready", value: formatNumber(promotionPlane.summary?.auto_promotable_count || buildPlane.promotion_ready_count || 0) },
      { label: "Private Bundles", value: formatNumber(publishPlane.summary?.bundle_count || buildPlane.private_publish_bundle_count || 0), note: `${formatNumber(publishPlane.summary?.publish_safe_count || buildPlane.private_publish_safe_count || 0)} safe` },
      { label: "Build Artifacts", value: formatNumber(buildSummary.artifact_count || 0) }
    ],
    sections: [
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Curated Build Manifests</h2>
            <p>These are the clearest current proof that the build layer is becoming explicit and portable instead of remaining an inferred scanner cluster.</p>
          </div>
          <strong>${formatNumber(buildPlane.curated_manifest_count || 0)}<small>manifests</small></strong>
        </div>
        <div class="build-grid">
${curatedBuildCards(stateSnapshot, 12) || "          <article class='build-card'><h3>No curated builds indexed yet</h3></article>"}
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Private Publish Gate</h2>
            <p>This is the practical bridge from “curated build” to “release artifact.” It shows whether a build can be packaged for reuse without leaking private project surface.</p>
          </div>
          <strong>${formatNumber(publishPlane.summary?.bundle_count || 0)}<small>bundles</small></strong>
        </div>
        <div class="build-grid">
${privatePublishCards(stateSnapshot, 12) || "          <article class='build-card'><h3>No private publish bundles indexed yet</h3></article>"}
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Release-Backed Build Artifacts</h2>
            <p>Release artifacts matter because they turn “we found a cluster” into “we can package, version, and eventually update this capability.”</p>
          </div>
          <strong>${formatNumber(buildSummary.artifact_count || 0)}<small>artifacts</small></strong>
        </div>
        <div class="build-grid">
${releaseArtifactCards(stateSnapshot, 12) || "          <article class='build-card'><h3>No build release artifacts indexed yet</h3></article>"}
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Scanner-Discovered Build Candidates</h2>
            <p>These are still mined from code structure and recurrence, but they already show where the strongest reusable capabilities are forming across the portfolio.</p>
          </div>
          <strong>${formatNumber(scanner.build_report?.detected_brick_count || 0)}<small>participating bricks</small></strong>
        </div>
        <div class="build-grid">
${buildCandidateCards(scanner, 24) || "          <article class='build-card'><h3>No build candidates detected</h3></article>"}
        </div>
      </section>`
    ]
  });
}

function capabilitiesHtml(registry, stateSnapshot = null) {
  const scanner = registry.scanner_report || {};
  const families = capabilityFamilies(stateSnapshot, scanner);
  const buildPlane = stateSnapshot?.build_plane || {};
  const topDomains = families.slice(0, 8).map((entry) => `${entry.label}: ${formatNumber(entry.project_count)} projects`).join(" · ");

  return surfacePageHtml({
    title: "Top Capability Families",
    lead: "A capability-first view over the build layer. This is the page that makes the jump from individual bricks to repeated product capability patterns visible.",
    activeHref: "CAPABILITIES.generated.html",
    metrics: [
      { label: "Capability Families", value: formatNumber(families.length) },
      { label: "Recurrent Builds", value: formatNumber(scanner.build_report?.recurrent_candidate_count || 0) },
      { label: "Recurrent Families", value: formatNumber(scanner.build_report?.recurrent_family_count || 0) },
      { label: "Peak Confidence", value: formatNumber(families[0]?.max_confidence_score || 0) },
      { label: "Curated Builds", value: formatNumber(buildPlane.curated_manifest_count || 0) },
      { label: "Installable", value: formatNumber(buildPlane.installable_build_count || 0), note: "Curated build manifests only" }
    ],
    sections: [
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Recurring Capability Families</h2>
            <p>These families are the real answer to your “bigger than bricks” concern. They expose where multiple bricks repeatedly combine into the same usable capability shape.</p>
          </div>
          <strong>${formatNumber(families.length)}<small>families</small></strong>
        </div>
        <div class="build-grid">
${capabilityFamilyCards(stateSnapshot, scanner, 18) || "          <article class='build-card'><h3>No recurring capability families detected yet</h3></article>"}
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Highest-Confidence Capability Builds</h2>
            <p>The strongest current candidates are repeated capability bundles that already look like reusable product modules instead of isolated source fragments.</p>
          </div>
          <strong>${formatNumber(scanner.build_report?.average_confidence_score || 0)}<small>/100 avg</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Top Build Candidates</h2>
            <div class="build-grid">
${buildCandidateCards(scanner, 12) || "              <article class='build-card'><h3>No build candidates detected yet</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Curated Capability Builds</h2>
            <div class="build-grid">
${curatedBuildCards(stateSnapshot, 8) || "              <article class='build-card'><h3>No curated capability builds yet</h3></article>"}
            </div>
          </div>
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>What Dominates Right Now</h2>
            <p>This line shows the strongest family labels currently visible from the build index. It is a fast way to see whether SMARCH is accumulating real reusable capability breadth.</p>
          </div>
          <strong>${formatNumber(scanner.build_report?.detected_brick_count || 0)}<small>bricks in builds</small></strong>
        </div>
        <div class="panel">
          <ul class="status-line">
            <li>${escapeHtml(topDomains || "No dominant capability families recorded yet.")}</li>
          </ul>
        </div>
      </section>`
    ]
  });
}

function canonicalizationHtml(registry, stateSnapshot = null) {
  const scanner = registry.scanner_report || {};
  const canonicalization = canonicalizationState(stateSnapshot, scanner);

  return surfacePageHtml({
    title: "Canonicalization Target Board",
    lead: "The promotion board for turning repeated capability and overlap evidence into trusted canonical builds and bricks. This makes the canonicalization backlog inspectable instead of fuzzy.",
    activeHref: "CANONICALIZATION.generated.html",
    metrics: [
      { label: "Ready Projects", value: formatNumber(canonicalization.counts?.ready_project_count || 0) },
      { label: "Project Bottlenecks", value: formatNumber(canonicalization.counts?.project_work_bottleneck_count || 0) },
      { label: "Artifact Bottlenecks", value: formatNumber(canonicalization.counts?.artifact_promotion_bottleneck_count || 0) },
      { label: "Build Targets", value: formatNumber(canonicalization.counts?.build_target_count || 0) },
      { label: "Brick Targets", value: formatNumber(canonicalization.counts?.brick_target_count || 0) },
      { label: "Top Targets", value: formatNumber((canonicalization.top_targets || []).length) }
    ],
    sections: [
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Why Canonicalization Is Still Blocked</h2>
            <p>These blockers explain why a bigger brick count is not enough on its own. Promotion only creates value when cloneability, contracts, and project pressure are under control.</p>
          </div>
          <strong>${escapeHtml(canonicalization.project_canonicalization_ready ? "ready" : "blocked")}<small>portfolio state</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Blocking Reasons</h2>
            <ul class="boundary-list">
${canonicalizationReasonList(stateSnapshot, scanner) || "              <li><strong>No canonicalization blockers recorded.</strong></li>"}
            </ul>
          </div>
          <div class="panel">
            <h2>Counts</h2>
            <ul class="status-line">
              <li>project count: ${formatNumber(canonicalization.counts?.project_count || 0)}</li>
              <li>ready projects: ${formatNumber(canonicalization.counts?.ready_project_count || 0)}</li>
              <li>project bottlenecks: ${formatNumber(canonicalization.counts?.project_work_bottleneck_count || 0)}</li>
              <li>artifact bottlenecks: ${formatNumber(canonicalization.counts?.artifact_promotion_bottleneck_count || 0)}</li>
              <li>build targets: ${formatNumber(canonicalization.counts?.build_target_count || 0)}</li>
              <li>brick targets: ${formatNumber(canonicalization.counts?.brick_target_count || 0)}</li>
            </ul>
          </div>
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Global Top Targets</h2>
            <p>These are the highest-leverage candidates for promotion right now, spanning both build-level and brick-level targets.</p>
          </div>
          <strong>${formatNumber((canonicalization.top_targets || []).length)}<small>targets</small></strong>
        </div>
        <div class="build-grid">
${canonicalTargetCards(stateSnapshot, scanner, 18) || "          <article class='build-card'><h3>No canonicalization targets queued</h3></article>"}
        </div>
      </section>`,
      `      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Project-Level Target Snapshots</h2>
            <p>Use these to see which project should be stabilized first before spending effort on global promotion work.</p>
          </div>
          <strong>${formatNumber((stateSnapshot?.projects || []).length)}<small>projects</small></strong>
        </div>
        <div class="plan-grid">
${projectCanonicalizationCards(stateSnapshot, 10) || "          <article class='plan-card'><h3>No project target snapshots available</h3></article>"}
        </div>
      </section>`
    ]
  });
}

function dashboardHtml(registry, bricks, metadata, stateSnapshot = null) {
  const projects = registry.projects || [];
  const scanner = registry.scanner_report || {};
  const refactor = registry.refactor_report || {};
  const buildPlane = stateSnapshot?.build_plane || {};
  const releasePlane = stateSnapshot?.release_plane || {};
  const releaseSummary = releasePlane.summary || {};
  const releaseBuildSummary = releaseSummary.build || {};
  const installPlane = stateSnapshot?.install_plane || {};
  const qualityReport = stateSnapshot?.trust?.code_quality_report || scanner.code_quality_report || {};
  const totalBricks = bricks.length;
  const totalWarnings = projects.reduce((sum, project) => sum + (project.warning_count || 0), 0);
  const totalErrors = projects.reduce((sum, project) => sum + (project.error_count || 0), 0);
  const blockedProjects = projects.filter((project) => projectStatus(project, metadata.get(project.id)).includes("blocked")).length;
  const avgScore = totalBricks ? Math.round(bricks.reduce((sum, brick) => sum + (brick.score || 0), 0) / totalBricks) : 0;
  const statusCounts = countBy(projects, (project) => projectStatus(project, metadata.get(project.id)));
  const brickStatusCounts = countBy(bricks, (brick) => brick.status);
  const healthCounts = countBy(bricks, (brick) => brick.health?.status);
  const riskCounts = countBy(bricks, (brick) => brick.risk);
  const clusterCounts = countBy(bricks, (brick) => brick.feature_cluster?.name);
  const maxProjectBricks = Math.max(1, ...projects.map((project) => project.brick_count || 0));
  const projectRows = projects.map((project) => {
    const meta = metadata.get(project.id);
    const status = projectStatus(project, meta);
    const tone = projectTone(status);
    const security = meta?.sma?.security_gate || project.security_gate;
    const width = Math.max(4, Math.round(((project.brick_count || 0) / maxProjectBricks) * 100));

    return `      <article class="project ${tone}" data-name="${escapeHtml(`${project.id} ${project.root}`.toLowerCase())}" data-status="${escapeHtml(status)}">
        <div class="project-head">
          <h3>${escapeHtml(project.id)}</h3>
          <span>${escapeHtml(status)}</span>
        </div>
        <p>${escapeHtml(project.root || "No root recorded")}</p>
        <div class="project-meter"><b style="width:${width}%"></b></div>
        <dl>
          <div><dt>Bricks</dt><dd>${project.brick_count || 0}</dd></div>
          <div><dt>Warnings</dt><dd>${project.warning_count || 0}</dd></div>
          <div><dt>Errors</dt><dd>${project.error_count || 0}</dd></div>
          <div><dt>Security</dt><dd>${security ? `${security.high_or_critical || 0} high/critical` : "not recorded"}</dd></div>
        </dl>
        <a class="project-link" href="projects/${slugify(project.id)}.md">Open project page</a>
      </article>`;
  }).join("\n");
  const statusBars = statusCounts.map(([status, count]) => {
    const width = projects.length ? Math.max(6, Math.round((count / projects.length) * 100)) : 0;
    return `        <div class="bar-row"><span>${escapeHtml(status)}</span><b style="width:${width}%"></b><em>${count}</em></div>`;
  }).join("\n");
  const brickBars = brickStatusCounts.map(([status, count]) => {
    const width = totalBricks ? Math.max(6, Math.round((count / totalBricks) * 100)) : 0;
    return `        <div class="bar-row"><span>${escapeHtml(status)}</span><b style="width:${width}%"></b><em>${count}</em></div>`;
  }).join("\n");
  const healthPills = healthCounts.map(([health, count]) => `<li>${escapeHtml(health)} health: ${count}</li>`).join("\n          ");
  const riskPills = riskCounts.map(([risk, count]) => `<li>${escapeHtml(risk)} risk: ${count}</li>`).join("\n          ");
  const clusterBars = clusterCounts.slice(0, 10).map(([cluster, count]) => {
    const width = totalBricks ? Math.max(6, Math.round((count / totalBricks) * 100)) : 0;
    return `        <div class="bar-row"><span>${escapeHtml(cluster)}</span><b style="width:${width}%"></b><em>${count}</em></div>`;
  }).join("\n");
  const readinessAverage = scanner.readiness?.average_score || 0;
  const readinessGrade = scanner.readiness?.average_grade || "F";
  const complianceAverage = scanner.compliance_report?.average_score || 0;
  const complianceGrade = scanner.compliance_report?.average_grade || "F";
  const buildCandidateCount = scanner.build_report?.candidate_count || 0;
  const buildConfidence = scanner.build_report?.average_confidence_score || 0;
  const recurrentBuildCount = scanner.build_report?.recurrent_candidate_count || 0;
  const recurrentFamilyCount = scanner.build_report?.recurrent_family_count || 0;
  const refactorQueueCount = (refactor.refactor_queue || []).length;
  const duplicateClusterCount = (scanner.duplicate_clusters || []).length;
  const tokenReduction = scanner.token_economics?.raw_source_tokens
    ? Math.round(((scanner.token_economics.raw_source_tokens - (scanner.token_economics.estimated_summary_tokens || 0)) / scanner.token_economics.raw_source_tokens) * 100)
    : 0;
  const envGapCount = scanner.env_contract_report?.bricks_with_undeclared_refs || 0;
  const curatedBuildCount = buildPlane.curated_manifest_count || 0;
  const releasedCuratedBuildCount = buildPlane.released_curated_build_count || 0;
  const updateReadyBuildCount = buildPlane.update_ready_build_count || 0;
  const releaseArtifactCount = releaseSummary.release_count || 0;
  const installTargetCount = installPlane.target_count || 0;
  const installUpdateEventCount = installPlane.update_event_count || 0;
  const qualityAverage = qualityReport.average_score || qualityReport.score || 0;
  const qualityGrade = qualityReport.average_grade || qualityReport.grade || "A";
  const scannerBricks = scannerReadinessCards(scanner);
  const complianceProjectDeck = complianceProjectCards(scanner);
  const complianceDimensionDeck = complianceDimensionRows(scanner);
  const complianceGapDeck = complianceGapCards(scanner);
  const buildDeck = buildCandidateCards(scanner);
  const buildFamilies = buildFamilyRows(scanner);
  const curatedBuildDeck = curatedBuildCards(stateSnapshot);
  const releaseDeck = releaseArtifactCards(stateSnapshot);
  const installDeck = installEvidenceCards(stateSnapshot);
  const remediationDeck = remediationActionCards(scanner);
  const remediationPlans = remediationProjectPlans(scanner);
  const qualityDeck = qualityQueueCards(stateSnapshot?.trust?.quality_queue || scanner.remediation_report?.quality_queue || [], 10);
  const qualityProjectDeck = qualityProjectCards(stateSnapshot, 8);
  const queueCards = scannerQueueCards(refactor.refactor_queue || []);
  const cloneCards = cloneRiskCards(scanner);
  const envCards = envContractCards(scanner);
  const duplicateDeck = duplicateCards(scanner);
  const tokenDeck = tokenCards(scanner);
  const boundaryList = boundaryRows(scanner);
  const proofDeck = proofSurfaceCards(stateSnapshot, scanner, stateSnapshot?.totals || {}, projects.length);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BRICKWORKS Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #04070c;
      --bg-alt: #090d12;
      --panel: #f4f1e8;
      --panel-strong: #e3ddd2;
      --ink: #111111;
      --hero-ink: #f4f1e8;
      --muted: #6c675f;
      --line: #111111;
      --blue: #8fb6ff;
      --gold: #f6bb08;
      --green: #78b14f;
      --wine: #c44960;
      --teal: #4bb3a5;
      --shadow: 10px 10px 0 #111111;
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--hero-ink);
      font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
      line-height: 1.6;
    }
    body {
      background:
        radial-gradient(circle at 16% 12%, rgba(143, 182, 255, 0.18), transparent 0 22%),
        radial-gradient(circle at 84% 14%, rgba(255, 255, 255, 0.08), transparent 0 18%),
        linear-gradient(180deg, #05070b 0%, #090d12 34%, #0b1016 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.03;
      background-image:
        linear-gradient(rgba(244, 241, 232, 0.22) 1px, transparent 1px),
        linear-gradient(90deg, rgba(244, 241, 232, 0.22) 1px, transparent 1px);
      background-size: 84px 84px;
      mask-image: radial-gradient(circle at center, black 28%, transparent 88%);
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    button,
    input,
    code,
    .brand-name,
    .crumbs,
    .chrome-cta a,
    .kicker,
    .metric span,
    .nav a,
    .panel h2,
    .scan-result,
    .bar-row,
    .status-line,
    .project-head span,
    .project-link,
    .scanner-band-head strong small,
    .scanner-brick-head p,
    .queue-project,
    .risk-card p,
    .env-card p,
    .duplicate-card p,
    .token-card p,
    .gap-card p,
    .action-card p,
    .plan-card p,
    .build-card p,
    .action-tag,
    dt {
      font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .chrome {
      position: sticky;
      top: 0;
      z-index: 40;
      backdrop-filter: blur(12px);
      background: linear-gradient(180deg, rgba(4, 7, 12, 0.84), rgba(4, 7, 12, 0.38));
      border-bottom: 1px solid rgba(244, 241, 232, 0.14);
    }
    .chrome-inner {
      max-width: 1520px;
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand-mark {
      width: 34px;
      height: 28px;
      background: linear-gradient(180deg, #ffe47f 0 55%, var(--gold) 55% 100%);
      border-radius: 4px 4px 6px 6px;
      position: relative;
      box-shadow: 0 3px 0 #7a4d00;
    }
    .brand-mark::before,
    .brand-mark::after {
      content: "";
      position: absolute;
      top: -5px;
      width: 11px;
      height: 7px;
      border-radius: 999px;
      background: #ffe47f;
    }
    .brand-mark::before { left: 4px; }
    .brand-mark::after { right: 4px; }
    .brand-name {
      font-weight: 700;
      letter-spacing: 0.14em;
      font-size: 0.95rem;
      color: var(--hero-ink);
    }
    .crumbs {
      margin-left: 8px;
      color: rgba(244, 241, 232, 0.6);
      font-size: 0.74rem;
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .chrome-cta {
      margin-left: auto;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .chrome-cta a {
      font-size: 0.68rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 9px 12px;
      border: 1px solid rgba(244, 241, 232, 0.14);
      background: rgba(4, 7, 12, 0.2);
      color: rgba(244, 241, 232, 0.76);
      backdrop-filter: blur(6px);
      transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
    }
    .chrome-cta a:hover {
      background: rgba(4, 7, 12, 0.42);
      border-color: rgba(143, 182, 255, 0.5);
      transform: translateY(-1px);
    }
    header {
      max-width: 1520px;
      margin: 0 auto;
      padding: 38px 24px 0;
    }
    .hero-shell {
      position: relative;
      overflow: hidden;
      padding: 30px;
      border: 2px solid #111111;
      box-shadow: var(--shadow);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.06), transparent 24%),
        linear-gradient(135deg, rgba(143, 182, 255, 0.16), rgba(4, 7, 12, 0) 34%),
        linear-gradient(180deg, #0c1017 0%, #05080d 100%);
    }
    .hero-shell::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 18% 22%, rgba(143, 182, 255, 0.16), transparent 0 26%),
        radial-gradient(circle at 78% 24%, rgba(255, 255, 255, 0.08), transparent 0 20%),
        repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.02) 1px, transparent 1px, transparent 4px);
      pointer-events: none;
    }
    .hero-shell > * {
      position: relative;
      z-index: 1;
    }
    .kicker {
      margin: 0 0 14px;
      color: rgba(244, 241, 232, 0.6);
      font-size: 0.74rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    h1,
    .projects-head h2,
    .scanner-band-head h2,
    .scanner-brick h3,
    .queue-card h3,
    .risk-card h3,
    .env-card h3,
    .duplicate-card h3,
    .token-card h3,
    .gap-card h3,
    .action-card h3,
    .plan-card h3,
    .build-card h3,
    .project h3 {
      font-family: "Anton", Impact, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    h1 {
      max-width: 980px;
      margin: 0;
      font-size: clamp(3rem, 8vw, 6.8rem);
      line-height: 0.92;
      color: var(--hero-ink);
    }
    .lead {
      max-width: 880px;
      margin: 16px 0 0;
      color: rgba(244, 241, 232, 0.76);
      font-size: clamp(1rem, 2vw, 1.2rem);
    }
    .hero-note {
      max-width: 960px;
      margin: 18px 0 0;
      color: rgba(244, 241, 232, 0.6);
      font-size: 0.92rem;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
      gap: 12px;
      margin-top: 24px;
    }
    .metric,
    .panel,
    .project {
      background: var(--panel);
      color: var(--ink);
      border: 2px solid #111111;
      box-shadow: 6px 6px 0 #111111;
    }
    .metric {
      position: relative;
      min-height: 98px;
      padding: 14px 16px;
      overflow: hidden;
    }
    .metric::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 6px;
      background: linear-gradient(90deg, var(--blue), var(--gold));
    }
    .metric:nth-child(3n)::before { background: linear-gradient(90deg, var(--gold), #ffe47f); }
    .metric:nth-child(3n + 2)::before { background: linear-gradient(90deg, var(--teal), var(--blue)); }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 0.66rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      margin-top: 10px;
      font-family: "Anton", Impact, sans-serif;
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 0.92;
    }
    main {
      max-width: 1520px;
      margin: 0 auto;
      padding: 20px 24px 84px;
    }
    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 18px 0 26px;
    }
    .nav a,
    button {
      min-height: 44px;
      border: 2px solid #111111;
      background: var(--panel);
      color: var(--ink);
      padding: 0 14px;
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      box-shadow: 4px 4px 0 #111111;
      cursor: pointer;
      transition: transform 160ms ease, background 160ms ease;
    }
    .nav a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .nav a:hover,
    button:hover {
      transform: translate(-1px, -1px);
      background: #fff6d9;
    }
    input {
      width: 100%;
      min-height: 46px;
      border: 2px solid #111111;
      background: var(--panel);
      color: var(--ink);
      padding: 0 14px;
      font-size: 0.84rem;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 18px;
      align-items: start;
    }
    .dashboard-overview {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .panel {
      padding: 18px;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .bar-row {
      display: grid;
      grid-template-columns: minmax(0, 170px) 1fr 42px;
      gap: 10px;
      align-items: center;
      margin: 10px 0;
      color: var(--muted);
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .bar-row b {
      display: block;
      height: 12px;
      min-width: 6px;
      border-radius: 999px;
      border: 1px solid #111111;
      background: linear-gradient(90deg, var(--blue), var(--wine));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4);
    }
    .bar-row em {
      color: var(--ink);
      font-style: normal;
      text-align: right;
    }
    .status-line {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 0.66rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .status-line li {
      border: 1px solid rgba(17, 17, 17, 0.14);
      padding: 8px 10px;
      background: rgba(17, 17, 17, 0.04);
      color: var(--muted);
    }
    .scan-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 10px;
      align-items: start;
    }
    .browser {
      display: none;
      max-height: 240px;
      overflow: auto;
      margin-top: 12px;
      border: 2px solid #111111;
      background: #0b0f17;
      color: var(--hero-ink);
      padding: 8px;
      box-shadow: 6px 6px 0 #111111;
    }
    .browser button {
      width: 100%;
      min-height: 38px;
      margin: 4px 0;
      border: 1px solid rgba(244, 241, 232, 0.12);
      background: rgba(244, 241, 232, 0.04);
      color: var(--hero-ink);
      box-shadow: none;
      text-align: left;
      padding: 0 12px;
      transform: none;
    }
    .browser button:hover {
      background: rgba(244, 241, 232, 0.1);
      transform: none;
    }
    .scan-result {
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 0.74rem;
      overflow-wrap: anywhere;
    }
    .projects-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      margin: 42px 0 16px;
    }
    .projects-head h2 {
      margin: 0;
      font-size: clamp(2.4rem, 5vw, 4.4rem);
      line-height: 0.92;
      color: var(--hero-ink);
    }
    .project-search {
      max-width: 360px;
    }
    .projects {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
      gap: 14px;
    }
    .project {
      min-height: 248px;
      padding: 18px;
      overflow: hidden;
      border-top: 8px solid var(--blue);
      transition: transform 160ms ease;
    }
    .project:hover {
      transform: translate(-2px, -2px);
    }
    .project.ready { border-top-color: var(--green); }
    .project.review { border-top-color: var(--gold); }
    .project.danger { border-top-color: var(--wine); }
    .project-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
    }
    .project h3 {
      margin: 0;
      font-size: clamp(1.7rem, 3vw, 2.6rem);
      line-height: 0.92;
      overflow-wrap: anywhere;
    }
    .project-head span {
      background: #111111;
      color: #ffffff;
      padding: 6px 8px;
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .project p {
      min-height: 48px;
      margin: 12px 0;
      color: var(--muted);
      font-size: 0.84rem;
      overflow-wrap: anywhere;
    }
    .project-meter,
    .compliance-bar,
    .token-bar {
      height: 12px;
      overflow: hidden;
      border-radius: 999px;
      border: 1px solid #111111;
      background: rgba(17, 17, 17, 0.08);
      margin: 10px 0 14px;
    }
    .project-meter b {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--teal), var(--gold));
    }
    dl {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
      margin: 0;
    }
    dl div {
      border-top: 1px solid rgba(17, 17, 17, 0.14);
      padding: 8px 0 0;
    }
    dt {
      color: var(--muted);
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    dd {
      margin: 4px 0 0;
      font-size: 0.92rem;
      font-weight: 700;
    }
    .project-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 14px;
      color: #20395c;
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-decoration: none;
    }
    .project-link:hover {
      color: #111111;
    }
    .scanner-stack {
      display: grid;
      gap: 24px;
      margin: 24px 0 30px;
    }
    .scanner-band {
      position: relative;
      overflow: hidden;
      padding: 22px;
      border: 2px solid #111111;
      box-shadow: var(--shadow);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.06), transparent 24%),
        linear-gradient(135deg, rgba(143, 182, 255, 0.16), rgba(4, 7, 12, 0) 34%),
        linear-gradient(180deg, #0c1017 0%, #05080d 100%);
    }
    .scanner-band::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 20% 22%, rgba(143, 182, 255, 0.1), transparent 0 24%),
        radial-gradient(circle at 78% 16%, rgba(255, 255, 255, 0.06), transparent 0 18%);
      pointer-events: none;
    }
    .scanner-band > * {
      position: relative;
      z-index: 1;
    }
    .scanner-band-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      margin-bottom: 16px;
    }
    .scanner-band-head h2 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 4rem);
      line-height: 0.92;
      color: var(--hero-ink);
    }
    .scanner-band-head p {
      margin: 10px 0 0;
      color: rgba(244, 241, 232, 0.72);
      font-size: 0.92rem;
      max-width: 860px;
    }
    .scanner-band-head strong {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      background: var(--panel);
      color: var(--ink);
      border: 2px solid #111111;
      box-shadow: 6px 6px 0 #111111;
      padding: 12px 16px 10px;
      font-family: "Anton", Impact, sans-serif;
      font-size: clamp(2rem, 4vw, 3.5rem);
      line-height: 0.9;
    }
    .scanner-band-head strong small {
      font-size: 0.68rem;
      color: var(--muted);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .scanner-brick-grid,
    .queue-grid,
    .risk-grid,
    .env-grid,
    .duplicate-grid,
    .token-grid,
    .gap-grid,
    .action-grid,
    .plan-grid,
    .build-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }
    .scanner-brick,
    .queue-card,
    .risk-card,
    .env-card,
    .duplicate-card,
    .token-card,
    .gap-card,
    .action-card,
    .plan-card,
    .build-card {
      position: relative;
      overflow: hidden;
      background: var(--panel);
      color: var(--ink);
      border: 2px solid #111111;
      box-shadow: 6px 6px 0 #111111;
      padding: 18px;
    }
    .scanner-brick::after,
    .queue-card::after,
    .risk-card::after,
    .env-card::after,
    .duplicate-card::after,
    .token-card::after,
    .gap-card::after,
    .action-card::after,
    .plan-card::after,
    .build-card::after {
      content: "";
      position: absolute;
      inset: auto 0 0 0;
      height: 7px;
      background: linear-gradient(90deg, var(--blue), var(--gold));
      opacity: 0.96;
    }
    .scanner-brick--ready::after,
    .risk-card--copy_ready::after,
    .gap-card--ready::after,
    .build-card--ready::after {
      background: linear-gradient(90deg, #3d8f59, #7fbe56);
    }
    .scanner-brick--review::after,
    .risk-card--guided::after,
    .risk-card--manual_review::after,
    .env-card--manual_review::after,
    .gap-card--review::after,
    .gap-card--manual_review::after,
    .build-card--review::after {
      background: linear-gradient(90deg, #dba928, #ffe47f);
    }
    .scanner-brick--danger::after,
    .queue-card--critical::after,
    .risk-card--blocked::after,
    .env-card--blocked::after,
    .gap-card--danger::after,
    .gap-card--blocked::after,
    .build-card--danger::after {
      background: linear-gradient(90deg, #a93f52, #e16d82);
    }
    .scanner-studs {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .scanner-studs span {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      background: linear-gradient(180deg, #fff9e7, #d7cfc0);
      border: 1px solid #111111;
      box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.7);
    }
    .scanner-brick-head,
    .queue-card h3,
    .risk-card h3,
    .env-card h3,
    .duplicate-card h3,
    .token-card h3,
    .gap-card h3,
    .action-card h3,
    .plan-card h3,
    .build-card h3 {
      margin: 0;
    }
    .scanner-brick-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: end;
    }
    .scanner-brick-head p,
    .queue-project,
    .risk-card p,
    .env-card p,
    .duplicate-card p,
    .token-card p,
    .gap-card p,
    .action-card p,
    .plan-card p,
    .build-card p {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 0.64rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .scanner-brick-head strong {
      font-family: "Anton", Impact, sans-serif;
      font-size: clamp(2rem, 4vw, 3.2rem);
      line-height: 0.9;
    }
    .scanner-brick-head strong small {
      font-size: 0.68rem;
      color: var(--muted);
      margin-left: 6px;
    }
    .scanner-brick h3,
    .queue-card h3,
    .risk-card h3,
    .env-card h3,
    .duplicate-card h3,
    .token-card h3,
    .gap-card h3,
    .action-card h3,
    .plan-card h3,
    .build-card h3 {
      margin: 0 0 12px;
      font-size: clamp(1.55rem, 2.7vw, 2.4rem);
      line-height: 0.94;
      overflow-wrap: anywhere;
    }
    .scanner-brick ul,
    .env-card ul,
    .duplicate-card ul,
    .gap-card ul,
    .plan-card ul,
    .boundary-list,
    .compliance-list {
      margin: 10px 0 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 0.84rem;
    }
    .action-tag {
      display: inline-flex;
      align-items: center;
      border: 1px solid #111111;
      background: rgba(143, 182, 255, 0.16);
      padding: 4px 8px;
      margin-bottom: 10px;
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #20395c;
    }
    .gap-card h3 small {
      font-size: 0.7rem;
      color: var(--muted);
      margin-left: 6px;
    }
    .compliance-list {
      list-style: none;
      padding-left: 0;
      margin: 0;
    }
    .compliance-list li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 12px;
      align-items: center;
      border-bottom: 1px solid rgba(17, 17, 17, 0.14);
      padding: 10px 0;
    }
    .compliance-list li:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .compliance-list strong,
    .compliance-list span,
    .compliance-list em {
      font-size: 0.82rem;
      font-style: normal;
    }
    .compliance-list span,
    .compliance-list em {
      color: var(--muted);
    }
    .compliance-bar b,
    .token-bar b {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--wine), var(--gold));
    }
    .queue-card {
      padding-left: 62px;
    }
    .queue-rank {
      position: absolute;
      top: 16px;
      left: 16px;
      width: 32px;
      height: 32px;
      background: #111111;
      color: #ffffff;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 32px;
      text-align: center;
    }
    .queue-copy {
      min-height: 70px;
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 0.88rem;
    }
    .boundary-list {
      display: grid;
      gap: 10px;
      list-style: none;
      padding-left: 0;
    }
    .boundary-list li {
      display: grid;
      gap: 4px;
      border: 2px solid #111111;
      background: rgba(244, 241, 232, 0.94);
      padding: 12px;
      box-shadow: 4px 4px 0 #111111;
    }
    .boundary-list strong {
      font-size: 0.82rem;
      color: #111111;
    }
    .boundary-list span,
    .boundary-list em,
    code {
      color: var(--muted);
      font-size: 0.74rem;
      font-style: normal;
      overflow-wrap: anywhere;
    }
    code {
      display: inline-block;
      background: rgba(17, 17, 17, 0.08);
      color: #20395c;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .panel .lead {
      max-width: none;
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 0.86rem;
    }
    @media (max-width: 1180px) {
      .dashboard-overview {
        grid-template-columns: 1fr;
      }
      .grid {
        grid-template-columns: 1fr;
      }
      .scan-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 880px) {
      .chrome-inner {
        padding: 12px 16px;
        align-items: flex-start;
        flex-direction: column;
      }
      .chrome-cta {
        margin-left: 0;
      }
      header {
        padding: 28px 16px 0;
      }
      .hero-shell {
        padding: 22px 18px;
        box-shadow: 8px 8px 0 #111111;
      }
      main {
        padding: 18px 16px 70px;
      }
      .projects-head {
        align-items: start;
        flex-direction: column;
      }
      .project-search {
        max-width: none;
      }
      .scanner-band-head {
        align-items: start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="chrome">
    <div class="chrome-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">BRICKWORKS</span></div>
      <nav class="crumbs" aria-label="Dashboard location"><span>Dashboard</span><span>/</span><span>Scanner Command Deck</span></nav>
      <div class="chrome-cta">
        <a href="index.html">SMA home</a>
        <a href="BRICK_WALL_LEGO.generated.html">Brick wall</a>
        <a href="FEATURE_CLUSTERS.generated.html">Feature clusters</a>
      </div>
    </div>
  </div>
  <header>
    <div class="hero-shell">
      <p class="kicker">Sweetspot Modular Architecture · live command deck</p>
      <h1>Scanner Command Deck</h1>
      <p class="lead">Brick-by-brick and build-by-build feedback for readiness, release trust, install evidence, updateability, boundary leaks, refactor pressure, overlap, and token efficiency.</p>
      <p class="hero-note">This surface is the operational layer above the registry: what is reusable now, what needs refactor pressure next, and where builds are crossing from scanner evidence into delivery assets.</p>
      <div class="metrics">
      <div class="metric"><span>Projects</span><strong>${projects.length}</strong></div>
      <div class="metric"><span>Bricks</span><strong>${totalBricks}</strong></div>
      <div class="metric"><span>Readiness</span><strong>${readinessAverage}/${readinessGrade}</strong></div>
      <div class="metric"><span>Compliance</span><strong>${complianceAverage}/${complianceGrade}</strong></div>
      <div class="metric"><span>Build Candidates</span><strong>${buildCandidateCount}</strong></div>
      <div class="metric"><span>Curated Builds</span><strong>${curatedBuildCount}</strong></div>
      <div class="metric"><span>Build Releases</span><strong>${releaseArtifactCount}</strong></div>
      <div class="metric"><span>Install Targets</span><strong>${installTargetCount}</strong></div>
      <div class="metric"><span>Update Events</span><strong>${installUpdateEventCount}</strong></div>
      <div class="metric"><span>Refactor Queue</span><strong>${refactorQueueCount}</strong></div>
      <div class="metric"><span>Warnings</span><strong>${totalWarnings}</strong></div>
      <div class="metric"><span>Blocked</span><strong>${scanner.clone_preflight?.counts?.blocked || blockedProjects}</strong></div>
      <div class="metric"><span>Env Gaps</span><strong>${envGapCount}</strong></div>
      <div class="metric"><span>Fix Actions</span><strong>${(scanner.remediation_report?.top_actions || []).length}</strong></div>
      <div class="metric"><span>Token Savings</span><strong>${tokenReduction}%</strong></div>
      </div>
    </div>
  </header>
  <main>
    <nav class="nav" aria-label="Dashboard navigation">
      <a href="PROOF.generated.html">Proof</a>
      <a href="BUILD_REGISTRY.generated.html">Build Registry</a>
      <a href="CAPABILITIES.generated.html">Capabilities</a>
      <a href="CANONICALIZATION.generated.html">Canonicalization</a>
      <a href="BRICK_WALL.generated.html">Brick Wall</a>
      <a href="FEATURE_CLUSTERS.generated.html">Feature Clusters</a>
      <a href="BRICK_CATALOG.generated.md">Catalog</a>
      <a href="PROJECT_HEALTH.generated.md">Project Health</a>
      <a href="SMA_STATE.generated.json">State JSON</a>
    </nav>
    <section class="scanner-band">
      <div class="scanner-band-head">
        <div>
          <h2>Adoption Surfaces</h2>
          <p>These are the high-value public and internal proof views: portfolio proof, build registry, capability families, and canonicalization targets. They all read from the current state snapshot and scanner build index.</p>
        </div>
        <strong>4<small>linked views</small></strong>
      </div>
      <div class="build-grid">
${proofDeck || "        <article class='build-card'><h3>No adoption surfaces generated yet</h3></article>"}
      </div>
    </section>
    <section class="grid dashboard-overview" aria-label="Status charts">
      <div class="panel">
        <h2>Project Status</h2>
${statusBars || "        <p>No projects indexed.</p>"}
      </div>
      <div class="panel">
        <h2>Brick Signals</h2>
${brickBars || "        <p>No bricks indexed.</p>"}
        <ul class="status-line">
          ${healthPills}
          ${riskPills}
        </ul>
      </div>
      <div class="panel">
        <h2>Scanner Pressure</h2>
        <ul class="status-line">
          <li>quality: ${formatNumber(qualityAverage)}/${escapeHtml(qualityGrade)}</li>
          <li>quality hotspots: ${formatNumber(qualityReport.hotspot_file_count || 0)}</li>
          <li>quality backlog: ${formatNumber(scanner.remediation_report?.counts?.quality || 0)}</li>
          <li>smell hits: ${formatNumber(qualityReport.total_smell_count || 0)}</li>
          <li>private imports: ${scanner.boundary_report?.private_cross_brick_import_count || 0}</li>
          <li>cross-group leaks: ${scanner.boundary_report?.cross_brick_owned_import_count || 0}</li>
          <li>same-group coupling: ${scanner.boundary_report?.same_group_internal_import_count || 0}</li>
          <li>unresolved local imports: ${scanner.boundary_report?.unresolved_local_import_count || 0}</li>
          <li>drift entries: ${scanner.manifest_drift?.count || 0}</li>
          <li>undeclared env refs: ${scanner.env_contract_report?.undeclared_reference_count || 0}</li>
          <li>ignored runtime env refs: ${scanner.env_contract_report?.ignored_reference_count || 0}</li>
          <li>duplicate clusters: ${duplicateClusterCount}</li>
          <li>raw source tokens: ${formatNumber(scanner.token_economics?.raw_source_tokens || 0)}</li>
        </ul>
        <h2 style="margin-top:16px;">Top Feature Areas</h2>
${clusterBars || "        <p>No feature clusters indexed.</p>"}
      </div>
    </section>
    <section class="scanner-stack" aria-label="Scanner intelligence">
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>SMA Compliance</h2>
            <p>Compliance scores measure how many reusable bricks actually meet the SMA contract: clean boundaries, declared envs, clone steps, tests, API docs, attestation, and security hygiene.</p>
          </div>
          <strong>${complianceAverage}<small>/${complianceGrade}</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Coverage By Dimension</h2>
            <ul class="compliance-list">
${complianceDimensionDeck || "              <li><strong>No compliance dimensions active.</strong></li>"}
            </ul>
            <h2 style="margin-top:16px;">Project Compliance</h2>
            <div class="gap-grid">
${complianceProjectDeck || "              <article class='gap-card'><h3>No compliance scores yet</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Highest Compliance Gaps</h2>
            <div class="gap-grid">
${complianceGapDeck || "              <article class='gap-card'><h3>No compliance gaps detected</h3></article>"}
            </div>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Build Layer</h2>
            <p>These are repeated multi-brick capabilities the scanner can already see. They are the raw scanner-side funnel that feeds curated build manifests and release artifacts.</p>
          </div>
          <strong>${buildConfidence}<small>/100 avg</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Top Build Candidates</h2>
            <div class="build-grid">
${buildDeck || "              <article class='build-card'><h3>No build candidates yet</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Recurring Build Families</h2>
            <ul class="boundary-list">
${buildFamilies || "              <li><strong>No recurrent build families detected.</strong></li>"}
            </ul>
            <ul class="status-line" style="margin-top:16px;">
              <li>detected builds: ${buildCandidateCount}</li>
              <li>recurrent builds: ${recurrentBuildCount}</li>
              <li>recurrent families: ${recurrentFamilyCount}</li>
              <li>build-participating bricks: ${formatNumber(scanner.build_report?.detected_brick_count || 0)}</li>
            </ul>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Build Delivery Plane</h2>
            <p>Curated manifests, release artifacts, and update-ready trust signals show whether SMARCH is becoming a real product layer instead of only a scanner output.</p>
          </div>
          <strong>${releasedCuratedBuildCount}<small>/${curatedBuildCount} released</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Curated Builds</h2>
            <div class="build-grid">
${curatedBuildDeck || "              <article class='build-card'><h3>No curated builds yet</h3></article>"}
            </div>
            <ul class="status-line" style="margin-top:16px;">
              <li>released curated builds: ${releasedCuratedBuildCount}</li>
              <li>update-ready builds: ${updateReadyBuildCount}</li>
              <li>rollback-supported builds: ${buildPlane.rollback_supported_build_count || 0}</li>
              <li>candidate+ verification: ${buildPlane.candidate_or_better_verification_count || 0}</li>
            </ul>
          </div>
          <div class="panel">
            <h2>Release Index</h2>
            <div class="build-grid">
${releaseDeck || "              <article class='build-card'><h3>No release artifacts indexed</h3></article>"}
            </div>
            <ul class="status-line" style="margin-top:16px;">
              <li>build artifacts: ${releaseBuildSummary.artifact_count || 0}</li>
              <li>published build artifacts: ${releaseBuildSummary.published_artifact_count || 0}</li>
              <li>candidate channel releases: ${(releaseBuildSummary.channels || {}).candidate || 0}</li>
              <li>stable/lts artifacts: ${releaseBuildSummary.stable_or_lts_artifact_count || 0}</li>
            </ul>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Install And Update Evidence</h2>
            <p>Central progress is only real once builds are installed into target projects and their <code>.smarch</code> control plane records prove placements, frozen graph state, and update journal history.</p>
          </div>
          <strong>${installTargetCount}<small>targets</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Observed Targets</h2>
            <div class="plan-grid">
${installDeck || "              <article class='plan-card'><h3>No persisted build installs detected under Projects/ yet</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Install Evidence Totals</h2>
            <ul class="status-line">
              <li>selected builds: ${installPlane.selected_build_count || 0}</li>
              <li>resolved bricks: ${installPlane.resolved_brick_count || 0}</li>
              <li>imports tracked: ${installPlane.import_count || 0}</li>
              <li>placements tracked: ${installPlane.placement_count || 0}</li>
              <li>journal events: ${installPlane.update_event_count || 0}</li>
              <li>latest event: ${escapeHtml(installPlane.latest_event_at || "none recorded")}</li>
            </ul>
            <p class="lead" style="font-size:14px;margin-top:16px;">Scan roots: ${escapeHtml((installPlane.scan_roots || []).join(" · ") || "none")}</p>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Code Quality Control</h2>
            <p>SMA refactor should improve the codebase itself, not just its modular inventory. This lane keeps smell hotspots, oversized UI/service files, and exact-ish duplicate forks visible.</p>
          </div>
          <strong>${formatNumber(qualityAverage)}<small>/${escapeHtml(qualityGrade)}</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Top Quality Actions</h2>
            <div class="plan-grid">
${qualityDeck || "              <article class='plan-card'><h3>No quality actions queued</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Project Quality Pressure</h2>
            <div class="plan-grid">
${qualityProjectDeck || "              <article class='plan-card'><h3>No project quality pressure recorded</h3></article>"}
            </div>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Next Moves</h2>
            <p>High-priority scanner fixes grouped into env contracts, RLS completion, boundary cleanup, and code-quality repair so the backlog turns into concrete moves instead of abstract scores.</p>
          </div>
          <strong>${(scanner.remediation_report?.top_actions || []).length}<small>actions</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Top Actions</h2>
            <div class="action-grid">
${remediationDeck || "              <article class='action-card'><h3>No actions queued</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Project Action Plans</h2>
            <div class="plan-grid">
${remediationPlans || "              <article class='plan-card'><h3>No project plans queued</h3></article>"}
            </div>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Project Readiness Bricks</h2>
            <p>Each project gets a scanner readiness grade based on validation blockers, clone preflight failures, boundary leaks, manifest drift, oversized files, and manifest backlog.</p>
          </div>
          <strong>${readinessAverage}<small>/${readinessGrade}</small></strong>
        </div>
        <div class="scanner-brick-grid">
${scannerBricks || "          <article class='scanner-brick'><h3>No readiness data yet</h3></article>"}
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Refactor Queue</h2>
            <p>The highest-pressure files to split first, with expected slice count and the first safe move already spelled out.</p>
          </div>
          <strong>${refactorQueueCount}<small>queued</small></strong>
        </div>
        <div class="queue-grid">
${queueCards || "          <article class='queue-card'><h3>No queue entries</h3></article>"}
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Boundary And Clone Feedback</h2>
            <p>Boundary violations come from import scanning. Clone risk comes from source coverage, validation, security, contract completeness, and local dependency leakage.</p>
          </div>
          <strong>${scanner.clone_preflight?.counts?.blocked || 0}<small>blocked</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Boundary Alerts</h2>
            <ul class="boundary-list">
${boundaryList || "              <li><strong>No boundary alerts.</strong></li>"}
            </ul>
            <h2 style="margin-top:16px;">Env Contract Gaps</h2>
            <div class="env-grid">
${envCards || "              <article class='env-card'><h3>No env gaps detected</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Highest Clone Risk</h2>
            <div class="risk-grid">
${cloneCards || "              <article class='risk-card'><h3>No clone risk data</h3></article>"}
            </div>
          </div>
        </div>
      </section>
      <section class="scanner-band">
        <div class="scanner-band-head">
          <div>
            <h2>Overlap And Token Economy</h2>
            <p>Duplicate clusters show likely canonicalization candidates. Token cards show where compact summaries win most against raw source loading.</p>
          </div>
          <strong>${duplicateClusterCount}<small>clusters</small></strong>
        </div>
        <div class="grid">
          <div class="panel">
            <h2>Duplicate Clusters</h2>
            <div class="duplicate-grid">
${duplicateDeck || "              <article class='duplicate-card'><h3>No duplicate clusters</h3></article>"}
            </div>
          </div>
          <div class="panel">
            <h2>Token Heavy Bricks</h2>
            <div class="token-grid">
${tokenDeck || "              <article class='token-card'><h3>No token report yet</h3></article>"}
            </div>
          </div>
        </div>
      </section>
    </section>
    <section class="panel command-panel" aria-label="Add project">
      <h2>Add Project</h2>
      <p class="scan-result">First-time setup runs discovery, creates missing project-bound manifests, rescans, generates this dashboard, and runs the security gate. Use plain scan when you only want inventory without writing manifests.</p>
      <div class="scan-grid">
        <input id="scan-root" value=PROJECTS_ROOT aria-label="Project folder path">
        <button id="browse">Browse</button>
        <button id="scan">Run Scan</button>
        <button id="setup">First-Time Setup</button>
      </div>
      <div class="browser" id="browser"></div>
      <p class="scan-result" id="scan-result">Open through the local SMA dashboard server to browse folders and trigger scans. Static file mode stays read-only.</p>
    </section>
    <div class="projects-head">
      <h2>Projects</h2>
      <input class="project-search" id="project-search" type="search" placeholder="Filter projects">
    </div>
    <section class="projects" id="projects" aria-label="Projects">
${projectRows || '      <div class="project"><h3>No projects indexed</h3><p>Run a scan to add a project.</p></div>'}
    </section>
  </main>
  <script>
    const result = document.getElementById("scan-result");
    const scanRoot = document.getElementById("scan-root");
    const browser = document.getElementById("browser");
    const projectSearch = document.getElementById("project-search");
    const projects = Array.from(document.querySelectorAll(".project[data-name]"));

    async function api(path, options) {
      const response = await fetch(path, options);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function browse(path) {
      try {
        const data = await api("/api/list?path=" + encodeURIComponent(path));
        scanRoot.value = data.path;
        browser.style.display = "block";
        browser.innerHTML = "";
        if (data.parent) {
          const parent = document.createElement("button");
          parent.textContent = "..";
          parent.addEventListener("click", () => browse(data.parent));
          browser.append(parent);
        }
        for (const item of data.dirs) {
          const button = document.createElement("button");
          button.textContent = item.name;
          button.addEventListener("click", () => browse(item.path));
          browser.append(button);
        }
        result.textContent = "Folder selected. Run scan when ready.";
      } catch (error) {
        result.textContent = "Local dashboard server is required for folder browsing. " + error.message;
      }
    }

    document.getElementById("browse").addEventListener("click", () => browse(scanRoot.value));
    document.getElementById("scan").addEventListener("click", async () => {
      result.textContent = "Scanning " + scanRoot.value + " ...";
      try {
        const data = await api("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: scanRoot.value })
        });
        result.innerHTML = "Scan complete: " + data.count + " brick(s), " + data.unmanifested_count + " unmanifested. <a href='" + data.dashboard + "'>Open dashboard</a>";
      } catch (error) {
        result.textContent = "Scan failed. " + error.message;
      }
    });

    document.getElementById("setup").addEventListener("click", async () => {
      result.textContent = "Running first-time setup for " + scanRoot.value + " ...";
      try {
        const data = await api("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: scanRoot.value })
        });
        result.innerHTML = "Setup complete: " + data.count + " brick(s), " + data.unmanifested_count + " unmanifested, " + data.security_high_or_critical + " high/critical security finding(s). <a href='" + data.dashboard + "'>Open dashboard</a>";
      } catch (error) {
        result.textContent = "Setup failed. " + error.message;
      }
    });

    projectSearch.addEventListener("input", () => {
      const value = projectSearch.value.trim().toLowerCase();
      for (const project of projects) {
        project.hidden = value && !project.dataset.name.includes(value);
      }
    });
  </script>
</body>
</html>
`;
}

function projectHealthMarkdown(projects, bricks) {
  const rows = projects.map((project) => mdTableRow([
    `[${project.id}](projects/${slugify(project.id)}.md)`,
    project.brick_count ?? 0,
    project.unmanifested_count ?? 0,
    project.candidate_group_count ?? 0,
    project.average_score ?? 0,
    project.health_counts?.ok ?? 0,
    project.health_counts?.warn ?? 0,
    project.health_counts?.fail ?? 0,
    project.error_count ?? 0,
    project.warning_count ?? 0
  ]));

  return `# Project Health

Generated from the SMA registry.

| Project | Manifested | Unmanifested | Groups | Avg Score | OK | Warn | Fail | Errors | Warnings |
|---------|------------|--------------|--------|-----------|----|------|------|--------|----------|
${rows.join("\n")}

Total bricks: ${bricks.length}
Unmanifested candidates: ${projects.reduce((sum, project) => sum + (project.unmanifested_count || 0), 0)}

`;
}

function projectPage(project, bricks, unmanifested, candidateGroups) {
  const projectBricks = bricks.filter((brick) => brick.project === project.id);
  const projectCandidates = unmanifested.filter((candidate) => candidate.project === project.id);
  const projectGroups = candidateGroups.filter((group) => group.project === project.id);
  const rows = projectBricks.map((brick) => mdTableRow([
    `[${brick.name}](../bricks/${slugify(brick.id)}.md)`,
    brick.feature_cluster?.name || "General / Shared",
    brick.status,
    brick.score,
    brick.health?.status || "",
    brick.health?.errors?.join(", ") || "",
    brick.health?.warnings?.join(", ") || ""
  ]));
  const candidateRows = projectCandidates.map((candidate) => mdTableRow([
    candidate.candidate_type || "",
    candidate.hierarchy_role || "",
    candidate.group_name || "",
    candidate.relative_path || candidate.path,
    candidate.reason
  ]));
  const typeRows = Object.entries(project.candidate_type_counts || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([type, count]) => mdTableRow([type, count]));
  const roleRows = Object.entries(project.candidate_role_counts || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([role, count]) => mdTableRow([role, count]));
  const groupRows = projectGroups.map((group) => mdTableRow([
    group.name,
    group.candidate_count,
    Object.entries(group.candidate_type_counts || {}).map(([type, count]) => `${type}: ${count}`).join(", "),
    (group.sample_paths || []).slice(0, 6).join("; ")
  ]));

  return `# ${project.id}

## Health

| Field | Value |
|-------|-------|
| Bricks | ${project.brick_count ?? projectBricks.length} |
| Unmanifested candidates | ${project.unmanifested_count ?? projectCandidates.length} |
| Candidate groups | ${project.candidate_group_count ?? projectGroups.length} |
| Average score | ${project.average_score ?? 0} |
| OK | ${project.health_counts?.ok ?? 0} |
| Warn | ${project.health_counts?.warn ?? 0} |
| Fail | ${project.health_counts?.fail ?? 0} |
| Errors | ${project.error_count ?? 0} |
| Warnings | ${project.warning_count ?? 0} |

## Candidate Types

| Type | Count |
|------|-------|
${typeRows.join("\n")}

## Candidate Roles

| Role | Count |
|------|-------|
${roleRows.join("\n")}

## Candidate Groups

| Group | Count | Types | Samples |
|-------|-------|-------|---------|
${groupRows.join("\n")}

## Bricks

| Brick | Feature Area | Status | Score | Health | Errors | Warnings |
|-------|--------------|--------|-------|--------|--------|----------|
${rows.join("\n")}

## Unmanifested Candidates

| Type | Role | Group | Path | Reason |
|------|------|-------|------|--------|
${candidateRows.join("\n")}

`;
}

function courseHtml(bricks) {
  const cards = bricks.map((brick) => `
      <article class="card">
        <p class="eyebrow">${escapeHtml(brick.kind || "brick")}</p>
        <h3>${escapeHtml(brick.name)}</h3>
        <dl>
          <div><dt>Status</dt><dd>${escapeHtml(brick.status || "unknown")}</dd></div>
          <div><dt>Score</dt><dd>${escapeHtml(brick.score ?? 0)}</dd></div>
          <div><dt>Clone</dt><dd>${escapeHtml(brick.clone_readiness || "unknown")}</dd></div>
        </dl>
      </article>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SMA Brick Course</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1b1b1f;
      --muted: #5e636e;
      --line: #d8dbe2;
      --panel: #f7f8fa;
      --accent: #146c5f;
      --accent-2: #8b2f47;
      --paper: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.55;
    }
    header, section { padding: 48px max(20px, calc((100vw - 1100px) / 2)); }
    header { background: #eef5f3; border-bottom: 1px solid var(--line); }
    h1 { max-width: 800px; margin: 0 0 16px; font-size: 44px; line-height: 1.08; }
    h2 { margin: 0 0 18px; font-size: 30px; }
    h3 { margin: 4px 0 12px; font-size: 20px; }
    p { max-width: 760px; margin: 0 0 16px; }
    .lead { font-size: 19px; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 18px; background: var(--paper); }
    .band { background: var(--panel); border-block: 1px solid var(--line); }
    .eyebrow { color: var(--accent); font-weight: 700; text-transform: uppercase; font-size: 12px; letter-spacing: 0; margin: 0; }
    .flow { display: flex; flex-wrap: wrap; gap: 8px; padding: 0; list-style: none; }
    .flow li { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--paper); }
    dl { margin: 0; display: grid; gap: 8px; }
    dl div { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); padding-top: 8px; }
    dt { color: var(--muted); }
    dd { margin: 0; font-weight: 650; }
    .quiz { border-left: 5px solid var(--accent-2); background: #fbf1f4; padding: 18px; border-radius: 8px; }
    code { background: #eef0f3; border-radius: 4px; padding: 1px 5px; }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Sweetspot Modular Architecture</p>
    <h1>Learn SMA By Reading Bricks</h1>
    <p class="lead">A brick is reusable only when its code, tests, security gates, clone notes, and provenance travel together.</p>
  </header>

  <section>
    <h2>The Lifecycle</h2>
    <ul class="flow">
      <li>Find brick</li>
      <li>Inspect trust</li>
      <li>Copy files</li>
      <li>Adapt ports</li>
      <li>Run gates</li>
      <li>Record provenance</li>
    </ul>
  </section>

  <section class="band">
    <h2>The Gates</h2>
    <div class="grid">
      <article class="card"><p class="eyebrow">SSA-v2</p><h3>Security Boundary</h3><p>No frontend secrets, no privileged direct calls, explicit data paths.</p></article>
      <article class="card"><p class="eyebrow">SSI</p><h3>Failure Isolation</h3><p>Lazy safety, error boundary, fallback, and access gate.</p></article>
      <article class="card"><p class="eyebrow">SSTF</p><h3>Proof Tests</h3><p>Behavior, contracts, edge cases, and security regressions.</p></article>
      <article class="card"><p class="eyebrow">SVA</p><h3>Vulnerability Gate</h3><p>Secrets, authz, RLS, dependency, and attack-surface checks.</p></article>
    </div>
  </section>

  <section>
    <h2>Brick Catalog</h2>
    <div class="grid">
${cards || '      <article class="card"><h3>No bricks indexed yet</h3><p>Add module.sweetspot.json files, then run the scanner.</p></article>'}
    </div>
  </section>

  <section class="band">
    <h2>Decision Quiz</h2>
    <div class="quiz">
      <p><strong>You found a candidate brick with score 82 and no RLS matrix, but it touches user_private data. Do you make it canonical?</strong></p>
      <p>No. It can be a guided/manual copy, but canonical status needs the access matrix and negative tests.</p>
    </div>
  </section>
</body>
</html>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = JSON.parse(await fs.readFile(options.registry, "utf8"));
  const bricks = registry.bricks || [];
  const metadata = await projectMetadata(registry.projects || []);
  const stateSnapshotPath = path.resolve(repoRoot, "wiki/SMA_STATE.generated.json");
  const stateSnapshot = await maybeReadJson(stateSnapshotPath);

  await fs.rm(path.join(options.out, "bricks"), { recursive: true, force: true });
  await fs.rm(path.join(options.out, "projects"), { recursive: true, force: true });
  await fs.mkdir(path.join(options.out, "bricks"), { recursive: true });
  await fs.mkdir(path.join(options.out, "courses"), { recursive: true });
  await fs.mkdir(path.join(options.out, "projects"), { recursive: true });

  for (const brick of bricks) {
    const slug = slugify(brick.id);
    const manifest = await readManifest(brick);
    attachFeatureCluster(brick, manifest);
    await fs.writeFile(path.join(options.out, "bricks", `${slug}.md`), brickMarkdown(brick, manifest));
  }

  await fs.writeFile(path.join(options.out, "BRICK_CATALOG.generated.md"), catalogMarkdown(bricks));
  await fs.writeFile(path.join(options.out, "PROJECT_HEALTH.generated.md"), projectHealthMarkdown(registry.projects || [], bricks));
  await fs.writeFile(path.join(options.out, "BRICK_WALL.generated.html"), brickWallHtml(registry, bricks));
  await fs.writeFile(path.join(options.out, "FEATURE_CLUSTERS.generated.html"), featureClustersHtml(registry, bricks));
  await fs.writeFile(path.join(options.out, "DASHBOARD.generated.html"), dashboardHtml(registry, bricks, metadata, stateSnapshot));
  await fs.writeFile(path.join(options.out, "PROOF.generated.html"), proofSurfaceHtml(registry, stateSnapshot));
  await fs.writeFile(path.join(options.out, "BUILD_REGISTRY.generated.html"), buildRegistryHtml(registry, stateSnapshot));
  await fs.writeFile(path.join(options.out, "CAPABILITIES.generated.html"), capabilitiesHtml(registry, stateSnapshot));
  await fs.writeFile(path.join(options.out, "CANONICALIZATION.generated.html"), canonicalizationHtml(registry, stateSnapshot));
  if (stateSnapshot) {
    await fs.writeFile(path.join(options.out, "SMA_STATE.generated.json"), `${JSON.stringify(stateSnapshot, null, 2)}\n`);
  }

  for (const project of registry.projects || []) {
    await fs.writeFile(path.join(options.out, "projects", `${slugify(project.id)}.md`), projectPage(project, bricks, registry.unmanifested_bricks || [], registry.candidate_groups || []));
  }

  await fs.writeFile(path.join(options.out, "courses", "sma-brick-course.generated.html"), courseHtml(bricks));

  console.log(`Generated ${bricks.length} brick page(s) and ${(registry.projects || []).length} project page(s) in ${options.out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
