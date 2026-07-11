#!/usr/bin/env node
/**
 * WHAT: Renders detailed brick Markdown into themed web pages and indexes.
 * WHY: The generated brick catalog needs a browsable presentation without an external renderer.
 * HOW: Reads per-project Markdown pages and applies the repository's small built-in renderer.
 * OUTPUTS: Writes per-brick pages, project indexes, and a master index below --root.
 * CALLERS: Wiki generation workflows run it after detailed Markdown pages exist.
 * USAGE: `mkdir -p /tmp/sma-wiki-html-example && node tools/sma-wiki-html.ts --root /tmp/sma-wiki-html-example`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WIKI_ROOT = path.resolve(__dirname, "../wiki/bricks-detailed");

type LooseRecord = Record<string, string | string[]>;
type Crumb = { label: string; href?: string };

function parseArgs(argv: string[]): { root: string } {
  const o = { root: WIKI_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--root" && n) { o.root = path.resolve(n); i += 1; }
  }
  return o;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// YAML front-matter (we emit key: value and key: ["a","b"])
function parseFrontMatter(text: string): { fm: LooseRecord; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text };
  const fm: LooseRecord = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let v: string | string[] = line.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith("[") && v.endsWith("]")) {
      try { v = JSON.parse(v); }
      catch { /* Keep malformed optional arrays as their original scalar text. */ }
    }
    fm[key] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

// Simple inline formatter: code spans, bold, italics, links. Order matters.
function renderInline(text: string): string {
  // Protect existing HTML entities
  let out = escapeHtml(text);
  // Code spans
  out = out.replace(/`([^`]+)`/g, (_match: string, content: string) => `<code>${content}</code>`);
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italics (avoid clashing with bold's asterisks)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

// Quick table row parser — assumes pipes aren't inside code
function parseTableRow(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((cell: string) => cell.trim());
}

function renderMarkdown(body: string): string {
  const lines = body.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];

    // blank line
    if (!line.trim()) { i += 1; continue; }

    // horizontal rule
    if (/^\s*---+\s*$/.test(line)) { out.push("<hr/>"); i += 1; continue; }

    // fenced code block
    if (/^```/.test(line)) {
      const langMatch = line.match(/^```(\w+)?/);
      const lang = langMatch?.[1] || "";
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre class="code lang-${escapeHtml(lang)}"><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // headings
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const level = hm[1].length;
      const content = renderInline(hm[2].trim());
      const anchor = hm[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      out.push(`<h${level} id="${anchor}">${content}</h${level}>`);
      i += 1;
      continue;
    }

    // blockquote
    if (line.startsWith("> ")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // table (header | --- | body)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const header = parseTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      const thead = header.map((cell: string) => `<th>${renderInline(cell)}</th>`).join("");
      const tbody = rows.map((row: string[]) => `<tr>${row.map((cell: string) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="tbl-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${buf.map((x) => `<li>${renderInline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${buf.map((x) => `<li>${renderInline(x)}</li>`).join("")}</ol>`);
      continue;
    }

    // paragraph — consume until blank line
    const paraBuf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#|```|>|[-*]\s|\d+\.\s|\|)/.test(lines[i]) && !/^\s*---+\s*$/.test(lines[i])) {
      paraBuf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function pageCss() {
  return `
:root {
  --bg: #f0ece2;
  --bg-alt: #ded9d0;
  --bg-dark: #04070c;
  --panel: #f4f1e8;
  --panel-strong: #e3ddd2;
  --ink: #111111;
  --hero-ink: #f4f1e8;
  --muted: #6c675f;
  --line: #111111;
  --blue: #8fb6ff;
  --gold: #f6bb08;
  --slate: #7d7d7d;
  --shadow: 10px 10px 0 #111111;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg-dark);
  color: var(--hero-ink);
  font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  line-height: 1.6;
}
body {
  background:
    radial-gradient(circle at 16% 12%, rgba(143,182,255,0.18), transparent 0 22%),
    radial-gradient(circle at 84% 14%, rgba(255,255,255,0.08), transparent 0 18%),
    linear-gradient(180deg, #05070b 0%, #090d12 34%, #0b1016 100%);
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.03;
  background-image:
    linear-gradient(rgba(244,241,232,0.22) 1px, transparent 1px),
    linear-gradient(90deg, rgba(244,241,232,0.22) 1px, transparent 1px);
  background-size: 84px 84px;
  mask-image: radial-gradient(circle at center, black 28%, transparent 88%);
}
.mono, pre, code, .brand-name, .crumbs, .chrome-cta a, .pill, .hero-title .partno, .hero-cta, .toc h5, .stat .lbl, .card .sub {
  font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
a {
  color: inherit;
  text-decoration: none;
}
.chrome {
  position: sticky;
  top: 0;
  z-index: 40;
  backdrop-filter: blur(12px);
  background: linear-gradient(180deg, rgba(4,7,12,0.84), rgba(4,7,12,0.38));
  border-bottom: 1px solid rgba(244,241,232,0.14);
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
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
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
  border-radius: 50%;
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
  color: rgba(244,241,232,0.6);
  font-size: 0.74rem;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.crumbs a { color: inherit; }
.crumbs a:hover { color: var(--hero-ink); }
.crumbs .sep { color: rgba(244,241,232,0.22); }
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
  border: 1px solid rgba(244,241,232,0.14);
  background: rgba(4,7,12,0.2);
  color: rgba(244,241,232,0.76);
  backdrop-filter: blur(6px);
  transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.chrome-cta a:hover {
  background: rgba(4,7,12,0.42);
  border-color: rgba(143,182,255,0.5);
  transform: translateY(-1px);
}
main {
  max-width: 1520px;
  margin: 0 auto;
  padding: 54px 24px 84px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 270px;
  gap: 24px;
}
.brick-hero,
.index-hero {
  grid-column: 1 / -1;
  position: relative;
  overflow: hidden;
  display: grid;
  gap: 22px;
  align-items: end;
  padding: 30px;
  border: 2px solid #111111;
  box-shadow: var(--shadow);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.06), transparent 24%),
    linear-gradient(135deg, rgba(143,182,255,0.16), rgba(4,7,12,0) 34%),
    linear-gradient(180deg, #0c1017 0%, #05080d 100%);
}
.brick-hero::before,
.index-hero::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 20% 22%, rgba(143,182,255,0.16), transparent 0 26%),
    radial-gradient(circle at 78% 26%, rgba(255,255,255,0.08), transparent 0 20%),
    repeating-linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.02) 1px, transparent 1px, transparent 4px);
  pointer-events: none;
}
.brick-hero {
  grid-template-columns: 130px minmax(0, 1fr) auto;
}
.hero-block,
.index-hero > * {
  position: relative;
  z-index: 1;
}
.hero-title .partno,
.index-hero .partno {
  color: rgba(244,241,232,0.62);
  font-size: 0.72rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.hero-title h1,
.index-hero h1,
main > h1 {
  margin: 0;
  font-family: "Anton", Impact, sans-serif;
  font-size: clamp(3rem, 8vw, 6.8rem);
  line-height: 0.92;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--hero-ink);
}
.index-hero p,
.hero-title p {
  margin: 14px 0 0;
  max-width: 760px;
  color: rgba(244,241,232,0.76);
}
.hero-meta,
.index-hero__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.pill {
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 7px 10px;
  border: 1px solid rgba(244,241,232,0.14);
  background: rgba(4,7,12,0.28);
  color: rgba(244,241,232,0.74);
}
.pill.status-canonical { color: #111111; background: #ffe47f; border-color: #111111; }
.pill.status-candidate { color: #111111; background: var(--blue); border-color: #111111; }
.pill.status-project_bound { color: var(--hero-ink); background: rgba(244,241,232,0.12); }
.hero-svg {
  width: 118px;
  display: block;
  filter: drop-shadow(0 18px 28px rgba(0,0,0,0.42));
}
.hero-cta {
  text-align: right;
  color: rgba(244,241,232,0.68);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.hero-cta a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 10px;
  padding: 12px 14px;
  border: 2px solid #111111;
  box-shadow: 6px 6px 0 #111111;
  background: var(--panel);
  color: var(--ink);
}
.hero-cta a:hover {
  transform: translate(-1px, -1px);
}
.doc-article,
.grid,
.summary {
  grid-column: 1 / 2;
}
.doc-article {
  grid-row: 2;
  background: var(--panel);
  color: var(--ink);
  border: 2px solid #111111;
  box-shadow: var(--shadow);
  padding: clamp(24px, 4vw, 46px);
}
.doc-article h1 { margin: 0 0 18px; font-family: "Anton", Impact, sans-serif; font-size: clamp(2.4rem, 6vw, 4.6rem); line-height: 0.94; text-transform: uppercase; }
.doc-article h2 {
  margin: 38px 0 0;
  padding-bottom: 10px;
  border-bottom: 2px solid #111111;
  font-size: 0.8rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.doc-article h3 {
  margin: 30px 0 0;
  font-family: "Anton", Impact, sans-serif;
  font-size: clamp(1.8rem, 3vw, 3rem);
  line-height: 0.96;
  text-transform: uppercase;
}
.doc-article h4 {
  margin: 24px 0 0;
  font-size: 0.75rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.doc-article p,
.doc-article ul,
.doc-article ol,
.doc-article li {
  color: #26231d;
}
.doc-article strong { color: #111111; }
.doc-article ul,
.doc-article ol { margin: 14px 0 14px 22px; padding: 0; }
.doc-article li { margin: 6px 0; }
.doc-article code {
  background: rgba(17,17,17,0.08);
  color: #20395c;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.92em;
}
.doc-article pre.code {
  background: #0b0f17;
  border: 2px solid #111111;
  color: var(--hero-ink);
  padding: 16px 18px;
  overflow-x: auto;
  box-shadow: 6px 6px 0 #111111;
}
.doc-article pre.code code { background: transparent; color: inherit; padding: 0; }
.doc-article .tbl-wrap {
  overflow-x: auto;
  margin: 16px 0;
  border: 2px solid #111111;
  box-shadow: 6px 6px 0 #111111;
}
.doc-article table { width: 100%; border-collapse: collapse; font-size: 0.94rem; }
.doc-article th,
.doc-article td {
  padding: 12px 14px;
  border-bottom: 1px solid rgba(17,17,17,0.16);
  text-align: left;
  vertical-align: top;
}
.doc-article th {
  background: #111111;
  color: var(--hero-ink);
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.doc-article tr:last-child td { border-bottom: none; }
.doc-article blockquote {
  margin: 18px 0;
  padding: 16px 18px;
  border-left: 6px solid var(--blue);
  background: rgba(143,182,255,0.12);
  color: #20395c;
}
.doc-article hr {
  border: none;
  border-top: 2px solid rgba(17,17,17,0.12);
  margin: 34px 0;
}
.toc {
  grid-column: 2 / 3;
  grid-row: 2;
  position: sticky;
  top: 96px;
  align-self: start;
  background: #111111;
  color: var(--hero-ink);
  border: 2px solid #111111;
  box-shadow: var(--shadow);
  padding: 16px 16px 12px;
}
.toc h5 {
  margin: 0 0 10px;
  font-size: 0.7rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(244,241,232,0.58);
}
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li + li { margin-top: 4px; }
.toc a {
  display: block;
  padding: 7px 8px;
  color: rgba(244,241,232,0.76);
}
.toc a:hover {
  background: rgba(244,241,232,0.08);
  color: var(--hero-ink);
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 18px;
}
.stat {
  background: var(--panel);
  color: var(--ink);
  border: 2px solid #111111;
  box-shadow: 6px 6px 0 #111111;
  padding: 14px 16px;
}
.stat .lbl {
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.stat .num {
  margin-top: 8px;
  font-family: "Anton", Impact, sans-serif;
  font-size: clamp(2rem, 4vw, 3.6rem);
  line-height: 0.92;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
  margin-top: 22px;
}
.card {
  background: var(--panel);
  color: var(--ink);
  border: 2px solid #111111;
  box-shadow: 6px 6px 0 #111111;
  padding: 18px;
  transition: transform 160ms ease;
}
.card:hover { transform: translate(-2px, -2px); }
.card .name {
  font-family: "Anton", Impact, sans-serif;
  font-size: clamp(1.6rem, 2vw, 2.3rem);
  line-height: 0.92;
  text-transform: uppercase;
}
.card .sub {
  margin-top: 10px;
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.card .pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
footer {
  max-width: 1520px;
  margin: 0 auto;
  padding: 0 24px 44px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  color: rgba(244,241,232,0.62);
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
footer a { color: rgba(244,241,232,0.86); }
@media (max-width: 1180px) {
  main {
    grid-template-columns: 1fr;
  }
  .toc {
    position: static;
    grid-column: 1 / -1;
  }
}
@media (max-width: 860px) {
  .chrome-inner {
    padding: 12px 16px;
    align-items: flex-start;
    flex-direction: column;
  }
  .chrome-cta { margin-left: 0; }
  main {
    padding: 34px 16px 70px;
  }
  .brick-hero {
    grid-template-columns: 1fr;
  }
  .hero-cta {
    text-align: left;
  }
  .doc-article {
    padding: 24px 18px;
    box-shadow: 8px 8px 0 #111111;
  }
}
`;
}

function heroSvg(fm: LooseRecord): string {
  // Simple 2x2 brick in the status color.
  const status = String(fm.status || "project_bound");
  const palette = {
    canonical: { top: "#ffd859", front: "#f5b800", side: "#b98600", edge: "#7a5a00" },
    candidate: { top: "#6c9bff", front: "#3475ff", side: "#1f4cc0", edge: "#14306b" },
    project_bound: { top: "#c6ccd6", front: "#9aa3b2", side: "#5e6776", edge: "#353c48" }
  }[status] || { top: "#c6ccd6", front: "#9aa3b2", side: "#5e6776", edge: "#353c48" };
  const w = 96, h = 48, d = 18;
  const stud = (cx: number, cy: number): string => `<ellipse cx="${cx}" cy="${cy}" rx="10" ry="7" fill="${palette.top}" stroke="${palette.edge}" stroke-width="1"/><ellipse cx="${cx-1.5}" cy="${cy-2}" rx="6" ry="3" fill="rgba(255,255,255,0.3)"/>`;
  return `<svg class="hero-svg" viewBox="0 -14 ${w + d + 8} ${h + d + 8}">
    <polygon points="${w},0 ${w+d},${-d/2} ${w+d},${h-d/2} ${w},${h}" fill="${palette.side}" stroke="${palette.edge}" stroke-width="1"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="${palette.front}" stroke="${palette.edge}" stroke-width="1"/>
    <polygon points="0,0 ${d},${-d/2} ${w+d},${-d/2} ${w},0" fill="${palette.top}" stroke="${palette.edge}" stroke-width="1"/>
    <g transform="translate(${d/2}, ${-d/2})">
      ${stud(w*0.25, h*0.25)}
      ${stud(w*0.75, h*0.25)}
      ${stud(w*0.25, h*0.75)}
      ${stud(w*0.75, h*0.75)}
    </g>
  </svg>`;
}

function buildChrome(crumbs: string, depth = 2): string {
  const prefix = depth === 1 ? "../" : "../../";
  return `<div class="chrome"><div class="chrome-inner">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">BRICKWORKS</span></div>
    <nav class="crumbs">${crumbs}</nav>
    <div class="chrome-cta">
      <a href="${prefix}index.html">SMA home</a>
      <a href="${prefix}BRICK_WALL_LEGO.generated.html">Brick wall</a>
    </div>
  </div></div>`;
}

function crumbsFor(parts: Crumb[]): string {
  const spans: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.href) spans.push(`<a href="${escapeHtml(p.href)}">${escapeHtml(p.label)}</a>`);
    else spans.push(`<span>${escapeHtml(p.label)}</span>`);
    if (i < parts.length - 1) spans.push(`<span class="sep">/</span>`);
  }
  return spans.join("");
}

function tocFromBody(bodyHtml: string): string {
  const re = /<h2 id="([^"]+)">([^<]+)<\/h2>/g;
  const items = [];
  let m;
  while ((m = re.exec(bodyHtml)) !== null) items.push({ id: m[1], text: m[2] });
  if (items.length === 0) return "";
  return `<aside class="toc"><h5>On this page</h5><ul>${items.map((it) => `<li><a href="#${it.id}">${escapeHtml(it.text)}</a></li>`).join("")}</ul></aside>`;
}

async function renderBrickPage(mdPath: string, project: string): Promise<string> {
  const raw = await fs.readFile(mdPath, "utf8");
  const { fm, body } = parseFrontMatter(raw);
  const bodyHtml = renderMarkdown(body);
  const toc = tocFromBody(bodyHtml);
  const title = String(fm.title || path.basename(mdPath).replace(/\.md$/, ""));
  const status = fm.status || "project_bound";
  const kind = fm.kind || "—";
  const tags = Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags === "string" ? [fm.tags] : []);
  const portable = mdPath.replace(/\.md$/, ".portable.md");
  const portableBase = path.basename(portable);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · BRICKWORKS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>${pageCss()}</style>
</head>
<body>
${buildChrome(crumbsFor([
  { label: "index", href: "../index.html" },
  { label: project, href: "INDEX.html" },
  { label: title }
]), 2)}
<main>
  <div class="brick-hero">
    <div class="hero-block">${heroSvg(fm)}</div>
    <div class="hero-block hero-title">
      <div class="partno">BRICK · ${escapeHtml(String(fm.brick_id || ""))}</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="hero-meta">
        <span class="pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>
        <span class="pill">${escapeHtml(kind)}</span>
        ${fm.archetype ? `<span class="pill">${escapeHtml(String(fm.archetype))}</span>` : ""}
        <span class="pill">${escapeHtml(project)}</span>
      </div>
      ${tags.length ? `<div class="hero-meta">${tags.slice(0, 12).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="hero-block hero-cta">
      <a href="${escapeHtml(portableBase)}">Portable doc ↗</a>
    </div>
  </div>
  ${toc}
  <article class="doc-article">${bodyHtml}</article>
</main>
<footer>
  <span>BRICKWORKS · rendered ${new Date().toISOString().slice(0,10)}</span>
  <span>generator: tools/sma-wiki-html.ts</span>
  <span><a href="../../BRICK_WALL_LEGO.generated.html">Open the brick wall</a></span>
  <span><a href="../index.html">All bricks</a></span>
</footer>
</body>
</html>`;
}

async function listProjects(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function renderProjectIndex(root: string, project: string): Promise<string> {
  const dir = path.join(root, project);
  const entries = await fs.readdir(dir);
  const pages: Array<{ file: string; title: string; status: string; kind: string; archetype: string }> = [];
  for (const e of entries) {
    if (!e.endsWith(".md") || e.endsWith(".portable.md") || e === "INDEX.md") continue;
    const { fm } = parseFrontMatter(await fs.readFile(path.join(dir, e), "utf8"));
    pages.push({
      file: e.replace(/\.md$/, ".html"),
      title: String(fm.title || e.replace(/\.md$/, "")),
      status: String(fm.status || "project_bound"),
      kind: String(fm.kind || "—"),
      archetype: String(fm.archetype || "")
    });
  }
  pages.sort((a, b) => a.title.localeCompare(b.title));
  const cards = pages.map((p) => `<article class="card"><a href="${escapeHtml(p.file)}"><div class="name">${escapeHtml(p.title)}</div><div class="sub">${escapeHtml(p.kind)} · ${escapeHtml(p.archetype || "—")}</div><div class="pills"><span class="pill status-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></div></a></article>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(project)} · BRICKWORKS</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>${pageCss()}</style></head><body>
${buildChrome(crumbsFor([{ label: "index", href: "../index.html" }, { label: project }]), 2)}
<main>
  <section class="index-hero">
    <div class="partno">Project bay</div>
    <h1>${escapeHtml(project)}</h1>
    <p>Detailed brick references for one project bay. Open a page to inspect boundaries, trust metadata, and clone-ready context.</p>
  </section>
  <div class="summary">
    <div class="stat"><div class="lbl">Total pages</div><div class="num">${pages.length}</div></div>
    <div class="stat"><div class="lbl">Canonical</div><div class="num" style="color: var(--gold)">${pages.filter((p) => p.status === "canonical").length}</div></div>
    <div class="stat"><div class="lbl">Candidate</div><div class="num" style="color: var(--blue)">${pages.filter((p) => p.status === "candidate").length}</div></div>
  </div>
  <div class="grid">${cards || '<p>No pages yet.</p>'}</div>
</main>
<footer><span>BRICKWORKS · project index</span><span><a href="../index.html">Back to all bricks</a></span></footer>
</body></html>`;
}

async function renderMasterIndex(root: string): Promise<string> {
  const projects = await listProjects(root);
  const proj = [];
  let totalPages = 0;
  for (const p of projects) {
    const entries = await fs.readdir(path.join(root, p));
    const pages = entries.filter((e) => e.endsWith(".md") && !e.endsWith(".portable.md") && e !== "INDEX.md");
    proj.push({ p, count: pages.length });
    totalPages += pages.length;
  }
  const cards = proj.sort((a, b) => b.count - a.count).map(({ p, count }) => `<article class="card"><a href="${escapeHtml(p)}/INDEX.html"><div class="name">${escapeHtml(p)}</div><div class="sub">${count} brick page(s)</div></a></article>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BRICKWORKS · All Bricks</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>${pageCss()}</style></head><body>
${buildChrome(crumbsFor([{ label: "BRICKWORKS · all bricks" }]), 1)}
<main>
  <section class="index-hero">
    <div class="partno">Registry surface</div>
    <h1>All Bricks</h1>
    <p>The detailed doc surface mirrors the live registry: project bays, per-brick references, and portable clone-ready pages.</p>
  </section>
  <div class="summary">
    <div class="stat"><div class="lbl">Project bays</div><div class="num">${projects.length}</div></div>
    <div class="stat"><div class="lbl">Total wiki pages</div><div class="num">${totalPages}</div></div>
    <div class="stat"><div class="lbl">Generator</div><div class="num" style="font-size:14px; font-weight: 400; color: var(--muted)">sma-wiki-html</div></div>
  </div>
  <div class="grid">${cards || '<p>No projects yet. Run <code>npm run codex:wiki</code>.</p>'}</div>
</main>
<footer>
  <span>BRICKWORKS · brick catalog</span>
  <span><a href="../BRICK_WALL_LEGO.generated.html">Visual wall</a></span>
</footer>
</body></html>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projects = await listProjects(opts.root);
  let rendered = 0;
  for (const project of projects) {
    const dir = path.join(opts.root, project);
    const entries = await fs.readdir(dir);
    for (const e of entries) {
      if (!e.endsWith(".md") || e.endsWith(".portable.md") || e === "INDEX.md") continue;
      const mdPath = path.join(dir, e);
      const html = await renderBrickPage(mdPath, project);
      const out = mdPath.replace(/\.md$/, ".html");
      await fs.writeFile(out, html);
      rendered += 1;
    }
    const idx = await renderProjectIndex(opts.root, project);
    await fs.writeFile(path.join(dir, "INDEX.html"), idx);
  }
  const master = await renderMasterIndex(opts.root);
  await fs.writeFile(path.join(opts.root, "index.html"), master);
  console.log(JSON.stringify({ projects: projects.length, pages_rendered: rendered, master_index: path.join(opts.root, "index.html") }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
