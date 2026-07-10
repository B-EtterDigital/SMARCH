#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(root, "skills", "inventory.json");
const packagePath = path.join(root, "package.json");
const pluginPath = path.join(root, ".claude-plugin", "plugin.json");
const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");

function fail(message) {
  throw new Error(`[sma-plugin-sync] ${message}`);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.relative(root, filePath)}: ${error.message}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
}

async function validateInventory(inventory) {
  if (inventory?.schemaVersion !== 1) {
    fail("skills/inventory.json schemaVersion must be 1");
  }

  requireNonEmptyString(inventory?.plugin?.name, "plugin.name");
  requireNonEmptyString(inventory?.plugin?.description, "plugin.description");
  requireNonEmptyString(inventory?.marketplace?.name, "marketplace.name");
  requireNonEmptyString(inventory?.marketplace?.owner?.name, "marketplace.owner.name");

  if (inventory.marketplace.source !== "./") {
    fail('marketplace.source must be "./" so the repository root is installed as the plugin');
  }

  if (!Array.isArray(inventory.skills) || inventory.skills.length === 0) {
    fail("skills must be a non-empty array");
  }

  const entries = new Map();
  for (const entry of inventory.skills) {
    requireNonEmptyString(entry?.name, "skills[].name");
    requireNonEmptyString(entry?.reason, `skills.${entry.name}.reason`);
    if (typeof entry.bundle !== "boolean") {
      fail(`skills.${entry.name}.bundle must be a boolean`);
    }
    if (entries.has(entry.name)) {
      fail(`duplicate skill inventory entry: ${entry.name}`);
    }
    entries.set(entry.name, entry);
  }

  const diskSkillNames = (await fs.readdir(path.join(root, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const inventorySkillNames = [...entries.keys()].sort();

  const missing = diskSkillNames.filter((name) => !entries.has(name));
  const stale = inventorySkillNames.filter((name) => !diskSkillNames.includes(name));
  if (missing.length > 0 || stale.length > 0) {
    fail(`inventory drift (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"})`);
  }

  const bundled = inventory.skills.filter((entry) => entry.bundle).map((entry) => entry.name).sort();
  if (bundled.length === 0) {
    fail("at least one skill must have bundle=true");
  }

  for (const name of bundled) {
    try {
      await fs.access(path.join(root, "skills", name, "SKILL.md"));
    } catch {
      fail(`bundled skill is missing SKILL.md: ${name}`);
    }
  }

  return bundled;
}

function generatePlugin(inventory, version, bundled) {
  const { name, displayName, ...metadata } = inventory.plugin;
  return {
    "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name,
    ...(displayName ? { displayName } : {}),
    version,
    ...metadata,
    skills: bundled.map((skillName) => `./skills/${skillName}`),
  };
}

function generateMarketplace(inventory, version, bundled) {
  return {
    name: inventory.marketplace.name,
    description: inventory.plugin.description,
    owner: inventory.marketplace.owner,
    plugins: [
      {
        name: inventory.plugin.name,
        source: inventory.marketplace.source,
        description: inventory.plugin.description,
        version,
        skills: bundled.map((skillName) => `./skills/${skillName}`),
      },
    ],
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function syncFile(filePath, expected, check) {
  const relativePath = path.relative(root, filePath);
  if (check) {
    let actual;
    try {
      actual = await fs.readFile(filePath, "utf8");
    } catch (error) {
      fail(`${relativePath} is missing: ${error.message}`);
    }
    if (actual !== expected) {
      fail(`${relativePath} is out of sync; run node tools/sma-plugin-sync.mjs`);
    }
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, expected);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    fail(`unknown argument: ${args.find((arg) => arg !== "--check")}`);
  }
  const check = args.includes("--check");
  const [inventory, packageJson] = await Promise.all([
    readJson(inventoryPath),
    readJson(packagePath),
  ]);

  requireNonEmptyString(packageJson?.version, "package.json version");
  const bundled = await validateInventory(inventory);
  const outputs = [
    [pluginPath, serialize(generatePlugin(inventory, packageJson.version, bundled))],
    [marketplacePath, serialize(generateMarketplace(inventory, packageJson.version, bundled))],
  ];

  for (const [filePath, expected] of outputs) {
    await syncFile(filePath, expected, check);
  }

  const action = check ? "verified" : "generated";
  console.log(`[sma-plugin-sync] ${action} ${outputs.length} manifests at version ${packageJson.version}`);
  console.log(`[sma-plugin-sync] bundled skills (${bundled.length}): ${bundled.join(", ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
