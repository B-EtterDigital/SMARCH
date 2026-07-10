#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = ["sma-gen3", "sma-enforcer", "sma-course-builder"];

const platformTargets = {
  "claude-code": [".claude/skills"],
  codex: [".codex/skills"],
  opencode: [".opencode/skills", ".agents/skills"]
};

function parseArgs(argv) {
  const options = { target: process.cwd(), platform: "all", instructions: true };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--target" && next) {
      options.target = path.resolve(next);
      i += 1;
    } else if (arg === "--platform" && next) {
      options.platform = next;
      i += 1;
    } else if (arg === "--no-instructions") {
      options.instructions = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Install SMA agent skills

Usage:
  node tools/install-agent-skills.mjs --target /path/to/project --platform all

Platforms:
  claude-code, codex, opencode, all

Options:
  --no-instructions  Install skills without appending AGENTS.md / CLAUDE.md snippets
`);
      process.exit(0);
    }
  }

  return options;
}

async function copyDir(source, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function appendInstructionSnippet(target, targetFile, templateFile) {
  const snippetPath = path.join(smaRoot, "templates", "agents", templateFile);
  const targetPath = path.join(target, targetFile);
  const snippet = await fs.readFile(snippetPath, "utf8");
  let existing = "";

  try {
    existing = await fs.readFile(targetPath, "utf8");
  } catch {
    // No project AGENTS.md exists yet.
  }

  if (existing.includes("# SMA Enforcement")) {
    return false;
  }

  const next = existing.trim()
    ? `${existing.trim()}\n\n${snippet}`
    : snippet;

  await fs.writeFile(targetPath, `${next.trim()}\n`);
  return true;
}

async function installForPlatform(target, platform) {
  const targets = platformTargets[platform];

  if (!targets) {
    throw new Error(`Unknown platform: ${platform}`);
  }

  for (const relativeTarget of targets) {
    for (const skillName of skillNames) {
      await copyDir(
        path.join(smaRoot, "skills", skillName),
        path.join(target, relativeTarget, skillName)
      );
    }
  }

  if (platform === "codex") {
    await appendInstructionSnippet(target, "AGENTS.md", "AGENTS.sma.md");
  }

  if (platform === "claude-code") {
    await appendInstructionSnippet(target, "CLAUDE.md", "CLAUDE.sma.md");
  }

  if (platform === "opencode") {
    await appendInstructionSnippet(target, "AGENTS.md", "OPENCODE.sma.md");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const platforms = options.platform === "all"
    ? Object.keys(platformTargets)
    : [options.platform];

  for (const platform of platforms) {
    if (options.instructions) {
      await installForPlatform(options.target, platform);
    } else {
      const targets = platformTargets[platform];

      if (!targets) {
        throw new Error(`Unknown platform: ${platform}`);
      }

      for (const relativeTarget of targets) {
        for (const skillName of skillNames) {
          await copyDir(
            path.join(smaRoot, "skills", skillName),
            path.join(options.target, relativeTarget, skillName)
          );
        }
      }
    }
    console.log(`Installed SMA skills for ${platform}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
