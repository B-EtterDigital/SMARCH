#!/usr/bin/env node
/**
 * WHAT: Generates detailed per-brick reference pages grounded in code, manifests, documentation, and connection evidence.
 * WHY: Reusers need installation, interfaces, examples, risks, and troubleshooting in one source-backed page instead of scattered files.
 * HOW: Reads approved brick context, asks Codex for structured sections, and writes pages consumed by the detailed wiki indexer.
 * Usage: `node tools/sma-codex-wiki.mjs --limit 1 --dry-run`
 */
/**
 * sma-codex-wiki: write a full wiki page per approved brick (candidate or
 * canonical), grounded in its source code, sibling docs, manifest semantics,
 * and connection edges.
 *
 * For each selected brick we pack up to ~12KB of context (top source files,
 * README*.md, sibling *.md docs, the manifest.semantics block, the top 6
 * connection edges), and ask codex to fill a strict schema covering:
 *   - overview
 *   - when_to_use / when_not_to_use
 *   - architecture
 *   - public_api reference (per symbol)
 *   - configuration & env vars
 *   - installation & clone walk-through
 *   - usage example (runnable snippet)
 *   - integration recipe for dropping into a new project
 *   - related_bricks (from connections)
 *   - troubleshooting
 *   - faq
 *
 * The structured JSON is rendered to Markdown with YAML front-matter and
 * written to wiki/bricks/<project>/<brick_slug>.md. A per-project index is
 * rebuilt at wiki/bricks/<project>/INDEX.md, and the merged wiki's brick
 * pages are replaced with the richer ones.
 *
 * Usage:
 *   node tools/sma-codex-wiki.mjs                           # all approved bricks
 *   node tools/sma-codex-wiki.mjs --limit 20                # smoke test
 *   node tools/sma-codex-wiki.mjs --filter cascadepipeline  # one brick
 *   node tools/sma-codex-wiki.mjs --statuses canonical,candidate
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codexBatch } from "./lib/codex-runner.mjs";
import { PROJECTS_ROOT, SMA_ROOT, smaPath } from "./lib/sma-paths.mjs";

function parseArgs(argv) {
  const opts = {
    registry: smaPath("scans/all-projects/latest.registry.json"),
    candidates: smaPath("security/reuse_candidates.json"),
    connections: smaPath("security/brick_connections.json"),
    outRoot: smaPath("wiki/bricks-detailed"),
    limit: 0,
    concurrency: 2,
    overwrite: false,
    project: "",
    filter: "",
    statuses: "canonical,candidate",
    minScore: 40,
    timeoutMs: 360000,
    model: "gpt-5.4",
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--registry" && n) { opts.registry = path.resolve(n); i += 1; }
    else if (a === "--candidates" && n) { opts.candidates = path.resolve(n); i += 1; }
    else if (a === "--connections" && n) { opts.connections = path.resolve(n); i += 1; }
    else if (a === "--out-root" && n) { opts.outRoot = path.resolve(n); i += 1; }
    else if (a === "--limit" && n) { opts.limit = Number(n); i += 1; }
    else if (a === "--concurrency" && n) { opts.concurrency = Number(n); i += 1; }
    else if (a === "--overwrite") opts.overwrite = true;
    else if (a === "--project" && n) { opts.project = n; i += 1; }
    else if (a === "--filter" && n) { opts.filter = n.toLowerCase(); i += 1; }
    else if (a === "--statuses" && n) { opts.statuses = n; i += 1; }
    else if (a === "--min-score" && n) { opts.minScore = Number(n); i += 1; }
    else if (a === "--timeout" && n) { opts.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--model" && n) { opts.model = n; i += 1; }
    else if (a === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

// MSDN/rustdoc-quality schema: every API member gets a full signature doc
// with params, returns, throws, remarks, example, and see-also.
const API_MEMBER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name", "kind", "signature", "summary", "remarks",
    "params", "returns", "throws", "example", "since", "stability", "see_also"
  ],
  properties: {
    name: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "function", "async_function", "class", "constructor", "method",
        "property", "type", "interface", "enum", "constant", "variable",
        "component", "hook", "endpoint", "event", "middleware", "file", "other"
      ]
    },
    signature: { type: "string" },          // full syntax: `function foo(x: string): Promise<void>`
    summary: { type: "string" },            // 1–2 sentences
    remarks: { type: "string" },            // longer notes, side effects, thread-safety, perf etc.
    params: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "required", "description"],
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          required: { type: "boolean" },
          description: { type: "string" }
        }
      }
    },
    returns: { type: "string" },
    throws: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "condition"],
        properties: {
          type: { type: "string" },
          condition: { type: "string" }
        }
      }
    },
    example: { type: "string" },           // fenced code block — empty string if none
    since: { type: "string" },             // version or git-sha or empty
    stability: { type: "string", enum: ["stable", "experimental", "deprecated", "internal", "unknown"] },
    see_also: { type: "array", items: { type: "string" } }  // other symbol names or brick ids
  }
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "overview", "when_to_use", "when_not_to_use", "architecture",
    "public_api", "configuration", "installation", "usage_example",
    "integration_recipe", "related_bricks", "troubleshooting", "faq",
    "caveats", "references", "portable_doc"
  ],
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    when_to_use: { type: "array", items: { type: "string" } },
    when_not_to_use: { type: "array", items: { type: "string" } },
    architecture: { type: "string" },
    public_api: { type: "array", items: API_MEMBER_SCHEMA },
    configuration: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "scope", "required", "purpose", "default", "example"],
        properties: {
          name: { type: "string" },
          scope: { type: "string", enum: ["env_server", "env_public_client", "env_ci", "config_file", "runtime_arg", "secret_manager", "other"] },
          required: { type: "boolean" },
          purpose: { type: "string" },
          default: { type: "string" },
          example: { type: "string" }
        }
      }
    },
    installation: { type: "array", items: { type: "string" } },
    usage_example: { type: "string" },
    integration_recipe: { type: "array", items: { type: "string" } },
    related_bricks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "summary"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["depends_on", "composes_with", "alternative_to", "supersedes", "depended_by", "shared_concept"] },
          summary: { type: "string" }
        }
      }
    },
    troubleshooting: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symptom", "likely_cause", "fix"],
        properties: {
          symptom: { type: "string" },
          likely_cause: { type: "string" },
          fix: { type: "string" }
        }
      }
    },
    faq: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["q", "a"],
        properties: { q: { type: "string" }, a: { type: "string" } }
      }
    },
    caveats: { type: "array", items: { type: "string" } },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "location"],
        properties: {
          label: { type: "string" },
          location: { type: "string" }
        }
      }
    },
    // Compact, self-contained doc meant to be dropped into a host project's
    // docs/ folder alongside the cloned brick. Markdown string — no front-matter.
    portable_doc: { type: "string" }
  }
};

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }
async function maybe(p) { try { return await fs.readFile(p, "utf8"); } catch { return null; } }

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function gatherDocs(brick, manifest) {
  const rootDir = path.dirname(brick.manifest_path);
  const wanted = new Set();
  const isFileBrick = (brick.source_paths || []).some((p) => /\.(t|j)sx?$|\.py$/i.test(p));
  if (isFileBrick) {
    wanted.add(path.resolve(PROJECTS_ROOT, brick.project || "", brick.source_paths[0]));
  }
  for (const name of [
    "README.md", "README.txt", "readme.md", "OVERVIEW.md", "USAGE.md",
    "ARCHITECTURE.md", "CHANGELOG.md",
    "index.ts", "index.tsx", "index.js", "index.mjs",
    `${path.basename(rootDir)}.ts`, `${path.basename(rootDir)}.tsx`
  ]) {
    wanted.add(path.join(rootDir, name));
  }
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    let addedSrc = 0, addedMd = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.endsWith(".module.sweetspot.json") || e.name === "module.sweetspot.json") continue;
      if (/\.(test|spec)\./i.test(e.name)) continue;
      if (/\.md$|\.mdx$/i.test(e.name) && addedMd < 4) {
        wanted.add(path.join(rootDir, e.name)); addedMd += 1;
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(e.name) && addedSrc < 4) {
        wanted.add(path.join(rootDir, e.name)); addedSrc += 1;
      }
    }
  } catch {}

  const pieces = [];
  let bytes = 0;
  const BUDGET = 11_500;
  for (const f of wanted) {
    if (bytes >= BUDGET) break;
    const text = await maybe(f);
    if (!text) continue;
    const slice = text.slice(0, Math.max(300, Math.min(BUDGET - bytes, 3500)));
    pieces.push(`### ${path.relative(PROJECTS_ROOT, f)}\n${slice}`);
    bytes += slice.length;
  }
  return pieces.join("\n\n");
}

function buildPrompt(brick, manifest, docs, connectionEdges) {
  const sem = manifest.semantics || {};
  const connBlock = connectionEdges.slice(0, 8)
    .map((e) => `- ${e.kind} → ${e.target}  (${e.confidence || ""})  ${e.reason || ""}`)
    .join("\n");
  return `You write a full wiki page for a reusable software brick in a multi-project registry. An AI agent reads this page later to decide whether to reuse the brick in a new project, then to integrate it. Be specific, grounded, and concrete. No marketing fluff.

## Brick metadata
- id: ${brick.id}
- name: ${brick.name}
- project: ${brick.project}
- status: ${brick.status || manifest.brick?.status || "project_bound"}
- kind: ${brick.kind}
- source_paths: ${JSON.stringify(brick.source_paths || [])}
- existing_purpose: ${sem.purpose || "(none)"}
- existing_tags: ${JSON.stringify(sem.tags || [])}
- existing_public_api: ${JSON.stringify(sem.public_api || [])}
- existing_risks: ${JSON.stringify(sem.risks || [])}
- existing_related_concepts: ${JSON.stringify(sem.related_concepts || [])}

## Known connections (from the cross-brick graph)
${connBlock || "(none)"}

## Source + documentation excerpts

${docs || "(no readable source or docs)"}

## Your task
Return JSON matching the schema. Quality bar: the page should be **as complete and precise as a C#/MSDN, rustdoc, or TypeDoc reference page**. Ground every claim in the source; when the source is silent, say so rather than inventing.

Specific requirements:

- \`overview\` — 3–6 sentences. Lead with the concrete problem the brick solves, not the category.
- \`architecture\` — describe internal modules, data flow, threading/concurrency, dependencies, extension points. Cross-reference file paths.
- \`public_api\` — **per symbol**: \`signature\` is the full syntax as it would appear in the source (TypeScript / Deno / Python — match the brick's language). Enumerate every \`params\` entry with type + required + description. Fill \`returns\`, \`throws\` (include the exception type and the condition that triggers it), \`remarks\` (side effects, perf, thread-safety, lifecycle), a runnable \`example\` fenced code block when you can show one, \`since\` if you can tell from source or empty, \`stability\` and \`see_also\` cross-references to other public symbols or related_bricks ids. If a symbol is not visible in the source, still list it using kind="other" and explain the limitation in \`remarks\`.
- \`configuration\` — every env var / config key the brick reads, with scope, required flag, default value (or "—"), and a concrete example value.
- \`installation\` — ordered copy-paste steps to land the brick in a fresh project.
- \`usage_example\` — one self-contained fenced code block that actually exercises the public API's happy path.
- \`integration_recipe\` — ordered steps to wire the brick into an *existing* app (routing/UI mount, migrations, env, feature flags, observability).
- \`related_bricks\` — only use ids that appeared in "Known connections"; do not invent ids.
- \`troubleshooting\` — 2–5 concrete symptoms an integrator will hit, with a likely cause and the fix.
- \`faq\` — 3–6 honest questions a consumer would ask (e.g., "does this support X runtime?", "is it thread-safe?", "how do I mock it in tests?").
- \`caveats\` — limits, things that will surprise new users, footguns.
- \`references\` — the actual file paths you inspected plus any external docs mentioned in the source.
- \`portable_doc\` — a **self-contained markdown document** (no front-matter) a developer can drop into their target project's \`docs/\` folder *alongside the cloned brick*. It should compact the overview + public API + configuration + usage example + troubleshooting into a single readable page, no back-references to the SMA registry. Assume the reader has the brick code locally and just needs to know how to use it.

Return ONLY the JSON object.`;
}

function renderMarkdown(brick, manifest, data) {
  const sem = manifest.semantics || {};
  const front = [
    "---",
    `title: ${JSON.stringify(data.title || brick.name || brick.id)}`,
    `brick_id: ${brick.id}`,
    `project: ${brick.project}`,
    `status: ${brick.status || manifest.brick?.status || "project_bound"}`,
    `kind: ${brick.kind}`,
    `source_paths: ${JSON.stringify(brick.source_paths || [])}`,
    sem.reuse_archetype ? `archetype: ${sem.reuse_archetype}` : null,
    sem.tags?.length ? `tags: ${JSON.stringify(sem.tags)}` : null,
    `generated_at: ${new Date().toISOString()}`,
    `generated_by: codex-gpt-5.4`,
    "---",
    ""
  ].filter(Boolean).join("\n");

  const lines = [front];
  lines.push(`# ${data.title || brick.name || brick.id}`, "");
  lines.push(`## Overview`, "", data.overview || "_(pending)_", "");
  if (data.when_to_use?.length) {
    lines.push(`## When to use`, "", ...data.when_to_use.map((s) => `- ${s}`), "");
  }
  if (data.when_not_to_use?.length) {
    lines.push(`## When NOT to use`, "", ...data.when_not_to_use.map((s) => `- ${s}`), "");
  }
  if (data.architecture) {
    lines.push(`## Architecture`, "", data.architecture, "");
  }
  if (data.public_api?.length) {
    lines.push(`## Public API`, "");
    lines.push(`> Each member below is documented in the MSDN/rustdoc-style: signature, parameters, returns, throws, remarks, example.`, "");
    for (const s of data.public_api) {
      lines.push(`### \`${s.name}\` — ${s.kind}${s.stability && s.stability !== "unknown" ? ` *(${s.stability})*` : ""}`, "");
      if (s.signature) lines.push("```typescript", s.signature, "```", "");
      if (s.summary) lines.push(s.summary, "");
      if (s.params?.length) {
        lines.push("**Parameters**", "", "| Name | Type | Required | Description |", "|---|---|---|---|");
        for (const p of s.params) lines.push(`| \`${p.name}\` | \`${p.type}\` | ${p.required ? "yes" : "no"} | ${p.description} |`);
        lines.push("");
      }
      if (s.returns) lines.push(`**Returns** — ${s.returns}`, "");
      if (s.throws?.length) {
        lines.push("**Throws**", "");
        for (const t of s.throws) lines.push(`- \`${t.type}\` — ${t.condition}`);
        lines.push("");
      }
      if (s.remarks) lines.push(`**Remarks** — ${s.remarks}`, "");
      if (s.example) lines.push("**Example**", "", s.example, "");
      if (s.see_also?.length) lines.push(`**See also** — ${s.see_also.map((x) => `\`${x}\``).join(", ")}`, "");
      if (s.since) lines.push(`*Since:* ${s.since}`, "");
      lines.push("---", "");
    }
  }
  if (data.configuration?.length) {
    lines.push(`## Configuration & environment`, "", "| Name | Scope | Required | Default | Purpose | Example |", "|---|---|---|---|---|---|");
    for (const c of data.configuration) lines.push(`| \`${c.name}\` | ${c.scope} | ${c.required ? "yes" : "no"} | ${c.default ? `\`${c.default}\`` : "—"} | ${c.purpose} | ${c.example ? `\`${c.example}\`` : "—"} |`);
    lines.push("");
  }
  if (data.installation?.length) {
    lines.push(`## Installation`, "", ...data.installation.map((s, i) => `${i + 1}. ${s}`), "");
  }
  if (data.usage_example) {
    lines.push(`## Usage example`, "", data.usage_example, "");
  }
  if (data.integration_recipe?.length) {
    lines.push(`## Integration recipe`, "", ...data.integration_recipe.map((s, i) => `${i + 1}. ${s}`), "");
  }
  if (data.related_bricks?.length) {
    lines.push(`## Related bricks`, "", "| Relationship | Brick | Summary |", "|---|---|---|");
    for (const r of data.related_bricks) lines.push(`| ${r.kind} | \`${r.id}\` | ${r.summary} |`);
    lines.push("");
  }
  if (data.troubleshooting?.length) {
    lines.push(`## Troubleshooting`, "", "| Symptom | Likely cause | Fix |", "|---|---|---|");
    for (const t of data.troubleshooting) lines.push(`| ${t.symptom} | ${t.likely_cause} | ${t.fix} |`);
    lines.push("");
  }
  if (data.faq?.length) {
    lines.push(`## FAQ`, "");
    for (const q of data.faq) { lines.push(`**${q.q}**`, "", q.a, ""); }
  }
  if (data.caveats?.length) {
    lines.push(`## Caveats`, "", ...data.caveats.map((s) => `- ${s}`), "");
  }
  if (data.references?.length) {
    lines.push(`## References`, "", ...data.references.map((r) => `- ${r.label} — ${r.location}`), "");
  }
  return lines.join("\n");
}

async function loadBricks(opts) {
  const cands = await readJson(opts.candidates);
  const registry = await readJson(opts.registry);
  const byId = new Map(registry.bricks.map((b) => [b.id, b]));
  const wanted = opts.statuses.split(",").map((s) => s.trim()).filter(Boolean);
  const list = [];
  for (const b of cands.bricks || []) {
    if (opts.minScore > 0 && (b.score || 0) < opts.minScore) continue;
    const reg = byId.get(b.id);
    const status = reg?.status || "project_bound";
    if (wanted.length && !wanted.includes(status)) continue;
    if (opts.project && b.project !== opts.project) continue;
    if (opts.filter) {
      const f = opts.filter;
      const hay = `${b.id} ${b.name || ""} ${(b.source_paths||[]).join(" ")}`.toLowerCase();
      if (!hay.includes(f)) continue;
    }
    list.push({ ...b, status });
  }
  if (opts.limit > 0) list.length = Math.min(list.length, opts.limit);
  return list;
}

async function loadConnections(opts) {
  const d = await maybe(opts.connections);
  if (!d) return new Map();
  try {
    const parsed = JSON.parse(d);
    const byFrom = new Map();
    for (const e of parsed.edges || []) {
      if (!byFrom.has(e.from)) byFrom.set(e.from, []);
      byFrom.get(e.from).push(e);
    }
    return byFrom;
  } catch { return new Map(); }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bricks = await loadBricks(opts);
  const conns = await loadConnections(opts);
  console.error(`writing wiki pages for ${bricks.length} brick(s) (concurrency=${opts.concurrency})`);

  const items = [];
  const meta = new Map();

  for (const b of bricks) {
    try {
      const manifest = JSON.parse(await fs.readFile(b.manifest_path, "utf8"));
      const slug = slugify(b.id);
      const outPath = path.join(opts.outRoot, b.project || "_unknown", `${slug}.md`);
      if (!opts.overwrite) {
        const stat = await fs.stat(outPath).catch(() => null);
        if (stat) continue;
      }
      const docs = await gatherDocs(b, manifest);
      const edges = conns.get(b.id) || [];
      items.push({
        id: b.id,
        prompt: buildPrompt(b, manifest, docs, edges),
        schema: SCHEMA
      });
      meta.set(b.id, { brick: b, manifest, outPath });
    } catch (err) {
      console.error(`skip ${b.id}: ${err.message}`);
    }
  }

  console.error(`queued ${items.length} (skipped ${bricks.length - items.length} existing — use --overwrite to regenerate)`);

  let processed = 0, written = 0, cacheHits = 0, failed = 0;
  const writeQueue = [];

  await codexBatch(items, {
    concurrency: opts.concurrency,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    onResult: (wrapped) => {
      processed += 1;
      const r = wrapped.result;
      if (!r.ok) { failed += 1; console.error(`  ${wrapped.id}: ${r.error}`); return; }
      if (r.fromCache) cacheHits += 1;
      const m = meta.get(wrapped.id);
      if (!m) return;
      const md = renderMarkdown(m.brick, m.manifest, r.data);
      const portablePath = m.outPath.replace(/\.md$/, ".portable.md");
      const portableMd = (r.data.portable_doc && r.data.portable_doc.trim())
        ? r.data.portable_doc.trim()
        : `# ${r.data.title || m.brick.name || m.brick.id}\n\n${r.data.overview || ""}\n`;
      const writePromise = (async () => {
        if (opts.dryRun) { written += 1; return; }
        try {
          await fs.mkdir(path.dirname(m.outPath), { recursive: true });
          await fs.writeFile(m.outPath, md);
          await fs.writeFile(portablePath, portableMd);
          m.manifest.semantics = m.manifest.semantics || {};
          m.manifest.semantics.wiki_page = path.relative(SMA_ROOT, m.outPath);
          m.manifest.semantics.wiki_portable_page = path.relative(SMA_ROOT, portablePath);
          m.manifest.semantics.wiki_generated_at = new Date().toISOString();
          await fs.writeFile(m.brick.manifest_path, `${JSON.stringify(m.manifest, null, 2)}\n`);
          written += 1;
        } catch (err) {
          failed += 1; console.error(`  write ${m.outPath}: ${err.message}`);
        }
      })();
      writeQueue.push(writePromise);
      if (processed % 3 === 0) console.error(`  ${processed}/${items.length} (${written} written so far, ${cacheHits} cache hits, ${failed} failed)`);
    }
  });
  await Promise.allSettled(writeQueue);

  // Rebuild per-project INDEX.md
  const projects = new Set();
  for (const [, m] of meta) projects.add(m.brick.project || "_unknown");
  for (const p of projects) {
    const dir = path.join(opts.outRoot, p);
    try {
      const entries = await fs.readdir(dir);
      const pages = entries.filter((e) => e.endsWith(".md") && e !== "INDEX.md").sort();
      const idx = [
        `# ${p} — brick index`, "",
        `Total pages: ${pages.length}`, "",
        ...pages.map((f) => `- [${f.replace(/\.md$/, "")}](${f})`),
        ""
      ].join("\n");
      await fs.writeFile(path.join(dir, "INDEX.md"), idx);
    } catch {}
  }

  console.log(JSON.stringify({
    bricks_scanned: bricks.length,
    queued: items.length,
    processed, cache_hits: cacheHits, written, failed,
    out_root: opts.outRoot,
    dry_run: opts.dryRun
  }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
