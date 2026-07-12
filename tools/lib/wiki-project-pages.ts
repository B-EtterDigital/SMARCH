/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition -- Wiki generation preserves established HTML interpolation, truthy fallback, and guards for older registry snapshots. */
/* eslint-disable max-lines-per-function -- Each generator is one static HTML template; splitting contiguous markup would make escaping and snapshot order harder to audit. */
import { escapeHtml, mdTableRow, slugify } from "./wiki-utils.ts";
import type { GlobalRegistry } from "./schema-types/global.registry.schema.d.ts";
import type { CompactBrick } from "./scan-discovery.ts";

type RegistryProject = GlobalRegistry["projects"][number];
type Candidate = NonNullable<GlobalRegistry["unmanifested_bricks"]>[number];
type CandidateGroup = NonNullable<GlobalRegistry["candidate_groups"]>[number];



export function projectHealthMarkdown(projects: RegistryProject[], bricks: CompactBrick[]): string {
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

export function projectPage(project: RegistryProject, bricks: CompactBrick[], unmanifested: Candidate[], candidateGroups: CandidateGroup[]): string {
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

export function courseHtml(bricks: CompactBrick[]): string {
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
