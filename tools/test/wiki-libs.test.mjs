import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  brickMarkdown,
  brickWallHtml,
  catalogMarkdown,
  featureClustersHtml,
  maybeReadJson,
  readManifest,
} from "../lib/wiki-bricks.ts";
import { courseHtml, projectHealthMarkdown, projectPage } from "../lib/wiki-project-pages.ts";
import {
  buildRegistryHtml,
  canonicalizationHtml,
  capabilitiesHtml,
  proofSurfaceHtml,
} from "../lib/wiki-surface-pages.ts";
import { countBy, escapeHtml, mdTableRow, slugify } from "../lib/wiki-utils.ts";

const brick = {
  id: "demo<script>",
  name: "Demo <script>",
  project: "wiki-project",
  kind: "service",
  status: "canonical",
  score: 91,
  clone_readiness: "ready",
  health: { status: "ok", error_count: 0, warning_count: 0, errors: [], warnings: [] },
  risk: "low",
  models: ["fixture-model"],
  data_classes: ["public"],
  source_paths: ["tools/lib/demo.ts"],
  manifest_path: "module.sweetspot.json",
  feature_cluster: { id: "demo", name: "Demo Cluster", description: "Fixture cluster" },
};

test("wiki utility serializers normalize identifiers, escaping, tables, and stable counts", () => {
  assert.equal(slugify("  Hello / World  "), "hello-world");
  assert.equal(slugify(null), "unknown");
  assert.equal(escapeHtml(`<a href="x&y">`), "&lt;a href=&quot;x&amp;y&quot;&gt;");
  assert.equal(mdTableRow(["line\none", null, 3]), "| line one |  | 3 |");
  assert.deepEqual(countBy(["b", "a", "b", "a", "c"], (value) => value === "c" ? null : value), [
    ["a", 2],
    ["b", 2],
    ["unknown", 1],
  ]);
});

test("wiki file readers fail closed and markdown renderers preserve live registry evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-wiki-libs-"));
  try {
    const manifestPath = path.join(root, "module.sweetspot.json");
    await writeFile(manifestPath, JSON.stringify({ brick: { id: "demo" } }));
    assert.deepEqual(await readManifest({ manifest_path: manifestPath }), { brick: { id: "demo" } });
    assert.equal(await readManifest({}), null);
    assert.equal(await maybeReadJson(path.join(root, "missing.json")), null);
    await writeFile(path.join(root, "bad.json"), "{");
    assert.equal(await maybeReadJson(path.join(root, "bad.json")), null);

    const catalog = catalogMarkdown([/** @type {any} */ (brick)]);
    const detail = brickMarkdown(/** @type {any} */ (brick), null);
    assert.match(catalog, /Demo <script>/);
    assert.match(detail, /Models recorded \| fixture-model/);
    assert.match(detail, /Public API\n\n- Not declared/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wiki HTML surfaces render deterministic empty and populated states with escaped content", () => {
  const project = {
    id: "wiki-project",
    brick_count: 1,
    unmanifested_count: 1,
    candidate_group_count: 1,
    average_score: 91,
    health_counts: { ok: 1, warn: 0, fail: 0 },
    error_count: 0,
    warning_count: 0,
    candidate_type_counts: { service: 1 },
    candidate_role_counts: { primary: 1 },
  };
  const registry = { projects: [project], bricks: [brick] };
  const health = projectHealthMarkdown([/** @type {any} */ (project)], [/** @type {any} */ (brick)]);
  const page = projectPage(
    /** @type {any} */ (project),
    [/** @type {any} */ (brick)],
    [/** @type {any} */ ({ project: "wiki-project", candidate_type: "service", hierarchy_role: "primary", group_name: "demo", relative_path: "src/demo", reason: "fixture" })],
    [/** @type {any} */ ({ project: "wiki-project", name: "demo", candidate_count: 1, candidate_type_counts: { service: 1 }, sample_paths: ["src/demo"] })],
  );
  assert.match(health, /Total bricks: 1/);
  assert.match(page, /src\/demo/);

  const course = courseHtml([/** @type {any} */ (brick)]);
  const wall = brickWallHtml(/** @type {any} */ (registry), [/** @type {any} */ (brick)]);
  const clusters = featureClustersHtml(/** @type {any} */ (registry), [/** @type {any} */ (brick)]);
  assert.doesNotMatch(course, /<h3>Demo <script><\/h3>/);
  assert.match(course, /Demo &lt;script&gt;/);
  assert.match(wall, /data-status="canonical"/);
  assert.match(wall, /Demo &lt;script&gt;/);
  assert.match(clusters, /Demo Cluster/);

  const emptyRegistry = /** @type {any} */ ({ projects: [], bricks: [] });
  const surfaces = [
    proofSurfaceHtml(emptyRegistry),
    buildRegistryHtml(emptyRegistry),
    capabilitiesHtml(emptyRegistry),
    canonicalizationHtml(emptyRegistry),
  ];
  assert.deepEqual(surfaces.map((html) => html.startsWith("<!doctype html>")), [true, true, true, true]);
  assert.match(surfaces[0], /<title>SMARCH Proof Surface<\/title>/);
  assert.match(surfaces[1], /No curated builds indexed yet/);
  assert.match(surfaces[2], /No recurring capability families detected yet/);
  assert.match(surfaces[3], /No canonicalization targets queued/);
});
