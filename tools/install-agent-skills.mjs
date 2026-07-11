#!/usr/bin/env node
/**
 * WHAT: Installs repository agent skills, instruction snippets, and optional ambient hooks into a target project.
 * WHY: Supported coding agents need the same current workflow files without manual copying or platform drift.
 * HOW: The command accepts a target and platform, copies skill directories, and optionally merges instructions and hooks.
 * Inputs are local repository templates; outputs stay inside the selected project's agent configuration directories.
 * Use the no-instructions flag when only skill packages should be installed.
 * Usage: node tools/install-agent-skills.mjs --help
 */
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
  const options = { target: process.cwd(), platform: "all", instructions: true, hooks: false };

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
    } else if (arg === "--hooks") {
      options.hooks = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Install SMA agent skills

Usage:
  node tools/install-agent-skills.mjs --target /path/to/project --platform all

Platforms:
  claude-code, codex, opencode, all

Options:
  --no-instructions  Install skills without appending AGENTS.md / CLAUDE.md snippets
  --hooks            Merge ambient write hooks into .claude/settings.json
`);
      process.exit(0);
    }
  }

  return options;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function hasCommandHook(entries, command) {
  return entries.some((entry) =>
    Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command)
  );
}

async function installAmbientHooks(target) {
  const settingsPath = path.join(target, ".claude", "settings.json");
  /** @type {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ type?: string, command?: string }> }>> }} */
  let settings = {};

  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Cannot merge ambient hooks into ${settingsPath}: ${error.message}`);
    }
  }

  if (!settings || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error(`Cannot merge ambient hooks into ${settingsPath}: settings root must be an object`);
  }

  settings.hooks ??= {};
  if (Array.isArray(settings.hooks) || typeof settings.hooks !== "object") {
    throw new Error(`Cannot merge ambient hooks into ${settingsPath}: hooks must be an object`);
  }

  const matcher = "Write|Edit|MultiEdit|NotebookEdit";
  const hookSpecs = [
    ["PreToolUse", "pre-write.sh"],
    ["PostToolUse", "post-write.sh"],
  ];

  for (const [eventName, scriptName] of hookSpecs) {
    settings.hooks[eventName] ??= [];
    if (!Array.isArray(settings.hooks[eventName])) {
      throw new Error(`Cannot merge ambient hooks into ${settingsPath}: hooks.${eventName} must be an array`);
    }

    const command = shellQuote(path.join(smaRoot, "tools", "hooks", "ambient", scriptName));
    if (!hasCommandHook(settings.hooks[eventName], command)) {
      settings.hooks[eventName].push({
        matcher,
        hooks: [{ type: "command", command }],
      });
    }
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Installed SMA ambient hooks in ${settingsPath}`);
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

  if (options.hooks) {
    await installAmbientHooks(options.target);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
