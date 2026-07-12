#!/usr/bin/env node
/* Defensive external-input guards and JavaScript coercion semantics are intentional in this behavior-preserving strict-type pass. */
/* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "off", @typescript-eslint/no-unnecessary-condition: "off", @typescript-eslint/no-useless-default-assignment: "off", @typescript-eslint/prefer-nullish-coalescing: "off", @typescript-eslint/array-type: "off", max-lines-per-function: "off", complexity: "off", @typescript-eslint/prefer-optional-chain: "off", @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-type-conversion: "off", @typescript-eslint/restrict-template-expressions: "off", @typescript-eslint/use-unknown-in-catch-callback-variable: "off" */
/**
 * WHAT: Installs repository agent skills, instruction snippets, and optional ambient hooks into a target project.
 * WHY: Supported coding agents need the same current workflow files without manual copying or platform drift.
 * HOW: The command accepts a target and platform, copies skill directories, and optionally merges instructions and hooks.
 * Inputs are local repository templates; outputs stay inside the selected project's agent configuration directories.
 * Use the no-instructions flag when only skill packages should be installed.
 * Usage: node tools/install-agent-skills.ts --help
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
type Platform = keyof typeof platformTargets;

interface InstallOptions {
  target: string;
  platform: string;
  instructions: boolean;
  hooks: boolean;
  check: boolean;
}

interface CommandHook {
  type?: string;
  command?: string;
}

interface HookEntry {
  matcher?: string;
  hooks?: CommandHook[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
}

function isPlatform(value: string): value is Platform {
  return value in platformTargets;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv: string[]): InstallOptions {
  const options = { target: process.cwd(), platform: "all", instructions: true, hooks: false, check: false };

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
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Install SMA agent skills

Usage:
  node tools/install-agent-skills.ts --target /path/to/project --platform all

Platforms:
  claude-code, codex, opencode, all

Options:
  --check            Validate source skills and templates without writing files
  --no-instructions  Install skills without appending AGENTS.md / CLAUDE.md snippets
  --hooks            Merge ambient write hooks into .claude/settings.json
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function checkSources(): Promise<void> {
  const checked: string[] = [];

  for (const skillName of skillNames) {
    const skillPath = path.join(smaRoot, "skills", skillName, "SKILL.md");
    const source = await fs.readFile(skillPath, "utf8");
    if (!source.trim()) {
      throw new Error(`Skill source is empty: ${skillPath}`);
    }
    checked.push(path.relative(smaRoot, skillPath));
  }

  for (const templateFile of ["AGENTS.sma.md", "CLAUDE.sma.md", "OPENCODE.sma.md"]) {
    const templatePath = path.join(smaRoot, "templates", "agents", templateFile);
    const source = await fs.readFile(templatePath, "utf8");
    if (!source.includes("# SMA Enforcement")) {
      throw new Error(`Instruction template lacks the SMA Enforcement heading: ${templatePath}`);
    }
    checked.push(path.relative(smaRoot, templatePath));
  }

  console.log(`SMA agent skill sources: passed (${checked.length} files)`);
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function hasCommandHook(entries: HookEntry[], command: string): boolean {
  return entries.some((entry) =>
    Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command)
  );
}

async function installAmbientHooks(target: string): Promise<void> {
  const settingsPath = path.join(target, ".claude", "settings.json");
  let settings: ClaudeSettings = {};

  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as ClaudeSettings;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new Error(`Cannot merge ambient hooks into ${settingsPath}: ${errorMessage(error)}`);
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
  const hookSpecs: [string, string][] = [
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

async function copyDir(source: string, dest: string): Promise<void> {
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

async function appendInstructionSnippet(target: string, targetFile: string, templateFile: string): Promise<boolean> {
  const snippetPath = path.join(smaRoot, "templates", "agents", templateFile);
  const targetPath = path.join(target, targetFile);
  const snippet = await fs.readFile(snippetPath, "utf8");
  let existing = "";

  try {
    existing = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    // No project instruction file exists yet.
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

async function installForPlatform(target: string, platform: Platform): Promise<void> {
  const targets = platformTargets[platform];

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    await checkSources();
    return;
  }

  if (options.platform !== "all" && !isPlatform(options.platform)) {
    throw new Error(`Unknown platform: ${options.platform}`);
  }
  const platforms: Platform[] = options.platform === "all"
    ? Object.keys(platformTargets) as Platform[]
    : [options.platform];

  for (const platform of platforms) {
    if (options.instructions) {
      await installForPlatform(options.target, platform);
    } else {
      const targets = platformTargets[platform];

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
