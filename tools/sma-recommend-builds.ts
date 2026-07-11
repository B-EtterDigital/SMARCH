#!/usr/bin/env node
/**
 * What: Ranks reusable builds against a plain-language product need.
 * Why: Teams need evidence-based starting points instead of searching the portfolio manually.
 * How: Reads state, registry, and build indexes, then prints ranked human or structured results.
 * Callers: Adoption workflows and operators use it during project discovery.
 * Example: `node tools/sma-recommend-builds.ts --help`
 */

import path from "node:path";
import process from "node:process";
import { loadAdoptionContext, buildRecommendations, formatJson } from "./lib/sma-adoption.ts";

const HELP = `SMARCH recommend-builds

Usage:
  node tools/sma-recommend-builds.ts --vision "build an electron app with auth and billing"
  node tools/sma-recommend-builds.ts --query "ai image generation"
  node tools/sma-recommend-builds.ts auth billing
  node tools/sma-recommend-builds.ts --vision "ai image generation with proxy delivery" --project acme-studio
  node tools/sma-recommend-builds.ts --vision "admin operations" --json

Options:
  --vision <text>       Vision or query text to rank against
  --query <text>        Simple query string
  --project <id>        Restrict recommendations to one project
  --limit <n>           Number of results to return. Default: 8
  --top <n>             Alias for --limit
  --state <file>        Override SMA state snapshot path
  --registry <file>     Override merged registry path
  --build-index <file>  Override build index path
  --json                Print machine-readable JSON
  --help                Show this help
`;

type Recommendation = ReturnType<typeof buildRecommendations>[number];

interface CliOptions {
  buildIndex: string;
  help: boolean;
  json: boolean;
  limit: number;
  project: string;
  query: string;
  registry: string;
  state: string;
  vision: string;
}

interface RecommendationReport {
  project: string | null;
  result_count: number;
  results: Recommendation[];
  vision: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!options.vision) fail("missing --vision, --query, or positional search terms");

  const context = await loadAdoptionContext(options);
  if (!context.registry) fail(`missing merged registry at ${options.registry || context.paths.registry}`);

  const recommendations = buildRecommendations({
    state: context.state,
    registry: context.registry,
    buildIndex: context.buildIndex,
    query: options.vision,
    limit: options.limit,
    project: options.project,
  });
  const deduped = dedupeRecommendations(recommendations).slice(0, options.limit);

  const report: RecommendationReport = {
    vision: options.vision,
    project: options.project || null,
    result_count: deduped.length,
    results: deduped,
  };

  if (options.json) {
    process.stdout.write(formatJson(report));
    return;
  }

  process.stdout.write(renderHuman(report));
}

function dedupeRecommendations(entries: Recommendation[]): Recommendation[] {
  const seen = new Set<string>();
  const output: Recommendation[] = [];
  for (const entry of entries) {
    const key = [entry.type, entry.project, entry.name].join("::").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    vision: "",
    query: "",
    project: "",
    limit: 8,
    state: "",
    registry: "",
    buildIndex: "",
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--vision" && next) {
      options.vision = next;
      index += 1;
      continue;
    }
    if (arg === "--query" && next) {
      options.query = next;
      index += 1;
      continue;
    }
    if (arg === "--project" && next) {
      options.project = next;
      index += 1;
      continue;
    }
    if ((arg === "--limit" || arg === "--top") && next) {
      options.limit = Math.max(1, Number.parseInt(next, 10) || 8);
      index += 1;
      continue;
    }
    if (arg === "--state" && next) {
      options.state = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--build-index" && next) {
      options.buildIndex = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      options.vision = [options.vision, arg].filter(Boolean).join(" ").trim();
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!options.vision && options.query) options.vision = options.query;
  return options;
}

function renderHuman(report: RecommendationReport): string {
  return [
    "SMARCH recommend-builds",
    `vision: ${report.vision}`,
    report.project ? `project: ${report.project}` : null,
    "",
    ...(report.results.length > 0
      ? report.results.map((entry, index) => {
        const matches = entry.matches.length ? `matches ${entry.matches.join(", ")}` : "matches none";
        const release = entry.release_count ? `releases ${String(entry.release_count)}` : "no releases yet";
        return `${String(index + 1)}. ${String(entry.name)} [${entry.type}] (${String(entry.project)})\n   score ${String(entry.score)} · ${entry.readiness ?? "unknown"} · ${entry.trust ?? "unknown"} · ${release}\n   ${matches}\n   ${entry.why}`;
      })
      : ["No builds matched the supplied vision."]),
    "",
    "Honesty:",
    "- curated_build entries come from build manifests/build index when available",
    "- build_candidate entries are scanner-inferred and not released builds yet",
    "",
  ].filter(Boolean).join("\n");
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
