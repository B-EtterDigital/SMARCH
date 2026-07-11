#!/usr/bin/env node
/**
 * What: Recalculates a manifest's weighted reuse-readiness score.
 * Why: Declared quality scores can drift from the current gate evidence and clone readiness.
 * How: Reads one manifest, applies the fixed gate weights and penalties, and prints the comparison.
 * Callers: Audits and lifecycle workflows use it to verify stored scores.
 * Example: `node tools/sma-score.ts --help`
 */
import fs from "node:fs/promises";

const weights = {
  ssa_v2: 15,
  ssi: 10,
  sstf: 15,
  spe: 10,
  srs: 10,
  sva: 15,
  srls: 10,
  sev: 5,
  ssc: 5
} as const;

interface ScoreArgs { manifest: string }

function parseArgs(argv: string[]): ScoreArgs {
  const options: ScoreArgs = { manifest: "" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if ((arg === "--manifest" || arg === "-m") && next) {
      options.manifest = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA score

Usage:
  node tools/sma-score.ts --manifest path/to/module.sweetspot.json
`);
      process.exit(0);
    }
  }

  if (!options.manifest) {
    throw new Error("Missing --manifest");
  }

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function calculateScore(manifest: unknown): number {
  const root = isRecord(manifest) ? manifest : {};
  const sweetspot = isRecord(root.sweetspot) ? root.sweetspot : {};
  let totalWeight = 0;
  let weighted = 0;

  for (const [gate, weight] of Object.entries(weights)) {
    const gateValue = sweetspot[gate];
    const score = isRecord(gateValue) ? gateValue.score : undefined;

    if (typeof score !== "number") {
      continue;
    }

    totalWeight += weight;
    weighted += score * weight;
  }

  const clone = isRecord(root.clone) ? root.clone : {};
  const cloneReadiness = clone.readiness;
  const cloneScore = cloneReadiness === "copy_ready"
    ? 100
    : cloneReadiness === "guided"
      ? 80
      : cloneReadiness === "manual_only"
        ? 50
        : 0;

  totalWeight += 5;
  weighted += cloneScore * 5;

  if (totalWeight === 0) {
    return 0;
  }

  return Math.round(weighted / totalWeight);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest: unknown = JSON.parse(await fs.readFile(options.manifest, "utf8"));
  const root = isRecord(manifest) ? manifest : {};
  const brick = isRecord(root.brick) ? root.brick : {};
  const quality = isRecord(root.quality) ? root.quality : {};
  const calculated = calculateScore(manifest);

  console.log(JSON.stringify({
    manifest: options.manifest,
    brick_id: typeof brick.id === "string" ? brick.id : "",
    declared_score: typeof quality.score === "number" ? quality.score : null,
    calculated_score: calculated
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
