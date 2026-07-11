#!/usr/bin/env node
/**
 * WHAT: Resolves and copies one brick or curated build into a target project with provenance and follow-up instructions.
 * WHY: Reuse must preserve source identity, export policy, adaptation steps, and receipts instead of becoming an untraceable file copy.
 * HOW: Reads registries or a build manifest, previews by default, writes only with `--write`, and is called by operators and clone smoke tests.
 * Usage: `node tools/sma-clone.ts --search workos --list`
 */
/**
 * sma-clone: copy a canonical/candidate brick or a first-class build into a
 * target project and stamp its provenance into the target's legacy
 * .sweetspot/imports.json and initial SMARCH control-plane artifacts under
 * .smarch/.
 *
 *   node tools/sma-clone.ts --brick <id> --target /path/to/project
 *   node tools/sma-clone.ts --build <id> --target /path/to/project
 *   node tools/sma-clone.ts --build-manifest examples/build.sweetspot.json --target /path/to/project
 *   node tools/sma-clone.ts --brick <id> --target /path/to/project --write
 *   node tools/sma-clone.ts --search workos --list
 *
 * Defaults to dry-run. Use --write to actually copy files. Always leaves a
 * post-clone checklist (the brick's `clone_steps` + integration_recipe) in
 * stdout and a markdown file at target/.sweetspot/clones/<brick-slug>.md.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertExportAllowed, ExportBlockedError } from "./lib/export-guard.ts";
import { verifyCommercialEntitlement } from "./lib/commercial-entitlement.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectsRoot = path.resolve(repoRoot, "..", "Projects");
const ignoredCopyDirs = new Set(["node_modules", "dist", "build", ".next", ".turbo"]);

function parseArgs(argv): Record<string, any> {
  const o = {
    registry: path.resolve(repoRoot, "scans/all-projects/latest.registry.json"),
    brick: "",
    build: "",
    buildManifest: "",
    target: "",
    search: "",
    docDir: "docs/bricks",
    write: false,
    list: false,
    force: false,
    allowClosed: false,
    entitlement: process.env.SMA_ENTITLEMENT_FILE || "",
    licensee: process.env.SMA_LICENSEE || "",
    entitlementTrustedKeys: process.env.SMA_ENTITLEMENT_TRUSTED_KEYS || "",
    registryOrigin: process.env.SMA_REGISTRY_ORIGIN || ""
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--registry" && n) { o.registry = path.resolve(n); i += 1; }
    else if (a === "--brick" && n) { o.brick = n; i += 1; }
    else if (a === "--build" && n) { o.build = n; i += 1; }
    else if (a === "--build-manifest" && n) { o.buildManifest = path.resolve(n); i += 1; }
    else if (a === "--target" && n) { o.target = path.resolve(n); i += 1; }
    else if (a === "--search" && n) { o.search = n.toLowerCase(); i += 1; }
    else if (a === "--doc-dir" && n) { o.docDir = n; i += 1; }
    else if (a === "--registry-origin" && n) { o.registryOrigin = n; i += 1; }
    else if (a === "--entitlement" && n) { o.entitlement = path.resolve(n); i += 1; }
    else if (a === "--licensee" && n) { o.licensee = n; i += 1; }
    else if (a === "--entitlement-trusted-keys" && n) { o.entitlementTrustedKeys = path.resolve(n); i += 1; }
    else if (a === "--write") o.write = true;
    else if (a === "--list") o.list = true;
    else if (a === "--force") o.force = true;
    else if (a === "--allow-closed") o.allowClosed = true;
  }
  return o;
}

// Refuse to copy closed/private source unless explicitly, auditably acknowledged.
function guardCloneWrite(opts, brickIds, project) {
  try {
    assertExportAllowed({
      operation: "clone",
      brickIds,
      project,
      targetVisibility: "community", // a clone copies raw source out — treat conservatively
      allowClosed: opts.allowClosed,
    });
  } catch (err) {
    if (err instanceof ExportBlockedError) {
      console.error(err.message);
      process.exit(3);
    }
    throw err;
  }
}

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }
async function maybeReadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }

async function copyDir(src, dst) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (ignoredCopyDirs.has(e.name)) continue;
      await copyDir(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function pathExists(p) { try { await fs.access(p); return true; } catch { return false; } }

function normalizeRelativePath(p) {
  return String(p || "").split(path.sep).join("/").replace(/^\.\//, "");
}

function relFrom(root, absolutePath) {
  return normalizeRelativePath(path.relative(root, absolutePath));
}

function toStringArray(value): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => toStringArray(item));
  const stringValue = typeof value === "string" ? value.trim() : String(value).trim();
  return stringValue ? [stringValue] : [];
}

function uniqStrings(values): string[] {
  return [...new Set<string>(values.flatMap((value) => toStringArray(value)).map((value) => value.trim()).filter(Boolean))];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function semverOrFallback(value, fallback = "0.0.0") {
  const candidate = String(value || "").trim();
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate)
    ? candidate
    : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(p) {
  return sha256(await fs.readFile(p));
}

async function sha256PathIfExists(p) {
  return (await pathExists(p)) ? sha256File(p) : null;
}

async function sha256JsonFile(p) {
  return sha256(await fs.readFile(p));
}

async function findBrickById(registry, id) {
  if (registry.bricks.find((b) => b.id === id)) return registry.bricks.find((b) => b.id === id);
  const prefix = registry.bricks.find((b) => b.id.startsWith(id));
  return prefix || null;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function score(text, term) { return text.toLowerCase().includes(term) ? 1 : 0; }

async function searchBricks(registry, term) {
  const hits = [];
  for (const b of registry.bricks) {
    const mf = await maybeReadJson(b.manifest_path);
    const sem = mf?.semantics || {};
    const hay = `${b.id} ${b.name} ${b.project} ${sem.purpose || ""} ${(sem.tags || []).join(" ")} ${(b.source_paths || []).join(" ")}`;
    if (score(hay, term)) {
      hits.push({
        id: b.id, name: b.name, project: b.project, status: b.status,
        kind: b.kind, paths: b.source_paths,
        purpose: sem.purpose, tags: sem.tags
      });
    }
  }
  return hits.sort((a, b) => {
    const rank = { canonical: 3, candidate: 2, project_bound: 1 };
    return (rank[b.status] || 0) - (rank[a.status] || 0);
  });
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function inferSourceProjectRoot(manifestPath, sourcePaths, fallbackProjectId) {
  const manifestDir = path.dirname(manifestPath);
  const normalizedSources = uniqStrings(sourcePaths).map((sourcePath) => normalizeRelativePath(sourcePath)).sort((a, b) => b.length - a.length);
  let current = manifestDir;

  while (true) {
    for (const rel of normalizedSources) {
      if (await pathExists(path.resolve(current, rel))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(projectsRoot, fallbackProjectId || "");
}

const cachedProjectSearchRoots = [];
let projectSearchRootsLoaded = false;

async function listProjectSearchRoots() {
  if (projectSearchRootsLoaded) return cachedProjectSearchRoots;
  projectSearchRootsLoaded = true;
  const roots = new Set([projectsRoot]);
  try {
    const levelOne = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const entry of levelOne) {
      if (!entry.isDirectory()) continue;
      if (ignoredCopyDirs.has(entry.name)) continue;
      const levelOnePath = path.join(projectsRoot, entry.name);
      roots.add(levelOnePath);
      try {
        const levelTwo = await fs.readdir(levelOnePath, { withFileTypes: true });
        for (const nested of levelTwo) {
          if (!nested.isDirectory()) continue;
          if (ignoredCopyDirs.has(nested.name)) continue;
          roots.add(path.join(levelOnePath, nested.name));
        }
      } catch {
        // ignore unreadable nested roots
      }
    }
  } catch {
    // ignore unreadable project roots
  }
  cachedProjectSearchRoots.push(...roots);
  return cachedProjectSearchRoots;
}

async function resolveSourcePath(relativePath, preferredRoots = []) {
  const normalized = normalizeRelativePath(relativePath);
  const roots = [...new Set([
    ...preferredRoots.filter(Boolean).map((root) => path.resolve(root)),
    ...(await listProjectSearchRoots())
  ])];
  for (const root of roots) {
    const absolutePath = path.resolve(root, normalized);
    if (await pathExists(absolutePath)) return { root, absolutePath };
  }
  return null;
}

async function findBuildManifestCandidates(dir) {
  if (!(await pathExists(dir))) return [];
  const matches = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredCopyDirs.has(entry.name) || entry.name === ".git") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      matches.push(absolutePath);
    }
  }
  await walk(dir);
  return matches;
}

async function resolveBuildManifestPath(opts, registry) {
  if (opts.buildManifest) {
    if (!(await pathExists(opts.buildManifest))) {
      throw new Error(`build manifest not found at ${opts.buildManifest}`);
    }
    return opts.buildManifest;
  }

  if (!opts.build) return "";

  if (await pathExists(opts.build)) return path.resolve(opts.build);

  const searchDirs = [
    path.resolve(repoRoot, "builds"),
    path.resolve(repoRoot, "manifests"),
    path.resolve(repoRoot, "examples")
  ];

  const candidates = [];
  for (const dir of searchDirs) candidates.push(...await findBuildManifestCandidates(dir));

  for (const candidate of candidates) {
    try {
      const manifest = await readJson(candidate);
      if (manifest?.build?.id === opts.build) return candidate;
    } catch {
      // ignore non-build JSON candidates
    }
  }

  const scannerBuild = (registry.scanner_report?.build_report?.top_candidates || []).find((entry) => entry.candidate_key === opts.build);
  if (scannerBuild) {
    throw new Error(`build "${opts.build}" exists as a scanner candidate but has no installable build manifest. Pass --build-manifest <path>.`);
  }

  throw new Error(`no build manifest matched "${opts.build}"`);
}

async function collectPathEntries(src, dst, sourceBaseRoot, targetBaseRoot, contentKind) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(src, { withFileTypes: true });
    const collected = [];
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredCopyDirs.has(entry.name)) continue;
      const nested = await collectPathEntries(
        path.join(src, entry.name),
        path.join(dst, entry.name),
        sourceBaseRoot,
        targetBaseRoot,
        contentKind
      );
      collected.push(...nested);
    }
    return collected;
  }

  if (!stat.isFile()) return [];

  return [{
    src,
    dst,
    source_path: relFrom(sourceBaseRoot, src),
    target_path: relFrom(targetBaseRoot, dst),
    content_kind: contentKind
  }];
}

function extractEnvVariableNames(envContract) {
  if (!envContract || typeof envContract !== "object") return [];
  const normalizeEnvItemName = (item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && item.name) return item.name;
    return "";
  };
  const variableNames = [];
  if (Array.isArray(envContract.variables)) {
    for (const variable of envContract.variables) {
      if (typeof variable === "string") variableNames.push(variable);
      else if (variable && typeof variable === "object" && variable.name) variableNames.push(variable.name);
    }
  }
  if (Array.isArray(envContract.required)) variableNames.push(...envContract.required.map(normalizeEnvItemName));
  if (Array.isArray(envContract.optional)) variableNames.push(...envContract.optional.map(normalizeEnvItemName));
  return uniqStrings(variableNames);
}

function extractRlsTableNames(rlsContract) {
  if (!rlsContract || typeof rlsContract !== "object") return [];
  const tableNames = [];
  if (Array.isArray(rlsContract.tables)) tableNames.push(...rlsContract.tables);
  if (Array.isArray(rlsContract.negative_tests)) {
    for (const testCase of rlsContract.negative_tests) {
      if (typeof testCase === "string") continue;
      if (testCase && typeof testCase === "object" && testCase.table) tableNames.push(testCase.table);
    }
  }
  return uniqStrings(tableNames);
}

function deriveTestCommands(brick, manifest) {
  return uniqStrings([
    ...(brick.test_commands || []),
    ...(manifest.tests?.commands || []),
    ...(manifest.verification?.commands || []),
    ...(manifest.clone?.verification_commands || [])
  ]);
}

function deriveImportStatus(plan, placementCount) {
  const missingCount = plan.actions.filter((action) => action.kind === "skip_missing").length;
  const blockedCount = plan.actions.filter((action) => action.kind === "skip_exists").length;
  if (missingCount > 0 && placementCount === 0) return "blocked";
  if (missingCount > 0 || blockedCount > 0) return "partial";
  return "installed";
}

function mapBrickStatusToTrustTier(status) {
  if (status === "canonical") return "canonical";
  if (status === "candidate") return "candidate";
  if (status === "verified") return "verified";
  return "experimental";
}

function mapBrickStatusToVerificationStatus(status) {
  if (status === "canonical") return "canonical";
  if (status === "candidate") return "candidate";
  return "unverified";
}

function mapBuildTrustTier(build) {
  const trustTier = String(build?.trust_tier || "").toLowerCase();
  if (["experimental", "candidate", "verified", "canonical"].includes(trustTier)) return trustTier;
  if (trustTier === "reviewed") return "candidate";

  const status = String(build?.status || "").toLowerCase();
  if (status === "canonical") return "canonical";
  if (status === "verified") return "verified";
  if (status === "candidate") return "candidate";
  return "experimental";
}

function mapBuildVerificationStatus(build, verification) {
  const explicit = String(firstDefined(verification?.status, build?.status, "")).toLowerCase();
  if (explicit === "canonical") return "canonical";
  if (explicit === "verified" || explicit === "passing") return "verified";
  if (explicit === "candidate" || explicit === "partial" || explicit === "guided") return "candidate";
  if (explicit === "failed" || explicit === "unsafe") return "failed";
  return "unverified";
}

function deriveBuildTestCommands(manifest) {
  return uniqStrings([
    ...(manifest?.verification?.smoke_commands || []),
    ...(manifest?.interfaces?.commands || []),
    ...(manifest?.clone?.verification_commands || []),
    ...(manifest?.clone?.post_clone_checks || [])
  ]);
}

function createImportId(brickId, timestamp) {
  const stamp = timestamp.replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `smarch_${slugify(brickId)}_${stamp}_${suffix}`;
}

function toJsonObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function mapContentKindToPlacementKind(contentKind) {
  if (contentKind === "portable_doc") return "doc";
  return "file";
}

function inferSymbolKind(symbol) {
  const value = String(symbol || "");
  if (!value) return "other";
  if (value.startsWith("use") && value[3] && value[3] === value[3].toUpperCase()) return "hook";
  if (/^[A-Z]/.test(value)) return "component";
  if (/[()]/.test(value)) return "function";
  return "other";
}

function mapPublicApiToSymbols(publicApi) {
  return uniqStrings(publicApi).map((symbol) => ({
    name: symbol,
    kind: inferSymbolKind(symbol)
  }));
}

function envScopeToSurface(scope) {
  const value = String(scope || "").toLowerCase();
  if (value.includes("client") || value.includes("public")) return "client";
  if (value.includes("edge")) return "edge";
  if (value.includes("worker")) return "worker";
  if (value.includes("shared")) return "shared";
  return "server";
}

function buildEnvBindingRecords(envContract) {
  const records = [];
  if (!envContract || typeof envContract !== "object") return records;

  const toEnvName = (value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && value.name) return value.name;
    return "";
  };
  const requiredNames = new Set(uniqStrings((Array.isArray(envContract.required) ? envContract.required : []).map(toEnvName)));
  if (Array.isArray(envContract.variables)) {
    for (const variable of envContract.variables) {
      if (typeof variable === "string") {
        records.push({
          name: variable,
          surface: "server",
          required: requiredNames.has(variable)
        });
        continue;
      }
      if (!variable || typeof variable !== "object" || !variable.name) continue;
      records.push({
        name: variable.name,
        surface: envScopeToSurface(variable.scope),
        required: requiredNames.has(variable.name) || (Array.isArray(variable.required_in) && variable.required_in.length > 0),
        bound_to: variable.example || undefined
      });
    }
  }

  if (Array.isArray(envContract.required)) {
    for (const variable of envContract.required) {
      if (!variable || typeof variable !== "object" || !variable.name) continue;
      records.push({
        name: variable.name,
        surface: envScopeToSurface(variable.scope),
        required: true,
        bound_to: variable.example || undefined
      });
    }
  }

  if (Array.isArray(envContract.optional)) {
    for (const variable of envContract.optional) {
      if (!variable || typeof variable !== "object" || !variable.name) continue;
      records.push({
        name: variable.name,
        surface: envScopeToSurface(variable.scope),
        required: false,
        bound_to: variable.example || undefined
      });
    }
  }

  for (const name of requiredNames) {
    if (!records.find((record) => record.name === name)) {
      records.push({ name, surface: "server", required: true });
    }
  }

  return records;
}

function buildAdapterPointRecords(adaptationPoints) {
  return uniqStrings(adaptationPoints).map((point) => ({
    id: slugify(point),
    kind: "other",
    required: true,
    status: "pending"
  }));
}

function mapArtifactStatusToChannel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "canonical" || value === "stable") return "stable";
  if (value === "candidate") return "candidate";
  if (value === "beta") return "beta";
  if (value === "alpha") return "alpha";
  return "dev";
}

function createBuildChildImportId(buildImportId, brickId) {
  return `${buildImportId}:brick:${sha256(brickId).slice(0, 10)}`;
}

function mapCloneOwnershipMode(ownership) {
  const value = String(ownership || "").toLowerCase();
  if (value === "adapter" || value === "adapted") return "adapted";
  if (value === "fork" || value === "forked") return "forked";
  if (value === "local") return "local";
  return "managed";
}

function resolveTargetPathFromFileMap(fileMapEntries, sourcePath) {
  const normalizedSourcePath = normalizeRelativePath(sourcePath);
  const normalizedEntries = Array.isArray(fileMapEntries)
    ? fileMapEntries
      .filter((entry) => isObject(entry) && entry.source_path && entry.target_path)
      .map((entry) => ({
        source_path: normalizeRelativePath(entry.source_path),
        target_path: normalizeRelativePath(entry.target_path),
        ownership: entry.ownership,
        notes: entry.notes || ""
      }))
      .sort((a, b) => b.source_path.length - a.source_path.length)
    : [];
  for (const entry of normalizedEntries) {
    if (normalizedSourcePath === entry.source_path) {
      return { target_path: entry.target_path, ownership: entry.ownership, notes: entry.notes };
    }
    if (normalizedSourcePath.startsWith(`${entry.source_path}/`)) {
      const suffix = normalizedSourcePath.slice(entry.source_path.length + 1);
      return {
        target_path: normalizeRelativePath(path.posix.join(entry.target_path, suffix)),
        ownership: entry.ownership,
        notes: entry.notes
      };
    }
  }
  return {
    target_path: normalizedSourcePath,
    ownership: "managed",
    notes: ""
  };
}

function normalizeBuildBrickRefs(manifest) {
  const entries = [
    ...(manifest?.composition?.brick_refs || []),
    ...(manifest?.source?.derived_from_bricks || [])
  ];
  const seen = new Set();
  return entries
    .filter((entry) => isObject(entry) && entry.brick_id)
    .sort((a, b) => (a.order || 9999) - (b.order || 9999))
    .filter((entry) => {
      if (seen.has(entry.brick_id)) return false;
      seen.add(entry.brick_id);
      return true;
    });
}

function aggregateEnvContractFromRecords(records) {
  const required = [];
  const optional = [];
  for (const record of records) {
    if (!record || !record.name) continue;
    const target = record.required ? required : optional;
    target.push(record.name);
  }
  const contract: Record<string, any> = {};
  if (required.length) contract.required = uniqStrings(required);
  if (optional.length) contract.optional = uniqStrings(optional);
  return contract;
}

function aggregateRlsContractFromTables(tableNames) {
  const contract: Record<string, any> = {};
  const tables = uniqStrings(tableNames);
  if (tables.length) contract.tables = tables;
  return contract;
}

function deriveImportStatusForImport(actions, placementCount, importId) {
  const relevantActions = actions.filter((action) => action.import_id === importId);
  const missingCount = relevantActions.filter((action) => action.kind === "skip_missing").length;
  const blockedCount = relevantActions.filter((action) => action.kind === "skip_exists").length;
  if (missingCount > 0 && placementCount === 0) return "blocked";
  if (missingCount > 0 || blockedCount > 0) return "partial";
  return "installed";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registry = await readJson(opts.registry);

  if (opts.search) {
    const hits = await searchBricks(registry, opts.search);
    console.log(JSON.stringify({
      query: opts.search,
      results: hits.slice(0, 20).map((h) => ({
        id: h.id, name: h.name, project: h.project,
        status: h.status, kind: h.kind,
        purpose: h.purpose ? h.purpose.slice(0, 160) : null
      }))
    }, null, 2));
    return;
  }

  if (opts.list || (!opts.brick && !opts.build && !opts.buildManifest)) {
    const canonical = registry.bricks.filter((b) => b.status === "canonical");
    console.log(JSON.stringify({
      canonical: canonical.map((b) => ({ id: b.id, name: b.name, project: b.project, paths: b.source_paths })),
      total_canonical: canonical.length
    }, null, 2));
    return;
  }

  if (!opts.target) {
    console.error("error: --target /path/to/project is required (unless --list / --search)");
    process.exit(2);
  }

  if (opts.brick && (opts.build || opts.buildManifest)) {
    console.error("error: choose either --brick or --build/--build-manifest, not both");
    process.exit(2);
  }

  if (opts.build || opts.buildManifest) {
    const buildManifestPath = await resolveBuildManifestPath(opts, registry);
    const buildManifest = await readJson(buildManifestPath);
    const buildMeta = toJsonObject(buildManifest.build, {});
    const buildId = String(buildMeta.id || opts.build || "").trim();
    if (!buildId) {
      console.error(`error: build manifest at ${buildManifestPath} is missing build.id`);
      process.exit(2);
    }
    if (opts.build && !(await pathExists(opts.build)) && buildMeta.id && opts.build !== buildMeta.id) {
      console.error(`error: --build "${opts.build}" does not match build manifest id "${buildMeta.id}"`);
      process.exit(2);
    }

    const registrySha = await sha256JsonFile(opts.registry);
    const now = new Date().toISOString();
    const slug = slugify(buildId);
    const buildImportId = createImportId(buildId, now);
    const buildName = buildMeta.name || buildId;
    const buildStatus = buildMeta.status || "candidate";
    const buildVersion = semverOrFallback(firstDefined(buildMeta.version, buildManifest.version), "0.1.0");
    const buildCloneReadiness = firstDefined(buildManifest.clone?.readiness, "unknown");
    const buildCloneSteps = uniqStrings(buildManifest.clone?.install_steps || []);
    const buildInstallSteps = uniqStrings([
      ...(buildManifest.clone?.install_steps || []),
      ...(buildManifest.verification?.smoke_commands || []),
      ...(buildManifest.runtime?.commands || [])
    ]);
    const buildIntegrationRecipe = uniqStrings(buildManifest.clone?.post_clone_checks || []);
    const buildAdaptationPoints = uniqStrings([
      ...(buildManifest.clone?.required_ports || []),
      ...((buildManifest.clone?.file_map || [])
        .filter((entry) => isObject(entry) && String(entry.ownership || "").toLowerCase() === "adapter")
        .map((entry) => entry.target_path || entry.source_path))
    ]);
    const buildKnownTraps = uniqStrings(buildManifest.clone?.rollback_steps || []);
    const buildPublicApi = uniqStrings([
      ...(buildManifest.runtime?.commands || []),
      ...(buildManifest.runtime?.endpoints || []),
      ...(buildManifest.runtime?.routes || [])
    ]);
    const buildTags = uniqStrings([
      ...(buildMeta.domain || []),
      ...(buildManifest.composition?.shared_contracts || []),
      buildMeta.kind || ""
    ]);
    const buildRisks = uniqStrings([
      buildManifest.classification?.risk ? `Risk level: ${buildManifest.classification.risk}` : "",
      buildManifest.classification?.notes || ""
    ]);

    const buildBrickRefs = normalizeBuildBrickRefs(buildManifest);
    const requiredBuildBrickRefs = buildBrickRefs.filter((entry) => entry.required !== false);
    const resolvedBricks = [];
    for (const ref of requiredBuildBrickRefs) {
      const resolvedBrick = await findBrickById(registry, ref.brick_id);
      if (!resolvedBrick) {
        console.error(`error: build "${buildId}" requires brick "${ref.brick_id}" but it was not found in the registry`);
        process.exit(2);
      }
      const resolvedManifest = await readJson(resolvedBrick.manifest_path);
      verifyCommercialEntitlement({ manifest: resolvedManifest, brickId: resolvedBrick.id, licensee: opts.licensee, entitlementFile: opts.entitlement, trustedKeysFile: opts.entitlementTrustedKeys });
      const resolvedSemantics = resolvedManifest.semantics || {};
      const sourceProjectRoot = await inferSourceProjectRoot(
        resolvedBrick.manifest_path,
        resolvedBrick.source_paths || [],
        resolvedBrick.project || ref.project || ""
      );
      const envContract = toJsonObject(firstDefined(resolvedManifest.security?.env, resolvedBrick.env_contract), {});
      const rlsContract = toJsonObject(firstDefined(resolvedManifest.security?.rls, resolvedBrick.rls_contract), {});
      const publicApi = uniqStrings([
        ...(resolvedSemantics.public_api || []),
        ...(resolvedBrick.public_api || []),
        ...(resolvedManifest.public_api || [])
      ]);
      const adaptationPoints = uniqStrings([
        ...(resolvedBrick.clone_adaptation_points || []),
        ...(resolvedManifest.clone?.adaptation_points || []),
        ref.role ? `Role: ${ref.role}` : ""
      ]);
      resolvedBricks.push({
        ref,
        import_id: createBuildChildImportId(buildImportId, resolvedBrick.id),
        brick: resolvedBrick,
        manifest: resolvedManifest,
        sem: resolvedSemantics,
        sourceProjectRoot,
        version: semverOrFallback(firstDefined(resolvedBrick.version, resolvedManifest.brick?.version, resolvedManifest.build?.version), "0.0.0"),
        cloneReadiness: firstDefined(resolvedBrick.clone_readiness, resolvedManifest.clone?.readiness, "unknown"),
        cloneSteps: uniqStrings(resolvedSemantics.clone_steps || []),
        installSteps: uniqStrings([...(resolvedBrick.clone_install_steps || []), ...(resolvedManifest.clone?.install_steps || [])]),
        integrationRecipe: uniqStrings(resolvedSemantics.integration_recipe || []),
        adaptationPoints,
        knownTraps: uniqStrings([...(resolvedBrick.clone_known_traps || []), ...(resolvedManifest.clone?.known_traps || [])]),
        publicApi,
        testCommands: deriveTestCommands(resolvedBrick, resolvedManifest),
        risks: uniqStrings(resolvedSemantics.risks || []),
        tags: uniqStrings(resolvedSemantics.tags || []),
        envContract,
        rlsContract,
        envBindings: extractEnvVariableNames(envContract),
        rlsTables: extractRlsTableNames(rlsContract),
        envBindingRecords: buildEnvBindingRecords(envContract),
        adapterPointRecords: buildAdapterPointRecords(adaptationPoints),
        exportedSymbols: mapPublicApiToSymbols(publicApi)
      });
    }

    const declaredSourcePaths = uniqStrings((buildManifest.source?.paths || []).map((value) => normalizeRelativePath(value)));
    const buildSourcePaths = declaredSourcePaths.length
      ? declaredSourcePaths
      : uniqStrings(resolvedBricks.flatMap((entry) => (entry.brick.source_paths || []).map((value) => normalizeRelativePath(value))));

    if (buildSourcePaths.length === 0) {
      console.error(`error: build "${buildId}" does not declare any source.paths and no brick source paths were resolved`);
      process.exit(2);
    }

    const preferredRoots = uniqStrings(resolvedBricks.map((entry) => entry.sourceProjectRoot));
    const buildEnvContractDeclared = toJsonObject(firstDefined(buildManifest.contracts?.env, buildManifest.security?.env), {});
    const buildRlsContractDeclared = toJsonObject(firstDefined(buildManifest.contracts?.rls, buildManifest.security?.rls), {});
    const buildEnvBindingRecordsList = buildEnvBindingRecords(
      Object.keys(buildEnvContractDeclared).length
        ? buildEnvContractDeclared
        : aggregateEnvContractFromRecords(resolvedBricks.flatMap((entry) => entry.envBindingRecords))
    );
    const buildEnvContract = Object.keys(buildEnvContractDeclared).length
      ? buildEnvContractDeclared
      : aggregateEnvContractFromRecords(buildEnvBindingRecordsList);
    const buildRlsContract = Object.keys(buildRlsContractDeclared).length
      ? buildRlsContractDeclared
      : aggregateRlsContractFromTables(resolvedBricks.flatMap((entry) => entry.rlsTables));
    const buildEnvBindings = extractEnvVariableNames(buildEnvContract);
    const buildRlsTables = extractRlsTableNames(buildRlsContract);
    const buildAdapterPointRecordsList = buildAdapterPointRecords(buildAdaptationPoints);
    const buildTestCommands = uniqStrings([
      ...(buildManifest.verification?.smoke_commands || []),
      ...(buildManifest.runtime?.commands || []),
      ...resolvedBricks.flatMap((entry) => entry.testCommands)
    ]);

    const buildActionOwnerForPath = (relativePath) => {
      const normalizedPath = normalizeRelativePath(relativePath);
      const candidates = resolvedBricks
        .map((entry) => {
          const sourceHints = uniqStrings([entry.ref.path || "", ...(entry.brick.source_paths || [])])
            .map((value) => normalizeRelativePath(value))
            .sort((a, b) => b.length - a.length);
          const matchedSource = sourceHints.find((sourceHint) => normalizedPath === sourceHint || normalizedPath.startsWith(`${sourceHint}/`));
          return matchedSource ? { entry, matchedSource } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.matchedSource.length - a.matchedSource.length);
      return candidates[0]?.entry || null;
    };

    const plan: Record<string, any> = {
      artifact_type: "build",
      build: buildId,
      name: buildName,
      from_project: buildManifest.source?.project || null,
      status: buildStatus,
      manifest_path: relFrom(repoRoot, buildManifestPath),
      resolved_bricks: resolvedBricks.map((entry) => ({
        brick_id: entry.brick.id,
        name: entry.brick.name,
        project: entry.brick.project,
        role: entry.ref.role || null,
        required: entry.ref.required !== false,
        import_id: entry.import_id
      })),
      actions: []
    };

    for (const relativePath of buildSourcePaths) {
      const owner = buildActionOwnerForPath(relativePath);
      const targetMapping = resolveTargetPathFromFileMap(buildManifest.clone?.file_map || [], relativePath);
      const resolvedSource = await resolveSourcePath(relativePath, owner ? [owner.sourceProjectRoot, ...preferredRoots] : preferredRoots);
      const actionBase = {
        import_id: owner?.import_id || buildImportId,
        artifact_type: owner ? "brick" : "build",
        artifact_id: owner?.brick.id || buildId,
        source_base_root: resolvedSource?.root || (owner?.sourceProjectRoot || projectsRoot),
        ownership_mode: mapCloneOwnershipMode(targetMapping.ownership),
        ownership_note: targetMapping.notes || "",
        exported_symbols: owner?.exportedSymbols || [],
          env_binding_records: owner?.envBindingRecords || buildEnvBindingRecordsList,
          adapter_point_records: owner?.adapterPointRecords || buildAdapterPointRecordsList
      };
      const dst = path.resolve(opts.target, targetMapping.target_path);
      if (!resolvedSource) {
        plan.actions.push({
          ...actionBase,
          kind: "skip_missing",
          src: path.resolve(actionBase.source_base_root, relativePath),
          dst,
          reason: "source path does not exist in any resolved project root"
        });
        continue;
      }
      const stat = await fs.stat(resolvedSource.absolutePath);
      if (await pathExists(dst) && !opts.force) {
        plan.actions.push({
          ...actionBase,
          kind: "skip_exists",
          src: resolvedSource.absolutePath,
          dst,
          hint: "pass --force to overwrite"
        });
        continue;
      }
      plan.actions.push({
        ...actionBase,
        kind: stat.isDirectory() ? "copy_dir" : "copy_file",
        src: resolvedSource.absolutePath,
        dst
      });
    }

    for (const supportingArtifact of uniqStrings(buildManifest.source?.supporting_artifacts || [])) {
      const normalized = normalizeRelativePath(supportingArtifact);
      const sourceCandidates = [
        path.resolve(repoRoot, normalized),
        path.resolve(path.dirname(buildManifestPath), normalized)
      ];
      const existingSource = await Promise.all(sourceCandidates.map(async (candidate) => (await pathExists(candidate)) ? candidate : null));
      const matchedSource = existingSource.find(Boolean);
      if (!matchedSource) continue;
      const dst = path.resolve(opts.target, opts.docDir, "builds", slug, path.basename(normalized));
      if (await pathExists(dst) && !opts.force) {
        plan.actions.push({
          kind: "skip_exists",
          import_id: buildImportId,
          artifact_type: "build",
          artifact_id: buildId,
          src: matchedSource,
          dst,
          hint: "pass --force to overwrite"
        });
        continue;
      }
      plan.actions.push({
        kind: "copy_doc",
        import_id: buildImportId,
        artifact_type: "build",
        artifact_id: buildId,
        src: matchedSource,
        dst,
        source_base_root: repoRoot,
        ownership_mode: "managed",
        ownership_note: "supporting_artifact",
        exported_symbols: [],
        env_binding_records: buildEnvBindingRecordsList,
        adapter_point_records: buildAdapterPointRecordsList
      });
    }

    const legacyImportsPath = path.resolve(opts.target, ".sweetspot", "imports.json");
    const smarchRoot = path.resolve(opts.target, ".smarch");
    const smarchImportsPath = path.resolve(smarchRoot, "imports.json");
    const buildLockPath = path.resolve(smarchRoot, "build-lock.json");
    const placementsPath = path.resolve(smarchRoot, "placements.json");
    const updateJournalPath = path.resolve(smarchRoot, "update-journal.jsonl");
    const checklistPath = path.resolve(opts.target, ".sweetspot", "clones", `${slug}.md`);
    plan.import_id = buildImportId;
    plan.control_plane = {
      legacy_imports: legacyImportsPath,
      smarch_imports: smarchImportsPath,
      build_lock: buildLockPath,
      placements: placementsPath,
      update_journal: updateJournalPath
    };

    const plannedCopyActions = plan.actions.filter((action) => action.kind === "copy_dir" || action.kind === "copy_file" || action.kind === "copy_doc");
    const planHash = sha256(JSON.stringify({
      import_id: buildImportId,
      build_id: buildId,
      build_manifest_path: buildManifestPath,
      target: opts.target,
      force: opts.force,
      resolved_bricks: resolvedBricks.map((entry) => entry.brick.id),
      actions: plan.actions.map((action) => ({
        kind: action.kind,
        import_id: action.import_id || null,
        artifact_type: action.artifact_type || null,
        artifact_id: action.artifact_id || null,
        src: action.src || null,
        dst: action.dst || null,
        reason: action.reason || null
      }))
    }));

    if (opts.write) {
      guardCloneWrite(opts, resolvedBricks.map((entry) => entry.brick.id), resolvedBricks[0]?.brick?.project || null);
      const placementEntries = [];
      for (const action of plan.actions) {
        if (action.kind === "copy_dir") {
          const entries = await collectPathEntries(action.src, action.dst, action.source_base_root, opts.target, "source_file");
          await copyDir(action.src, action.dst);
          placementEntries.push(...entries.map((entry) => ({ ...entry, action })));
        } else if (action.kind === "copy_file") {
          const entries = await collectPathEntries(action.src, action.dst, action.source_base_root, opts.target, "source_file");
          await copyFile(action.src, action.dst);
          placementEntries.push(...entries.map((entry) => ({ ...entry, action })));
        } else if (action.kind === "copy_doc") {
          const entries = await collectPathEntries(action.src, action.dst, action.source_base_root || repoRoot, opts.target, "portable_doc");
          await copyFile(action.src, action.dst);
          placementEntries.push(...entries.map((entry) => ({ ...entry, action })));
        }
      }

      const placementRecords = [];
      for (const entry of placementEntries) {
        placementRecords.push({
          placement_id: sha256(`${entry.action.import_id}:${entry.target_path}`).slice(0, 16),
          import_id: entry.action.import_id,
          kind: mapContentKindToPlacementKind(entry.content_kind),
          source_path: entry.source_path,
          target_path: entry.target_path,
          source_hash: await sha256File(entry.src),
          target_hash: await sha256PathIfExists(entry.dst),
          exported_symbols: entry.action.exported_symbols || [],
          alias_rewrites: [],
          env_bindings: entry.action.env_binding_records || [],
          adapter_points: entry.action.adapter_point_records || [],
          local_overrides: [],
          ownership: {
            mode: entry.action.ownership_mode || "managed",
            owner: "smarch",
            replaceable: !opts.force
          }
        });
      }

      const placementCountsByImportId = new Map();
      const targetPathsByImportId = new Map();
      const docPathsByImportId = new Map();
      for (const placement of placementRecords) {
        placementCountsByImportId.set(placement.import_id, (placementCountsByImportId.get(placement.import_id) || 0) + 1);
        if (!targetPathsByImportId.has(placement.import_id)) targetPathsByImportId.set(placement.import_id, new Set());
        targetPathsByImportId.get(placement.import_id).add(placement.target_path);
        if (placement.kind === "doc") {
          if (!docPathsByImportId.has(placement.import_id)) docPathsByImportId.set(placement.import_id, new Set());
          docPathsByImportId.get(placement.import_id).add(placement.target_path);
        }
      }

      const checklistRelPath = relFrom(opts.target, checklistPath);
      const buildImportStatus = deriveImportStatusForImport(plan.actions, placementCountsByImportId.get(buildImportId) || 0, buildImportId);

      const legacyImports = (await maybeReadJson(legacyImportsPath)) || { version: 1, imports: [] };
      legacyImports.imports = Array.isArray(legacyImports.imports) ? legacyImports.imports : [];
      legacyImports.imports.push({
        artifact_type: "build",
        build_id: buildId,
        build_name: buildName,
        from_project: buildManifest.source?.project || null,
        source_paths: buildSourcePaths,
        imported_at: now,
        sma_model: "codex-gpt-5.4",
        clone_steps: buildCloneSteps,
        integration_recipe: buildIntegrationRecipe,
        risks: buildRisks,
        resolved_bricks: resolvedBricks.map((entry) => ({
          brick_id: entry.brick.id,
          role: entry.ref.role || null,
          required: entry.ref.required !== false
        }))
      });
      await fs.mkdir(path.dirname(legacyImportsPath), { recursive: true });
      await fs.writeFile(legacyImportsPath, JSON.stringify(legacyImports, null, 2));
      plan.imports_record = legacyImportsPath;

      const smarchImports = (await maybeReadJson(smarchImportsPath)) || { version: 1, schema: "smarch.imports.v0", imports: [] };
      smarchImports.version = 1;
      smarchImports.schema = "smarch.imports.v0";
      smarchImports.generated_at = now;
      smarchImports.imports = Array.isArray(smarchImports.imports) ? smarchImports.imports : [];
      smarchImports.imports.push({
        import_id: buildImportId,
        artifact_type: "build",
        artifact_id: buildId,
        artifact_name: buildName,
        source_project: buildManifest.source?.project || null,
        status: buildImportStatus,
        imported_at: now,
        imported_by: "tools/sma-clone.ts",
        source_registry: {
          path: opts.registry,
          sha256: registrySha
        },
        source_manifest_path: relFrom(repoRoot, buildManifestPath),
        source_status: buildStatus,
        source_kind: buildMeta.kind || "build",
        source_paths: buildSourcePaths,
        target_paths: uniqStrings(plan.actions
          .filter((action) => action.kind === "copy_dir" || action.kind === "copy_file")
          .map((action) => relFrom(opts.target, action.dst))),
        portable_doc_paths: [...(docPathsByImportId.get(buildImportId) || new Set())],
        checklist_path: checklistRelPath,
        clone_readiness: buildCloneReadiness,
        source_manifest_schema_version: buildManifest.schema_version || null,
        install_state: {
          planned_actions: plannedCopyActions.length,
          placements_recorded: placementRecords.length,
          skipped_existing_actions: plan.actions.filter((action) => action.kind === "skip_exists").length,
          missing_source_actions: plan.actions.filter((action) => action.kind === "skip_missing").length
        },
        contracts: {
          env: buildEnvContract,
          rls: buildRlsContract,
          env_bindings: buildEnvBindings,
          rls_tables: buildRlsTables
        },
        verification: {
          test_commands: buildTestCommands,
          clone_steps: buildCloneSteps,
          install_steps: buildInstallSteps,
          adaptation_points: buildAdaptationPoints,
          integration_recipe: buildIntegrationRecipe,
          risks: buildRisks,
          known_traps: buildKnownTraps
        },
        metadata: {
          purpose: buildMeta.summary || null,
          tags: buildTags,
          public_api: buildPublicApi,
          risk: firstDefined(buildManifest.classification?.risk, null),
          resolved_bricks: resolvedBricks.map((entry) => ({
            brick_id: entry.brick.id,
            role: entry.ref.role || null,
            import_id: entry.import_id
          }))
        }
      });

      for (const entry of resolvedBricks) {
        const importStatus = deriveImportStatusForImport(plan.actions, placementCountsByImportId.get(entry.import_id) || 0, entry.import_id);
        smarchImports.imports.push({
          import_id: entry.import_id,
          artifact_type: "brick",
          artifact_id: entry.brick.id,
          artifact_name: entry.brick.name,
          source_project: entry.brick.project,
          status: importStatus,
          imported_at: now,
          imported_by: "tools/sma-clone.ts",
          source_registry: {
            path: opts.registry,
            sha256: registrySha
          },
          source_manifest_path: relFrom(repoRoot, entry.brick.manifest_path),
          source_status: entry.brick.status,
          source_kind: entry.brick.kind,
          source_paths: uniqStrings(entry.brick.source_paths || []),
          target_paths: [...(targetPathsByImportId.get(entry.import_id) || new Set())],
          portable_doc_paths: [...(docPathsByImportId.get(entry.import_id) || new Set())],
          checklist_path: checklistRelPath,
          clone_readiness: entry.cloneReadiness,
          source_manifest_schema_version: entry.manifest.schema_version || null,
          install_state: {
            planned_actions: plan.actions.filter((action) => action.import_id === entry.import_id && (action.kind === "copy_dir" || action.kind === "copy_file" || action.kind === "copy_doc")).length,
            placements_recorded: placementCountsByImportId.get(entry.import_id) || 0,
            skipped_existing_actions: plan.actions.filter((action) => action.import_id === entry.import_id && action.kind === "skip_exists").length,
            missing_source_actions: plan.actions.filter((action) => action.import_id === entry.import_id && action.kind === "skip_missing").length
          },
          contracts: {
            env: entry.envContract,
            rls: entry.rlsContract,
            env_bindings: entry.envBindings,
            rls_tables: entry.rlsTables
          },
          verification: {
            test_commands: entry.testCommands,
            clone_steps: entry.cloneSteps,
            install_steps: entry.installSteps,
            adaptation_points: entry.adaptationPoints,
            integration_recipe: entry.integrationRecipe,
            risks: entry.risks,
            known_traps: entry.knownTraps
          },
          metadata: {
            purpose: entry.sem.purpose || null,
            tags: entry.tags,
            public_api: entry.publicApi,
            risk: firstDefined(entry.brick.risk, null),
            role: entry.ref.role || null,
            parent_build_id: buildId,
            parent_build_import_id: buildImportId
          }
        });
      }
      await fs.mkdir(path.dirname(smarchImportsPath), { recursive: true });
      await fs.writeFile(smarchImportsPath, JSON.stringify(smarchImports, null, 2));

      const buildLock = (await maybeReadJson(buildLockPath)) || {};
      buildLock.version = 1;
      buildLock.schema_version = "1.0.0";
      buildLock.lock = toJsonObject(buildLock.lock, {});
      buildLock.lock.generated_at = now;
      buildLock.lock.generated_by = {
        actor: "smarch",
        tool: "tools/sma-clone.ts",
        model: "codex-gpt-5.4"
      };
      buildLock.lock.registry_snapshot_sha = registrySha;
      buildLock.lock.mode = "exact";
      buildLock.lock.imports_path = ".smarch/imports.json";
      buildLock.lock.placements_path = ".smarch/placements.json";
      buildLock.lock.update_journal_path = ".smarch/update-journal.jsonl";
      if (opts.registryOrigin) buildLock.lock.registry_origin = opts.registryOrigin;
      buildLock.target = toJsonObject(buildLock.target, {});
      buildLock.target.id = buildLock.target.id || slugify(path.basename(opts.target) || "target-project");
      buildLock.target.name = buildLock.target.name || path.basename(opts.target) || "target-project";
      buildLock.target.root = opts.target;
      buildLock.selected_builds = Array.isArray(buildLock.selected_builds) ? buildLock.selected_builds : [];
      buildLock.resolved_bricks = Array.isArray(buildLock.resolved_bricks) ? buildLock.resolved_bricks : [];
      buildLock.frozen_dependency_graph = toJsonObject(buildLock.frozen_dependency_graph, {});
      buildLock.frozen_dependency_graph.nodes = Array.isArray(buildLock.frozen_dependency_graph.nodes) ? buildLock.frozen_dependency_graph.nodes : [];
      buildLock.frozen_dependency_graph.edges = Array.isArray(buildLock.frozen_dependency_graph.edges) ? buildLock.frozen_dependency_graph.edges : [];
      buildLock.channels = Array.isArray(buildLock.channels) ? buildLock.channels : [];
      buildLock.trust_policy = toJsonObject(buildLock.trust_policy, {});
      buildLock.trust_policy.allowed_release_statuses = Array.isArray(buildLock.trust_policy.allowed_release_statuses)
        ? buildLock.trust_policy.allowed_release_statuses
        : ["draft", "published"];
      buildLock.trust_policy.minimum_verification_status = buildLock.trust_policy.minimum_verification_status || mapBuildVerificationStatus(buildMeta, buildManifest.verification);
      buildLock.trust_policy.require_contract_hashes = firstDefined(buildLock.trust_policy.require_contract_hashes, false);
      buildLock.trust_policy.allow_local_overrides = firstDefined(buildLock.trust_policy.allow_local_overrides, Boolean(opts.force));
      buildLock.trust_policy.fail_on_yanked_release = firstDefined(buildLock.trust_policy.fail_on_yanked_release, true);
      buildLock.trust_policy.fail_on_breaking_upgrade = firstDefined(buildLock.trust_policy.fail_on_breaking_upgrade, true);
      buildLock.verification_policy = toJsonObject(buildLock.verification_policy, {});
      buildLock.verification_policy.run_declared_tests = firstDefined(buildLock.verification_policy.run_declared_tests, buildTestCommands.length > 0);
      buildLock.verification_policy.run_import_resolution = firstDefined(buildLock.verification_policy.run_import_resolution, true);
      buildLock.verification_policy.run_env_truthing = firstDefined(buildLock.verification_policy.run_env_truthing, buildEnvBindingRecordsList.length > 0);
      buildLock.verification_policy.run_rls_truthing = firstDefined(buildLock.verification_policy.run_rls_truthing, buildRlsTables.length > 0);
      buildLock.verification_policy.fail_on_missing_env = firstDefined(buildLock.verification_policy.fail_on_missing_env, buildEnvBindingRecordsList.some((binding) => binding.required));
      buildLock.verification_policy.fail_on_contract_delta = firstDefined(buildLock.verification_policy.fail_on_contract_delta, true);
      buildLock.verification_policy.required_check_status = buildLock.verification_policy.required_check_status || "warning";
      buildLock.verification_policy.post_install_checks = uniqStrings([...buildCloneSteps, ...buildInstallSteps, ...buildIntegrationRecipe]);
      buildLock.selected_builds.push({
        import_id: buildImportId,
        artifact_type: "build",
        artifact_id: buildId,
        release_version: buildVersion,
        release_hash: planHash,
        channel: mapArtifactStatusToChannel(buildStatus),
        source_project: buildManifest.source?.project || null,
        trust_tier: mapBuildTrustTier(buildMeta),
        verification_status: mapBuildVerificationStatus(buildMeta, buildManifest.verification),
        local_overrides: 0
      });
      buildLock.frozen_dependency_graph.nodes.push({
        node_id: buildImportId,
        artifact_type: "build",
        artifact_id: buildId,
        release_version: buildVersion,
        release_hash: planHash
      });
      for (const entry of resolvedBricks) {
        const brickPlanHash = sha256(`${planHash}:${entry.brick.id}:${entry.import_id}`);
        buildLock.resolved_bricks.push({
          import_id: entry.import_id,
          artifact_type: "brick",
          artifact_id: entry.brick.id,
          release_version: entry.version,
          release_hash: brickPlanHash,
          channel: mapArtifactStatusToChannel(entry.brick.status),
          source_project: entry.brick.project,
          trust_tier: mapBrickStatusToTrustTier(entry.brick.status),
          verification_status: mapBrickStatusToVerificationStatus(entry.brick.status),
          local_overrides: 0
        });
        buildLock.frozen_dependency_graph.nodes.push({
          node_id: entry.import_id,
          artifact_type: "brick",
          artifact_id: entry.brick.id,
          release_version: entry.version,
          release_hash: brickPlanHash
        });
        buildLock.frozen_dependency_graph.edges.push({
          from: buildImportId,
          to: entry.import_id,
          relation: entry.ref.required === false ? "optional" : "depends_on"
        });
      }
      await fs.writeFile(buildLockPath, JSON.stringify(buildLock, null, 2));

      const placements = (await maybeReadJson(placementsPath)) || {};
      placements.schema_version = "1.0.0";
      placements.map = toJsonObject(placements.map, {});
      placements.map.generated_at = now;
      placements.map.generated_by = {
        actor: "smarch",
        tool: "tools/sma-clone.ts",
        model: "codex-gpt-5.4"
      };
      placements.map.registry_snapshot_sha = registrySha;
      placements.map.lockfile_path = ".smarch/build-lock.json";
      placements.map.imports_path = ".smarch/imports.json";
      placements.target = toJsonObject(placements.target, {});
      placements.target.id = placements.target.id || slugify(path.basename(opts.target) || "target-project");
      placements.target.name = placements.target.name || path.basename(opts.target) || "target-project";
      placements.target.root = opts.target;
      placements.imports = Array.isArray(placements.imports) ? placements.imports : [];
      placements.placements = Array.isArray(placements.placements) ? placements.placements : [];
      placements.imports.push({
        import_id: buildImportId,
        artifact_type: "build",
        artifact_id: buildId,
        release_version: buildVersion,
        release_hash: planHash,
        imported_at: now,
        status: buildImportStatus === "partial" ? "adapted" : "installed",
        portable_doc_paths: [...(docPathsByImportId.get(buildImportId) || new Set())]
      });
      for (const entry of resolvedBricks) {
        const importStatus = deriveImportStatusForImport(plan.actions, placementCountsByImportId.get(entry.import_id) || 0, entry.import_id);
        placements.imports.push({
          import_id: entry.import_id,
          artifact_type: "brick",
          artifact_id: entry.brick.id,
          release_version: entry.version,
          release_hash: sha256(`${planHash}:${entry.brick.id}:${entry.import_id}`),
          imported_at: now,
          status: importStatus === "partial" ? "adapted" : "installed",
          portable_doc_paths: [...(docPathsByImportId.get(entry.import_id) || new Set())]
        });
      }
      placements.placements.push(...placementRecords);
      await fs.writeFile(placementsPath, JSON.stringify(placements, null, 2));

      const updateJournalRecord = {
        schema: "smarch.update-journal-event.v0",
        event_id: sha256(`${buildImportId}:${now}:${planHash}`).slice(0, 20),
        event_type: "clone_install",
        created_at: now,
        import_id: buildImportId,
        artifact_type: "build",
        artifact_id: buildId,
        from_version: null,
        to_version: buildVersion,
        plan_hash: planHash,
        registry_snapshot_sha: registrySha,
        checks_run: buildTestCommands.map((command) => ({ kind: "declared_test_command", command })),
        result: buildImportStatus,
        rollback_ref: null,
        duration_ms: 0,
        manual_edits_count: 0,
        placements_written: placementRecords.length,
        skipped_existing_actions: plan.actions.filter((action) => action.kind === "skip_exists").length,
        missing_source_actions: plan.actions.filter((action) => action.kind === "skip_missing").length,
        portable_doc_paths: [...(docPathsByImportId.get(buildImportId) || new Set())],
        checklist_path: checklistRelPath,
        legacy_imports_record: relFrom(opts.target, legacyImportsPath),
        resolved_brick_import_ids: resolvedBricks.map((entry) => entry.import_id)
      };
      await fs.appendFile(updateJournalPath, `${JSON.stringify(updateJournalRecord)}\n`);
      for (const entry of resolvedBricks) {
        const importStatus = deriveImportStatusForImport(plan.actions, placementCountsByImportId.get(entry.import_id) || 0, entry.import_id);
        const brickJournalRecord = {
          schema: "smarch.update-journal-event.v0",
          event_id: sha256(`${entry.import_id}:${now}:${planHash}`).slice(0, 20),
          event_type: "clone_install",
          created_at: now,
          import_id: entry.import_id,
          artifact_type: "brick",
          artifact_id: entry.brick.id,
          from_version: null,
          to_version: entry.version,
          plan_hash: sha256(`${planHash}:${entry.brick.id}:${entry.import_id}`),
          registry_snapshot_sha: registrySha,
          checks_run: entry.testCommands.map((command) => ({ kind: "declared_test_command", command })),
          result: importStatus,
          rollback_ref: updateJournalRecord.event_id,
          duration_ms: 0,
          manual_edits_count: 0,
          placements_written: placementCountsByImportId.get(entry.import_id) || 0,
          skipped_existing_actions: plan.actions.filter((action) => action.import_id === entry.import_id && action.kind === "skip_exists").length,
          missing_source_actions: plan.actions.filter((action) => action.import_id === entry.import_id && action.kind === "skip_missing").length,
          portable_doc_paths: [...(docPathsByImportId.get(entry.import_id) || new Set())],
          checklist_path: checklistRelPath,
          parent_build_import_id: buildImportId
        };
        await fs.appendFile(updateJournalPath, `${JSON.stringify(brickJournalRecord)}\n`);
      }
      plan.smarch = {
        import_id: buildImportId,
        status: buildImportStatus,
        imports_record: smarchImportsPath,
        build_lock: buildLockPath,
        placements_record: placementsPath,
        update_journal: updateJournalPath,
        placements_written: placementRecords.length
      };
    }

    const checklistBody = `# Build clone checklist — ${buildName}
Generated: ${now}
Source project: ${buildManifest.source?.project || "unknown"}
Build ID: ${buildId}
Status at clone: ${buildStatus}
Import ID: ${buildImportId}

## Resolved bricks
${resolvedBricks.map((entry) => `- [ ] ${entry.brick.id}${entry.ref.role ? ` (${entry.ref.role})` : ""}`).join("\n")}

## Install steps
${buildInstallSteps.map((step) => `- [ ] ${step}`).join("\n")}

## Post-clone checks
${buildIntegrationRecipe.map((step) => `- [ ] ${step}`).join("\n")}

## Adaptation points
${buildAdaptationPoints.map((step) => `- [ ] ${step}`).join("\n")}

## Known risks
${buildRisks.map((step) => `- [ ] ${step}`).join("\n")}

## Rollback traps
${buildKnownTraps.map((step) => `- [ ] ${step}`).join("\n")}

## Files copied
${plan.actions.filter((action) => action.kind.startsWith("copy")).map((action) => `- ${action.dst}`).join("\n")}

## SMARCH control plane
- [ ] Review \`.smarch/imports.json\` for the build import and resolved brick records.
- [ ] Review \`.smarch/build-lock.json\` for the selected build and frozen brick graph.
- [ ] Review \`.smarch/placements.json\` for exact file placements.
- [ ] Review \`.smarch/update-journal.jsonl\` for the initial install event.

## Next steps
- [ ] Bind env vars declared by the build and each resolved brick.
- [ ] Re-run target-side verification and smoke flows.
- [ ] Re-run the target project's scanner to register the imported build footprint.
`;
    if (opts.write) {
      await fs.mkdir(path.dirname(checklistPath), { recursive: true });
      await fs.writeFile(checklistPath, checklistBody);
      plan.checklist = checklistPath;
    }

    console.log(JSON.stringify({
      dry_run: !opts.write,
      plan,
      next_step: opts.write
        ? `Open ${checklistPath} to finish integration.`
        : "Rerun with --write to perform the copy."
    }, null, 2));
    return;
  }

  const brick = await findBrickById(registry, opts.brick);
  if (!brick) { console.error(`error: no brick matched id "${opts.brick}"`); process.exit(2); }

  const manifest = await readJson(brick.manifest_path);
  verifyCommercialEntitlement({ manifest, brickId: brick.id, licensee: opts.licensee, entitlementFile: opts.entitlement, trustedKeysFile: opts.entitlementTrustedKeys });
  const sem = manifest.semantics || {};
  const artifactVersion = semverOrFallback(firstDefined(brick.version, manifest.brick?.version, manifest.build?.version), "0.0.0");
  const sourceProjectRoot = await inferSourceProjectRoot(brick.manifest_path, brick.source_paths || [], brick.project || "");
  const registrySha = await sha256JsonFile(opts.registry);
  const now = new Date().toISOString();
  const slug = slugify(brick.id);
  const importId = createImportId(brick.id, now);
  const cloneReadiness = firstDefined(brick.clone_readiness, manifest.clone?.readiness, "unknown");
  const cloneSteps = uniqStrings(sem.clone_steps || []);
  const integrationRecipe = uniqStrings(sem.integration_recipe || []);
  const installSteps = uniqStrings([...(brick.clone_install_steps || []), ...(manifest.clone?.install_steps || [])]);
  const adaptationPoints = uniqStrings([...(brick.clone_adaptation_points || []), ...(manifest.clone?.adaptation_points || [])]);
  const knownTraps = uniqStrings([...(brick.clone_known_traps || []), ...(manifest.clone?.known_traps || [])]);
  const publicApi = uniqStrings([...(sem.public_api || []), ...(brick.public_api || []), ...(manifest.public_api || [])]);
  const testCommands = deriveTestCommands(brick, manifest);
  const risks = uniqStrings(sem.risks || []);
  const tags = uniqStrings(sem.tags || []);
  const envContract = toJsonObject(firstDefined(manifest.security?.env, brick.env_contract), {});
  const rlsContract = toJsonObject(firstDefined(manifest.security?.rls, brick.rls_contract), {});
  const envBindings = extractEnvVariableNames(envContract);
  const rlsTables = extractRlsTableNames(rlsContract);
  const envBindingRecords = buildEnvBindingRecords(envContract);
  const adapterPointRecords = buildAdapterPointRecords(adaptationPoints);
  const exportedSymbols = mapPublicApiToSymbols(publicApi);

  const plan: Record<string, any> = { brick: brick.id, name: brick.name, from_project: brick.project, status: brick.status, actions: [] };

  for (const rel of brick.source_paths || []) {
    const src = path.resolve(sourceProjectRoot, rel);
    const dst = path.resolve(opts.target, rel);
    if (!(await pathExists(src))) { plan.actions.push({ kind: "skip_missing", src, reason: "source path does not exist in source project" }); continue; }
    const stat = await fs.stat(src);
    if (await pathExists(dst) && !opts.force) {
      plan.actions.push({ kind: "skip_exists", dst, hint: "pass --force to overwrite" });
      continue;
    }
    plan.actions.push({ kind: stat.isDirectory() ? "copy_dir" : "copy_file", src, dst });
  }

  // Portable doc: prefer <wiki>/<slug>.portable.md if it exists
  const portable = path.resolve(repoRoot, "wiki/bricks-detailed", brick.project || "_unknown", `${slug}.portable.md`);
  const wikiPage = sem.wiki_page
    ? path.resolve(repoRoot, sem.wiki_page)
    : null;
  if (await pathExists(portable)) {
    plan.actions.push({ kind: "copy_doc", src: portable, dst: path.resolve(opts.target, opts.docDir, `${slug}.md`) });
  } else if (wikiPage && await pathExists(wikiPage)) {
    plan.actions.push({ kind: "copy_doc", src: wikiPage, dst: path.resolve(opts.target, opts.docDir, `${slug}.md`) });
  }

  // Provenance records
  const legacyImportsPath = path.resolve(opts.target, ".sweetspot", "imports.json");
  const smarchRoot = path.resolve(opts.target, ".smarch");
  const smarchImportsPath = path.resolve(smarchRoot, "imports.json");
  const buildLockPath = path.resolve(smarchRoot, "build-lock.json");
  const placementsPath = path.resolve(smarchRoot, "placements.json");
  const updateJournalPath = path.resolve(smarchRoot, "update-journal.jsonl");
  const checklistPath = path.resolve(opts.target, ".sweetspot", "clones", `${slug}.md`);
  plan.import_id = importId;
  plan.control_plane = {
    legacy_imports: legacyImportsPath,
    smarch_imports: smarchImportsPath,
    build_lock: buildLockPath,
    placements: placementsPath,
    update_journal: updateJournalPath
  };

  const plannedCopyActions = plan.actions.filter((action) => action.kind === "copy_dir" || action.kind === "copy_file" || action.kind === "copy_doc");
  const planHash = sha256(JSON.stringify({
    import_id: importId,
    brick_id: brick.id,
    target: opts.target,
    force: opts.force,
    actions: plan.actions.map((action) => ({
      kind: action.kind,
      src: action.src || null,
      dst: action.dst || null,
      reason: action.reason || null
    }))
  }));

  if (opts.write) {
    guardCloneWrite(opts, [brick.id], brick.project || null);
    const placementEntries = [];
    for (const a of plan.actions) {
      if (a.kind === "copy_dir") {
        const entries = await collectPathEntries(a.src, a.dst, sourceProjectRoot, opts.target, "source_file");
        await copyDir(a.src, a.dst);
        placementEntries.push(...entries);
      } else if (a.kind === "copy_file") {
        const entries = await collectPathEntries(a.src, a.dst, sourceProjectRoot, opts.target, "source_file");
        await copyFile(a.src, a.dst);
        placementEntries.push(...entries);
      } else if (a.kind === "copy_doc") {
        const entries = await collectPathEntries(a.src, a.dst, repoRoot, opts.target, "portable_doc");
        await copyFile(a.src, a.dst);
        placementEntries.push(...entries);
      }
    }
    const placementRecords = [];
    for (const entry of placementEntries) {
      placementRecords.push({
        placement_id: sha256(`${importId}:${entry.target_path}`).slice(0, 16),
        import_id: importId,
        kind: mapContentKindToPlacementKind(entry.content_kind),
        source_path: entry.source_path,
        target_path: entry.target_path,
        source_hash: await sha256File(entry.src),
        target_hash: await sha256PathIfExists(entry.dst),
        exported_symbols: exportedSymbols,
        alias_rewrites: [],
        env_bindings: envBindingRecords,
        adapter_points: adapterPointRecords,
        local_overrides: [],
        ownership: {
          mode: "managed",
          owner: "smarch",
          replaceable: !opts.force
        }
      });
    }
    const importStatus = deriveImportStatus(plan, placementRecords.length);
    const copiedTargetRoots = uniqStrings(plan.actions
      .filter((action) => action.kind === "copy_dir" || action.kind === "copy_file")
      .map((action) => relFrom(opts.target, action.dst)));
    const portableDocPaths = uniqStrings(placementRecords
      .filter((placement) => placement.kind === "doc")
      .map((placement) => placement.target_path));
    const checklistRelPath = relFrom(opts.target, checklistPath);

    // Legacy imports.json
    const legacyImports = (await maybeReadJson(legacyImportsPath)) || { version: 1, imports: [] };
    legacyImports.imports = Array.isArray(legacyImports.imports) ? legacyImports.imports : [];
    legacyImports.imports.push({
      brick_id: brick.id,
      brick_name: brick.name,
      from_project: brick.project,
      source_paths: brick.source_paths,
      imported_at: now,
      sma_model: "codex-gpt-5.4",
      clone_steps: sem.clone_steps || [],
      integration_recipe: sem.integration_recipe || null,
      risks: sem.risks || []
    });
    await fs.mkdir(path.dirname(legacyImportsPath), { recursive: true });
    await fs.writeFile(legacyImportsPath, JSON.stringify(legacyImports, null, 2));
    plan.imports_record = legacyImportsPath;

    // New SMARCH control-plane artifacts
    const smarchImports = (await maybeReadJson(smarchImportsPath)) || { version: 1, schema: "smarch.imports.v0", imports: [] };
    smarchImports.version = 1;
    smarchImports.schema = "smarch.imports.v0";
    smarchImports.generated_at = now;
    smarchImports.imports = Array.isArray(smarchImports.imports) ? smarchImports.imports : [];
    smarchImports.imports.push({
      import_id: importId,
      artifact_type: "brick",
      artifact_id: brick.id,
      artifact_name: brick.name,
      source_project: brick.project,
      status: importStatus,
      imported_at: now,
      imported_by: "tools/sma-clone.ts",
      source_registry: {
        path: opts.registry,
        sha256: registrySha
      },
      source_manifest_path: relFrom(repoRoot, brick.manifest_path),
      source_status: brick.status,
      source_kind: brick.kind,
      source_paths: uniqStrings(brick.source_paths || []),
      target_paths: copiedTargetRoots,
      portable_doc_paths: portableDocPaths,
      checklist_path: checklistRelPath,
      clone_readiness: cloneReadiness,
      source_manifest_schema_version: manifest.schema_version || null,
      install_state: {
        planned_actions: plannedCopyActions.length,
        placements_recorded: placementRecords.length,
        skipped_existing_actions: plan.actions.filter((action) => action.kind === "skip_exists").length,
        missing_source_actions: plan.actions.filter((action) => action.kind === "skip_missing").length
      },
      contracts: {
        env: envContract,
        rls: rlsContract,
        env_bindings: envBindings,
        rls_tables: rlsTables
      },
      verification: {
        test_commands: testCommands,
        clone_steps: cloneSteps,
        install_steps: installSteps,
        adaptation_points: adaptationPoints,
        integration_recipe: integrationRecipe,
        risks,
        known_traps: knownTraps
      },
      metadata: {
        purpose: sem.purpose || null,
        tags,
        public_api: publicApi,
        risk: firstDefined(brick.risk, null)
      }
    });
    await fs.mkdir(path.dirname(smarchImportsPath), { recursive: true });
    await fs.writeFile(smarchImportsPath, JSON.stringify(smarchImports, null, 2));

    const buildLock = (await maybeReadJson(buildLockPath)) || {};
    buildLock.version = 1;
    buildLock.schema_version = "1.0.0";
    buildLock.lock = toJsonObject(buildLock.lock, {});
    buildLock.lock.generated_at = now;
    buildLock.lock.generated_by = {
      actor: "smarch",
      tool: "tools/sma-clone.ts",
      model: "codex-gpt-5.4"
    };
    buildLock.lock.registry_snapshot_sha = registrySha;
    buildLock.lock.mode = "exact";
    buildLock.lock.imports_path = ".smarch/imports.json";
    buildLock.lock.placements_path = ".smarch/placements.json";
    buildLock.lock.update_journal_path = ".smarch/update-journal.jsonl";
    if (opts.registryOrigin) buildLock.lock.registry_origin = opts.registryOrigin;
    buildLock.target = toJsonObject(buildLock.target, {});
    buildLock.target.id = buildLock.target.id || slugify(path.basename(opts.target) || "target-project");
    buildLock.target.name = buildLock.target.name || path.basename(opts.target) || "target-project";
    buildLock.target.root = opts.target;
    buildLock.selected_builds = Array.isArray(buildLock.selected_builds) ? buildLock.selected_builds : [];
    buildLock.resolved_bricks = Array.isArray(buildLock.resolved_bricks) ? buildLock.resolved_bricks : [];
    buildLock.frozen_dependency_graph = toJsonObject(buildLock.frozen_dependency_graph, {});
    buildLock.frozen_dependency_graph.nodes = Array.isArray(buildLock.frozen_dependency_graph.nodes) ? buildLock.frozen_dependency_graph.nodes : [];
    buildLock.frozen_dependency_graph.edges = Array.isArray(buildLock.frozen_dependency_graph.edges) ? buildLock.frozen_dependency_graph.edges : [];
    buildLock.channels = Array.isArray(buildLock.channels) ? buildLock.channels : [];
    buildLock.trust_policy = toJsonObject(buildLock.trust_policy, {});
    buildLock.trust_policy.allowed_release_statuses = Array.isArray(buildLock.trust_policy.allowed_release_statuses)
      ? buildLock.trust_policy.allowed_release_statuses
      : ["draft", "published"];
    buildLock.trust_policy.minimum_verification_status = buildLock.trust_policy.minimum_verification_status || mapBrickStatusToVerificationStatus(brick.status);
    buildLock.trust_policy.require_contract_hashes = firstDefined(buildLock.trust_policy.require_contract_hashes, false);
    buildLock.trust_policy.allow_local_overrides = firstDefined(buildLock.trust_policy.allow_local_overrides, Boolean(opts.force));
    buildLock.trust_policy.fail_on_yanked_release = firstDefined(buildLock.trust_policy.fail_on_yanked_release, true);
    buildLock.trust_policy.fail_on_breaking_upgrade = firstDefined(buildLock.trust_policy.fail_on_breaking_upgrade, true);
    buildLock.verification_policy = toJsonObject(buildLock.verification_policy, {});
    buildLock.verification_policy.run_declared_tests = firstDefined(buildLock.verification_policy.run_declared_tests, testCommands.length > 0);
    buildLock.verification_policy.run_import_resolution = firstDefined(buildLock.verification_policy.run_import_resolution, true);
    buildLock.verification_policy.run_env_truthing = firstDefined(buildLock.verification_policy.run_env_truthing, envBindingRecords.length > 0);
    buildLock.verification_policy.run_rls_truthing = firstDefined(buildLock.verification_policy.run_rls_truthing, rlsTables.length > 0);
    buildLock.verification_policy.fail_on_missing_env = firstDefined(buildLock.verification_policy.fail_on_missing_env, envBindingRecords.some((binding) => binding.required));
    buildLock.verification_policy.fail_on_contract_delta = firstDefined(buildLock.verification_policy.fail_on_contract_delta, true);
    buildLock.verification_policy.required_check_status = buildLock.verification_policy.required_check_status || "warning";
    buildLock.verification_policy.post_install_checks = uniqStrings([...cloneSteps, ...installSteps]);
    buildLock.resolved_bricks.push({
      import_id: importId,
      artifact_type: "brick",
      artifact_id: brick.id,
      release_version: artifactVersion,
      release_hash: planHash,
      channel: "dev",
      source_project: brick.project,
      trust_tier: mapBrickStatusToTrustTier(brick.status),
      verification_status: mapBrickStatusToVerificationStatus(brick.status),
      local_overrides: 0
    });
    buildLock.frozen_dependency_graph.nodes.push({
      node_id: importId,
      artifact_type: "brick",
      artifact_id: brick.id,
      release_version: artifactVersion,
      release_hash: planHash
    });
    await fs.writeFile(buildLockPath, JSON.stringify(buildLock, null, 2));

    const placements = (await maybeReadJson(placementsPath)) || {};
    placements.schema_version = "1.0.0";
    placements.map = toJsonObject(placements.map, {});
    placements.map.generated_at = now;
    placements.map.generated_by = {
      actor: "smarch",
      tool: "tools/sma-clone.ts",
      model: "codex-gpt-5.4"
    };
    placements.map.registry_snapshot_sha = registrySha;
    placements.map.lockfile_path = ".smarch/build-lock.json";
    placements.map.imports_path = ".smarch/imports.json";
    placements.target = toJsonObject(placements.target, {});
    placements.target.id = placements.target.id || slugify(path.basename(opts.target) || "target-project");
    placements.target.name = placements.target.name || path.basename(opts.target) || "target-project";
    placements.target.root = opts.target;
    placements.imports = Array.isArray(placements.imports) ? placements.imports : [];
    placements.placements = Array.isArray(placements.placements) ? placements.placements : [];
    placements.imports.push({
      import_id: importId,
      artifact_type: "brick",
      artifact_id: brick.id,
      release_version: artifactVersion,
      release_hash: planHash,
      imported_at: now,
      status: importStatus === "partial" ? "adapted" : "installed",
      portable_doc_paths: portableDocPaths
    });
    placements.placements.push(...placementRecords);
    await fs.writeFile(placementsPath, JSON.stringify(placements, null, 2));

    const updateJournalRecord = {
      schema: "smarch.update-journal-event.v0",
      event_id: sha256(`${importId}:${now}:${planHash}`).slice(0, 20),
      event_type: "clone_install",
      created_at: now,
      import_id: importId,
      artifact_type: "brick",
      artifact_id: brick.id,
      from_version: null,
      to_version: artifactVersion,
      plan_hash: planHash,
      registry_snapshot_sha: registrySha,
      checks_run: testCommands.map((command) => ({ kind: "declared_test_command", command })),
      result: importStatus,
      rollback_ref: null,
      duration_ms: 0,
      manual_edits_count: 0,
      placements_written: placementRecords.length,
      skipped_existing_actions: plan.actions.filter((action) => action.kind === "skip_exists").length,
      missing_source_actions: plan.actions.filter((action) => action.kind === "skip_missing").length,
      portable_doc_paths: portableDocPaths,
      checklist_path: checklistRelPath,
      legacy_imports_record: relFrom(opts.target, legacyImportsPath)
    };
    await fs.appendFile(updateJournalPath, `${JSON.stringify(updateJournalRecord)}\n`);
    plan.smarch = {
      import_id: importId,
      status: importStatus,
      imports_record: smarchImportsPath,
      build_lock: buildLockPath,
      placements_record: placementsPath,
      update_journal: updateJournalPath,
      placements_written: placementRecords.length
    };
  }

  // Checklist file
  const checklistBody = `# Clone checklist — ${brick.name || brick.id}
Generated: ${now}
Source project: ${brick.project}
Brick ID: ${brick.id}
Status at clone: ${brick.status}
Import ID: ${importId}

## Clone steps (from brick manifest)
${cloneSteps.map((s) => `- [ ] ${s}`).join("\n")}

## Integration recipe
${integrationRecipe.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Known risks
${risks.map((s) => `- [ ] ${s}`).join("\n")}

## Clone adaptation points
${adaptationPoints.map((s) => `- [ ] ${s}`).join("\n")}

## Known traps
${knownTraps.map((s) => `- [ ] ${s}`).join("\n")}

## Files copied
${plan.actions.filter((a) => a.kind.startsWith("copy")).map((a) => `- ${a.dst}`).join("\n")}

## SMARCH control plane
- [ ] Review \`.smarch/imports.json\` for the installed import record.
- [ ] Review \`.smarch/build-lock.json\` for the frozen brick record.
- [ ] Review \`.smarch/placements.json\` for exact file placements.
- [ ] Review \`.smarch/update-journal.jsonl\` for the initial install event.

## Next steps
- [ ] Install any missing npm deps referenced in the brick's source.
- [ ] Set env vars listed in the brick's configuration matrix.
- [ ] Re-run the target project's sma-scan + sma-promote to register the clone.
- [ ] Run the brick's tests locally in the target.
`;
  if (opts.write) {
    await fs.mkdir(path.dirname(checklistPath), { recursive: true });
    await fs.writeFile(checklistPath, checklistBody);
    plan.checklist = checklistPath;
  }

  console.log(JSON.stringify({
    dry_run: !opts.write,
    plan,
    next_step: opts.write
      ? `Open ${checklistPath} to finish integration.`
      : "Rerun with --write to perform the copy."
  }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
