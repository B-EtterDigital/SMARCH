/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Existing logical-OR fallbacks intentionally treat every falsy value as absent; replacing them with ?? would change behavior. */
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Runtime registry, manifest, and CLI inputs can violate their optimistic compile-time declarations; these guards are intentional. */
import fs from "node:fs/promises";

import { featureClusterForBrick as featureClusterFor } from "./feature-clusters.ts";

import { countBy, escapeHtml, mdTableRow, slugify } from "./wiki-utils.ts";
import type { LooseRecord } from "./wiki-utils.ts";
import type { BrickManifest } from "./schema-types/brick.manifest.schema.d.ts";
import type { GlobalRegistry } from "./schema-types/global.registry.schema.d.ts";
import type { CompactBrick } from "./scan-discovery.ts";

interface GateView { status?: string; score?: number; notes?: string; evidence?: string[] }
type ManifestView = BrickManifest & {
  sweetspot?: Record<string, GateView>;
  supply_chain?: { dependencies?: { name: string; version?: string; license?: string; risk?: string; purpose?: string }[] };
};
interface FeatureClusterView { id: string; name: string; description: string; bricks: CompactBrick[]; warning_count: number; error_count: number; score_total: number; risk_counts: Record<string, number>; status_counts: Record<string, number>; kind_counts: Record<string, number>; project_counts: Record<string, number>; count: number; average_score: number }



export async function readManifest(brick: LooseRecord): Promise<ManifestView | null> {
  if (typeof brick.manifest_path !== "string" || !brick.manifest_path) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(brick.manifest_path, "utf8"));
    return parsed as ManifestView;
  } catch {
    // External registry entries may reference manifests unavailable on this machine.
    return null;
  }
}

export async function maybeReadJson(filePath: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed;
  } catch {
    // Optional generated inputs are represented as absent.
    return null;
  }
}

function gateRows(manifest: ManifestView | null | undefined): string {
  const gates: Record<string, GateView> = manifest?.sweetspot || {};
  return Object.entries(gates).map(([name, gate]) => mdTableRow([
    name,
    gate.status || "",
    gate.score ?? "",
    gate.notes || "",
    Array.isArray(gate.evidence) ? gate.evidence.join("; ") : ""
  ])).join("\n");
}

function listLines(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) {
    return "- Not declared";
  }

  return items.map((item) => `- ${String(item)}`).join("\n");
}

function provenanceLines(manifest: ManifestView | null | undefined): string {
  const events = [
    manifest?.provenance.created_by,
    ...(manifest?.provenance.touched_by || []),
    ...(manifest?.provenance.reviewed_by || [])
  ].filter((event): event is NonNullable<typeof event> => Boolean(event));

  if (events.length === 0) {
    return "- Not recorded";
  }

  return events.map((event) => {
    const actor = [event.actor_kind, event.provider, event.model || event.actor_id].filter(Boolean).join(" / ");
    return `- ${actor}: ${event.role} at ${event.timestamp || "unknown time"} - ${event.summary || "No summary"}`;
  }).join("\n");
}

function envRows(manifest: ManifestView | null | undefined): string {
  const vars = manifest?.security.env.variables || [];

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

function dependencyRows(manifest: ManifestView | null | undefined): string {
  const dependencies = manifest?.supply_chain.dependencies || [];

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

// eslint-disable-next-line max-lines-per-function, complexity -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
export function brickMarkdown(brick: CompactBrick, manifest: ManifestView | null): string {
  const models = brick.models.length ? brick.models.join(", ") : "Not recorded";
  const dataClasses = brick.data_classes.length ? brick.data_classes.join(", ") : "Not declared";
  const findings = manifest?.security.vulnerability_findings;
  const codeBudget = manifest?.quality.code_budget;

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
| Score | ${String(brick.score ?? 0)} |
| Clone readiness | ${brick.clone_readiness || "unknown"} |
| Health | ${brick.health.status || "unknown"} |
| Validation errors | ${String(brick.health.error_count ?? 0)} |
| Validation warnings | ${String(brick.health.warning_count ?? 0)} |
| Risk | ${brick.risk || "unknown"} |
| Data classes | ${dataClasses} |
| Models recorded | ${models} |

## Code Budget

| Field | Value |
|-------|-------|
| Status | ${codeBudget?.status || "Not declared"} |
| Feature lines | ${String(codeBudget?.feature_lines ?? "Not declared")} |
| File count | ${String(codeBudget?.file_count ?? "Not declared")} |
| Dependency count | ${String(codeBudget?.dependency_count ?? "Not declared")} |
| Notes | ${codeBudget?.notes || "Not declared"} |

## Source

| Field | Value |
|-------|-------|
| Manifest | ${brick.manifest_path || ""} |
| Source paths | ${(brick.source_paths || []).join(", ") || "Not declared"} |
| Owner | ${manifest?.owner.primary || "Not declared"} |

## Boundaries

| Field | Value |
|-------|-------|
| Owned paths | ${(manifest?.boundaries.owned_paths || []).join(", ") || "Not declared"} |
| Public paths | ${(manifest?.boundaries.public_paths || []).join(", ") || "Not declared"} |
| Private paths | ${(manifest?.boundaries.private_paths || []).join(", ") || "Not declared"} |
| Forbidden imports | ${(manifest?.boundaries.forbidden_imports || []).join(", ") || "Not declared"} |

## Supply Chain

| Dependency | Version | License | Risk | Purpose |
|------------|---------|---------|------|---------|
${dependencyRows(manifest)}

## Gates

| Gate | Status | Score | Notes | Evidence |
|------|--------|-------|-------|----------|
${gateRows(manifest) || "| Not declared | | | | |"}

## Public API

${listLines(manifest?.interfaces.public_api)}

## Adapter Points

${listLines(manifest?.interfaces.adapters)}

## Clone Steps

${listLines(manifest?.clone.install_steps)}

## Known Traps

${listLines(manifest?.clone.known_traps)}

## Env Contract

| Variable | Scope | Required In | Forbidden In |
|----------|-------|-------------|--------------|
${envRows(manifest)}

## RLS Contract

| Field | Value |
|-------|-------|
| Required | ${String(manifest?.security.rls.required ?? "unknown")} |
| Status | ${manifest?.security.rls.status || "unknown"} |
| Matrix | ${manifest?.security.rls.matrix_path || "Not declared"} |

## Vulnerability Findings

| Severity | Count |
|----------|-------|
| Critical | ${String(findings?.critical ?? 0)} |
| High | ${String(findings?.high ?? 0)} |
| Medium | ${String(findings?.medium ?? 0)} |
| Low | ${String(findings?.low ?? 0)} |

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

export function catalogMarkdown(bricks: CompactBrick[]): string {
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
      brick.health.status || "",
      brick.risk || "",
      brick.feature_cluster?.name || "General / Shared",
      brick.models.join(", ") || ""
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

function optionList(values: [string, number][]): string {
  return values.map(([value]) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
}

function shortPath(brick: CompactBrick): string {
  const [first] = brick.source_paths || [];
  return first || brick.manifest_path || "";
}

function brickTone(brick: CompactBrick): string {
  if (brick.health.status === "fail" || brick.risk === "critical") {
    return "danger";
  }

  if (brick.health.warning_count > 0 || brick.status === "project_bound" || brick.risk === "high") {
    return "review";
  }

  if (brick.status === "canonical" && brick.health.status === "ok") {
    return "ready";
  }

  return "steady";
}

// eslint-disable-next-line complexity -- Compatibility fallback expressions inflate the branch metric although this normalization and report assembly remains linear.
function featureClusters(bricks: CompactBrick[]): FeatureClusterView[] {
  const byId = new Map<string, Omit<FeatureClusterView, "count" | "average_score">>();

  for (const brick of bricks) {
    const cluster = brick.feature_cluster || featureClusterFor({
      id: brick.id,
      name: brick.name,
      kind: brick.kind,
      status: brick.status,
      risk: brick.risk,
      brick_group: brick.brick_group || undefined,
      manifest_path: brick.manifest_path,
      source_paths: brick.source_paths,
      domain: brick.domain,
    });
    const current = byId.get(cluster.id) || {
      ...cluster,
      bricks: [] as CompactBrick[],
      warning_count: 0,
      error_count: 0,
      score_total: 0,
      risk_counts: {},
      status_counts: {},
      kind_counts: {},
      project_counts: {}
    };

    current.bricks.push(brick);
    current.warning_count += brick.health.warning_count || 0;
    current.error_count += brick.health.error_count || 0;
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

function countsLine(counts: Record<string, number> | null | undefined): string {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}: ${String(count)}`)
    .join(", ");
}

// eslint-disable-next-line max-lines-per-function -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
export function brickWallHtml(registry: GlobalRegistry, bricks: CompactBrick[]): string {
  const projects = registry.projects || [];
  const totalWarnings = projects.reduce((sum, project) => sum + (project.warning_count || 0), 0);
  const totalErrors = projects.reduce((sum, project) => sum + (project.error_count || 0), 0);
  const avgScore = bricks.length ? Math.round(bricks.reduce((sum, brick) => sum + (brick.score || 0), 0) / bricks.length) : 0;
  const byKind = countBy(bricks, (brick) => brick.kind);
  const byStatus = countBy(bricks, (brick) => brick.status);
  const byHealth = countBy(bricks, (brick) => brick.health.status);
  const byRisk = countBy(bricks, (brick) => brick.risk);
  const byCluster = countBy(bricks, (brick) => brick.feature_cluster?.name);
  const byProject = countBy(bricks, (brick) => brick.project);
  const projectName = projects.length === 1 ? projects[0]?.id || "SMA Registry" : "SMA Registry";
  const dominantStatus = byStatus[0]?.[0] || "unknown";
// eslint-disable-next-line complexity -- Compatibility fallback expressions inflate the branch metric although this normalization and report assembly remains linear.
  const wallRows = bricks.map((brick) => {
    const slug = slugify(brick.id);
    const pathLabel = shortPath(brick);
    const tone = brickTone(brick);
    const warnings = brick.health.warning_count ?? 0;
    const errors = brick.health.error_count ?? 0;

    return `      <a class="brick ${tone}" href="bricks/${slug}.md" data-name="${escapeHtml(`${brick.name} ${brick.id} ${brick.project || ""} ${pathLabel} ${brick.feature_cluster?.name || ""}`.toLowerCase())}" data-project="${escapeHtml(brick.project || "unknown")}" data-kind="${escapeHtml(brick.kind || "unknown")}" data-status="${escapeHtml(brick.status || "unknown")}" data-health="${escapeHtml(brick.health.status || "unknown")}" data-risk="${escapeHtml(brick.risk || "unknown")}" data-cluster="${escapeHtml(brick.feature_cluster?.name || "General / Shared")}">
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
          <span>${escapeHtml(brick.health.status || "unknown")}</span>
          <span>${String(warnings)} warn</span>
          <span>${String(errors)} err</span>
        </span>
      </a>`;
  }).join("\n");
  const kindBars = byKind.slice(0, 10).map(([kind, count]) => {
    const width = bricks.length ? Math.max(6, Math.round((count / bricks.length) * 100)) : 0;
    return `        <div class="bar-row"><span>${escapeHtml(kind)}</span><b style="width:${String(width)}%"></b><em>${String(count)}</em></div>`;
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
      <div class="metric"><span>Total Bricks</span><strong>${String(bricks.length)}</strong></div>
      <div class="metric"><span>Average Score</span><strong>${String(avgScore)}</strong></div>
      <div class="metric"><span>Warnings</span><strong>${String(totalWarnings)}</strong></div>
      <div class="metric"><span>Errors</span><strong>${String(totalErrors)}</strong></div>
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
          ${byStatus.map(([status, count]) => `<li>${escapeHtml(status)}: ${String(count)}</li>`).join("\n          ")}
          ${byHealth.map(([health, count]) => `<li>${escapeHtml(health)} health: ${String(count)}</li>`).join("\n          ")}
          ${byRisk.map(([risk, count]) => `<li>${escapeHtml(risk)} risk: ${String(count)}</li>`).join("\n          ")}
        </ul>
      </div>
    </section>
    <div class="wall-head">
      <h2>All Bricks</h2>
      <span class="visible-count"><span id="visible-count">${String(bricks.length)}</span> visible of ${String(bricks.length)}</span>
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

// eslint-disable-next-line max-lines-per-function -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
export function featureClustersHtml(registry: GlobalRegistry, bricks: CompactBrick[]): string {
  const clusters = featureClusters(bricks);
  const projectName = (registry.projects || []).length === 1 ? registry.projects[0]?.id || "SMA Registry" : "SMA Registry";
  const largest = Math.max(1, ...clusters.map((cluster) => cluster.count));
  const cards = clusters.map((cluster) => {
    const width = Math.max(5, Math.round((cluster.count / largest) * 100));
    const topBricks = cluster.bricks
      .slice()
      .sort((a, b) => (b.health.warning_count || 0) - (a.health.warning_count || 0) || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((brick) => `<li><a href="bricks/${slugify(brick.id)}.md">${escapeHtml(brick.name)}</a><span>${escapeHtml(brick.project || "unknown")} / ${escapeHtml(shortPath(brick))}</span></li>`)
      .join("\n");

    return `      <article class="cluster" id="${escapeHtml(cluster.id)}" data-name="${escapeHtml(`${cluster.name} ${cluster.description}`.toLowerCase())}">
        <div class="cluster-head">
          <div>
            <p class="eyebrow">Feature Area</p>
            <h2>${escapeHtml(cluster.name)}</h2>
          </div>
          <strong>${String(cluster.count)}</strong>
        </div>
        <p>${escapeHtml(cluster.description)}</p>
        <div class="meter"><b style="width:${String(width)}%"></b></div>
        <dl>
          <div><dt>Average score</dt><dd>${String(cluster.average_score)}</dd></div>
          <div><dt>Warnings</dt><dd>${String(cluster.warning_count)}</dd></div>
          <div><dt>Errors</dt><dd>${String(cluster.error_count)}</dd></div>
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
