#!/usr/bin/env node
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
};

function parseArgs(argv) {
  const options = { manifest: "" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if ((arg === "--manifest" || arg === "-m") && next) {
      options.manifest = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA score

Usage:
  node tools/sma-score.mjs --manifest path/to/module.sweetspot.json
`);
      process.exit(0);
    }
  }

  if (!options.manifest) {
    throw new Error("Missing --manifest");
  }

  return options;
}

export function calculateScore(manifest) {
  let totalWeight = 0;
  let weighted = 0;

  for (const [gate, weight] of Object.entries(weights)) {
    const score = manifest.sweetspot?.[gate]?.score;

    if (typeof score !== "number") {
      continue;
    }

    totalWeight += weight;
    weighted += score * weight;
  }

  const cloneReadiness = manifest.clone?.readiness;
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
  const manifest = JSON.parse(await fs.readFile(options.manifest, "utf8"));
  const calculated = calculateScore(manifest);

  console.log(JSON.stringify({
    manifest: options.manifest,
    brick_id: manifest.brick?.id || "",
    declared_score: manifest.quality?.score ?? null,
    calculated_score: calculated
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

