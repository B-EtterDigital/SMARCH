#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../../sma-validate.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "brick.manifest.schema.json");
const SCANNER_PATH = path.join(REPO_ROOT, "tools", "sma-scan.mjs");
const DEFAULT_OUTPUT = path.join(SCRIPT_DIR, "portfolio");
const SNAPSHOT_PATH = path.join(SCRIPT_DIR, "portfolio.snapshot.json");
const SNAPSHOT_ROOT = "tools/evals/fixtures/portfolio";
const FIXED_SEED = "smarch-public-eval-fixtures-v1";
const FIXED_TIMESTAMP = "2026-01-15T00:00:00.000Z";
const MAX_PORTFOLIO_BYTES = 2 * 1024 * 1024;

const PROJECTS = [
  {
    id: "acme-desktop",
    description: "Deterministic desktop operations fixture.",
    bricks: [
      "activity-feed",
      "app-shell",
      "command-palette",
      "desktop-bridge",
      "device-status",
      "document-cache",
      "env-probe",
      "export-queue",
      "notification-center",
      "oversized-catalog",
      "search-index",
      "session-store",
      "timeline-core",
      "workspace-router"
    ]
  },
  {
    id: "acme-studio",
    description: "Deterministic media studio fixture.",
    bricks: [
      "asset-browser",
      "audio-mixer",
      "caption-track",
      "clip-inspector",
      "color-pipeline",
      "export-preset",
      "media-bin",
      "preview-renderer",
      "project-timeline",
      "render-queue",
      "scene-library",
      "timeline-core",
      "transition-engine"
    ]
  },
  {
    id: "acme-cms",
    description: "Deterministic content management fixture.",
    bricks: [
      "approval-flow",
      "asset-library",
      "audit-reader",
      "content-editor",
      "entry-index",
      "locale-router",
      "media-policy",
      "navigation-tree",
      "publish-queue",
      "revision-store",
      "schema-registry",
      "silent-parser",
      "slug-service"
    ]
  }
];

const DUPLICATE_PAIR = [
  "acme-desktop.timeline-core",
  "acme-studio.timeline-core"
];

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, selftest: false, updateSnapshot: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--out" && next) {
      options.output = path.resolve(next);
      index += 1;
    } else if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--update-snapshot") {
      options.updateSnapshot = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Deterministic SMA fixture portfolio generator

Usage:
  node tools/evals/fixtures/gen.mjs [--out <directory>]
  node tools/evals/fixtures/gen.mjs --selftest
  node tools/evals/fixtures/gen.mjs --update-snapshot
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function seedHash(value) {
  return createHash("sha256").update(`${FIXED_SEED}:${value}`).digest("hex");
}

function titleCase(slug) {
  return slug
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function symbolName(slug) {
  const title = titleCase(slug).replace(/\s+/g, "");
  return `${title[0].toLowerCase()}${title.slice(1)}`;
}

function normalSource(projectId, slug) {
  const symbol = symbolName(slug);
  const token = seedHash(`${projectId}:${slug}`).slice(0, 12);

  return [
    `const fixtureToken = "${token}";`,
    "",
    `export function ${symbol}Record(input = {}) {`,
    `  return { fixtureToken, kind: "${slug}", enabled: input.enabled !== false };`,
    "}",
    "",
    `export function ${symbol}Summary(items = []) {`,
    "  return items.map((item, index) => ({ index, label: String(item.label || \"untitled\") }));",
    "}",
    ""
  ].join("\n");
}

function oversizedSource() {
  const lines = [
    "// Deterministic oversized fixture: intentionally repetitive for scanner evaluation.",
    "export const generatedCatalog = ["
  ];

  for (let index = 0; index < 1901; index += 1) {
    const code = seedHash(`oversized:${index}`).slice(0, 10);
    lines.push(`  { ordinal: ${index}, code: "${code}", active: true },`);
  }

  lines.push(
    "];",
    "",
    "export function catalogEntryAt(index) {",
    "  return generatedCatalog[index] || null;",
    "}",
    ""
  );

  return lines.join("\n");
}

function envGapSource() {
  return [
    "const fixtureToken = process.env.ACME_FIXTURE_TOKEN;",
    "",
    "export function readFixtureToken() {",
    "  return fixtureToken || \"fixture-token-unset\";",
    "}",
    ""
  ].join("\n");
}

function silentCatchSource() {
  return [
    "export function parseFixturePayload(value) {",
    "  try {",
    "    return JSON.parse(value);",
    "  } catch {}",
    "",
    "  return null;",
    "}",
    ""
  ].join("\n");
}

function duplicateSource(spaced) {
  const lines = ["export const timelineTransforms = ["];

  for (let index = 0; index < 124; index += 1) {
    const suffix = String(index).padStart(3, "0");
    lines.push(spaced
      ? `  function transform${suffix} (value) { return value + ${index}; },`
      : `function transform${suffix}(value){return value+${index};},`);
  }

  lines.push(
    "];",
    "export function applyTimelineTransform(index, value) {",
    "  return timelineTransforms[index](value);",
    "}",
    ""
  );

  return lines.join("\n");
}

function sourceFor(projectId, slug) {
  if (projectId === "acme-desktop" && slug === "oversized-catalog") {
    return oversizedSource();
  }

  if (projectId === "acme-desktop" && slug === "env-probe") {
    return envGapSource();
  }

  if (projectId === "acme-cms" && slug === "silent-parser") {
    return silentCatchSource();
  }

  if (slug === "timeline-core") {
    return duplicateSource(projectId === "acme-studio");
  }

  return normalSource(projectId, slug);
}

function gateScore() {
  return { status: "passing", score: 92, evidence: ["deterministic fixture generation"] };
}

function touchEvent(projectId, slug) {
  return {
    actor_kind: "automation",
    actor_id: "tools/evals/fixtures/gen.mjs",
    role: "implementer",
    timestamp: FIXED_TIMESTAMP,
    summary: `Generated public-safe ${projectId}.${slug} evaluation fixture.`
  };
}

function manifestFor(projectId, slug, sourceText) {
  const sourcePath = `src/modules/${slug}`;
  const lineCount = sourceText.split(/\r?\n/).length;
  const isEnvGap = projectId === "acme-desktop" && slug === "env-probe";
  const displayName = slug === "timeline-core"
    ? projectId === "acme-desktop" ? "Timeline Normalizer" : "Sequence Timeline Shaper"
    : titleCase(slug);
  const touch = touchEvent(projectId, slug);
  const sweetspot = Object.fromEntries([
    "ssa_v2", "ssi", "sstf", "spe", "srs", "ssra",
    "sas", "sva", "srls", "sev", "ssc", "sai"
  ].map((key) => [key, gateScore()]));

  return {
    schema_version: "1.0.0",
    brick: {
      id: `${projectId}.${slug}`,
      name: displayName,
      kind: "module",
      status: "project_bound",
      version: "1.0.0-fixture",
      language: ["JavaScript"],
      frameworks: ["Node.js"],
      domain: [projectId.replace("acme-", ""), "evaluation"]
    },
    hierarchy: {
      level: "module",
      contains: ["utility", "file"],
      component_policy: "internal_by_default",
      notes: "Public-safe deterministic evaluation fixture."
    },
    source: {
      project: projectId,
      archive_hash: seedHash(`${projectId}:${slug}:archive`),
      paths: [sourcePath]
    },
    owner: {
      primary: "fixture-evals",
      team: "SMA Evaluation"
    },
    boundaries: {
      owned_paths: [`${sourcePath}/**`],
      public_paths: [`${sourcePath}/index.mjs`],
      private_paths: [],
      forbidden_imports: [],
      allowed_side_effects: []
    },
    classification: {
      data_classes: ["public"],
      risk: "low",
      notes: "Contains synthetic fixture data only."
    },
    sweetspot,
    interfaces: {
      public_api: [`${sourcePath}/index.mjs`],
      adapters: [],
      forbidden_dependencies: [],
      required_dependencies: []
    },
    security: {
      rls: {
        required: false,
        status: "not_applicable",
        negative_tests: []
      },
      env: isEnvGap
        ? { required: true, status: "missing", variables: [] }
        : { required: false, status: "not_applicable", variables: [] },
      vulnerability_findings: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        report_paths: []
      }
    },
    supply_chain: {
      dependencies: [],
      licenses: ["MIT"],
      checksums: []
    },
    quality: {
      score: 92,
      line_count: {
        max_file_lines: lineCount,
        over_600_count: lineCount > 600 ? 1 : 0
      },
      code_budget: {
        status: lineCount > 600 ? "bloated" : "lean",
        feature_lines: lineCount,
        file_count: 1,
        dependency_count: 0,
        notes: lineCount > 600
          ? "Intentionally oversized evaluation fixture."
          : "Bounded synthetic module fixture."
      },
      test_commands: ["node --check src/modules/*/index.mjs"],
      verification: [{
        command: "node tools/evals/fixtures/gen.mjs --selftest",
        status: "pass",
        timestamp: FIXED_TIMESTAMP
      }]
    },
    clone: {
      readiness: "guided",
      adaptation_points: ["fixture project id"],
      install_steps: ["Copy the fixture module into an isolated evaluation workspace."],
      known_traps: ["Intentional findings must remain isolated from production sources."]
    },
    provenance: {
      created_by: touch,
      touched_by: [],
      reviewed_by: [],
      source_chain: [{
        project: projectId,
        brick_id: `${projectId}.${slug}`,
        event: "created",
        timestamp: FIXED_TIMESTAMP
      }]
    }
  };
}

function resolvePointer(rootSchema, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Unsupported schema reference: ${reference}`);
  }

  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current, part) => current?.[part], rootSchema);
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateAgainstSchema(value, schema, rootSchema, location = "$") {
  const errors = [];
  const resolved = schema.$ref ? resolvePointer(rootSchema, schema.$ref) : schema;

  if (!resolved) {
    return [`${location}: unresolved schema reference ${schema.$ref}`];
  }

  if (resolved.type && !matchesType(value, resolved.type)) {
    return [`${location}: expected ${resolved.type}`];
  }

  if (Object.hasOwn(resolved, "const") && value !== resolved.const) {
    errors.push(`${location}: expected constant ${JSON.stringify(resolved.const)}`);
  }

  if (resolved.enum && !resolved.enum.some((entry) => Object.is(entry, value))) {
    errors.push(`${location}: value is not in enum`);
  }

  if (typeof value === "string") {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      errors.push(`${location}: shorter than minLength ${resolved.minLength}`);
    }

    if (resolved.pattern && !(new RegExp(resolved.pattern).test(value))) {
      errors.push(`${location}: does not match ${resolved.pattern}`);
    }

    if (resolved.format === "date-time" && Number.isNaN(Date.parse(value))) {
      errors.push(`${location}: invalid date-time`);
    }

    if (resolved.format === "uri") {
      try {
        new URL(value);
      } catch {
        errors.push(`${location}: invalid URI`);
      }
    }
  }

  if (typeof value === "number") {
    if (resolved.minimum !== undefined && value < resolved.minimum) {
      errors.push(`${location}: below minimum ${resolved.minimum}`);
    }

    if (resolved.maximum !== undefined && value > resolved.maximum) {
      errors.push(`${location}: above maximum ${resolved.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (resolved.minItems !== undefined && value.length < resolved.minItems) {
      errors.push(`${location}: fewer than ${resolved.minItems} items`);
    }

    if (resolved.uniqueItems) {
      const keys = value.map((entry) => JSON.stringify(entry));
      if (new Set(keys).size !== keys.length) {
        errors.push(`${location}: items are not unique`);
      }
    }

    if (resolved.items) {
      value.forEach((entry, index) => {
        errors.push(...validateAgainstSchema(entry, resolved.items, rootSchema, `${location}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of resolved.required || []) {
      if (!Object.hasOwn(value, requiredKey)) {
        errors.push(`${location}: missing required property ${requiredKey}`);
      }
    }

    if (resolved.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(resolved.properties || {}, key)) {
          errors.push(`${location}: unexpected property ${key}`);
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(resolved.properties || {})) {
      if (Object.hasOwn(value, key)) {
        errors.push(...validateAgainstSchema(value[key], propertySchema, rootSchema, `${location}.${key}`));
      }
    }
  }

  return errors;
}

function assertManifestValid(manifestPath, manifest, schema) {
  const schemaErrors = validateAgainstSchema(manifest, schema, schema);
  assert.equal(schemaErrors.length, 0, `${manifestPath} failed JSON schema validation:\n${schemaErrors.join("\n")}`);

  const semanticReport = validateManifest(manifestPath, manifest);
  assert.equal(
    semanticReport.errors.length,
    0,
    `${manifestPath} failed SMA validation:\n${semanticReport.errors.map((entry) => `${entry.code}: ${entry.message}`).join("\n")}`
  );
}

async function writeProject(outputRoot, project, schema) {
  const projectRoot = path.join(outputRoot, project.id);
  await fs.mkdir(path.join(projectRoot, ".smarch"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), stableJson({
    name: project.id,
    version: "1.0.0-fixture",
    private: true,
    type: "module",
    description: project.description
  }));
  await fs.writeFile(path.join(projectRoot, ".smarch", "project.json"), stableJson({
    schema_version: "1.0.0",
    project: project.id,
    fixture_seed: FIXED_SEED,
    public_safe: true
  }));

  for (const slug of project.bricks) {
    const brickRoot = path.join(projectRoot, "src", "modules", slug);
    const sourceText = sourceFor(project.id, slug);
    const manifest = manifestFor(project.id, slug, sourceText);
    const manifestPath = path.join(brickRoot, "module.sweetspot.json");
    assertManifestValid(manifestPath, manifest, schema);
    await fs.mkdir(brickRoot, { recursive: true });
    await fs.writeFile(path.join(brickRoot, "index.mjs"), sourceText);
    await fs.writeFile(manifestPath, stableJson(manifest));
  }
}

async function generatePortfolio(outputRoot) {
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });

  for (const project of PROJECTS) {
    await writeProject(outputRoot, project, schema);
  }

  return outputRoot;
}

async function treeSnapshot(root) {
  const entries = [];

  async function walk(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const absolutePath = path.join(current, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");

      if (child.isDirectory()) {
        entries.push({ path: `${relativePath}/`, kind: "directory" });
        await walk(absolutePath);
      } else if (child.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        entries.push({
          path: relativePath,
          kind: "file",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex")
        });
      }
    }
  }

  await walk(root);
  return entries;
}

function snapshotBytes(snapshot) {
  return snapshot.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
}

function snapshotSummary(snapshot) {
  const files = snapshot.filter((entry) => entry.kind === "file");
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    root: SNAPSHOT_ROOT,
    digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    fileCount: files.length,
    totalBytes: snapshotBytes(files)
  };
}

async function readCommittedSnapshot() {
  const snapshot = JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8"));
  assert.equal(snapshot.schemaVersion, 1, "fixture snapshot schemaVersion must be 1");
  assert.equal(snapshot.algorithm, "sha256", "fixture snapshot algorithm must be sha256");
  assert.equal(snapshot.root, SNAPSHOT_ROOT, `fixture snapshot root must be ${SNAPSHOT_ROOT}`);
  return snapshot;
}

function assertSnapshotMatches(actual, expected, label) {
  assert.deepEqual(
    actual,
    expected,
    `${label} snapshot drift; inspect the fixture change, then run node tools/evals/fixtures/gen.mjs --update-snapshot`
  );
}

async function scanPortfolio(portfolioRoot, reportPath) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    SCANNER_PATH,
    "--root", portfolioRoot,
    "--out", reportPath,
    "--json"
  ], {
    cwd: REPO_ROOT,
    maxBuffer: 8 * 1024 * 1024
  });

  assert.equal(stderr.trim(), "", `scanner wrote to stderr:\n${stderr}`);
  JSON.parse(stdout);
  return JSON.parse(await fs.readFile(reportPath, "utf8"));
}

function assertPlantedFindings(report) {
  assert.equal(report.bricks.length, 40, "expected exactly 40 fixture bricks");
  assert.equal(report.validation_error_count, 0, "all fixture manifests must pass scanner validation");
  assert.equal(report.refactor_report.oversized_file_count, 1, "expected one oversized file");
  assert.equal(report.refactor_report.severity_counts.critical, 1, "oversized file must be critical");
  assert.equal(report.scanner_report.env_contract_report.bricks_with_undeclared_refs, 1, "expected one env contract gap");
  assert.equal(report.scanner_report.env_contract_report.undeclared_reference_count, 1, "expected one undeclared env reference");
  assert.equal(report.scanner_report.code_quality_report.by_type.empty_catch, 1, "expected one silent catch");
  assert.equal(report.scanner_report.duplicate_clusters.length, 1, "expected one cross-project duplicate cluster");

  const [cluster] = report.scanner_report.duplicate_clusters;
  assert.equal(cluster.count, 2, "duplicate cluster must contain one pair");
  assert.deepEqual(cluster.projects, ["acme-desktop", "acme-studio"]);
  assert.deepEqual(cluster.bricks.map((brick) => brick.id).sort(), [...DUPLICATE_PAIR].sort());
}

async function selftest() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smarch-fixtures-selftest-"));
  const firstRoot = path.join(tempRoot, "first");
  const secondRoot = path.join(tempRoot, "second");

  try {
    await generatePortfolio(firstRoot);
    await generatePortfolio(secondRoot);

    const firstSnapshot = await treeSnapshot(firstRoot);
    const secondSnapshot = await treeSnapshot(secondRoot);
    assert.deepEqual(secondSnapshot, firstSnapshot, "two generated trees must be byte-identical");

    const expectedSnapshot = await readCommittedSnapshot();
    const committedSnapshot = await treeSnapshot(DEFAULT_OUTPUT);
    assertSnapshotMatches(snapshotSummary(committedSnapshot), expectedSnapshot, "committed fixture portfolio");
    assertSnapshotMatches(snapshotSummary(firstSnapshot), expectedSnapshot, "regenerated fixture portfolio");

    const totalBytes = snapshotBytes(firstSnapshot);
    assert(totalBytes < MAX_PORTFOLIO_BYTES, `portfolio is ${totalBytes} bytes; limit is ${MAX_PORTFOLIO_BYTES}`);

    const report = await scanPortfolio(firstRoot, path.join(tempRoot, "scanner-report.json"));
    assertPlantedFindings(report);

    const driftTarget = firstSnapshot.find((entry) => entry.kind === "file")?.path;
    assert(driftTarget, "fixture snapshot selftest requires at least one file");
    await fs.appendFile(path.join(firstRoot, driftTarget), "\nfixture drift selftest\n");
    const driftedSnapshot = snapshotSummary(await treeSnapshot(firstRoot));
    assert.throws(
      () => assertSnapshotMatches(driftedSnapshot, expectedSnapshot, "mutated fixture portfolio"),
      /snapshot drift/,
      "mutating a fixture must fail the committed snapshot gate"
    );

    console.log(JSON.stringify({
      ok: true,
      seed: FIXED_SEED,
      project_count: PROJECTS.length,
      brick_count: report.bricks.length,
      total_bytes: totalBytes,
      snapshot_digest: expectedSnapshot.digest,
      drift_negative_test: "passed",
      planted_findings: {
        oversized_files: 1,
        env_contract_gaps: 1,
        silent_catches: 1,
        duplicate_pairs: 1
      }
    }, null, 2));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.selftest && options.updateSnapshot) {
    throw new Error("--selftest and --update-snapshot are mutually exclusive");
  }

  if (options.updateSnapshot) {
    if (options.output !== DEFAULT_OUTPUT) {
      throw new Error("--update-snapshot only supports the committed fixture portfolio");
    }
    const summary = snapshotSummary(await treeSnapshot(DEFAULT_OUTPUT));
    await fs.writeFile(SNAPSHOT_PATH, stableJson(summary));
    console.log(JSON.stringify({ ok: true, snapshot: SNAPSHOT_PATH, ...summary }, null, 2));
    return;
  }

  if (options.selftest) {
    await selftest();
    return;
  }

  await generatePortfolio(options.output);
  const snapshot = await treeSnapshot(options.output);
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    seed: FIXED_SEED,
    project_count: PROJECTS.length,
    brick_count: PROJECTS.reduce((sum, project) => sum + project.bricks.length, 0),
    total_bytes: snapshotBytes(snapshot)
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: "fixture_generation_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
});
