import { buildCandidateCards, canonicalTargetCards, canonicalizationReasonList, canonicalizationState, capabilityFamilies, capabilityFamilyCards, curatedBuildCards, formatNumber, privatePublishCards, projectCanonicalizationCards, proofSurfaceCards, qualityQueueCards, releaseArtifactCards, surfaceMetricGrid, surfaceNav } from "./wiki-dashboard-helpers.ts";

import { escapeHtml } from "./wiki-utils.ts";



export function surfacePageHtml({ title, lead, activeHref, metrics, sections }) {
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

export function proofSurfaceHtml(registry, stateSnapshot = null) {
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

export function buildRegistryHtml(registry, stateSnapshot = null) {
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

export function capabilitiesHtml(registry, stateSnapshot = null) {
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

export function canonicalizationHtml(registry, stateSnapshot = null) {
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


