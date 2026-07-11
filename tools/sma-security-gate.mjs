#!/usr/bin/env node
/**
 * What: Scans a project tree for high-risk security patterns and policy violations.
 * Why: Secrets and unsafe code must be visible before validation, reuse, or release claims.
 * How: Accepts a root and scan limits, walks eligible files, and prints normalized findings.
 * Callers: Validation and continuous-integration workflows invoke it as a security gate.
 * Example: `node tools/sma-security-gate.mjs --help`
 */
import fs from "node:fs/promises";
import path from "node:path";

const excludedDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".astro",
  ".turbo",
  ".netlify",
  ".tmp",
  "tmp",
  "playwright-report",
  "test-results"
]);

const archiveDirPatterns = [
  "corrupt-backup",
  "stream_preview_release",
  "fix-push",
  "backup"
];

const excludedExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".mp4",
  ".mov",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".pdf"
]);

const includedExtensions = new Set([
  "",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".sql",
  ".py",
  ".sh",
  ".rs",
  ".go",
  ".java",
  ".php",
  ".rb",
  ".cs",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".txt",
  ".conf",
  ".ini"
]);

const includedNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.example",
  "Dockerfile",
  "Makefile",
  "AGENTS.md",
  "CLAUDE.md",
  "SKILL.md"
]);

const patterns = [
  { id: "private_key", severity: "critical", regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: "openai_key", severity: "high", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: "stripe_secret", severity: "high", regex: /\bsk_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { id: "google_api_key", severity: "medium", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { id: "env_file", severity: "medium", fileRegex: /(^|\/)\.env(\.|$)(?!example)/ }
];

const assignmentPatterns = [
  { id: "supabase_service_role", severity: "critical", key: "SUPABASE_SERVICE_ROLE_KEY" },
  { id: "clerk_secret", severity: "high", key: "CLERK_SECRET_KEY" }
];

function parseArgs(argv) {
  const options = { root: process.cwd(), json: false, soft: false, maxBytes: 1_000_000, includeArchives: false, maxFiles: 20000, baseline: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--root" && next) {
      options.root = path.resolve(next);
      i += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--soft") {
      options.soft = true;
    } else if (arg === "--max-bytes" && next) {
      options.maxBytes = Number(next);
      i += 1;
    } else if (arg === "--include-archives") {
      options.includeArchives = true;
    } else if (arg === "--max-files" && next) {
      options.maxFiles = Number(next);
      i += 1;
    } else if (arg === "--baseline" && next) {
      options.baseline = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA security gate

Usage:
  node tools/sma-security-gate.mjs --root /path/to/project

Options:
  --max-bytes  Skip files larger than this many bytes. Default: 1000000
  --include-archives  Include backup/archive-style directories
  --max-files  Stop after this many files. Default: 20000
  --json  Print machine-readable findings
  --soft  Exit 0 even when high/critical findings exist
`);
      process.exit(0);
    }
  }

  return options;
}

function shouldSkipDir(name, includeArchives) {
  if (excludedDirs.has(name)) {
    return true;
  }

  if (!includeArchives && archiveDirPatterns.some((pattern) => name.includes(pattern))) {
    return true;
  }

  return false;
}

function shouldScanFile(name) {
  if (includedNames.has(name)) {
    return true;
  }

  const ext = path.extname(name).toLowerCase();

  return includedExtensions.has(ext) && !excludedExtensions.has(ext);
}

function assignmentValue(line, key) {
  const match = line.match(new RegExp(`\\b${key}\\s*=\\s*([^\\s#;]+)`));
  return match?.[1]?.trim() || "";
}

// True if the line is wholly inside a // or /* ... */ comment region (best-effort
// per-line check) or a SQL '--' comment, or is whitespace.
function isCommentOrIdentifierOnly(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("--")) return true;          // SQL line comment
  if (trimmed.startsWith("*")) return true;            // continuation of block comment
  if (trimmed.startsWith("/*") || trimmed.includes("*/")) return true; // start/end of block comment
  if (trimmed.startsWith("//")) return true;
  return false;
}

// True if the value on the RHS is itself an identifier or env-read expression,
// not a literal string. Examples that should pass:
//   = _SUPABASE_SERVICE_ROLE_KEY
//   = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
//   = process.env.X
//   = Deno.env.get('X')
//   = config.supabaseKey
function isIdentifierOrEnvReadValue(value) {
  const v = value.trim().replace(/[;,]+$/, "");
  if (!v) return true;
  if (/^[_A-Za-z][_A-Za-z0-9]*$/.test(v)) return true;                    // bare identifier
  if (/^(require|requireEnv|getEnv|env)\s*\(/.test(v)) return true;       // env helper call
  if (/^(process\.env|Deno\.env|import\.meta\.env|globalThis\.process)/.test(v)) return true;
  if (/^[A-Za-z_$][\w$.]*\s*\(/.test(v)) return true;                     // any function call
  return false;
}

// True if the line declares a regex literal that contains the secret-shaped
// pattern (typically a /-----BEGIN PRIVATE KEY-----.../ pattern used to extract).
function isRegexLiteralContainingPattern(line) {
  // /-----BEGIN[^/]*-----.../  — a regex literal, not a string literal
  if (/\/-----BEGIN[^\/]*PRIVATE KEY-----.*-----END PRIVATE KEY-----.*?\/[gimsuy]*/.test(line)) return true;
  // multi-line regex split: opens with /-----BEGIN
  if (/\/-----BEGIN[^\/'"`]*PRIVATE KEY-----/.test(line)) return true;
  return false;
}

function placeholderValue(value) {
  const normalized = value
    .replace(/^['"]|['"]$/g, "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return true;
  }

  if (normalized.includes("process.env") || normalized.includes("deno.env") || normalized.includes("import.meta.env")) {
    return true;
  }

  // Normalize hyphens/dashes/dots to underscores so "your-key-here" matches "your_" / "_here"
  const flat = normalized.replace(/[-./\s]+/g, "_");

  return [
    "your_",
    "replace_",
    "placeholder",
    "example",
    "changeme",
    "change_me",
    "<",
    "${",
    "xxx",
    "_here",
    "dummy",
    "fake_",
    "test_token",
    "test-token",
    "0123456789",
    "1234567890",
    "abcdefghij",
    "redacted",
    "rotated",
    "removed"
  ].some((marker) => flat.includes(marker) || normalized.includes(marker));
}

// True for paths where any "secret-shaped" string is overwhelmingly likely to be
// documentation, fixture, or test data — not a live credential at rest.
function lowSignalPath(relativePath) {
  const lowered = relativePath.toLowerCase();
  if (/(^|\/)(docs?|wiki|readme|changelog)(\/|$)/.test(lowered)) return true;
  if (/\.md$|\.mdx$|\.rst$|\.txt$/.test(lowered)) return true;
  if (/\.test\.(t|j)sx?$|\.spec\.(t|j)sx?$|__tests__|__fixtures__|fixtures?\//.test(lowered)) return true;
  if (/(^|\/)(reports?|coverage|tmp)\//.test(lowered)) return true;
  return false;
}

// Heuristic: a "BEGIN ... PRIVATE KEY" line that is wrapped in quotes and
// followed/preceded by code like .replace(...) or const pemHeader = '...';
// is a parser literal, not actual key material.
function isPemHeaderStringLiteral(line) {
  const trimmed = line.trim();
  // line is wholly a quoted string assignment with header text
  if (/^(const|let|var|export\s+const)\s+\w+\s*=\s*['"`]-----BEGIN[^'"`]*PRIVATE KEY-----['"`]\s*;?\s*$/.test(trimmed)) {
    return true;
  }
  // header text appears inside .replace() or as an argument to a parser
  if (/\.replace\s*\(\s*['"`]-----BEGIN[^'"`]*PRIVATE KEY-----['"`]/.test(line)) return true;
  if (/['"`]-----BEGIN[^'"`]*PRIVATE KEY-----['"`]\s*[,)]/.test(line)) return true;
  // header text inside a .md fenced code block sample with no real base64 below it on the same line
  if (/['"`]-----BEGIN[^'"`]*PRIVATE KEY-----['"`]/.test(line) && !/[A-Za-z0-9+/]{40,}={0,2}/.test(line)) {
    // quoted but no long base64 chunk on the same line — string literal, not material
    return true;
  }
  // Template placeholder embedded between BEGIN/END markers — e.g. JSON string or SQL/CFG with
  // a YOUR_*/PLACEHOLDER body and no actual base64 between the markers on this line.
  if (/-----BEGIN[^]*PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.test(line)) {
    const innerMatch = line.match(/-----BEGIN[^]*?PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
    const inner = (innerMatch?.[1] || "").toLowerCase();
    if (!/[a-z0-9+\/]{40,}/i.test(inner)) return true; // no real base64 body inside this line
    if (/your_|_here|placeholder|replace|example|<.+>/i.test(inner)) return true;
  }
  return false;
}

async function loadBaseline(rootDir) {
  // baseline file lives at <root>/security/baseline.json or <root>/.sweetspot/security-baseline.json
  const candidates = [
    path.join(rootDir, "security", "baseline.json"),
    path.join(rootDir, ".sweetspot", "security-baseline.json")
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      const accepted = new Set(
        (parsed.accepted || []).map((entry) =>
          typeof entry === "string" ? entry : `${entry.id}:${entry.path}:${entry.line ?? ""}`
        )
      );
      return { file, accepted };
    } catch {
      // try next
    }
  }
  return { file: null, accepted: new Set() };
}

function findingKey(finding) {
  return `${finding.id}:${finding.path}:${finding.line ?? ""}`;
}

async function walk(dir, files = [], includeArchives = false, maxFiles = 20000) {
  if (files.length >= maxFiles) {
    return files;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      return files;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, includeArchives)) {
        continue;
      }

      await walk(fullPath, files, includeArchives, maxFiles);
      continue;
    }

    if (entry.isFile() && shouldScanFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function downgrade(severity) {
  if (severity === "critical") return "low";
  if (severity === "high") return "low";
  if (severity === "medium") return "info";
  return severity;
}

function extractRegexValue(line, pattern) {
  const match = line.match(pattern.regex);
  return match ? match[0] : "";
}

async function scanFile(root, filePath, maxBytes) {
  const relative = path.relative(root, filePath);
  const lowSignal = lowSignalPath(relative);
  const findings = [];

  for (const pattern of patterns) {
    if (pattern.fileRegex?.test(relative)) {
      findings.push({
        id: pattern.id,
        severity: pattern.severity,
        path: filePath,
        line: 1,
        message: `Sensitive file pattern: ${relative}`
      });
    }
  }

  let content = "";
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      return findings;
    }

    content = await fs.readFile(filePath, "utf8");
  } catch {
    return findings;
  }

  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("#") || isCommentOrIdentifierOnly(line)) {
      continue;
    }

    for (const pattern of patterns) {
      if (!pattern.regex?.test(line)) continue;

      // PEM header used as a string literal in code is not key material.
      if (pattern.id === "private_key" && isPemHeaderStringLiteral(line)) {
        continue;
      }

      // PEM header inside a regex literal is a parser, not key material.
      if (pattern.id === "private_key" && isRegexLiteralContainingPattern(line)) {
        continue;
      }

      // Apply placeholder filter to regex matches too — fixes "sk-your-...-here" in docs.
      const matchedValue = extractRegexValue(line, pattern);
      if (matchedValue && placeholderValue(matchedValue)) {
        continue;
      }

      let severity = pattern.severity;
      let note = `Potential secret or unsafe env exposure: ${pattern.id}`;
      if (lowSignal) {
        severity = downgrade(severity);
        note += ` (low-signal path: docs/test/fixture)`;
      }

      findings.push({
        id: pattern.id,
        severity,
        path: filePath,
        line: index + 1,
        message: note
      });
    }

    for (const pattern of assignmentPatterns) {
      const value = assignmentValue(line, pattern.key);

      if (value && !placeholderValue(value) && !isIdentifierOrEnvReadValue(value)) {
        let severity = pattern.severity;
        let note = `Potential secret or unsafe env exposure: ${pattern.id}`;
        if (lowSignal) {
          severity = downgrade(severity);
          note += ` (low-signal path: docs/test/fixture)`;
        }

        findings.push({
          id: pattern.id,
          severity,
          path: filePath,
          line: index + 1,
          message: note
        });
      }
    }
  }

  return findings;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = await walk(options.root, [], options.includeArchives, options.maxFiles);
  const rawFindings = [];

  for (const filePath of files) {
    const findings = await scanFile(options.root, filePath, options.maxBytes);
    rawFindings.push(...findings);
  }

  // Apply baseline (accepted findings file) — either from --baseline or auto-discovered.
  let baseline;
  if (options.baseline) {
    try {
      const raw = await fs.readFile(options.baseline, "utf8");
      const parsed = JSON.parse(raw);
      baseline = {
        file: options.baseline,
        accepted: new Set(
          (parsed.accepted || []).map((entry) =>
            typeof entry === "string" ? entry : `${entry.id}:${entry.path}:${entry.line ?? ""}`
          )
        )
      };
    } catch {
      baseline = { file: null, accepted: new Set() };
    }
  } else {
    baseline = await loadBaseline(options.root);
  }

  const accepted = [];
  const allFindings = [];
  for (const finding of rawFindings) {
    if (baseline.accepted.has(findingKey(finding))) {
      accepted.push(finding);
    } else {
      allFindings.push(finding);
    }
  }

  const highOrCritical = allFindings.filter((finding) => ["high", "critical"].includes(finding.severity));

  if (options.json) {
    console.log(JSON.stringify({
      count: allFindings.length,
      high_or_critical: highOrCritical.length,
      scanned_files: files.length,
      max_files: options.maxFiles,
      truncated: files.length >= options.maxFiles,
      baseline_file: baseline.file,
      baseline_suppressed: accepted.length,
      findings: allFindings
    }, null, 2));
  } else {
    for (const finding of allFindings) {
      console.log(`${finding.severity.toUpperCase()} ${finding.id} ${finding.path}:${finding.line} ${finding.message}`);
    }

    console.log(`SMA security gate complete: ${allFindings.length} finding(s), ${highOrCritical.length} high/critical, ${files.length} file(s) scanned${files.length >= options.maxFiles ? " (truncated)" : ""}${baseline.file ? `, baseline suppressed ${accepted.length}` : ""}`);
  }

  if (!options.soft && highOrCritical.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
