#!/usr/bin/env node
/**
 * sma-provenance-summary — emit a small, public-safe aggregate of the
 * provenance / license / similarity ledgers for the marketing site to surface.
 *
 * The full ledgers are large and untracked; this committed summary carries only
 * aggregate counts plus a handful of sample sealed bricks (short anchor/head
 * hashes only — never signatures or private keys). Netlify builds from git, so
 * the site reads THIS file, not the raw ledgers.
 *
 * Run: node tools/sma-provenance-summary.mjs
 * Out: security/provenance-summary.generated.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "security/provenance-summary.generated.json");

function readJson(rel) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function handle(email) {
  if (!email) return "unknown";
  return String(email).split("@")[0] || String(email);
}

function main() {
  const prov = readJson("registry/provenance-ledger.generated.json");
  const lic = readJson("registry/license-ledger.generated.json");
  const sim = readJson("security/similarity-scan.generated.json");
  if (!prov) { console.error("provenance ledger missing; run npm run provenance:ledger first"); process.exit(1); }

  const rows = prov.provenance || [];
  const hasLicense = Boolean(lic && Array.isArray(lic.licenses));
  const licRows = hasLicense ? lic.licenses : [];
  const licById = new Map(licRows.map((l) => [l.brick_id, l]));

  const sealed = rows.filter((r) => r.seal).length;
  const signed = rows.filter((r) => r.seal && r.seal.signature).length;
  // license counts only exist when the ledger does — never fabricate 0/0
  const license = hasLicense ? {
    open: licRows.filter((l) => l.openness === "open").length,
    closed: licRows.filter((l) => l.openness === "closed").length,
    source_available: licRows.filter((l) => l.openness === "source-available").length,
    total: licRows.length,
  } : null;

  // sample sealed bricks — one per project for diversity, public-safe fields only
  const samples = [];
  const seenProject = new Set();
  for (const r of rows) {
    if (!r.seal || !r.seal.anchor) continue;
    if (seenProject.has(r.project)) continue;
    const l = licById.get(r.brick_id) || {};
    const leaf = String(r.brick_id).split(".").pop() || r.brick_id;
    samples.push({
      id: leaf.slice(0, 40),
      project: r.project,
      owner: handle(r.owner),
      spdx: l.spdx || "unlicensed",
      openness: l.openness || "closed",
      contributors: Array.isArray(r.contributors) ? r.contributors.length : 1,
      commits: r.commit_count || 0,
      anchor: String(r.seal.anchor).slice(0, 16),
      head: String(r.seal.head || "").slice(0, 12),
      chain: r.seal.chain_length || 0,
    });
    seenProject.add(r.project);
    if (samples.length >= 5) break;
  }

  const summary = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    total: rows.length,
    sealed,
    signed,
    signing_key_id: prov.signing_key_id || null,
    algo: (rows[0] && rows[0].seal && rows[0].seal.algo) || "sha256-chain-v2",
    license,
    similarity: sim ? {
      scanned: sim.bricks_scanned || 0,
      near_duplicate_pairs: sim.near_duplicate_pairs || 0,
      cross_owner_theft: sim.theft_risk_pairs || 0,
    } : null,
    attestations: ["in-toto / SLSA", "SPDX 2.3", "CycloneDX 1.5"],
    samples,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ out: OUT, sealed, signed, open: license && license.open, closed: license && license.closed, cross_owner_theft: summary.similarity && summary.similarity.cross_owner_theft, samples: samples.length }, null, 2));
}

main();
