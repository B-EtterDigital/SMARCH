#!/usr/bin/env node
/**
 * WHAT: Renders the [brick](../docs/GLOSSARY.md#brick) registry as a self-contained interactive web catalog.
 * WHY: Operators need a visual way to compare brick size, status, ownership, and connections without reading raw registry records.
 * HOW: Reads registry and score files, writes one web page, and is called by dashboard operators reviewing the portfolio.
 * Usage: `node tools/sma-brick-wall-lego.mjs --out /tmp/sma-brick-wall.html`
 */
/**
 * sma-brick-wall-lego: render the brick registry as an interactive
 * "BRICKWORKS" catalog — isometric 3D interlocking-brick tiles, studded
 * baseplate, terminal chrome, AFOL/agent aesthetic.
 *
 * Design principles:
 *   - Size scales with code volume (1x1 .. 6x3 stud grid).
 *   - Color palette is our own, calibrated around status (gold/blue/slate)
 *     with archetype accents. No brand names.
 *   - Every brick is rendered as a real 3D brick (CSS transforms):
 *       top face (studs) + front face + right face.
 *   - Hover → instruction-booklet-style catalog card with part number,
 *     dimensions, color name, archetype, score, status, connections.
 *   - Filter chips, project tabs, search, connection heatmap.
 *   - Self-contained HTML, no external assets.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = {
    registry: path.join(REPO_ROOT, "scans/all-projects/latest.registry.json"),
    scores: path.join(REPO_ROOT, "security/reuse_all_scored.json"),
    connections: path.join(REPO_ROOT, "security/brick_connections.json"),
    wikiBase: "bricks-detailed",
    out: path.join(REPO_ROOT, "wiki/BRICK_WALL_LEGO.generated.html"),
    topProjects: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--registry" && n) { o.registry = path.resolve(n); i += 1; }
    else if (a === "--scores" && n) { o.scores = path.resolve(n); i += 1; }
    else if (a === "--connections" && n) { o.connections = path.resolve(n); i += 1; }
    else if (a === "--wiki-base" && n) { o.wikiBase = n; i += 1; }
    else if (a === "--out" && n) { o.out = path.resolve(n); i += 1; }
    else if (a === "--top-projects" && n) { o.topProjects = Number(n); i += 1; }
  }
  return o;
}

const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } };

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function partNumber(brick) {
  // 4-digit project code + 3-digit brick hash → like 4601-B07
  const h = crypto.createHash("sha1").update(brick.id).digest("hex");
  const tail = h.slice(0, 3).toUpperCase();
  const project = (brick.project || "SMA").slice(0, 2).toUpperCase();
  const n = parseInt(h.slice(3, 7), 16) % 9999;
  return `${project}${String(n).padStart(4, "0")}-${tail}`;
}

// Color families used by the UI. Each family has a top (studs/light), front
// (body), side (shadow), and outline. All chosen to evoke interlocking bricks
// without being anyone's trademarked palette.
const PALETTES = {
  // status palettes
  canonical:  { top: "#ffd859", front: "#f5b800", side: "#b98600", edge: "#7a5a00", name: "Sovereign Amber" },
  candidate:  { top: "#6c9bff", front: "#3475ff", side: "#1f4cc0", edge: "#14306b", name: "Pilot Blue" },
  project_bound: { top: "#c6ccd6", front: "#9aa3b2", side: "#5e6776", edge: "#353c48", name: "Slate Grey" },
  experimental: { top: "#b0d988", front: "#7fb04a", side: "#517a3d", edge: "#283c1e", name: "Mission Olive" }
};

// Archetype accent tint that softly overlays the front face.
const ACCENT = {
  primitive: "#1f7a8c",
  adapter: "#a23b72",
  service: "#38a169",
  feature: "#dd6b20",
  module: "#6a4bff",
  ui: "#e53e3e",
  "data-model": "#2c7a7b",
  infra: "#553c9a",
  "agent-skill": "#c584f7",
  experiment: "#ff66c4"
};

function brickPalette(brick) {
  const base = PALETTES[brick.status] || PALETTES.project_bound;
  const accent = ACCENT[String(brick.archetype || "").toLowerCase()] || null;
  return { ...base, accent };
}

// Stud grid size. cols: 1-6, rows: 1-3. Biased toward wide shapes typical of
// interlocking construction bricks.
function brickShape(brick) {
  const lines = brick.line_total || 0;
  const size = lines > 0 ? lines : 100;
  let cols, rows;
  if (size > 8000)      { cols = 6; rows = 3; }
  else if (size > 3500) { cols = 6; rows = 2; }
  else if (size > 1800) { cols = 4; rows = 2; }
  else if (size > 800)  { cols = 4; rows = 2; }
  else if (size > 350)  { cols = 3; rows = 2; }
  else if (size > 150)  { cols = 3; rows = 1; }
  else if (size > 60)   { cols = 2; rows = 1; }
  else                  { cols = 2; rows = 1; }
  const k = String(brick.kind || "").toLowerCase();
  if (/provider_file|handler_file|adapter_file|script_file|utility_file/.test(k)) { cols = Math.max(cols, 2); rows = 1; }
  if (/page_module|frontend_feature|module/.test(k)) { rows = Math.max(rows, 2); }
  if (/supabase_function|netlify/.test(k)) { cols = Math.max(cols, 3); rows = 1; }
  if (/agent_skill/.test(k)) { cols = 2; rows = 2; }
  if (/sidecar/.test(k)) { cols = 3; rows = 2; }
  return { cols: Math.min(cols, 6), rows: Math.min(rows, 3) };
}

// Build a single brick as a 3-face isometric SVG. STUD is the base stud width
// in px (on the unrotated top); the whole thing is transformed via CSS.
const STUD = 24;
const DEPTH = 18;   // how "thick" the brick looks in the front/side faces

function brickSvg(brick, shape, palette) {
  const w = shape.cols * STUD;
  const h = shape.rows * STUD;
  const topY = 0;

  // top-face studs
  const studs = [];
  for (let r = 0; r < shape.rows; r += 1) {
    for (let c = 0; c < shape.cols; c += 1) {
      const cx = c * STUD + STUD / 2;
      const cy = topY + r * STUD + STUD / 2;
      studs.push(`<g>
        <ellipse cx="${cx}" cy="${cy}" rx="${STUD/2 - 4}" ry="${STUD/2 - 5}" fill="${palette.top}" stroke="${palette.edge}" stroke-width="0.8"/>
        <ellipse cx="${cx - 1.2}" cy="${cy - 1.5}" rx="${STUD/2 - 8}" ry="${STUD/2 - 10}" fill="rgba(255,255,255,0.28)"/>
      </g>`);
    }
  }

  // accent stripe under studs (archetype)
  const accentStripe = palette.accent
    ? `<rect x="0" y="${h}" width="${w}" height="2" fill="${palette.accent}" opacity="0.8"/>`
    : "";

  return `<svg class="brick-3d" viewBox="-6 -6 ${w + 12 + DEPTH} ${h + 12 + DEPTH}" width="${w + 12 + DEPTH}" height="${h + 12 + DEPTH}" preserveAspectRatio="xMinYMin meet" aria-hidden="true">
    <!-- right face -->
    <polygon points="${w},${topY} ${w + DEPTH},${topY - DEPTH/2} ${w + DEPTH},${topY + h - DEPTH/2} ${w},${topY + h}"
             fill="${palette.side}" stroke="${palette.edge}" stroke-width="0.9"/>
    <!-- front face -->
    <rect x="0" y="${topY}" width="${w}" height="${h}" fill="${palette.front}" stroke="${palette.edge}" stroke-width="0.9"/>
    <!-- top face (parallelogram) -->
    <polygon points="0,${topY} ${DEPTH},${topY - DEPTH/2} ${w + DEPTH},${topY - DEPTH/2} ${w},${topY}"
             fill="${palette.top}" stroke="${palette.edge}" stroke-width="0.9"/>
    ${accentStripe}
    <!-- raised studs on top face -->
    <g transform="translate(${DEPTH/2}, ${-DEPTH/2})">${studs.join("")}</g>
    <!-- brand-mark tiny groove (decorative) -->
    <rect x="${w - 3}" y="${topY + h - 6}" width="3" height="4" fill="rgba(0,0,0,0.18)"/>
  </svg>`;
}

async function loadManifest(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }

async function loadEnrichedBricks(opts) {
  const reg = await readJson(opts.registry);
  if (!reg?.bricks) throw new Error(`no registry at ${opts.registry}`);
  const scores = await readJson(opts.scores);
  const scoreIdx = new Map();
  if (scores?.scored) for (const s of scores.scored) scoreIdx.set(s.id, s.score);
  const conn = await readJson(opts.connections);
  const edgesByFrom = new Map();
  if (conn?.edges) {
    for (const e of conn.edges) {
      if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, []);
      edgesByFrom.get(e.from).push(e);
    }
  }

  const out = [];
  for (const b of reg.bricks) {
    const m = await loadManifest(b.manifest_path);
    const sem = m?.semantics || {};
    out.push({
      ...b,
      reuse_score: scoreIdx.get(b.id) ?? (b.score || 0),
      purpose: sem.purpose || "",
      tags: sem.tags || [],
      archetype: sem.reuse_archetype || "",
      wiki_page: sem.wiki_page || null,
      connections: edgesByFrom.get(b.id) || []
    });
  }
  return { registry: reg, bricks: out };
}

function brickCard(brick, opts) {
  const palette = brickPalette(brick);
  const shape = brickShape(brick);
  const svg = brickSvg(brick, shape, palette);
  const slug = slugify(brick.id);
  const wiki = brick.wiki_page
    ? brick.wiki_page.replace(/^wiki\//, "")
    : `${opts.wikiBase}/${brick.project || "_unknown"}/${slug}.md`;
  const part = partNumber(brick);
  const tags = (brick.tags || []).slice(0, 6).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const conns = (brick.connections || [])
    .filter((c) => c.kind && c.kind !== "unrelated")
    .slice(0, 3)
    .map((c) => `<span class="conn conn-${c.kind}">${escapeHtml(c.kind)}</span>`).join("");
  const purposeHtml = brick.purpose
    ? escapeHtml(brick.purpose).slice(0, 360)
    : "<em>no manifest notes yet</em>";
  const searchHay = escapeHtml(`${brick.name} ${brick.id} ${brick.project} ${brick.kind} ${brick.archetype} ${(brick.tags||[]).join(" ")} ${brick.purpose}`.toLowerCase());
  return `<a class="brick-tile"
            href="${escapeHtml(wiki)}"
            data-search="${searchHay}"
            data-status="${escapeHtml(brick.status || "project_bound")}"
            data-archetype="${escapeHtml(brick.archetype || "")}"
            data-project="${escapeHtml(brick.project || "")}"
            data-score="${brick.reuse_score || 0}"
            style="--grid-cols: ${shape.cols}; --grid-rows: ${shape.rows};">
    <div class="brick-shell">
      ${svg}
    </div>
    <div class="tile-tape">
      <div class="tile-title">
        <span class="part-no">${part}</span>
        <span class="tile-name">${escapeHtml(brick.name || brick.id)}</span>
      </div>
      <div class="tile-meta">
        <span class="chip chip-status chip-${escapeHtml(brick.status || "project_bound")}">${escapeHtml(brick.status || "project_bound")}</span>
        <span class="chip chip-kind">${escapeHtml(brick.kind || "brick")}</span>
        <span class="chip chip-size">${shape.cols}×${shape.rows}</span>
        <span class="chip chip-color">${escapeHtml(palette.name)}</span>
      </div>
      <div class="tile-conns">${conns}</div>
      <div class="tile-tags">${tags}</div>
    </div>
    <div class="tile-card" role="tooltip">
      <div class="tile-card-head">
        <span class="tile-card-part">${part}</span>
        <span class="tile-card-status">${escapeHtml(brick.status || "project_bound")}</span>
      </div>
      <h4>${escapeHtml(brick.name || brick.id)}</h4>
      <p>${purposeHtml}</p>
      <dl>
        <dt>Project</dt><dd>${escapeHtml(brick.project || "?")}</dd>
        <dt>Kind</dt><dd>${escapeHtml(brick.kind || "?")}</dd>
        <dt>Archetype</dt><dd>${escapeHtml(brick.archetype || "—")}</dd>
        <dt>Studs</dt><dd>${shape.cols}×${shape.rows} = ${shape.cols * shape.rows}</dd>
        <dt>Colorway</dt><dd>${escapeHtml(palette.name)}</dd>
        <dt>Reuse score</dt><dd>${brick.reuse_score || 0}</dd>
        <dt>Connections</dt><dd>${(brick.connections || []).length}</dd>
      </dl>
      <div class="tile-card-tags">${tags}</div>
      <div class="tile-card-cta">Open assembly guide →</div>
    </div>
  </a>`;
}

function buildHtml({ registry, bricks }, opts) {
  const groups = new Map();
  for (const b of bricks) {
    const p = b.project || "unknown";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(b);
  }
  for (const [, list] of groups) list.sort((a, b) => (b.reuse_score || 0) - (a.reuse_score || 0));

  let order = [...groups.entries()]
    .map(([proj, list]) => ({
      proj,
      list,
      canonical: list.filter((b) => b.status === "canonical").length,
      candidate: list.filter((b) => b.status === "candidate").length,
      total: list.length
    }))
    .sort((a, b) => (b.canonical * 10 + b.candidate) - (a.canonical * 10 + a.candidate) || b.total - a.total);
  if (opts.topProjects > 0) order = order.slice(0, opts.topProjects);

  const totalBricks = bricks.length;
  const canonicalTotal = bricks.filter((b) => b.status === "canonical").length;
  const candidateTotal = bricks.filter((b) => b.status === "candidate").length;

  const archCounts = {};
  for (const b of bricks) { const a = b.archetype || "—"; archCounts[a] = (archCounts[a] || 0) + 1; }
  const archChips = Object.entries(archCounts).sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `<button class="chip-filter filter-arch" data-arch="${escapeHtml(a)}">${escapeHtml(a)} <em>${n}</em></button>`).join("");

  const sections = order.map(({ proj, list }) => `
    <section class="bay" data-project="${escapeHtml(proj)}">
      <header class="bay-head">
        <div class="bay-title">
          <span class="bay-index">BAY ${escapeHtml(proj.toUpperCase().slice(0, 3))}</span>
          <h2>${escapeHtml(proj)}</h2>
        </div>
        <div class="bay-counts">
          <span class="counter canonical"><em>${list.filter((b) => b.status === "canonical").length}</em> canonical</span>
          <span class="counter candidate"><em>${list.filter((b) => b.status === "candidate").length}</em> candidate</span>
          <span class="counter bound"><em>${list.filter((b) => !b.status || b.status === "project_bound").length}</em> project-bound</span>
          <span class="counter total"><em>${list.length}</em> total</span>
        </div>
      </header>
      <div class="baseplate">
        <div class="wall">
${list.map((b) => brickCard(b, opts)).join("\n")}
        </div>
      </div>
    </section>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BRICKWORKS — SMA Brick Registry</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg0: #04070c;
  --bg1: #0b1016;
  --bg2: #111821;
  --panel: #f4f1e8;
  --panel-strong: #e3ddd2;
  --line: #111111;
  --line2: rgba(244,241,232,0.14);
  --ink: #111111;
  --hero-ink: #f4f1e8;
  --muted: #6c675f;
  --accent: #ffe47f;
  --accent2: #8fb6ff;
  --pink: #ff66c4;
  --gold: #f6bb08;
  --blue: #3475ff;
  --slate: #9aa3b2;
  --olive: #7fb04a;
  --stud-size: 22px;
  --shadow: 10px 10px 0 #111111;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg0); color: var(--hero-ink); font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; }
body {
  background:
    radial-gradient(circle at 16% 14%, rgba(143,182,255,0.16), transparent 0 20%),
    radial-gradient(circle at 80% 18%, rgba(255,255,255,0.08), transparent 0 16%),
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 28%),
    var(--bg0);
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.03;
  background-image:
    linear-gradient(rgba(244,241,232,0.2) 1px, transparent 1px),
    linear-gradient(90deg, rgba(244,241,232,0.2) 1px, transparent 1px);
  background-size: 82px 82px;
  mask-image: radial-gradient(circle at center, black 28%, transparent 88%);
}
a { color: inherit; text-decoration: none; }
.mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ============ TOP CHROME ============ */
.chrome {
  position: sticky; top: 0; z-index: 40;
  backdrop-filter: blur(12px);
  background: linear-gradient(180deg, rgba(4,7,12,0.84), rgba(4,7,12,0.38));
  border-bottom: 1px solid rgba(244,241,232,0.14);
}
.chrome-inner {
  max-width: 1680px; margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.brand {
  display: flex; align-items: center; gap: 14px;
}
.brand-mark {
  width: 44px; height: 36px;
  background: linear-gradient(180deg, var(--accent) 0 55%, var(--gold) 55% 100%);
  border-radius: 4px 4px 6px 6px;
  position: relative;
  box-shadow: 0 4px 0 #3b2800;
}
.brand-mark::before, .brand-mark::after {
  content: ""; position: absolute; top: -7px;
  width: 14px; height: 10px; border-radius: 50% / 50%;
  background: var(--accent);
  box-shadow: inset 0 -3px 0 rgba(0,0,0,0.12);
}
.brand-mark::before { left: 5px; }
.brand-mark::after  { left: 25px; }
.brand h1 {
  margin: 0; font-family: "IBM Plex Mono", monospace;
  font-weight: 700; font-size: 20px; letter-spacing: 0.14em;
}
.brand-sub {
  font-family: "IBM Plex Mono", monospace; font-size: 11px; color: rgba(244,241,232,0.58); letter-spacing: 0.08em;
}
.chrome-side { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.chrome-cta { display: flex; gap: 8px; flex-wrap: wrap; }
.chrome-cta a {
  font-family: "IBM Plex Mono", monospace; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 9px 12px; border: 1px solid rgba(244,241,232,0.14); background: rgba(4,7,12,0.2); color: rgba(244,241,232,0.78);
  backdrop-filter: blur(6px); transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.chrome-cta a:hover { background: rgba(4,7,12,0.42); border-color: rgba(143,182,255,0.5); transform: translateY(-1px); }
.catalog-hero {
  max-width: 1680px; margin: 0 auto; padding: 32px 24px 0;
  display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr); gap: 18px;
}
.catalog-lede,
.catalog-panel {
  position: relative; overflow: hidden; border: 2px solid #111111; box-shadow: var(--shadow);
}
.catalog-lede {
  padding: 28px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.06), transparent 22%),
    linear-gradient(135deg, rgba(143,182,255,0.18), rgba(4,7,12,0) 36%),
    linear-gradient(180deg, #0e131b 0%, #05080d 100%);
}
.catalog-lede::before,
.catalog-panel::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(circle at 18% 20%, rgba(143,182,255,0.18), transparent 0 22%),
    repeating-linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.02) 1px, transparent 1px, transparent 4px);
}
.catalog-kicker,
.ticker {
  font-family: "IBM Plex Mono", monospace; font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase;
}
.catalog-kicker { color: rgba(244,241,232,0.58); }
.catalog-title {
  margin: 12px 0 0; font-family: "Anton", Impact, sans-serif; font-size: clamp(3.2rem, 8vw, 6.8rem); line-height: 0.9; text-transform: uppercase;
}
.catalog-body { margin: 16px 0 0; max-width: 720px; color: rgba(244,241,232,0.76); }
.catalog-ribbon { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.catalog-ribbon span {
  font-family: "IBM Plex Mono", monospace; font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase;
  padding: 8px 10px; border: 1px solid rgba(244,241,232,0.14); background: rgba(4,7,12,0.26);
}
.catalog-panel { padding: 22px; background: var(--panel); color: var(--ink); }
.ticker {
  color: var(--muted); padding: 0 0 14px; border-bottom: 2px solid #111111;
  display: flex; gap: 20px; flex-wrap: wrap;
}
.ticker b { color: var(--ink); font-weight: 700; }
.controls {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 16px 0 14px;
}
.controls input[type="search"], .controls select {
  height: 42px; background: rgba(17,17,17,0.04); color: var(--ink);
  border: 2px solid #111111; padding: 0 12px; font: inherit;
  font-family: "IBM Plex Mono", monospace; font-size: 13px; box-shadow: 4px 4px 0 #111111;
}
.controls input[type="search"] { flex: 1 1 320px; min-width: 240px; }
.controls input[type="search"]::placeholder { color: var(--muted); }
.filters-row {
  display: flex; gap: 6px; flex-wrap: wrap; padding: 0 0 14px;
  border-top: 2px solid #111111;
  padding-top: 14px;
}
.chip-filter {
  font-family: "IBM Plex Mono", monospace; font-size: 11px;
  background: rgba(17,17,17,0.04); color: var(--muted);
  border: 2px solid #111111; padding: 6px 10px;
  cursor: pointer; letter-spacing: 0.04em; box-shadow: 4px 4px 0 #111111;
}
.chip-filter em { color: var(--ink); font-style: normal; margin-left: 4px; }
.chip-filter.on { background: var(--accent); color: #1a1200; border-color: #111111; }
.chip-filter.on em { color: rgba(0,0,0,0.55); }

/* ============ STATS STRIP ============ */
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px;
  max-width: 1680px; margin: 0 auto; padding: 18px 24px 0;
}
.stat {
  background: var(--panel); color: var(--ink); border: 2px solid #111111;
  padding: 14px 16px; box-shadow: 6px 6px 0 #111111;
}
.stat .lbl { font-family: "IBM Plex Mono", monospace; font-size: 10px; color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; }
.stat .num { font-family: "Anton", Impact, sans-serif; font-size: 44px; line-height: 0.92; margin-top: 8px; }
.stat.gold .num { color: var(--gold); }
.stat.blue .num { color: var(--blue); }
.stat.slate .num { color: var(--slate); }

/* ============ BAYS (per project) ============ */
main { max-width: 1680px; margin: 0 auto; padding: 12px 24px 60px; }
.bay {
  margin: 14px 0 24px;
  background: linear-gradient(180deg, var(--bg1), var(--bg2));
  border: 2px solid #111111;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.bay-head {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 16px 18px; border-bottom: 2px solid #111111;
  background: var(--panel);
  color: var(--ink);
}
.bay-title { display: flex; gap: 12px; align-items: baseline; }
.bay-title h2 { margin: 0; font-family: "Anton", Impact, sans-serif; font-size: 36px; line-height: 0.9; text-transform: uppercase; }
.bay-index {
  font-family: "IBM Plex Mono", monospace; font-size: 11px; color: var(--muted);
  border: 2px solid #111111; padding: 4px 6px;
}
.bay-counts { display: flex; gap: 10px; font-family: "IBM Plex Mono", monospace; font-size: 11px; flex-wrap: wrap; }
.counter { color: var(--muted); letter-spacing: 0.06em; }
.counter em { color: var(--ink); font-style: normal; font-weight: 700; padding-right: 4px; }
.counter.canonical em { color: var(--gold); }
.counter.candidate em { color: var(--blue); }

/* Baseplate is a dotted grid behind the bricks. Each dot is a "stud hole". */
.baseplate {
  position: relative;
  padding: 28px 22px;
  background:
    radial-gradient(rgba(255,255,255,0.06) 1.5px, transparent 1.8px) 0 0 / var(--stud-size) var(--stud-size),
    linear-gradient(180deg, #0d111a 0%, #0a0d14 100%);
  background-position: 11px 11px, 0 0;
  border-top: 1px solid var(--line2);
}
.baseplate::before {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(180deg, transparent 85%, rgba(0,0,0,0.25));
  pointer-events: none;
}
.wall {
  display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end;
}

/* ============ BRICK TILES ============ */
.brick-tile {
  position: relative;
  background: #0f141c;
  border: 2px solid #111111;
  padding: 12px 12px 10px;
  min-width: 148px; max-width: 260px;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
  box-shadow: 6px 6px 0 rgba(0,0,0,0.45);
}
.brick-tile:hover {
  transform: translate(-2px, -2px);
  border-color: rgba(143,182,255,0.5);
  box-shadow: 8px 8px 0 rgba(0,0,0,0.55);
}
.brick-tile[data-status="canonical"] {
  border-color: rgba(245,184,0,0.35);
  box-shadow: 0 2px 12px rgba(245,184,0,0.12);
}
.brick-tile[data-status="candidate"] {
  border-color: rgba(52,117,255,0.35);
}
.brick-shell {
  display: flex; align-items: flex-end; justify-content: center;
  padding: 6px 0 4px;
  min-height: 62px;
}
.brick-3d { display: block; }

.tile-tape {
  display: flex; flex-direction: column; gap: 4px; text-align: center;
  padding-top: 6px;
}
.tile-title { display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap; }
.part-no {
  font-family: "IBM Plex Mono", monospace; font-size: 10px; letter-spacing: 0.08em;
  color: var(--muted); border: 1px dashed var(--line2); border-radius: 4px; padding: 1px 5px;
}
.tile-name {
  font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 12.5px;
  color: var(--hero-ink); word-break: break-word; max-width: 220px;
}
.tile-meta { display: flex; justify-content: center; gap: 4px; flex-wrap: wrap; }
.chip {
  font-family: "IBM Plex Mono", monospace; font-size: 9.5px; letter-spacing: 0.03em;
  padding: 2px 6px; border-radius: 999px;
  background: rgba(255,255,255,0.04); color: var(--muted);
}
.chip-status.chip-canonical { background: rgba(245,184,0,0.15); color: var(--gold); }
.chip-status.chip-candidate { background: rgba(52,117,255,0.15); color: var(--blue); }
.chip-status.chip-project_bound { background: rgba(154,163,178,0.12); color: var(--slate); }
.tile-conns { display: flex; justify-content: center; gap: 3px; flex-wrap: wrap; min-height: 14px; }
.conn {
  font-family: "IBM Plex Mono", monospace; font-size: 9px; letter-spacing: 0.06em;
  padding: 1px 5px; border-radius: 3px; text-transform: uppercase;
  background: #1a2436; color: var(--muted);
}
.conn.conn-depends_on { color: #ff8a72; background: rgba(255,138,114,0.1); }
.conn.conn-composes_with { color: #7fc0ff; background: rgba(127,192,255,0.1); }
.conn.conn-alternative_to { color: #ffd859; background: rgba(255,216,89,0.1); }
.conn.conn-supersedes { color: #ff66c4; background: rgba(255,102,196,0.1); }
.conn.conn-shared_concept { color: #9aa3b2; background: rgba(154,163,178,0.08); }
.tile-tags { display: flex; justify-content: center; gap: 3px; flex-wrap: wrap; }
.tag { font-family: "IBM Plex Mono", monospace; font-size: 9px; color: var(--muted); background: rgba(255,255,255,0.04); padding: 1px 5px; border-radius: 3px; }

/* ============ CATALOG CARD (hover popup) ============ */
.tile-card {
  position: absolute; z-index: 30;
  left: 50%; top: 100%; transform: translate(-50%, 8px);
  width: 300px;
  background: var(--panel);
  color: var(--ink);
  border: 2px solid #111111;
  padding: 12px 14px;
  box-shadow: var(--shadow);
  opacity: 0; pointer-events: none;
  transition: opacity 120ms ease, transform 120ms ease;
  text-align: left;
}
.brick-tile:hover .tile-card {
  opacity: 1; pointer-events: auto; transform: translate(-50%, 12px);
}
.tile-card-head { display: flex; justify-content: space-between; align-items: center; }
.tile-card-part { font-family: "IBM Plex Mono", monospace; font-size: 10.5px; color: var(--muted); letter-spacing: 0.08em; }
.tile-card-status { font-family: "IBM Plex Mono", monospace; font-size: 10px; padding: 2px 6px; border-radius: 999px; background: rgba(17,17,17,0.06); color: var(--muted); }
.tile-card h4 { margin: 6px 0 4px; font-size: 14px; letter-spacing: 0; }
.tile-card p { margin: 0 0 8px; font-size: 12px; color: #38342d; }
.tile-card dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0 0 6px; font-size: 11.5px; }
.tile-card dt { color: var(--muted); font-family: "IBM Plex Mono", monospace; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; align-self: center; }
.tile-card dd { margin: 0; color: var(--ink); font-family: "IBM Plex Mono", monospace; font-size: 11.5px; }
.tile-card-tags { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 4px; }
.tile-card-cta { margin-top: 10px; color: var(--ink); font-family: "IBM Plex Mono", monospace; font-size: 11px; letter-spacing: 0.06em; }

/* ============ FOOTER CHROME ============ */
footer {
  max-width: 1680px; margin: 0 auto; padding: 22px 24px 44px;
  font-family: "IBM Plex Mono", monospace; font-size: 11px; color: rgba(244,241,232,0.58);
  display: flex; gap: 16px; flex-wrap: wrap;
  border-top: 1px dashed rgba(244,241,232,0.18); margin-top: 20px;
}
footer .blink::after {
  content: "_"; display: inline-block; animation: blink 1.1s step-end infinite;
  color: var(--accent);
}
@keyframes blink { 50% { opacity: 0; } }

/* ============ RESPONSIVE ============ */
@media (max-width: 620px) {
  .chrome-inner { padding: 12px 16px; align-items: flex-start; flex-direction: column; }
  .chrome-side { margin-left: 0; }
  .catalog-hero { padding: 24px 16px 0; grid-template-columns: 1fr; }
  .stats, main, footer { padding-left: 16px; padding-right: 16px; }
  .brand-sub { display: none; }
  .bay-head { flex-direction: column; align-items: flex-start; }
  .bay-counts { flex-wrap: wrap; }
}
</style>
</head>
<body>
<div class="chrome">
  <div class="chrome-inner">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <h1>BRICKWORKS</h1>
    </div>
    <div class="chrome-side">
      <span class="brand-sub">Interlocking brick catalog · rev ${new Date().toISOString().slice(0, 10)}</span>
      <div class="chrome-cta">
        <a href="index.html">SMA home</a>
        <a href="bricks-detailed/index.html">Detailed docs</a>
      </div>
    </div>
  </div>
</div>

<section class="catalog-hero">
  <article class="catalog-lede">
    <div class="catalog-kicker">Live registry surface</div>
    <h2 class="catalog-title">Trust the wall. Then go deep.</h2>
    <p class="catalog-body">
      Real scan data, reusable brick inventory, and direct links into the detailed
      assembly guides. Start broad here, filter hard, then open the docs when a
      brick looks worth cloning.
    </p>
    <div class="catalog-ribbon">
      <span>brick-first registry</span>
      <span>real project inventory</span>
      <span>clone-ready docs</span>
      <span>agents + humans</span>
    </div>
  </article>
  <aside class="catalog-panel">
    <div class="ticker">
      <span><b>${totalBricks}</b> bricks</span>
      <span><b>${canonicalTotal}</b> canonical</span>
      <span><b>${candidateTotal}</b> candidate</span>
      <span><b>${groups.size}</b> bays</span>
      <span>agent: <b>codex-gpt-5.4</b></span>
      <span>mode: <b>READY</b></span>
    </div>
    <div class="controls">
      <input id="q" type="search" placeholder="~ search: auth, chat, transcription, stripe, provider_file …" />
      <select id="status">
        <option value="">[status: any]</option>
        <option value="canonical">[status: canonical]</option>
        <option value="candidate">[status: candidate]</option>
        <option value="project_bound">[status: project_bound]</option>
      </select>
      <select id="project">
        <option value="">[project: any]</option>
        ${[...groups.keys()].sort().map((p) => `<option value="${escapeHtml(p)}">[project: ${escapeHtml(p)}]</option>`).join("")}
      </select>
    </div>
    <div class="filters-row">
      <span class="mono" style="color: var(--muted); align-self: center; padding-right: 6px; font-size: 11px;">ARCH//</span>
      ${archChips || '<em style="color: var(--muted)">(no archetype data yet)</em>'}
    </div>
  </aside>
</section>

<div class="stats">
  <div class="stat"><div class="lbl">Total Bricks</div><div class="num">${totalBricks}</div></div>
  <div class="stat gold"><div class="lbl">Canonical</div><div class="num">${canonicalTotal}</div></div>
  <div class="stat blue"><div class="lbl">Candidate</div><div class="num">${candidateTotal}</div></div>
  <div class="stat slate"><div class="lbl">Project-bound</div><div class="num">${totalBricks - canonicalTotal - candidateTotal}</div></div>
  <div class="stat"><div class="lbl">Bays</div><div class="num">${groups.size}</div></div>
</div>

<main>
${sections || '<div class="bay"><div class="baseplate"><div class="wall"><em style="color:var(--muted)">No bricks yet. Run npm run scan.</em></div></div></div>'}
</main>

<footer>
  <span class="blink">BRICKWORKS · idle</span>
  <span>build: ${new Date().toISOString()}</span>
  <span>generator: tools/sma-brick-wall-lego.mjs</span>
  <span>docs: tools/sma-codex-wiki.mjs</span>
  <span>model: gpt-5.4</span>
  <span>made for adults and agents</span>
</footer>

<script>
  const q = document.getElementById("q");
  const sStatus = document.getElementById("status");
  const sProj = document.getElementById("project");
  const tiles = Array.from(document.querySelectorAll(".brick-tile"));
  const archButtons = document.querySelectorAll(".filter-arch");
  const activeArchs = new Set();
  archButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = btn.dataset.arch;
      if (activeArchs.has(a)) { activeArchs.delete(a); btn.classList.remove("on"); }
      else { activeArchs.add(a); btn.classList.add("on"); }
      apply();
    });
  });

  function apply() {
    const term = q.value.trim().toLowerCase();
    const st = sStatus.value;
    const pr = sProj.value;
    for (const t of tiles) {
      const matchTerm = !term || t.dataset.search.includes(term);
      const matchStatus = !st || t.dataset.status === st;
      const matchProject = !pr || t.dataset.project === pr;
      const matchArch = activeArchs.size === 0 || activeArchs.has(t.dataset.archetype);
      t.style.display = (matchTerm && matchStatus && matchProject && matchArch) ? "" : "none";
    }
    document.querySelectorAll(".bay").forEach((bay) => {
      const visible = Array.from(bay.querySelectorAll(".brick-tile")).some((t) => t.style.display !== "none");
      bay.style.display = visible ? "" : "none";
    });
  }
  q.addEventListener("input", apply);
  sStatus.addEventListener("change", apply);
  sProj.addEventListener("change", apply);
</script>
</body>
</html>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = await loadEnrichedBricks(opts);
  const html = buildHtml(data, opts);
  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, html);
  console.log(JSON.stringify({
    bricks: data.bricks.length,
    canonical: data.bricks.filter((b) => b.status === "canonical").length,
    candidate: data.bricks.filter((b) => b.status === "candidate").length,
    out: opts.out
  }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
