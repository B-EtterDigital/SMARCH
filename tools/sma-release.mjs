#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { assertExportAllowed, ExportBlockedError } from "./lib/export-guard.mjs";

const SCHEMA_VERSION = "1.0.0";
const DEFAULT_REGISTRY_PATH = "scans/all-projects/latest.registry.json";
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH_RE = /^[A-Fa-f0-9]{7,128}$/;
const HELP_TEXT = `Usage: node tools/sma-release.mjs --manifest <path> [options]

Generate a practical release artifact JSON for a brick or build manifest.

Options:
  --manifest <path>          Source manifest path. May also be passed positionally.
  --out <path>               Output JSON path.
                             Default: releases/<artifact_id>/<version>.json
  --channel <name>           Release channel override.
                             Default: inferred from manifest status/version.
  --status <name>            Release status. Default: draft
  --version <semver>         Override artifact version.
  --created-at <iso>         Override release creation timestamp.
                             Default: current time
  --published-at <iso>       Optional published timestamp.
  --source-commit <sha>      Override source commit hash.
  --registry <path>          Registry snapshot file used for registry_snapshot_sha.
                             Default: ${DEFAULT_REGISTRY_PATH} when present
  --registry-sha <hex>       Override registry_snapshot_sha directly.
  --previous-release <ref>   Previous release reference.
  --supersede <ref>          Release reference superseded by this release.
                             Repeat to add multiple entries.
  --replacement-release <ref>
                             Replacement release reference.
  --note <text>              Release notes.
  --breaking                 Mark the release as breaking.
  --search-root <path>       Extra root to use when resolving source.paths.
                             Repeat to add multiple entries.
  --stdout                   Print the generated JSON to stdout.
  --dry-run                  Generate without writing a file.
  --help                     Show this help.

Examples:
  node tools/sma-release.mjs --manifest examples/module.sweetspot.json
  node tools/sma-release.mjs --manifest examples/build.sweetspot.json --search-root ~/DEV/Projects/acme-studio-workspace/acme-studio
`;

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function uniqStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function semverOrFallback(value, fallback = "0.1.0") {
  if (typeof value === "string" && SEMVER_RE.test(value.trim())) return value.trim();
  return fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toPosixRelative(fromRoot, targetPath) {
  return path.relative(fromRoot, targetPath).split(path.sep).join("/");
}

function readJsonFile(filePath) {
  return fs.readFile(filePath, "utf8").then((text) => JSON.parse(text));
}

function parseArgs(argv) {
  const args = {
    searchRoots: [],
    supersedes: [],
    stdout: false,
    dryRun: false
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--stdout") {
      args.stdout = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      args.stdout = true;
      continue;
    }
    if (arg === "--breaking") {
      args.breaking = true;
      continue;
    }
    if (arg === "--allow-closed") {
      args.allowClosed = true;
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined) fail(`missing value for ${arg}`);

    switch (arg) {
      case "--manifest":
        args.manifest = next;
        break;
      case "--out":
        args.out = next;
        break;
      case "--channel":
        args.channel = next;
        break;
      case "--status":
        args.status = next;
        break;
      case "--version":
        args.version = next;
        break;
      case "--created-at":
        args.createdAt = next;
        break;
      case "--published-at":
        args.publishedAt = next;
        break;
      case "--source-commit":
        args.sourceCommit = next;
        break;
      case "--registry":
        args.registry = next;
        break;
      case "--registry-sha":
        args.registrySha = next;
        break;
      case "--previous-release":
        args.previousRelease = next;
        break;
      case "--supersede":
        args.supersedes.push(next);
        break;
      case "--replacement-release":
        args.replacementRelease = next;
        break;
      case "--note":
        args.note = next;
        break;
      case "--search-root":
        args.searchRoots.push(next);
        break;
      case "--registry-origin":
        args.registryOrigin = next;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }

    index += 1;
  }

  if (!args.manifest && positionals.length) args.manifest = positionals[0];
  return args;
}

function inferArtifactType(manifest) {
  if (manifest?.build?.id) return "build";
  if (manifest?.brick?.id) return "brick";
  fail("manifest must contain either a top-level build or brick object");
}

function inferArtifactId(manifest, artifactType) {
  const id = artifactType === "build" ? manifest.build?.id : manifest.brick?.id;
  if (typeof id !== "string" || !id.trim()) fail(`could not infer ${artifactType} id from manifest`);
  return id.trim();
}

function inferVersion(manifest, artifactType, overrideVersion) {
  if (overrideVersion && !SEMVER_RE.test(overrideVersion)) fail(`invalid semver passed to --version: ${overrideVersion}`);
  const manifestVersion = artifactType === "build" ? manifest.build?.version : manifest.brick?.version;
  return semverOrFallback(overrideVersion || manifestVersion, "0.1.0");
}

function inferChannel({ manifest, artifactType, version, overrideChannel }) {
  if (overrideChannel) return overrideChannel;
  const status = String(firstDefined(artifactType === "build" ? manifest.build?.status : manifest.brick?.status, "")).toLowerCase();
  if (version.includes("-alpha")) return "alpha";
  if (version.includes("-beta")) return "beta";
  if (version.includes("-rc")) return "candidate";
  if (status === "canonical") return "stable";
  if (status === "candidate") return "candidate";
  if (status === "deprecated") return "lts";
  return "dev";
}

function inferReleaseStatus({ manifest, artifactType, overrideStatus }) {
  if (overrideStatus) return overrideStatus;
  const status = String(firstDefined(artifactType === "build" ? manifest.build?.status : manifest.brick?.status, "")).toLowerCase();
  if (status === "deprecated") return "deprecated";
  return "draft";
}

function inferVerificationStatus(manifest, artifactType) {
  const rawStatus = artifactType === "build"
    ? String(firstDefined(manifest.verification?.status, manifest.build?.status, "")).toLowerCase()
    : String(firstDefined(manifest.brick?.status, manifest.clone?.readiness, "")).toLowerCase();

  switch (rawStatus) {
    case "canonical":
      return "canonical";
    case "verified":
    case "passing":
    case "copy_ready":
      return "verified";
    case "candidate":
    case "partial":
    case "guided":
      return "candidate";
    case "failed":
    case "error":
      return "failed";
    case "blocked":
    case "manual_only":
    case "missing":
    case "project_bound":
      return "unverified";
    default:
      return "unverified";
  }
}

function normalizeActorRecord(input, fallbackTimestamp) {
  if (!input || typeof input !== "object") return null;
  const actor = firstDefined(
    input.actor,
    [input.actor_kind, input.actor_id].filter(Boolean).join(":"),
    input.actor_id,
    input.primary
  );
  if (!actor) return null;

  const record = { actor };
  const tool = firstDefined(input.tool, input.provider, input.method);
  const model = firstDefined(input.model);
  const timestamp = firstDefined(input.timestamp, fallbackTimestamp);
  if (tool) record.tool = String(tool);
  if (model) record.model = String(model);
  if (timestamp) record.timestamp = String(timestamp);
  return record;
}

function detectProjectsRoot(cwd) {
  const direct = path.resolve(cwd, "..", "Projects");
  if (existsSync(direct)) return direct;
  return null;
}

async function listChildDirectories(rootPath) {
  if (!rootPath || !existsSync(rootPath)) return [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootPath, entry.name));
}

async function collectSearchRoots({ manifestPath, cwd, extraRoots }) {
  const roots = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    roots.add(path.resolve(candidate));
  };

  let cursor = path.dirname(manifestPath);
  while (true) {
    add(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  cursor = cwd;
  while (true) {
    add(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  for (const root of extraRoots || []) add(root);

  const projectsRoot = detectProjectsRoot(cwd);
  add(projectsRoot);
  for (const child of await listChildDirectories(projectsRoot)) {
    add(child);
    for (const grandchild of await listChildDirectories(child)) add(grandchild);
  }

  return [...roots];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveDeclaredPath(declaredPath, searchRoots) {
  if (path.isAbsolute(declaredPath) && await pathExists(declaredPath)) {
    return path.resolve(declaredPath);
  }

  for (const root of searchRoots) {
    const candidate = path.resolve(root, declaredPath);
    if (await pathExists(candidate)) return candidate;
  }

  return null;
}

function classifyArtifactKind(targetPath, stat) {
  const posixPath = targetPath.split(path.sep).join("/");
  const lower = posixPath.toLowerCase();
  if (stat.isDirectory()) return "directory";
  if (/(^|\/)(docs?|wiki)\//.test(lower) || /\.(md|mdx|html|txt)$/i.test(lower)) return "doc";
  if (/(^|\/)(__tests__|tests?|specs?|suites?)\//.test(lower) || /\.(test|spec)\.[A-Za-z0-9]+$/i.test(lower)) return "test";
  if (/(^|\/)(migrations?)\//.test(lower) || /\.sql$/i.test(lower)) return "migration";
  if (/(^|\/)(package\.json|tsconfig(\..+)?\.json|netlify\.toml|deno\.json|deno\.jsonc|vite\.config\.[^.]+|next\.config\.[^.]+|eslint(\..+)?\.(js|cjs|mjs|json)|prettier(\..+)?\.(js|cjs|mjs|json)|\.env(\..+)?|pnpm-workspace\.yaml|turbo\.json)$/i.test(lower)) return "config";
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|mp4|mov|webm|pdf)$/i.test(lower)) return "asset";
  return "file";
}

async function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function collectDirectoryFiles(rootPath) {
  const output = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        output.push(entryPath);
      }
    }
  }

  await walk(rootPath);
  return output;
}

async function contentDigestForPath(absolutePath) {
  const stat = await fs.stat(absolutePath);
  if (stat.isFile()) {
    return {
      sha256: await fileSha256(absolutePath),
      executable: Boolean(stat.mode & 0o111)
    };
  }

  if (!stat.isDirectory()) fail(`unsupported source path type: ${absolutePath}`);
  const files = await collectDirectoryFiles(absolutePath);
  const digestInput = [];
  let executable = false;
  for (const filePath of files) {
    const fileStat = await fs.stat(filePath);
    if (fileStat.mode & 0o111) executable = true;
    digestInput.push({
      path: toPosixRelative(absolutePath, filePath),
      sha256: await fileSha256(filePath)
    });
  }
  return {
    sha256: sha256Text(stableJson(digestInput)),
    executable
  };
}

function manifestPortableDocs(manifest, artifactType) {
  if (artifactType === "build") {
    return uniqStrings([
      ...(manifest.clone?.target_docs || []),
      ...(manifest.source?.supporting_artifacts || [])
    ]).filter((entry) => /[/.]/.test(entry));
  }
  return uniqStrings(manifest.source?.supporting_artifacts || []).filter((entry) => /[/.]/.test(entry));
}

function manifestEntrypoints(manifest, artifactType) {
  if (artifactType === "build") {
    return uniqStrings([
      ...(manifest.interfaces?.entrypoints || []),
      ...(manifest.interfaces?.api_endpoints || []),
      ...(manifest.interfaces?.commands || [])
    ]);
  }
  return uniqStrings(manifest.interfaces?.public_api || []);
}

function buildDependencyRefs(manifest, artifactType) {
  if (artifactType !== "build") return [];
  const merged = new Map();
  const refs = [
    ...(manifest.composition?.brick_refs || []),
    ...(manifest.source?.derived_from_bricks || [])
  ];
  for (const ref of refs) {
    if (!ref?.brick_id) continue;
    const key = ref.brick_id;
    const previous = merged.get(key) || {
      artifact_type: "brick",
      artifact_id: key
    };
    if (ref.required !== undefined) previous.required = Boolean(ref.required);
    merged.set(key, previous);
  }
  return [...merged.values()].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function buildExternalPackages(manifest, artifactType) {
  if (artifactType !== "brick") return [];
  const packages = new Map();
  for (const dependency of manifest.supply_chain?.dependencies || []) {
    if (!dependency?.name) continue;
    packages.set(dependency.name, {
      name: dependency.name,
      version_range: dependency.version || dependency.version_range,
      scope: "runtime"
    });
  }
  for (const dependency of manifest.interfaces?.required_dependencies || []) {
    if (!dependency) continue;
    if (!packages.has(dependency)) {
      packages.set(dependency, {
        name: dependency,
        scope: "runtime"
      });
    }
  }
  return [...packages.values()].map((entry) => {
    const next = { name: entry.name };
    if (entry.version_range) next.version_range = entry.version_range;
    if (entry.scope) next.scope = entry.scope;
    return next;
  });
}

function buildEnvContract(manifest, artifactType) {
  if (artifactType === "build") {
    const env = manifest.contracts?.env || {};
    return {
      required: uniqStrings((env.required || []).map((entry) => entry?.name)),
      optional: uniqStrings((env.optional || []).map((entry) => entry?.name)),
      forbidden: uniqStrings(env.forbidden || [])
    };
  }

  const env = manifest.security?.env || {};
  const variables = Array.isArray(env.variables) ? env.variables : [];
  const required = [];
  const optional = [];
  const forbidden = [];
  for (const entry of variables) {
    if (!entry?.name) continue;
    const isOptional = env.required === false || entry.required === false || Array.isArray(entry.optional_in) || entry.optional === true;
    if (isOptional) optional.push(entry.name);
    else required.push(entry.name);
    forbidden.push(...(entry.forbidden_in || []));
  }
  return {
    required: uniqStrings(required),
    optional: uniqStrings(optional),
    forbidden: uniqStrings(forbidden)
  };
}

function buildContractHashes(manifest, artifactType, contractSections) {
  const hashes = {};
  const envSection = artifactType === "build" ? manifest.contracts?.env : manifest.security?.env;
  const interfaceSection = manifest.interfaces;
  const dataSection = artifactType === "build"
    ? { data: manifest.contracts?.data, classification: manifest.classification?.data_classes || [] }
    : { classification: manifest.classification?.data_classes || [] };
  const rlsSection = artifactType === "build" ? manifest.contracts?.rls : manifest.security?.rls;
  const dependencySection = {
    dependency_refs: contractSections.dependency_refs,
    external_packages: contractSections.external_packages
  };
  const verificationSection = artifactType === "build"
    ? { verification: manifest.verification, upgrade: manifest.upgrade }
    : { verification: manifest.quality?.verification, tests: manifest.quality?.test_commands, clone: manifest.clone };

  if (envSection && Object.keys(envSection).length) hashes.env = sha256Text(stableJson(envSection));
  if (interfaceSection && Object.keys(interfaceSection).length) hashes.interfaces = sha256Text(stableJson(interfaceSection));
  if (dataSection && Object.keys(dataSection).length) hashes.data = sha256Text(stableJson(dataSection));
  if (rlsSection && Object.keys(rlsSection).length) hashes.rls = sha256Text(stableJson(rlsSection));
  if (dependencySection.dependency_refs.length || dependencySection.external_packages.length) hashes.dependencies = sha256Text(stableJson(dependencySection));
  if (verificationSection && Object.keys(verificationSection).length) hashes.verification = sha256Text(stableJson(verificationSection));
  return hashes;
}

function inferRuntimes(manifest, artifactType) {
  if (artifactType === "build") {
    const runtimes = uniqStrings(manifest.build?.runtimes || []);
    if (runtimes.length) return runtimes;
  }

  const runtimes = new Set();
  const languages = uniqStrings(manifest.brick?.language || []);
  const frameworks = uniqStrings(manifest.brick?.frameworks || []);
  const sourcePaths = uniqStrings(manifest.source?.paths || []);

  for (const value of [...languages, ...frameworks]) {
    const lower = value.toLowerCase();
    if (["typescript", "javascript", "tsx", "jsx", "node", "npm", "pnpm"].includes(lower)) runtimes.add("node");
    if (["react", "next", "vite", "browser"].includes(lower)) runtimes.add("browser");
    if (["electron"].includes(lower)) runtimes.add("electron");
    if (["deno"].includes(lower)) runtimes.add("deno");
  }
  if (sourcePaths.some((entry) => entry.includes("supabase/functions"))) runtimes.add("supabase");
  if (sourcePaths.some((entry) => entry.includes("electron"))) runtimes.add("electron");
  if (runtimes.size === 0) {
    for (const framework of frameworks) runtimes.add(framework.toLowerCase());
    for (const language of languages) runtimes.add(language.toLowerCase());
  }
  if (runtimes.size === 0) runtimes.add("unspecified");
  return [...runtimes];
}

function buildPublicInterfaces(manifest, artifactType) {
  if (artifactType === "build") {
    return uniqStrings([
      ...(manifest.interfaces?.entrypoints || []),
      ...(manifest.interfaces?.api_endpoints || []),
      ...(manifest.interfaces?.events || []),
      ...(manifest.interfaces?.ui_surfaces || []),
      ...(manifest.interfaces?.commands || [])
    ]);
  }
  return uniqStrings(manifest.interfaces?.public_api || []);
}

function buildDataClasses(manifest) {
  return uniqStrings(manifest.classification?.data_classes || []);
}

function mapCheckStatus(value) {
  const status = String(value || "").toLowerCase();
  if (["passed", "passing", "verified", "success"].includes(status)) return "passed";
  if (["failed", "error"].includes(status)) return "failed";
  return "skipped";
}

function buildVerificationChecks(manifest, artifactType) {
  if (artifactType === "build") {
    return (manifest.verification?.evidence || []).map((entry, index) => ({
      name: entry?.name || entry?.command || `check-${index + 1}`,
      status: mapCheckStatus(entry?.status),
      ...(entry?.command ? { command: entry.command } : {}),
      ...(entry?.evidence_path ? { evidence_path: entry.evidence_path } : {})
    }));
  }

  return (manifest.quality?.verification || []).map((entry, index) => ({
    name: entry?.name || entry?.command || `check-${index + 1}`,
    status: mapCheckStatus(entry?.status),
    ...(entry?.command ? { command: entry.command } : {}),
    ...(entry?.evidence_path ? { evidence_path: entry.evidence_path } : {})
  }));
}

function buildMigrationSection(manifest, artifactType) {
  if (artifactType !== "build") return undefined;
  const hooks = uniqStrings(manifest.upgrade?.migration_hooks || []);
  if (!hooks.length) return undefined;
  return {
    manual_steps: hooks
  };
}

function buildRollbackSection(manifest, artifactType) {
  const steps = artifactType === "build"
    ? uniqStrings(manifest.clone?.rollback_steps || [])
    : [];
  if (!steps.length) return undefined;
  return {
    notes: steps.join(" "),
    commands: steps
  };
}

function createdByRecord(manifest, createdAt) {
  const actor = normalizeActorRecord(manifest.provenance?.created_by, createdAt);
  if (actor) return actor;
  return {
    actor: process.env.USER || "unknown",
    tool: "tools/sma-release.mjs",
    timestamp: createdAt
  };
}

function reviewedByRecords(manifest, createdAt) {
  return (manifest.provenance?.reviewed_by || [])
    .map((entry) => normalizeActorRecord(entry, createdAt))
    .filter(Boolean);
}

function buildSourceChain({ manifest, manifestPathRelative, artifactType, artifactId, manifestHash, sourceCommit, registryRef, registryHash }) {
  const chain = [
    {
      kind: "manifest",
      ref: manifestPathRelative,
      hash: manifestHash
    }
  ];

  if (registryRef && registryHash) {
    chain.push({
      kind: "registry",
      ref: registryRef,
      hash: registryHash
    });
  }

  if (sourceCommit) {
    chain.push({
      kind: "commit",
      ref: sourceCommit,
      hash: sourceCommit
    });
  }

  if (artifactType === "build") {
    const refs = buildDependencyRefs(manifest, artifactType);
    for (const ref of refs) {
      chain.push({
        kind: "brick",
        ref: ref.artifact_id
      });
    }
  } else {
    chain.push({
      kind: "brick",
      ref: artifactId
    });
  }

  return chain;
}

function normalizeDateTime(value, flagName) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`invalid ${flagName} value: ${value}`);
  return parsed.toISOString();
}

function fallbackHash(label, sourceValue) {
  return sha256Text(`${label}:${sourceValue}`).slice(0, 64);
}

function gitCommitForPath(targetPath) {
  try {
    const output = execFileSync("git", ["-C", path.dirname(targetPath), "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (HASH_RE.test(output)) return output;
  } catch {
    return null;
  }
  return null;
}

async function resolveRegistryHash(cwd, overrideRegistry, overrideHash, manifestPath) {
  if (overrideHash) {
    if (!HASH_RE.test(overrideHash)) fail(`invalid --registry-sha value: ${overrideHash}`);
    return {
      hash: overrideHash,
      ref: overrideRegistry || DEFAULT_REGISTRY_PATH
    };
  }

  const registryPath = path.resolve(cwd, overrideRegistry || DEFAULT_REGISTRY_PATH);
  if (await pathExists(registryPath)) {
    return {
      hash: await fileSha256(registryPath),
      ref: toPosixRelative(cwd, registryPath)
    };
  }

  return {
    hash: fallbackHash("registry", manifestPath),
    ref: null
  };
}

async function buildContentSection({ manifest, artifactType, manifestPath, searchRoots, cwd }) {
  const declaredSourcePaths = uniqStrings(manifest.source?.paths || []);
  if (declaredSourcePaths.length === 0) fail("manifest.source.paths must contain at least one path");

  const declaredDocs = manifestPortableDocs(manifest, artifactType);
  const allEntries = [];
  const missing = [];

  for (const sourcePath of declaredSourcePaths) {
    const resolved = await resolveDeclaredPath(sourcePath, searchRoots);
    if (!resolved) {
      missing.push(sourcePath);
      continue;
    }
    allEntries.push({
      declaredPath: sourcePath,
      absolutePath: resolved,
      artifactKind: null
    });
  }

  for (const docPath of declaredDocs) {
    const resolved = await resolveDeclaredPath(docPath, searchRoots);
    if (!resolved) continue;
    allEntries.push({
      declaredPath: docPath,
      absolutePath: resolved,
      artifactKind: "doc"
    });
  }

  if (missing.length) {
    fail(`could not resolve declared source path(s): ${missing.join(", ")}. Use --search-root if needed.`);
  }

  const artifactMap = new Map();
  for (const entry of allEntries) {
    const stat = await fs.stat(entry.absolutePath);
    const digest = await contentDigestForPath(entry.absolutePath);
    const kind = entry.artifactKind || classifyArtifactKind(entry.absolutePath, stat);
    const artifact = {
      path: entry.declaredPath,
      kind,
      sha256: digest.sha256
    };
    if (digest.executable) artifact.executable = true;
    artifactMap.set(artifact.path, artifact);
  }

  const artifacts = [...artifactMap.values()];
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const manifestHash = await fileSha256(manifestPath);
  const contentHash = sha256Text(stableJson({
    manifest: {
      path: toPosixRelative(cwd, manifestPath),
      sha256: manifestHash
    },
    artifacts: artifacts.map(({ path: artifactPath, kind, sha256 }) => ({ path: artifactPath, kind, sha256 }))
  }));

  return {
    content: {
      included_paths: declaredSourcePaths,
      ...(declaredDocs.length ? { portable_docs: declaredDocs } : {}),
      ...(manifestEntrypoints(manifest, artifactType).length ? { entrypoints: manifestEntrypoints(manifest, artifactType) } : {}),
      artifacts
    },
    manifestHash,
    contentHash
  };
}

function buildContractsSection(manifest, artifactType) {
  const envContract = buildEnvContract(manifest, artifactType);
  const dependency_refs = buildDependencyRefs(manifest, artifactType);
  const external_packages = buildExternalPackages(manifest, artifactType);
  const contracts = {
    hashes: {},
    runtimes: inferRuntimes(manifest, artifactType)
  };

  if (envContract.required.length) contracts.required_env = envContract.required;
  if (envContract.optional.length) contracts.optional_env = envContract.optional;
  if (envContract.forbidden.length) contracts.forbidden_env = envContract.forbidden;

  const dataClasses = buildDataClasses(manifest);
  if (dataClasses.length) contracts.data_classes = dataClasses;

  const publicInterfaces = buildPublicInterfaces(manifest, artifactType);
  if (publicInterfaces.length) contracts.public_interfaces = publicInterfaces;
  if (dependency_refs.length) contracts.dependency_refs = dependency_refs;
  if (external_packages.length) contracts.external_packages = external_packages;

  contracts.hashes = buildContractHashes(manifest, artifactType, {
    dependency_refs,
    external_packages
  });

  return contracts;
}

function buildVerificationSection(manifest, artifactType, verificationStatus) {
  const verification = {
    status: verificationStatus
  };

  if (artifactType === "build") {
    const fixtureTargets = uniqStrings(manifest.verification?.fixture_targets || []);
    const smokeCommands = uniqStrings(manifest.verification?.smoke_commands || []);
    const integrationTargets = uniqStrings(manifest.verification?.integration_targets || []);
    const checks = buildVerificationChecks(manifest, artifactType);
    if (fixtureTargets.length) verification.fixture_targets = fixtureTargets;
    if (smokeCommands.length) verification.smoke_commands = smokeCommands;
    if (integrationTargets.length) verification.integration_targets = integrationTargets;
    if (checks.length) verification.checks = checks;
    if (typeof manifest.upgrade?.rollback_supported === "boolean") verification.rollback_supported = manifest.upgrade.rollback_supported;
    else if ((manifest.clone?.rollback_steps || []).length > 0) verification.rollback_supported = true;
  } else {
    const smokeCommands = uniqStrings(manifest.quality?.test_commands || []);
    const checks = buildVerificationChecks(manifest, artifactType);
    if (smokeCommands.length) verification.smoke_commands = smokeCommands;
    if (checks.length) verification.checks = checks;
    const adaptationPoints = uniqStrings(manifest.clone?.adaptation_points || []);
    if (adaptationPoints.length) verification.integration_targets = adaptationPoints;
  }

  return verification;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (!args.manifest) fail("missing --manifest <path>");

  const cwd = process.cwd();
  const manifestPath = path.resolve(cwd, args.manifest);
  if (!await pathExists(manifestPath)) fail(`manifest not found: ${args.manifest}`);

  const manifest = await readJsonFile(manifestPath);
  const artifactType = inferArtifactType(manifest);
  const artifactId = inferArtifactId(manifest, artifactType);

  // Export choke-point: a release exposes the artifact's file tree + hashes.
  // Refuse to release closed/private source to a wider audience than allowed.
  try {
    const brickIds = artifactType === "build"
      ? [...(manifest.composition?.brick_refs || []), ...(manifest.composition?.optional_bricks || []), ...(manifest.source?.derived_from_bricks || [])]
          .map((r) => r?.brick_id).filter(Boolean)
      : [artifactId];
    assertExportAllowed({
      operation: "release",
      brickIds,
      project: manifest.source?.project || null,
      targetVisibility: manifest.publishing?.visibility || "community",
      allowClosed: Boolean(args.allowClosed),
    });
  } catch (err) {
    if (err instanceof ExportBlockedError) { console.error(err.message); process.exit(3); }
    throw err;
  }

  const version = inferVersion(manifest, artifactType, args.version);
  const createdAt = normalizeDateTime(args.createdAt, "--created-at") || new Date().toISOString();
  const publishedAt = normalizeDateTime(args.publishedAt, "--published-at");
  const channel = inferChannel({ manifest, artifactType, version, overrideChannel: args.channel });
  const releaseStatus = inferReleaseStatus({ manifest, artifactType, overrideStatus: args.status });
  const searchRoots = await collectSearchRoots({
    manifestPath,
    cwd,
    extraRoots: args.searchRoots || []
  });

  const sourceCommit = (() => {
    const fromArgs = args.sourceCommit?.trim();
    if (fromArgs) {
      if (!HASH_RE.test(fromArgs)) fail(`invalid --source-commit value: ${fromArgs}`);
      return fromArgs;
    }
    const fromManifest = String(firstDefined(manifest.source?.commit, "")).trim();
    if (HASH_RE.test(fromManifest)) return fromManifest;
    return gitCommitForPath(manifestPath) || fallbackHash("commit", manifestPath);
  })();

  const { hash: registryHash, ref: registryRef } = await resolveRegistryHash(cwd, args.registry, args.registrySha, manifestPath);
  const { content, manifestHash, contentHash } = await buildContentSection({
    manifest,
    artifactType,
    manifestPath,
    searchRoots,
    cwd
  });
  const contracts = buildContractsSection(manifest, artifactType);
  const verificationStatus = inferVerificationStatus(manifest, artifactType);
  const verification = buildVerificationSection(manifest, artifactType, verificationStatus);
  if (verification.status === "verified" || verification.status === "canonical") {
    verification.verified_at = createdAt;
  }

  const manifestPathRelative = toPosixRelative(cwd, manifestPath);
  const release = {
    release_id: `${artifactId}@${version}`,
    artifact_type: artifactType,
    artifact_id: artifactId,
    version,
    channel,
    status: releaseStatus,
    ...(manifest.source?.project ? { source_project: manifest.source.project } : {}),
    source_manifest_path: manifestPathRelative,
    created_at: createdAt,
    ...(publishedAt ? { published_at: publishedAt } : {}),
    source_commit: sourceCommit,
    registry_snapshot_sha: registryHash,
    content_hash: contentHash,
    ...(args.previousRelease ? { previous_release: args.previousRelease } : {}),
    ...((args.registryOrigin || process.env.SMA_REGISTRY_ORIGIN)
      ? { registry_origin: args.registryOrigin || process.env.SMA_REGISTRY_ORIGIN }
      : {}),
    ...(args.supersedes.length ? { supersedes: uniqStrings(args.supersedes) } : {}),
    ...(args.replacementRelease ? { replacement_release: args.replacementRelease } : {}),
    ...(args.breaking ? { breaking: true } : {}),
    ...(args.note ? { notes: args.note } : {})
  };

  const provenance = {
    created_by: createdByRecord(manifest, createdAt),
    source_chain: buildSourceChain({
      manifest,
      manifestPathRelative,
      artifactType,
      artifactId,
      manifestHash,
      sourceCommit,
      registryRef,
      registryHash
    })
  };
  const reviewedBy = reviewedByRecords(manifest, createdAt);
  if (reviewedBy.length) provenance.reviewed_by = reviewedBy;

  const releaseArtifact = {
    schema_version: SCHEMA_VERSION,
    release,
    content,
    contracts,
    verification,
    ...(buildMigrationSection(manifest, artifactType) ? { migration: buildMigrationSection(manifest, artifactType) } : {}),
    ...(buildRollbackSection(manifest, artifactType) ? { rollback: buildRollbackSection(manifest, artifactType) } : {}),
    provenance
  };

  const outputPath = path.resolve(cwd, args.out || path.join("releases", artifactId, `${version}.json`));
  const json = `${JSON.stringify(releaseArtifact, null, 2)}\n`;

  if (!args.dryRun) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, json, "utf8");
  }

  if (args.stdout) {
    process.stdout.write(json);
  } else {
    const relativeOutput = toPosixRelative(cwd, outputPath);
    console.log(`Wrote ${relativeOutput}`);
  }
}

await main();
