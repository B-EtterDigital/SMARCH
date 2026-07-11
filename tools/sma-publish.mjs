#!/usr/bin/env node
/**
 * What: Prepares a reviewable community-export bundle from one artifact manifest.
 * Why: Sharing source without policy, license, and leak checks can expose private material.
 * How: Reads a manifest, source paths, and trust ledgers, then writes a redacted bundle and report.
 * Callers: Release operators use it before any external publishing step.
 * Example: `node tools/sma-publish.mjs --help`
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkComposition } from "./lib/license-lattice.mjs";
import { buildLicenseIndex } from "./lib/ledger-resolve.mjs";
import { evaluateExport } from "./lib/export-guard.mjs";

const SMA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_LEDGER_PATH = path.resolve(SMA_ROOT, "registry/license-ledger.generated.json");
const SCHEMA_VERSION = "1.0.0";
const DEFAULT_OUTPUT_ROOT = "publish";
const MAX_SCAN_BYTES = 512 * 1024;
const MAX_EVIDENCE_LENGTH = 160;
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "logs"
]);
const TEXT_FILE_RE = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|ini|mdx?|txt|sql|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|html?|css|scss|less|xml)$/i;
const BINARY_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|mp4|mov|webm|pdf|zip|gz|tar|tgz|woff2?|ttf|eot|wasm|lock)$/i;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9 .:_/-]{1,120}$/i;
const HELP_TEXT = `Usage: node tools/sma-publish.mjs --manifest <path> [options]

Prepare a publish-safe community export bundle for a brick or build manifest.
This tool never uploads anything. It creates redacted metadata plus a local
publish gate report so a team can review what can be shared without exposing the
whole project.

Options:
  --manifest <path>          Source manifest path. May also be passed positionally.
  --out <dir>                Output bundle directory.
                             Default: ${DEFAULT_OUTPUT_ROOT}/<artifact-type>/<community-slug>-<hash8>
  --search-root <path>       Extra root to use when resolving source.paths and docs.
                             Repeat to add multiple entries.
  --strict                   Treat warnings as blockers.
  --stdout                   Print the full bundle payload to stdout.
  --dry-run                  Analyze without writing files. Implies --stdout.
  --help                     Show this help.

Bundle contents:
  bundle.json                Export summary and file list
  manifest.community.json    Redacted manifest for community sharing
  publish-report.json        Gate report with blockers, warnings, and safe inventory

Notes:
  - Export mode is metadata-only by design. Raw source files are not copied.
  - A blocked result still produces a report; the report tells you what must be
    fixed before a community release is honest and safe.
`;

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value) {
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function slugify(value, fallback = "artifact") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, " ")
    .toLowerCase()
    .replace(/[_\s.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function trimText(value, max = MAX_EVIDENCE_LENGTH) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function sanitizePathFragment(value) {
  return String(value || "")
    .replace(/[^\w./-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

function looksLikePlaceholder(value) {
  return /(?:example|placeholder|changeme|dummy|sample|test[-_]?only|your[_-]?|xxx|todo|fake|mock|<[^>]+>)/i.test(String(value || ""));
}

function isProbablyBinary(buffer) {
  const limit = Math.min(buffer.length, 1024);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function classifyArtifactType(manifest) {
  if (manifest?.build?.id) return "build";
  if (manifest?.brick?.id) return "brick";
  fail("manifest must contain either a top-level build or brick object");
}

function inferOriginalArtifactId(manifest, artifactType) {
  const id = artifactType === "build" ? manifest.build?.id : manifest.brick?.id;
  if (typeof id !== "string" || !id.trim()) fail(`could not infer ${artifactType} id from manifest`);
  return id.trim();
}

function inferVersion(manifest, artifactType) {
  const version = artifactType === "build" ? manifest.build?.version : manifest.brick?.version;
  if (typeof version === "string" && version.trim()) return version.trim();
  return "0.1.0";
}

function inferDisplayName(manifest, artifactType) {
  const name = artifactType === "build"
    ? firstDefined(manifest.build?.name, manifest.build?.slug, manifest.build?.id)
    : firstDefined(manifest.brick?.name, manifest.brick?.id);
  return String(name || artifactType).trim();
}

function inferCommunityArtifactId({ artifactType, manifest, originalArtifactId, manifestPath }) {
  const slug = artifactType === "build"
    ? slugify(firstDefined(manifest.build?.slug, manifest.build?.name, originalArtifactId), artifactType)
    : slugify(firstDefined(manifest.brick?.name, originalArtifactId), artifactType);
  const digest = sha256Text(`${originalArtifactId}|${manifestPath}`).slice(0, 8);
  return `community.${artifactType}.${slug}.${digest}`;
}

function parseArgs(argv) {
  const args = {
    searchRoots: [],
    stdout: false,
    dryRun: false,
    strict: false
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
    if (arg === "--strict") {
      args.strict = true;
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
      case "--search-root":
        args.searchRoots.push(next);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!args.manifest && positionals.length) args.manifest = positionals[0];
  return args;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function detectProjectsRoot(cwd) {
  const direct = path.resolve(cwd, "..", "Projects");
  return direct;
}

async function listChildDirectories(rootPath) {
  if (!rootPath || !await pathExists(rootPath)) return [];
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

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function classifyFileKind(filePath) {
  const lower = toPosix(filePath).toLowerCase();
  if (/(^|\/)(docs?|wiki)\//.test(lower) || /\.(md|mdx|txt|html?)$/i.test(lower)) return "doc";
  if (/(^|\/)(__tests__|tests?|specs?|suites?)\//.test(lower) || /\.(test|spec)\.[A-Za-z0-9]+$/i.test(lower)) return "test";
  if (/(^|\/)(migrations?)\//.test(lower) || /\.sql$/i.test(lower)) return "migration";
  if (/(^|\/)(package\.json|tsconfig(\..+)?\.json|netlify\.toml|deno\.json|deno\.jsonc|vite\.config\.[^.]+|next\.config\.[^.]+|eslint(\..+)?\.(js|cjs|mjs|json)|prettier(\..+)?\.(js|cjs|mjs|json)|pnpm-workspace\.yaml|turbo\.json|dockerfile|docker-compose\..+|\.env(\..+)?)$/i.test(lower)) return "config";
  if (BINARY_FILE_RE.test(lower)) return "asset";
  return "source";
}

async function collectDirectoryFiles(rootPath) {
  const output = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(entryPath);
        continue;
      }
      if (entry.isFile()) output.push(entryPath);
    }
  }

  await walk(rootPath);
  return output;
}

async function fileInventoryForResolvedRoot(resolvedRoot, scope, rootIndex) {
  const stat = await fs.stat(resolvedRoot);
  const files = stat.isDirectory() ? await collectDirectoryFiles(resolvedRoot) : [resolvedRoot];
  const output = [];
  let fileIndex = 0;

  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    const fileStat = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase() || ".txt";
    const alias = `${scope}/${String(rootIndex).padStart(3, "0")}/${String(fileIndex).padStart(4, "0")}${ext}`;
    const relativeToRoot = stat.isDirectory() ? sanitizePathFragment(path.relative(resolvedRoot, filePath)) : path.basename(filePath);
    output.push({
      absolutePath: filePath,
      alias,
      scope,
      size: fileStat.size,
      relative_to_root: toPosix(relativeToRoot),
      file_kind: classifyFileKind(filePath)
    });
    fileIndex += 1;
  }

  return output;
}

async function loadTextForScan(filePath) {
  const buffer = await fs.readFile(filePath);
  const binary = isProbablyBinary(buffer) || BINARY_FILE_RE.test(filePath);
  if (binary) {
    return {
      binary: true,
      scannedBytes: 0,
      truncated: false,
      text: ""
    };
  }

  const truncated = buffer.length > MAX_SCAN_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_SCAN_BYTES) : buffer;
  const text = slice.toString("utf8");
  return {
    binary: false,
    scannedBytes: slice.length,
    truncated,
    text
  };
}

function sanitizeInlineSecrets(value) {
  return String(value || "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
    .replace(/\b(?:sk|rk)_live_[A-Za-z0-9]{10,}\b/g, "[redacted-live-key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "[redacted-github-token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-access-key]")
    .replace(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, "[redacted-google-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [redacted]")
    .replace(/\/home\/[A-Za-z0-9._-]+\/[^\s"'`<>]*/g, "/home/[redacted]")
    .replace(/[A-Z]:\\Users\\[^\s"'`<>]+/g, "C:\\Users\\[redacted]");
}

function sanitizeEvidence(value) {
  return trimText(sanitizeInlineSecrets(value));
}

function addFinding(findings, seen, finding) {
  const normalized = {
    severity: finding.severity,
    rule_id: finding.rule_id,
    category: finding.category,
    scope: finding.scope || "manifest",
    location: finding.location || "manifest",
    summary: trimText(finding.summary, 220),
    evidence: sanitizeEvidence(finding.evidence || ""),
    recommendation: trimText(finding.recommendation || "", 220)
  };
  const key = stableJson(normalized);
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(normalized);
}

function collectMatches(text, regex) {
  const output = [];
  const matcher = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let match;
  while ((match = matcher.exec(text)) !== null) {
    output.push(match);
    if (match[0] === "") matcher.lastIndex += 1;
  }
  return output;
}

function scanSecrets({ text, scope, location }, findings, seen) {
  const rules = [
    {
      rule_id: "secret-private-key",
      category: "secret",
      severity: "blocker",
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      summary: "Private key material detected."
    },
    {
      rule_id: "secret-openai-key",
      category: "secret",
      severity: "blocker",
      regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
      summary: "Secret-like OpenAI key detected."
    },
    {
      rule_id: "secret-stripe-live",
      category: "secret",
      severity: "blocker",
      regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
      summary: "Live Stripe credential detected."
    },
    {
      rule_id: "secret-github-token",
      category: "secret",
      severity: "blocker",
      regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
      summary: "GitHub token detected."
    },
    {
      rule_id: "secret-aws-key",
      category: "secret",
      severity: "blocker",
      regex: /\bAKIA[0-9A-Z]{16}\b/g,
      summary: "AWS access key id detected."
    },
    {
      rule_id: "secret-google-key",
      category: "secret",
      severity: "blocker",
      regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
      summary: "Google API key detected."
    },
    {
      rule_id: "secret-bearer-token",
      category: "secret",
      severity: "blocker",
      regex: /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
      summary: "Bearer token detected."
    },
    {
      rule_id: "secret-assignment",
      category: "secret",
      severity: "blocker",
      regex: /(?:api[_-]?key|access[_-]?token|secret|client[_-]?secret|service[_-]?role[_-]?key)\s*[:=]\s*["'`]?([A-Za-z0-9_./+=:-]{16,})/gi,
      summary: "Secret-like assignment detected."
    }
  ];

  for (const rule of rules) {
    for (const match of collectMatches(text, rule.regex)) {
      const candidate = String(match[0] || "");
      if (looksLikePlaceholder(candidate)) continue;
      addFinding(findings, seen, {
        severity: rule.severity,
        rule_id: rule.rule_id,
        category: rule.category,
        scope,
        location,
        summary: rule.summary,
        evidence: candidate,
        recommendation: "Remove live credentials from publishable material and replace them with placeholders or documented env contracts."
      });
    }
  }
}

function scanInternalUrls({ text, scope, location }, findings, seen) {
  const privateUrlRe = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|internal|lan|corp|home|test))(?:[/?#:][^\s"'`<>]*)?/gi;
  for (const match of collectMatches(text, privateUrlRe)) {
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: "internal-url",
      category: "internal_url",
      scope,
      location,
      summary: "Internal or private-network URL detected.",
      evidence: match[0],
      recommendation: "Replace internal URLs with contract-level descriptions or public placeholders before publishing."
    });
  }
}

function scanAbsolutePaths({ text, scope, location }, findings, seen) {
  const pathRe = /(?:\/home\/[A-Za-z0-9._-]+\/[^\s"'`<>]+|[A-Z]:\\Users\\[^\s"'`<>]+)/g;
  for (const match of collectMatches(text, pathRe)) {
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: "absolute-local-path",
      category: "local_path",
      scope,
      location,
      summary: "Absolute local filesystem path detected.",
      evidence: match[0],
      recommendation: "Do not publish local machine paths. Replace them with artifact-local aliases or relative examples."
    });
  }
}

function scanPrivatePrompts({ text, scope, location, originalPath }, findings, seen) {
  const lowerPath = String(originalPath || "").toLowerCase();
  const hasPromptPath = /(?:^|[\\/])(prompts?|instructions?|agents?|handover)(?:[\\/]|$)|\.prompt(?:\.[a-z0-9]+)?$/i.test(lowerPath);
  const promptRe = /\b(?:system prompt|developer prompt|assistant prompt|hidden instructions?|internal prompt|prompt library|do not reveal this prompt)\b/i;
  if (hasPromptPath || promptRe.test(text)) {
    addFinding(findings, seen, {
      severity: hasPromptPath ? "blocker" : "warning",
      rule_id: "private-prompt-material",
      category: "private_prompt",
      scope,
      location,
      summary: "Prompt or agent-instruction material appears to be included.",
      evidence: hasPromptPath ? originalPath : text.match(promptRe)?.[0] || "",
      recommendation: "Keep private prompts and hidden agent instructions out of community bundles unless they are intentionally open."
    });
  }
}

function scanProjectPlanLeakage({ text, scope, location, originalPath, fileKind }, findings, seen) {
  const lowerPath = String(originalPath || "").toLowerCase();
  const blockerRe = /\b(?:ceo strategy|investor update|go[- ]to[- ]market|launch plan|phase plan|private roadmap|confidential roadmap)\b/i;
  const warningRe = /\b(?:roadmap|handover|milestone plan|quarterly plan|backlog|strategy memo|internal strategy)\b/i;

  if (blockerRe.test(text) || (fileKind === "doc" && /(ceo[-_ ]strategy|roadmap|handover|phase[-_ ]plan)/.test(lowerPath))) {
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: "project-plan-leakage",
      category: "project_plan",
      scope,
      location,
      summary: "Project-plan or strategy material appears to be included.",
      evidence: blockerRe.test(text) ? text.match(blockerRe)?.[0] || "" : originalPath,
      recommendation: "Separate product strategy, handoff, and roadmap documents from any community export bundle."
    });
    return;
  }

  if (warningRe.test(text) || (fileKind === "doc" && /(roadmap|handover|strategy)/.test(lowerPath))) {
    addFinding(findings, seen, {
      severity: "warning",
      rule_id: "project-plan-warning",
      category: "project_plan",
      scope,
      location,
      summary: "Possible project-plan or internal roadmap language detected.",
      evidence: warningRe.test(text) ? text.match(warningRe)?.[0] || "" : originalPath,
      recommendation: "Review docs for strategic or private planning content before publishing."
    });
  }
}

function scanCustomerSpecific({ text, scope, location, originalPath }, findings, seen) {
  const lowerPath = String(originalPath || "").toLowerCase();
  const blockerRe = /(?:^|[\\/._-])(customer|tenant|client)(?:[\\/._-]|$)/i;
  const warningRe = /\b(?:customer-specific|tenant-specific|client-specific|for a specific customer|per-customer|whitelabel)\b/i;
  if (blockerRe.test(lowerPath)) {
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: "customer-specific-path",
      category: "customer_specific",
      scope,
      location,
      summary: "Customer- or tenant-specific source path detected.",
      evidence: originalPath,
      recommendation: "Extract the generic capability from customer-specific variants before community publishing."
    });
    return;
  }
  if (warningRe.test(text)) {
    addFinding(findings, seen, {
      severity: "warning",
      rule_id: "customer-specific-language",
      category: "customer_specific",
      scope,
      location,
      summary: "Customer- or tenant-specific language detected.",
      evidence: text.match(warningRe)?.[0] || "",
      recommendation: "Remove customer-specific assumptions or rename them to generic capability terms before publishing."
    });
  }
}

function scanTextBlob(meta, findings, seen) {
  if (!meta.text) return;
  scanSecrets(meta, findings, seen);
  scanInternalUrls(meta, findings, seen);
  scanAbsolutePaths(meta, findings, seen);
  scanPrivatePrompts(meta, findings, seen);
  scanProjectPlanLeakage(meta, findings, seen);
  scanCustomerSpecific(meta, findings, seen);
}

let _licenseLedgerCache;
function loadLicenseLedgerSync() {
  if (_licenseLedgerCache !== undefined) return _licenseLedgerCache;
  try {
    if (!existsSync(LICENSE_LEDGER_PATH)) { _licenseLedgerCache = null; return null; }
    const data = JSON.parse(readFileSync(LICENSE_LEDGER_PATH, "utf8"));
    _licenseLedgerCache = buildLicenseIndex(data.licenses || []);
  } catch {
    _licenseLedgerCache = null;
  }
  return _licenseLedgerCache;
}

// License-lattice guard: a publish bundle is a COMMUNITY artifact. It must not
// be emitted if the build's component bricks do not permit community release.
// "You cannot publish as open what was built from something closed."
function analyzeCompositionLattice(manifest, findings, seen) {
  const ids = uniqStrings([
    ...(manifest.composition?.brick_refs || []).map((entry) => entry?.brick_id),
    ...(manifest.composition?.optional_bricks || []).map((entry) => entry?.brick_id),
    ...(manifest.source?.derived_from_bricks || []).map((entry) => entry?.brick_id)
  ]);
  if (!ids.length) {
    // A build that declares no component bricks cannot prove its openness —
    // emptying composition must not become a way to launder a closed build.
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: "license-lattice-empty-composition",
      category: "policy",
      scope: "manifest",
      location: "manifest",
      summary: "Build declares no component bricks, so its openness cannot be verified.",
      evidence: "composition.brick_refs / derived_from_bricks are empty",
      recommendation: "Declare the build's component bricks so the license lattice can verify it may be published."
    });
    return;
  }

  const ledger = loadLicenseLedgerSync();
  if (!ledger) {
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: "license-ledger-missing",
      category: "policy",
      scope: "manifest",
      location: "manifest",
      summary: "License ledger not generated; cannot prove this build's bricks permit community release.",
      evidence: "registry/license-ledger.generated.json missing",
      recommendation: "Run: node tools/sma-provenance-ledger.mjs, then re-run publish."
    });
    return;
  }

  const projectHint = manifest.source?.project || null;
  const components = ids.map((id) => {
    const row = ledger.resolve(id, projectHint)?.row;
    // fail-safe: an unknown component is treated as closed/private.
    return row
      ? { brick_id: id, spdx: row.spdx, openness: row.openness, visibility: row.visibility }
      : { brick_id: id, spdx: null, openness: "closed", visibility: "private" };
  });

  const publishing = manifest.publishing || {};
  const hasAttribution = /attribution|contributor|credits|authors|notice/.test(
    (publishing.exposed_docs || []).join(" ").toLowerCase()
  );
  // The publish tool always emits a community-visible artifact, so evaluate
  // against the community target regardless of the declared visibility.
  const check = checkComposition({
    visibility: "community",
    license: publishing.license || null,
    openness: publishing.openness || null,
    publishable: true,
    has_attribution: hasAttribution
  }, components);

  for (const violation of check.violations) {
    if (violation.severity !== "block") continue;
    addFinding(findings, seen, {
      severity: "blocker",
      rule_id: `license-lattice-${violation.code.toLowerCase().replace(/_/g, "-")}`,
      category: "policy",
      scope: "manifest",
      location: "manifest",
      summary: violation.message,
      evidence: `effective openness=${check.effective.openness}, visibility=${check.effective.visibility}`,
      recommendation: "A build cannot be published more open than the meet of its component bricks. Open/relicense the restricted bricks, or keep this build private."
    });
  }
}

function analyzePolicy(manifest, artifactType, findings, seen) {
  if (artifactType === "build") {
    const publishing = manifest.publishing || {};
    if (publishing.publishable === false) {
      addFinding(findings, seen, {
        severity: "blocker",
        rule_id: "publish-policy-disabled",
        category: "policy",
        scope: "manifest",
        location: "manifest",
        summary: "Manifest explicitly marks this build as not publishable.",
        evidence: "publishing.publishable = false",
        recommendation: "Change the publishing policy only after the artifact is intentionally prepared for community release."
      });
    }
    if (["private", "internal"].includes(String(publishing.visibility || "").toLowerCase())) {
      addFinding(findings, seen, {
        severity: "warning",
        rule_id: "publish-visibility-private",
        category: "policy",
        scope: "manifest",
        location: "manifest",
        summary: `Publishing visibility is ${publishing.visibility}.`,
        evidence: `publishing.visibility = ${publishing.visibility}`,
        recommendation: "Treat this export as metadata-only until visibility is intentionally opened for community use."
      });
    }
    analyzeCompositionLattice(manifest, findings, seen);
  } else {
    const brickStatus = String(manifest.brick?.status || "").toLowerCase();
    if (["project_bound", "manual_only"].includes(brickStatus)) {
      addFinding(findings, seen, {
        severity: "warning",
        rule_id: "brick-status-project-bound",
        category: "policy",
        scope: "manifest",
        location: "manifest",
        summary: `Brick status is ${brickStatus}, so reuse proof is still weak.`,
        evidence: `brick.status = ${brickStatus}`,
        recommendation: "Review clone safety, contracts, and ownership before publishing a community-facing bundle."
      });
    }
    // A publish bundle is a COMMUNITY artifact — a single closed brick must not
    // be published to community either. Check the brick's own openness.
    const brickId = manifest.brick?.id;
    if (brickId) {
      const evalr = evaluateExport({ brickIds: [brickId], project: manifest.source?.project || null, targetVisibility: "community" });
      if (evalr.ledger_missing) {
        addFinding(findings, seen, {
          severity: "blocker",
          rule_id: "license-ledger-missing",
          category: "policy",
          scope: "manifest",
          location: "manifest",
          summary: "License ledger not generated; cannot prove this brick may be published to community.",
          evidence: "registry/license-ledger.generated.json missing",
          recommendation: "Run: node tools/sma-provenance-ledger.mjs, then re-run publish."
        });
      }
      for (const violation of evalr.violations) {
        addFinding(findings, seen, {
          severity: "blocker",
          rule_id: `license-lattice-${violation.code.toLowerCase().replace(/_/g, "-")}`,
          category: "policy",
          scope: "manifest",
          location: "manifest",
          summary: violation.message,
          evidence: `openness=${evalr.meet_openness}, visibility=${evalr.meet_visibility}`,
          recommendation: "A closed/private brick cannot be published to community. Open or relicense it, or keep it private."
        });
      }
    }
  }

  const risk = String(firstDefined(manifest.classification?.risk, "")).toLowerCase();
  if (["high", "critical"].includes(risk)) {
    addFinding(findings, seen, {
      severity: "warning",
      rule_id: "high-risk-classification",
      category: "risk",
      scope: "manifest",
      location: "manifest",
      summary: `Artifact classification risk is ${risk}.`,
      evidence: `classification.risk = ${risk}`,
      recommendation: "High-risk artifacts need a deliberate publish review even when the bundle is redacted."
    });
  }
}

function shouldKeepFriendlyName(value) {
  const lower = String(value || "").toLowerCase();
  if (!SAFE_NAME_RE.test(String(value || ""))) return false;
  if (/(customer|tenant|client|roadmap|strategy|handover|confidential|internal)/.test(lower)) return false;
  return true;
}

function sanitizeGenericString(value, context) {
  let next = sanitizeInlineSecrets(String(value || ""));
  for (const [source, replacement] of context.stringReplacements) {
    next = next.split(source).join(replacement);
  }
  next = next.replace(/\b[A-Fa-f0-9]{40,}\b/g, "[redacted-hash]");
  return next;
}

function maybeAliasPathString(value, context) {
  const normalized = String(value || "");
  if (!normalized) return normalized;
  const replacements = context.pathReplacements;
  for (const entry of replacements) {
    if (normalized === entry.source) return entry.alias;
    if (normalized.startsWith(`${entry.source}/`) || normalized.startsWith(`${entry.source}${path.sep}`)) {
      const suffix = normalized.slice(entry.source.length).replace(/^[\\/]+/, "");
      return `${entry.alias}/${sanitizePathFragment(toPosix(suffix))}`;
    }
  }
  return normalized;
}

function createStringSanitizer(context) {
  return function sanitizeValue(value, keyPath) {
    if (typeof value !== "string") return value;

    let next = maybeAliasPathString(value, context);

    if (["owner.primary", "owner.team"].includes(keyPath)) return "redacted";
    if (/^owner\.reviewers\.\d+$/.test(keyPath)) return "redacted";
    if (["source.project", "source.repository", "source.commit", "source.archive_hash"].includes(keyPath)) return "";
    if (/^contracts\.env\.(required|optional)\.\d+\.example$/.test(keyPath)) return "<redacted-example>";
    if (/^security\.env\.variables\.\d+\.example$/.test(keyPath)) return "<redacted-example>";
    if (/^provenance\..*\.session_id$/.test(keyPath)) return undefined;
    if (/^provenance\..*\.files_touched\.\d+$/.test(keyPath)) return undefined;
    if (/^provenance\..*\.actor_id$/.test(keyPath)) return "redacted";
    if (/^provenance\.source_chain\.\d+\.project$/.test(keyPath)) return "redacted";

    if (/^provenance\.source_chain\.\d+\.artifact_id$/.test(keyPath)) {
      return context.componentAliasById.get(next) || "component-redacted";
    }

    if (/^source\.(paths|supporting_artifacts)\.\d+$/.test(keyPath)) {
      return maybeAliasPathString(next, context);
    }
    if (/^boundaries\.(owned_paths|public_paths|private_paths)\.\d+$/.test(keyPath)) {
      return maybeAliasPathString(next, context);
    }
    if (/^clone\.file_map\.\d+\.(source_path|target_path)$/.test(keyPath)) {
      return maybeAliasPathString(next, context);
    }
    if (/^quality\.verification\.\d+\.command$/.test(keyPath)) {
      return sanitizeGenericString(next, context);
    }
    if (/^clone\.(adaptation_points|install_steps|known_traps|post_clone_checks|rollback_steps)\.\d+$/.test(keyPath)) {
      return sanitizeGenericString(next, context);
    }
    if (/^interfaces\.(public_api|entrypoints|api_endpoints|commands)\.\d+$/.test(keyPath)) {
      return sanitizeGenericString(next, context);
    }

    return sanitizeGenericString(next, context);
  };
}

function walkAndSanitize(value, sanitizer, keyPath = "", redactions = []) {
  if (Array.isArray(value)) {
    const next = [];
    value.forEach((entry, index) => {
      const childPath = keyPath ? `${keyPath}.${index}` : String(index);
      const sanitized = walkAndSanitize(entry, sanitizer, childPath, redactions);
      if (sanitized !== undefined) next.push(sanitized);
    });
    return next;
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      const sanitized = sanitizer(value, keyPath);
      if (sanitized !== value) {
        redactions.push({
          path: keyPath || "<root>",
          before: trimText(value, 60),
          after: trimText(sanitized, 60)
        });
      }
      return sanitized;
    }
    return value;
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    const sanitized = walkAndSanitize(entry, sanitizer, childPath, redactions);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function buildRootAliasMaps(resolvedRoots) {
  const rootEntries = [];
  const pathReplacements = [];

  resolvedRoots.forEach((root, index) => {
    const alias = `artifact://${root.scope}-${String(index + 1).padStart(3, "0")}`;
    rootEntries.push({
      scope: root.scope,
      alias,
      kind: root.kind
    });

    const normalizedDeclared = toPosix(root.declaredPath);
    const normalizedAbsolute = toPosix(root.absolutePath);
    pathReplacements.push({ source: normalizedDeclared, alias });
    pathReplacements.push({ source: normalizedAbsolute, alias });
  });

  pathReplacements.sort((left, right) => right.source.length - left.source.length);
  return { rootEntries, pathReplacements };
}

function buildComponentAliasMap(manifest, artifactType) {
  const map = new Map();
  if (artifactType !== "build") return map;

  const refs = uniqStrings([
    ...(manifest.composition?.brick_refs || []).map((entry) => entry?.brick_id),
    ...(manifest.composition?.optional_bricks || []).map((entry) => entry?.brick_id),
    ...(manifest.source?.derived_from_bricks || []).map((entry) => entry?.brick_id)
  ]);

  refs.forEach((brickId, index) => {
    map.set(brickId, `component-${String(index + 1).padStart(3, "0")}`);
  });
  return map;
}

function applyArtifactIdentityRedaction(redacted, artifactType, communityArtifactId, safeDisplayName) {
  if (artifactType === "build") {
    redacted.build.id = communityArtifactId;
    redacted.build.visibility = "community";
    if (!shouldKeepFriendlyName(redacted.build.name)) redacted.build.name = safeDisplayName;
    if (!shouldKeepFriendlyName(redacted.build.slug)) redacted.build.slug = slugify(safeDisplayName, "community-build");
  } else {
    redacted.brick.id = communityArtifactId;
    if (!shouldKeepFriendlyName(redacted.brick.name)) redacted.brick.name = safeDisplayName;
  }
}

function applyBuildRefRedaction(redacted, componentAliasById) {
  if (!redacted || !redacted.composition) return;
  const replaceRef = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.brick_id) entry.brick_id = componentAliasById.get(entry.brick_id) || "component-redacted";
    if (entry.path) entry.path = "artifact://component";
    if (entry.project) entry.project = "redacted";
    return entry;
  };

  for (const field of ["brick_refs", "optional_bricks"]) {
    if (Array.isArray(redacted.composition[field])) {
      redacted.composition[field] = redacted.composition[field].map((entry) => replaceRef(entry));
    }
  }

  if (Array.isArray(redacted.source?.derived_from_bricks)) {
    redacted.source.derived_from_bricks = redacted.source.derived_from_bricks.map((entry) => replaceRef(entry));
  }

  if (Array.isArray(redacted.composition?.alternatives)) {
    redacted.composition.alternatives = redacted.composition.alternatives.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      return {
        ...entry,
        brick_ids: Array.isArray(entry.brick_ids)
          ? entry.brick_ids.map((brickId) => componentAliasById.get(brickId) || "component-redacted")
          : []
      };
    });
  }

  if (Array.isArray(redacted.composition?.flows)) {
    redacted.composition.flows = redacted.composition.flows.map((flow) => {
      if (!flow || typeof flow !== "object") return flow;
      return {
        ...flow,
        steps: Array.isArray(flow.steps)
          ? flow.steps.map((step) => ({
            ...step,
            brick_refs: Array.isArray(step.brick_refs)
              ? step.brick_refs.map((brickId) => componentAliasById.get(brickId) || "component-redacted")
              : []
          }))
          : []
      };
    });
  }
}

function buildRedactedManifest({
  manifest,
  artifactType,
  communityArtifactId,
  safeDisplayName,
  rootAliasInfo,
  componentAliasById
}) {
  const redacted = cloneJson(manifest);
  const redactions = [];
  applyArtifactIdentityRedaction(redacted, artifactType, communityArtifactId, safeDisplayName);
  applyBuildRefRedaction(redacted, componentAliasById);

  const sanitizerContext = {
    pathReplacements: rootAliasInfo.pathReplacements,
    stringReplacements: [
      [inferOriginalArtifactId(manifest, artifactType), communityArtifactId],
      ...[...componentAliasById.entries()]
    ],
    componentAliasById
  };
  const sanitizeValue = createStringSanitizer(sanitizerContext);
  const sanitized = walkAndSanitize(redacted, sanitizeValue, "", redactions);

  if (sanitized.source) {
    sanitized.source.project = "";
    sanitized.source.repository = "";
    sanitized.source.commit = "";
    sanitized.source.archive_hash = "";
  }

  return {
    manifest: sanitized,
    redactions
  };
}

function summarizeFindings(findings, strictMode) {
  const counts = {
    blocker: findings.filter((entry) => entry.severity === "blocker").length,
    warning: findings.filter((entry) => entry.severity === "warning").length,
    info: findings.filter((entry) => entry.severity === "info").length
  };

  let status = "exportable";
  if (counts.blocker > 0 || (strictMode && counts.warning > 0)) status = "blocked";
  else if (counts.warning > 0) status = "review_required";

  return {
    status,
    counts,
    strict_mode: strictMode
  };
}

function buildScannedFileSummary(scanResults) {
  return scanResults.map((entry) => ({
    alias: entry.alias,
    scope: entry.scope,
    file_kind: entry.file_kind,
    size_bytes: entry.size,
    sha256: entry.sha256,
    text_scanned: entry.text_scanned,
    truncated: entry.truncated,
    finding_count: entry.finding_count
  }));
}

async function preparePublishBundle({ manifestPath, searchRoots, cwd, strictMode, outDirOverride }) {
  const manifest = await readJsonFile(manifestPath);
  const artifactType = classifyArtifactType(manifest);
  const originalArtifactId = inferOriginalArtifactId(manifest, artifactType);
  const version = inferVersion(manifest, artifactType);
  const originalDisplayName = inferDisplayName(manifest, artifactType);
  const safeDisplayName = shouldKeepFriendlyName(originalDisplayName)
    ? originalDisplayName
    : `${artifactType === "build" ? "Community Build" : "Community Brick"} ${sha256Text(originalArtifactId).slice(0, 6)}`;
  const communityArtifactId = inferCommunityArtifactId({ artifactType, manifest, originalArtifactId, manifestPath });

  const declaredSourcePaths = uniqStrings(manifest.source?.paths || []);
  if (declaredSourcePaths.length === 0) fail("manifest.source.paths must contain at least one path");

  const declaredDocPaths = artifactType === "build"
    ? uniqStrings([...(manifest.clone?.target_docs || []), ...(manifest.source?.supporting_artifacts || [])])
    : uniqStrings(manifest.source?.supporting_artifacts || []);

  const resolvedRoots = [];
  const unresolved = [];

  const sourceEntries = declaredSourcePaths.map((declaredPath) => ({ declaredPath, scope: "source", kind: "source_root" }));
  const docEntries = declaredDocPaths.map((declaredPath) => ({ declaredPath, scope: "doc", kind: "doc_root" }));

  for (const entry of [...sourceEntries, ...docEntries]) {
    const resolvedPath = await resolveDeclaredPath(entry.declaredPath, searchRoots);
    if (!resolvedPath) {
      unresolved.push(entry);
      continue;
    }
    resolvedRoots.push({
      ...entry,
      absolutePath: resolvedPath
    });
  }

  const findings = [];
  const seenFindings = new Set();
  analyzePolicy(manifest, artifactType, findings, seenFindings);

  for (const entry of unresolved) {
    addFinding(findings, seenFindings, {
      severity: entry.scope === "source" ? "warning" : "info",
      rule_id: "missing-declared-path",
      category: "resolution",
      scope: "manifest",
      location: "manifest",
      summary: `Declared ${entry.scope} path could not be resolved.`,
      evidence: entry.declaredPath,
      recommendation: "Either add --search-root for local analysis or remove stale publish docs/source references before export."
    });
  }

  const rootAliasInfo = buildRootAliasMaps(resolvedRoots);
  const componentAliasById = buildComponentAliasMap(manifest, artifactType);
  const scanResults = [];

  const manifestText = await fs.readFile(manifestPath, "utf8");
  scanTextBlob(
    {
      text: manifestText,
      scope: "manifest",
      location: "manifest/module.sweetspot.json",
      originalPath: path.basename(manifestPath),
      fileKind: "manifest"
    },
    findings,
    seenFindings
  );

  for (let rootIndex = 0; rootIndex < resolvedRoots.length; rootIndex += 1) {
    const root = resolvedRoots[rootIndex];
    const rootFiles = await fileInventoryForResolvedRoot(root.absolutePath, root.scope, rootIndex + 1);

    for (const fileEntry of rootFiles) {
      const buffer = await fs.readFile(fileEntry.absolutePath);
      const scan = await loadTextForScan(fileEntry.absolutePath);
      const beforeCount = findings.length;
      if (!scan.binary && (TEXT_FILE_RE.test(fileEntry.absolutePath) || ["doc", "source", "migration", "config", "test"].includes(fileEntry.file_kind))) {
        scanTextBlob(
          {
            text: scan.text,
            scope: root.scope,
            location: fileEntry.alias,
            originalPath: fileEntry.relative_to_root,
            fileKind: fileEntry.file_kind
          },
          findings,
          seenFindings
        );
      }
      scanResults.push({
        alias: fileEntry.alias,
        scope: fileEntry.scope,
        file_kind: fileEntry.file_kind,
        size: fileEntry.size,
        sha256: sha256Buffer(buffer),
        text_scanned: !scan.binary,
        truncated: scan.truncated,
        finding_count: findings.length - beforeCount
      });
    }
  }

  const decision = summarizeFindings(findings, strictMode);
  const { manifest: redactedManifest, redactions } = buildRedactedManifest({
    manifest,
    artifactType,
    communityArtifactId,
    safeDisplayName,
    rootAliasInfo,
    componentAliasById
  });

  const communitySlug = slugify(firstDefined(
    artifactType === "build" ? redactedManifest.build?.slug : redactedManifest.brick?.name,
    safeDisplayName,
    communityArtifactId
  ), artifactType);
  const communityShortHash = sha256Text(communityArtifactId).slice(0, 8);
  const bundleDir = path.resolve(outDirOverride || path.join(cwd, DEFAULT_OUTPUT_ROOT, artifactType, `${communitySlug}-${communityShortHash}`));

  const report = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    export_mode: "metadata_only",
    artifact: {
      type: artifactType,
      community_id: communityArtifactId,
      version,
      name: safeDisplayName
    },
    source_artifact: {
      original_id: originalArtifactId,
      original_name: inferDisplayName(manifest, artifactType),
      manifest_path: toPosix(path.relative(cwd, manifestPath))
    },
    decision,
    findings,
    root_aliases: rootAliasInfo.rootEntries,
    scanned_files: buildScannedFileSummary(scanResults),
    redaction_summary: {
      count: redactions.length,
      sample: redactions.slice(0, 40)
    },
    limitations: [
      "This tool does not prove the artifact is legally or commercially safe to publish.",
      "Heuristics are pragmatic and can miss subtle leaks or over-flag generic language.",
      "Raw source code is intentionally not copied into the export bundle."
    ]
  };

  const bundle = {
    schema_version: SCHEMA_VERSION,
    generated_at: report.generated_at,
    export_kind: "smarch_publish_bundle",
    export_mode: "metadata_only",
    artifact: report.artifact,
    source_artifact: report.source_artifact,
    decision,
    files: {
      redacted_manifest: "manifest.community.json",
      report: "publish-report.json"
    }
  };

  return {
    bundleDir,
    bundle,
    report,
    redactedManifest
  };
}

async function writeBundle(bundleDir, { bundle, report, redactedManifest }) {
  await fs.mkdir(bundleDir, { recursive: true });
  // Always write the report so the operator can see what must be fixed.
  await fs.writeFile(path.join(bundleDir, "publish-report.json"), JSON.stringify(sortJson(report), null, 2));
  // A blocked result must NEVER emit a community-visible artifact (bundle or
  // redacted manifest). This is the hard stop that keeps closed-source-derived
  // or leak-flagged builds from being released as open.
  if (report?.decision?.status === "blocked") return;
  await fs.writeFile(path.join(bundleDir, "bundle.json"), JSON.stringify(sortJson(bundle), null, 2));
  await fs.writeFile(path.join(bundleDir, "manifest.community.json"), JSON.stringify(sortJson(redactedManifest), null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (!args.manifest) fail("missing required --manifest <path>");

  const cwd = process.cwd();
  const manifestPath = path.resolve(args.manifest);
  if (!await pathExists(manifestPath)) fail(`manifest not found: ${manifestPath}`);

  const searchRoots = await collectSearchRoots({
    manifestPath,
    cwd,
    extraRoots: args.searchRoots || []
  });

  const prepared = await preparePublishBundle({
    manifestPath,
    searchRoots,
    cwd,
    strictMode: Boolean(args.strict),
    outDirOverride: args.out
  });

  if (!args.dryRun) {
    await writeBundle(prepared.bundleDir, prepared);
  }

  if (args.stdout) {
    console.log(JSON.stringify(sortJson({
      output_dir: prepared.bundleDir,
      ...prepared
    }), null, 2));
  } else {
    console.log(JSON.stringify({
      output_dir: prepared.bundleDir,
      status: prepared.report.decision.status,
      blocker_count: prepared.report.decision.counts.blocker,
      warning_count: prepared.report.decision.counts.warning,
      export_mode: "metadata_only"
    }, null, 2));
  }
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));
