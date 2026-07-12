#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Existing logical-OR fallbacks intentionally treat every falsy value as absent; replacing them with ?? would change behavior. */
/* eslint-disable @typescript-eslint/no-base-to-string -- String() deliberately preserves the prior template-literal coercion contract for human-readable reports. */
/**
 * What: Emits a small public-safe aggregate of provenance and license evidence.
 * Why: Public surfaces cannot depend on large private ledgers or expose sensitive seal material.
 * How: Reads generated trust ledgers and writes the committed provenance summary artifact.
 * Callers: The marketing site and release documentation consume the summary.
 * Example: `node tools/sma-provenance-summary.ts`
 */
/**
 * sma-provenance-summary — emit a small, public-safe aggregate of the
 * provenance / license / similarity ledgers for the marketing site to surface.
 *
 * The full ledgers are large and untracked; this committed summary carries only
 * aggregate counts plus a handful of sample sealed bricks (short anchor/head
 * hashes only — never signatures or private keys). Netlify builds from git, so
 * the site reads THIS file, not the raw ledgers.
 *
 * Run: node tools/sma-provenance-summary.ts
 * Out: security/provenance-summary.generated.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "security/provenance-summary.generated.json");

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readJson(rel: string): unknown {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function handle(email: unknown): string {
  if (!email) return "unknown";
  return String(email).split("@")[0] || String(email);
}

// eslint-disable-next-line max-lines-per-function, complexity -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
function main() {
  const prov = readJson("registry/provenance-ledger.generated.json");
  const lic = readJson("registry/license-ledger.generated.json");
  const sim = readJson("security/similarity-scan.generated.json");
  if (!isRecord(prov)) { console.error("provenance ledger missing; run npm run provenance:ledger first"); process.exit(1); }

  const rows = recordArray(prov.provenance);
  const hasLicense = isRecord(lic) && Array.isArray(lic.licenses);
  const licRows = hasLicense ? recordArray(lic.licenses) : [];
  const licById = new Map<string, JsonRecord>(licRows.map((entry) => [String(entry.brick_id ?? ""), entry]));

  const sealed = rows.filter((row) => isRecord(row.seal)).length;
  const signed = rows.filter((row) => isRecord(row.seal) && Boolean(row.seal.signature)).length;
  // license counts only exist when the ledger does — never fabricate 0/0
  const license = hasLicense ? {
    open: licRows.filter((l) => l.openness === "open").length,
    closed: licRows.filter((l) => l.openness === "closed").length,
    source_available: licRows.filter((l) => l.openness === "source-available").length,
    total: licRows.length,
  } : null;

  // sample sealed bricks — one per project for diversity, public-safe fields only
  const samples: Record<string, string | number>[] = [];
  const seenProject = new Set<string>();
  for (const r of rows) {
    if (!isRecord(r.seal) || !r.seal.anchor) continue;
    const project = String(r.project ?? "unknown");
    if (seenProject.has(project)) continue;
    const l = licById.get(String(r.brick_id ?? "")) ?? {};
    const leaf = String(r.brick_id ?? "unknown").split(".").pop() || "unknown";
    samples.push({
      id: leaf.slice(0, 40),
      project,
      owner: handle(r.owner),
      spdx: typeof l.spdx === "string" ? l.spdx : "unlicensed",
      openness: typeof l.openness === "string" ? l.openness : "closed",
      contributors: Array.isArray(r.contributors) ? r.contributors.length : 1,
      commits: typeof r.commit_count === "number" ? r.commit_count : 0,
      anchor: String(r.seal.anchor).slice(0, 16),
      head: String(r.seal.head || "").slice(0, 12),
      chain: typeof r.seal.chain_length === "number" ? r.seal.chain_length : 0,
    });
    seenProject.add(project);
    if (samples.length >= 5) break;
  }

  const summary = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    total: rows.length,
    sealed,
    signed,
    signing_key_id: typeof prov.signing_key_id === "string" ? prov.signing_key_id : null,
    algo: isRecord(rows[0]?.seal) && typeof rows[0].seal.algo === "string" ? rows[0].seal.algo : "sha256-chain-v2",
    license,
    similarity: isRecord(sim) ? {
      scanned: typeof sim.bricks_scanned === "number" ? sim.bricks_scanned : 0,
      near_duplicate_pairs: typeof sim.near_duplicate_pairs === "number" ? sim.near_duplicate_pairs : 0,
      cross_owner_theft: typeof sim.theft_risk_pairs === "number" ? sim.theft_risk_pairs : 0,
    } : null,
    attestations: ["in-toto / SLSA", "SPDX 2.3", "CycloneDX 1.5"],
    samples,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ out: OUT, sealed, signed, open: license?.open, closed: license?.closed, cross_owner_theft: summary.similarity?.cross_owner_theft, samples: samples.length }, null, 2));
}

main();
