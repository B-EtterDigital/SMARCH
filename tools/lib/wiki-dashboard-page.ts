import { boundaryRows, buildCandidateCards, buildFamilyRows, cloneRiskCards, complianceDimensionRows, complianceGapCards, complianceProjectCards, curatedBuildCards, duplicateCards, envContractCards, formatNumber, installEvidenceCards, projectStatus, projectTone, proofSurfaceCards, qualityProjectCards, qualityQueueCards, releaseArtifactCards, remediationActionCards, remediationProjectPlans, scannerQueueCards, scannerReadinessCards, tokenCards } from "./wiki-dashboard-helpers.ts";

import { countBy, escapeHtml, slugify } from "./wiki-utils.ts";
import type { GlobalRegistry } from "./schema-types/global.registry.schema.d.ts";
import type { CompactBrick } from "./scan-discovery.ts";
import type { QueueEntry, RegistryProject, ScannerView, StateSnapshot } from "./wiki-dashboard-helpers.ts";

type DashboardRegistry = Omit<GlobalRegistry, "projects"> & {
  projects: RegistryProject[];
  scanner_report?: ScannerView;
  refactor_report?: { refactor_queue?: QueueEntry[] };
};
type ProjectMeta = NonNullable<Parameters<typeof projectStatus>[1]>;



export function dashboardHtml(registry: DashboardRegistry, bricks: CompactBrick[], metadata: Map<string, ProjectMeta>, stateSnapshot: StateSnapshot | null = null): string {
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

