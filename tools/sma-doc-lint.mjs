#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SHELL_FENCE = /^(?:bash|sh|shell|console)$/i;

/** @typedef {{ root: string, json: boolean, selftest: boolean, help: boolean }} DocLintOptions */
/** @typedef {{ rule: string, file: string, line: number, message: string }} Finding */
/** @typedef {{ status: "passed" | "failed", root: string, files_checked: number, violation_count: number, by_rule: Record<string, number>, findings: Finding[] }} DocReport */
/** @typedef {{ selftest: true, status: "passed" | "failed", cases_total: number, cases_passed: number, cases: SelftestCase[], failures: string[] }} SelftestReport */
/** @typedef {{ name: string, passed: boolean, found: string[] }} SelftestCase */
/** @typedef {{ text: string, offsets: number[] }} VisibleMarkdown */
/** @typedef {{ label: string, target: string, line: number, labelStart: number, labelEnd: number }} MarkdownLink */
/** @typedef {{ code: string, line: number }} ShellFence */
/** @typedef {{ file: string, source: string }} RunnerSource */

const HELP = `sma-doc-lint — keep SMARCH documentation explained and executable.

Usage:
  node tools/sma-doc-lint.mjs
  node tools/sma-doc-lint.mjs --root <path> --json
  node tools/sma-doc-lint.mjs --selftest

Checks:
  1. Every docs/*.md file has introductory prose before its first H2.
  2. The first use of each glossary acronym links to docs/GLOSSARY.md.
  3. Shell command fences under docs/intro/ are registered by a journey runner.
  4. Relative Markdown links and local anchors resolve.

Exit codes:
  0  all checks passed
  1  one or more documentation violations
  2  configuration or I/O error
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.selftest) {
    const result = await runSelftest();
    printResult(result, options.json);
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }

  const report = await lintDocs(options.root);
  printResult(report, options.json);
  if (report.status !== "passed") process.exitCode = 1;
}

/** @param {string[]} argv @returns {DocLintOptions} */
function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false, selftest: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a path");
      options.root = path.resolve(value);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** @param {string} root @returns {Promise<DocReport>} */
async function lintDocs(root) {
  const docsRoot = path.join(root, "docs");
  const glossaryPath = path.join(docsRoot, "GLOSSARY.md");
  if (!existsSync(docsRoot)) throw new Error(`docs directory not found: ${relative(root, docsRoot)}`);
  if (!existsSync(glossaryPath)) throw new Error(`glossary not found: ${relative(root, glossaryPath)}`);

  const allDocs = await walkMarkdown(docsRoot);
  const topLevelDocs = allDocs.filter((file) => path.dirname(file) === docsRoot);
  const introDocs = allDocs.filter((file) => isWithin(path.join(docsRoot, "intro"), file));
  const glossary = await fs.readFile(glossaryPath, "utf8");
  const acronyms = glossaryAcronyms(glossary);
  const runnerSources = await readJourneyRunners(path.join(root, "tools", "evals", "journeys"));
  /** @type {Finding[]} */
  const findings = [];

  for (const file of topLevelDocs) {
    const markdown = await fs.readFile(file, "utf8");
    checkIntroParagraph(root, file, markdown, findings);
    if (file !== glossaryPath) checkAcronymLinks(root, file, markdown, glossaryPath, acronyms, findings);
  }

  for (const file of introDocs) {
    const markdown = await fs.readFile(file, "utf8");
    checkJourneyRegistration(root, file, markdown, runnerSources, findings);
  }

  const markdownByPath = new Map();
  for (const file of allDocs) markdownByPath.set(file, await fs.readFile(file, "utf8"));
  for (const [file, markdown] of markdownByPath) {
    checkInternalLinks(root, file, markdown, markdownByPath, findings);
  }

  return makeReport(root, allDocs.length, findings);
}

/** @param {string} root @param {string} file @param {string} markdown @param {Finding[]} findings */
function checkIntroParagraph(root, file, markdown, findings) {
  const h2 = markdown.search(/^##\s+/m);
  if (h2 < 0) return;
  const before = stripFrontmatter(markdown.slice(0, h2))
    .replace(/^#\s+.*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const paragraphs = before.split(/\n\s*\n/).map((/** @type {string} */ value) => value.trim()).filter(Boolean);
  if (paragraphs.some((paragraph) => /[A-Za-z0-9]/.test(stripMarkdown(paragraph)))) return;
  findings.push(finding(root, file, 1, "intro-paragraph", "add an introductory paragraph before the first H2"));
}

/** @param {string} root @param {string} file @param {string} markdown @param {string} glossaryPath @param {string[]} acronyms @param {Finding[]} findings */
function checkAcronymLinks(root, file, markdown, glossaryPath, acronyms, findings) {
  const visible = visibleMarkdown(markdown);
  for (const acronym of acronyms) {
    const match = new RegExp(`\\b${escapeRegex(acronym)}\\b`).exec(visible.text);
    if (!match) continue;
    const originalIndex = visible.offsets[match.index];
    const link = enclosingMarkdownLink(markdown, originalIndex);
    if (link && resolvesToFile(file, link.target, glossaryPath)) continue;
    findings.push(finding(
      root,
      file,
      lineAt(markdown, originalIndex),
      "acronym-glossary-link",
      `first use of ${acronym} must link to ${relative(path.dirname(file), glossaryPath)}`,
    ));
  }
}

/** @param {string} root @param {string} file @param {string} markdown @param {RunnerSource[]} runnerSources @param {Finding[]} findings */
function checkJourneyRegistration(root, file, markdown, runnerSources, findings) {
  const relativeDoc = relative(root, file);
  for (const fence of shellFences(markdown)) {
    const registered = runnerSources.some(({ source }) =>
      source.includes(relativeDoc)
      || source.includes(path.basename(file))
      || source.includes(fence.code.trim())
      || runnerDiscoversIntroCommands(source),
    );
    if (registered) continue;
    findings.push(finding(
      root,
      file,
      fence.line,
      "intro-command-registration",
      `shell command fence is not registered in tools/evals/journeys/ (${firstCommand(fence.code)})`,
    ));
  }
}

/**
* @param {string} source
*/
function runnerDiscoversIntroCommands(source) {
  const selectsIntroTree = /INTRO_DIR/.test(source) || /["']docs["'][\s\S]{0,80}["']intro["']/.test(source);
  const parsesShellFences = /parseBashBlocks|```(?:bash|sh|shell)/i.test(source);
  const executesCommands = /spawnSync|execFileSync|execSync/.test(source);
  return selectsIntroTree && parsesShellFences && executesCommands;
}

/** @param {string} root @param {string} file @param {string} markdown @param {Map<string, string>} markdownByPath @param {Finding[]} findings */
function checkInternalLinks(root, file, markdown, markdownByPath, findings) {
  for (const link of markdownLinks(markdown)) {
    const target = link.target.trim().replace(/^<|>$/g, "");
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [rawPath, rawAnchor = ""] = target.split("#", 2);
    let decodedPath;
    let decodedAnchor;
    try {
      decodedPath = decodeURIComponent(rawPath.split("?")[0]);
      decodedAnchor = decodeURIComponent(rawAnchor);
    } catch {
      findings.push(finding(root, file, link.line, "internal-link", `invalid URL encoding in link target: ${target}`));
      continue;
    }
    let resolved = decodedPath ? path.resolve(path.dirname(file), decodedPath) : file;
    if (existsSync(resolved) && !path.extname(resolved)) {
      const readme = path.join(resolved, "README.md");
      if (existsSync(readme)) resolved = readme;
    }
    if (!existsSync(resolved)) {
      findings.push(finding(root, file, link.line, "internal-link", `link target does not exist: ${target}`));
      continue;
    }
    if (!decodedAnchor || path.extname(resolved).toLowerCase() !== ".md") continue;
    let targetMarkdown = markdownByPath.get(resolved) ?? null;
    if (targetMarkdown === null) {
      try { targetMarkdown = readFileSync(resolved, "utf8"); } catch { targetMarkdown = null; }
    }
    if (targetMarkdown === null) continue;
    const anchors = markdownAnchors(targetMarkdown);
    if (!anchors.has(normalizeAnchor(decodedAnchor))) {
      findings.push(finding(root, file, link.line, "internal-link", `link anchor does not exist: ${target}`));
    }
  }
}

/**
* @param {string} markdown
*/
function glossaryAcronyms(markdown) {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => stripMarkdown(match[1]).trim())
    .filter((term) => /^[A-Z][A-Z0-9-]{1,}$/.test(term));
}

/**
* @param {string} markdown
*/
/** @param {string} markdown @returns {VisibleMarkdown} */
function visibleMarkdown(markdown) {
  const masked = [...markdown];
  /** @param {number} start @param {number} end */
  const mask = (start, end) => { for (let index = start; index < end; index += 1) masked[index] = " "; };
  for (const match of markdown.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~/g)) mask(match.index, match.index + match[0].length);
  for (const match of markdown.matchAll(/`[^`\n]*`|<!--[\s\S]*?-->/g)) mask(match.index, match.index + match[0].length);
  return { text: masked.join(""), offsets: Array.from({ length: markdown.length }, (_, index) => index) };
}

/** @param {string} markdown @param {number} index @returns {MarkdownLink | null} */
function enclosingMarkdownLink(markdown, index) {
  for (const link of markdownLinks(markdown)) {
    if (index >= link.labelStart && index < link.labelEnd) return link;
  }
  return null;
}

/**
* @param {string} markdown
*/
function markdownLinks(markdown) {
  /** @type {MarkdownLink[]} */
  const links = [];
  const pattern = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const labelStart = match.index + 1;
    links.push({
      label: match[1],
      target: match[2],
      line: lineAt(markdown, match.index),
      labelStart,
      labelEnd: labelStart + match[1].length,
    });
  }
  return links;
}

/**
* @param {string} markdown
*/
function markdownAnchors(markdown) {
  const anchors = new Set();
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = normalizeAnchor(stripMarkdown(match[1]));
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/<a\s+(?:name|id)=["']([^"']+)["'][^>]*>/gi)) anchors.add(normalizeAnchor(match[1]));
  return anchors;
}

/**
* @param {string} value
*/
function normalizeAnchor(value) {
  return value.trim().toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
* @param {string} markdown
*/
function shellFences(markdown) {
  /** @type {ShellFence[]} */
  const fences = [];
  const pattern = /```([^\n\r]*)\r?\n([\s\S]*?)\r?\n```/g;
  for (const match of markdown.matchAll(pattern)) {
    const language = match[1].trim().split(/\s+/)[0];
    if (!SHELL_FENCE.test(language)) continue;
    fences.push({ code: match[2], line: lineAt(markdown, match.index) });
  }
  return fences;
}

/** @param {string} dir @returns {Promise<RunnerSource[]>} */
async function readJourneyRunners(dir) {
  if (!existsSync(dir)) return [];
  const files = await walkFiles(dir, (/** @type {string} */ file) => /\.(?:mjs|js|cjs|ts)$/.test(file));
  return Promise.all(files.map(async (file) => ({ file, source: await fs.readFile(file, "utf8") })));
}

/** @param {string} dir @returns {Promise<string[]>} */
async function walkMarkdown(dir) {
  return walkFiles(dir, (/** @type {string} */ file) => file.endsWith(".md"));
}

/** @param {string} dir @param {(file: string) => boolean} include @returns {Promise<string[]>} */
async function walkFiles(dir, include) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && include(full)) files.push(full);
    }
  }
  await walk(dir);
  return files.sort();
}

/** @param {string} sourceFile @param {string} target @param {string} expectedFile */
function resolvesToFile(sourceFile, target, expectedFile) {
  const rawPath = target.replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
  if (!rawPath) return sourceFile === expectedFile;
  try {
    return path.resolve(path.dirname(sourceFile), decodeURIComponent(rawPath)) === expectedFile;
  } catch {
    return false;
  }
}

/**
* @param {string} markdown
*/
function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/**
* @param {string} value
*/
function stripMarkdown(value) {
  return value
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "");
}

/**
* @param {string} code
*/
function firstCommand(code) {
  return code.split(/\r?\n/).map((/** @type {string} */ line) => line.trim()).find((/** @type {string} */ line) => line && !line.startsWith("#")) || "empty block";
}

/** @param {string} markdown @param {number} index */
function lineAt(markdown, index) {
  return markdown.slice(0, index).split(/\r?\n/).length;
}

/**
* @param {string} value
*/
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} parent @param {string} file */
function isWithin(parent, file) {
  const rel = path.relative(parent, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** @param {string} root @param {string} file */
function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/** @param {string} root @param {string} file @param {number} line @param {string} rule @param {string} message @returns {Finding} */
function finding(root, file, line, rule, message) {
  return { rule, file: relative(root, file), line, message };
}

/** @param {string} root @param {number} filesChecked @param {Finding[]} findings @returns {DocReport} */
function makeReport(root, filesChecked, findings) {
  const byRule = Object.fromEntries(
    ["intro-paragraph", "acronym-glossary-link", "intro-command-registration", "internal-link"]
      .map((rule) => [rule, findings.filter((/** @type {{ rule: string; }} */ item) => item.rule === rule).length]),
  );
  return {
    status: findings.length === 0 ? "passed" : "failed",
    root,
    files_checked: filesChecked,
    violation_count: findings.length,
    by_rule: byRule,
    findings,
  };
}

/** @param {DocReport | SelftestReport} report @param {boolean} json */
function printResult(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if ('selftest' in report) {
    console.log(`[doc-lint] selftest ${report.status.toUpperCase()} — ${report.cases_passed}/${report.cases_total} case(s)`);
    for (const failure of report.failures) console.log(`  FAIL ${failure}`);
    return;
  }
  console.log(`[doc-lint] ${report.status.toUpperCase()} — ${report.files_checked} file(s), ${report.violation_count} violation(s)`);
  for (const item of report.findings) console.log(`  ${item.file}:${item.line} [${item.rule}] ${item.message}`);
}

/** @returns {Promise<SelftestReport>} */
async function runSelftest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sma-doc-lint-"));
  /** @type {SelftestCase[]} */
  const cases = [];
  try {
    const base = async () => {
      await fs.rm(temp, { recursive: true, force: true });
      await fs.mkdir(path.join(temp, "docs", "intro"), { recursive: true });
      await fs.mkdir(path.join(temp, "tools", "evals", "journeys"), { recursive: true });
      await fs.writeFile(path.join(temp, "docs", "GLOSSARY.md"), "# Glossary\n\nDefinitions used by these docs.\n\n## SMA\n\nSweetspot Modular Architecture.\n");
      await fs.writeFile(path.join(temp, "docs", "GUIDE.md"), "# Guide\n\nThe [SMA](GLOSSARY.md#sma) guide starts here.\n\n## Next\n\nContinue.\n");
      await fs.writeFile(path.join(temp, "docs", "intro", "lesson.md"), "# Lesson\n\nRun the registered exercise.\n\n\u0060\u0060\u0060bash\necho registered\n\u0060\u0060\u0060\n");
      await fs.writeFile(path.join(temp, "tools", "evals", "journeys", "lesson.mjs"), "const lesson = 'docs/intro/lesson.md';\nvoid lesson;\n");
    };
    /** @param {string} name @param {string | null} rule @param {(() => Promise<void>) | null} mutate */
    const expect = async (name, rule, mutate) => {
      await base();
      if (mutate) await mutate();
      const report = await lintDocs(temp);
      const passed = rule ? report.findings.some((item) => item.rule === rule) : report.findings.length === 0;
      cases.push({ name, passed, found: report.findings.map((item) => item.rule) });
    };

    await expect("valid fixture", null, null);
    await expect("missing intro paragraph", "intro-paragraph", async () => {
      await fs.writeFile(path.join(temp, "docs", "BAD.md"), "# Bad\n\n## Details\n\nToo late.\n");
    });
    await expect("unlinked first acronym", "acronym-glossary-link", async () => {
      await fs.writeFile(path.join(temp, "docs", "BAD.md"), "# Bad\n\nSMA appears without its glossary link.\n\n## Details\n\nMore.\n");
    });
    await expect("unregistered intro command", "intro-command-registration", async () => {
      await fs.writeFile(path.join(temp, "docs", "intro", "unregistered.md"), "# Missing journey\n\nThis command needs a runner.\n\n\u0060\u0060\u0060bash\nnpm run missing-journey\n\u0060\u0060\u0060\n");
    });
    await expect("broken internal link", "internal-link", async () => {
      await fs.writeFile(path.join(temp, "docs", "BAD.md"), "# Bad\n\nRead [nothing](MISSING.md).\n\n## Details\n\nMore.\n");
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }

  const failures = cases.filter((item) => !item.passed).map((item) => `${item.name}: found ${item.found.join(", ") || "nothing"}`);
  return {
    selftest: true,
    status: failures.length === 0 ? "passed" : "failed",
    cases_total: cases.length,
    cases_passed: cases.length - failures.length,
    cases,
    failures,
  };
}

main().catch((error) => {
  console.error(`[doc-lint] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
