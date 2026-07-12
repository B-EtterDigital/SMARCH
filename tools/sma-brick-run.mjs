#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { emitFailure, CliError } from "./cli-contract.mjs";
import { assertStrictSandboxAvailable, executeFixture } from "./lib/capsule-runtime.mjs";

const FIXTURE_TIMEOUT_MS = 30_000;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
/** @typedef {{ allowNet?: boolean, emit?: boolean, strictSandbox?: boolean, timeoutMs?: number, unsafeIsolationFallback?: boolean }} RunOptions */
/** @typedef {{ allowNet?: boolean, allowedPorts: string[], runtimeTemp: string, strictSandbox?: boolean }} FixtureOptions */
/** @typedef {{ name: string, inputs: unknown, expected_outputs: unknown }} Fixture */
/** @typedef {{ fixture: string | null, status: "PASS" | "FAIL", expected_outputs?: unknown, actual_outputs?: unknown, error?: unknown, checks?: string[] }} FixtureResult */
/** @typedef {{ interfaces: { ports: string[] }, security?: { env?: { variables?: Array<string | { name?: string }> } } }} CapsuleManifest */

class CapsuleError extends Error {
  /**
* @param {string} code
* @param {string | undefined} message
*/
  constructor(code, message) {
    super(message);
    this.name = "CapsuleError";
    this.code = code;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selftest) {
    await runSelftest();
    return;
  }

  const results = await runCapsule(options.capsulePath || process.cwd(), {
    allowNet: options.allowNet,
    strictSandbox: options.strictSandbox,
    unsafeIsolationFallback: options.unsafeIsolationFallback,
    emit: !options.quiet,
  });
  const failed = results.filter((result) => result.status === "FAIL");
  for (const result of failed) {
    emitFailure("brick-run", new CliError("FIXTURE_FAILED", `Fixture failed: ${result.fixture}`, {
      exitCode: 4,
      nextCommand: `Inspect fixtures/run.json and rerun \`sma brick-run ${options.capsulePath || process.cwd()}\`.`,
      context: { fixture: result.fixture, error: result.error || null },
    }));
  }
  if (options.verbose) process.stderr.write(`brick-run: ${results.length - failed.length}/${results.length} fixtures passed\n`);
  if (failed.length) process.exitCode = 4;
}

/** @param {string[]} args */
function parseArgs(args) {
  // Strict isolation is the default, but it needs Node >=25 (permission-scoped
  // --allow-net). On the LTS floor (Node 24), a deliberate operator opt-in lets
  // capsules run with reduced isolation without threading a flag through every
  // caller (brick-inspect spawns brick-run; the intro lane runs it in lessons).
  // Setting the env var IS the explicit acceptance; --strict-sandbox overrides it.
  const envFallback = /^(1|true|yes|on)$/i.test(process.env.SMA_CAPSULE_ISOLATION_FALLBACK ?? "");
  const options = { allowNet: false, selftest: false, strictSandbox: !envFallback, unsafeIsolationFallback: envFallback, capsulePath: "", json: false, quiet: false, verbose: false };
  let strictSandboxExplicit = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--allow-net") {
      options.allowNet = true;
    } else if (arg === "--strict-sandbox") {
      options.strictSandbox = true;
      options.unsafeIsolationFallback = false;
      strictSandboxExplicit = true;
    } else if (arg === "--unsafe-isolation-fallback") {
      options.strictSandbox = false;
      options.unsafeIsolationFallback = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--capsule") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new CapsuleError("USAGE", "--capsule requires a directory path");
      options.capsulePath = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Run deterministic capsule fixtures.

Usage:
  sma brick-run [--allow-net] [--capsule] <directory> [--json]
  sma brick-run --unsafe-isolation-fallback [--allow-net] <directory>
  sma brick-run --selftest

Options: --allow-net, --capsule, --json, --quiet, --verbose, --selftest, --help
Safety: strict isolation is the default (needs Node >=25). --unsafe-isolation-fallback explicitly permits reduced isolation on unsupported Node runtimes; the env var SMA_CAPSULE_ISOLATION_FALLBACK=1 is the same opt-in for every caller (e.g. brick-inspect, the intro lane). --strict-sandbox overrides both and hard-fails when strict isolation is unavailable.
Examples:
  sma brick-run templates/capsule --json
  sma brick-run --unsafe-isolation-fallback templates/capsule

Exit codes: 0 pass; 2 usage; 3 missing input; 4 invalid input/fixture failure; 1 runtime failure.`);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new CapsuleError("USAGE", `Unknown option: ${arg}`);
    } else if (options.capsulePath) {
      throw new CapsuleError("USAGE", "Only one capsule directory may be supplied");
    } else {
      options.capsulePath = arg;
    }
  }
  if (options.quiet && options.verbose) throw new CapsuleError("USAGE", "--quiet and --verbose cannot be combined");
  if (strictSandboxExplicit && options.unsafeIsolationFallback) {
    throw new CapsuleError("USAGE", "--strict-sandbox and --unsafe-isolation-fallback cannot be combined");
  }
  return options;
}

/** @param {string} capsulePath @param {RunOptions} [options] @returns {Promise<FixtureResult[]>} */
async function runCapsule(capsulePath, options = {}) {
  const root = path.resolve(capsulePath);
  const strictSandbox = options.unsafeIsolationFallback !== true;
  if (strictSandbox) assertStrictSandboxAvailable();
  const manifest = /** @type {CapsuleManifest} */ (await readJson(path.join(root, "module.sweetspot.json"), "capsule manifest"));
  const fixtureDocument = await readJson(path.join(root, "fixtures", "run.json"), "capsule fixture file");
  const fixtures = validateFixtures(fixtureDocument);
  await enforceConstraints(root, manifest);

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "sma-capsule-runtime-"));
  try {
    /** @type {FixtureResult[]} */
    const results = [];
    for (const fixture of fixtures) {
      const runtimeTemp = await mkdtemp(path.join(runtimeRoot, "fixture-"));
      /** @type {FixtureResult} */
      let result;
      try {
        const env = childEnvironment(manifest, runtimeTemp);
        const actual = await executeFixture(root, fixture.inputs, env, options.timeoutMs || FIXTURE_TIMEOUT_MS, {
          allowNet: options.allowNet === true,
          allowedPorts: manifest.interfaces.ports,
          runtimeTemp,
          strictSandbox,
        });
        const passed = isDeepStrictEqual(actual, fixture.expected_outputs);
        result = passed
          ? { fixture: fixture.name, status: "PASS" }
          : { fixture: fixture.name, status: "FAIL", expected_outputs: fixture.expected_outputs, actual_outputs: actual };
      } catch (error) {
        result = { fixture: fixture.name, status: "FAIL", error: fixtureError(error) };
      } finally {
        await rm(runtimeTemp, { recursive: true, force: true });
      }
      results.push(result);
      if (options.emit !== false) printResult(result);
    }
    return results;
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

/** @param {string} filePath @param {string} label @returns {Promise<unknown>} */
async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CapsuleError("MISSING_FILE", `Cannot read ${label} at ${filePath}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CapsuleError("INVALID_JSON", `Invalid JSON in ${label} at ${filePath}: ${errorMessage(error)}`);
  }
}

/** @param {unknown} document @returns {Fixture[]} */
function validateFixtures(document) {
  if (!document || typeof document !== 'object' || !("fixtures" in document) || !Array.isArray(document.fixtures) || document.fixtures.length === 0) {
    throw new CapsuleError("INVALID_FIXTURES", "fixtures/run.json must contain a non-empty fixtures array");
  }
  const names = new Set();
  for (const [index, fixture] of document.fixtures.entries()) {
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
      throw new CapsuleError("INVALID_FIXTURES", `Fixture at index ${index} must be an object`);
    }
    if (typeof fixture.name !== "string" || !fixture.name.trim()) {
      throw new CapsuleError("INVALID_FIXTURES", `Fixture at index ${index} must have a non-empty name`);
    }
    if (names.has(fixture.name)) throw new CapsuleError("INVALID_FIXTURES", `Duplicate fixture name: ${fixture.name}`);
    names.add(fixture.name);
    if (!Object.hasOwn(fixture, "inputs")) {
      throw new CapsuleError("INVALID_FIXTURES", `Fixture ${fixture.name} must declare inputs`);
    }
    if (!Object.hasOwn(fixture, "expected_outputs")) {
      throw new CapsuleError("INVALID_FIXTURES", `Fixture ${fixture.name} must declare expected_outputs`);
    }
  }
  return /** @type {Fixture[]} */ (document.fixtures);
}

/** @param {string} root @param {CapsuleManifest} manifest */
async function enforceConstraints(root, manifest) {
  await rejectSymbolicLinks(root, root);
  const sourceRoot = path.join(root, "src");
  const entryPath = path.join(sourceRoot, "index.ts");
  try {
    await readFile(entryPath, "utf8");
  } catch {
    throw new CapsuleError("CONSTRAINT_VIOLATION", `Capsule entry is missing: ${entryPath}`);
  }

  const ports = manifest?.interfaces?.ports ?? [];
  if (!Array.isArray(ports) || ports.some((port) => typeof port !== "string" || !port.trim())) {
    throw new CapsuleError("INVALID_MANIFEST", "module.sweetspot.json interfaces.ports must be an array of non-empty import specifiers");
  }
  const allowedPorts = new Set(ports);
  const sourceFiles = await collectSourceFiles(sourceRoot);

  for (const filePath of sourceFiles) {
    const source = await readFile(filePath, "utf8");
    for (const specifier of importSpecifiers(source)) {
      validateSpecifier({ root, sourceRoot, filePath, specifier, allowedPorts });
    }
  }
}

/** @param {string} directory @param {string} root */
async function rejectSymbolicLinks(directory, root) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new CapsuleError("CONSTRAINT_VIOLATION", `Cannot inspect capsule directory ${directory}: ${errorMessage(error)}`);
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const relativePath = path.relative(root, entryPath).replaceAll(path.sep, "/");
      throw new CapsuleError(
        "CONSTRAINT_VIOLATION",
        `${relativePath} is a symbolic link; capsule trees must not contain symlinks because they can escape the cwd jail`,
      );
    }
    if (entry.isDirectory()) await rejectSymbolicLinks(entryPath, root);
  }
}

/** @param {string} directory @returns {Promise<string[]>} */
async function collectSourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new CapsuleError("CONSTRAINT_VIOLATION", `Cannot read capsule src directory ${directory}: ${errorMessage(error)}`);
  }
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(entryPath));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

/**
* @param {string} source
*/
function importSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

/** @param {{ root: string, sourceRoot: string, filePath: string, specifier: string, allowedPorts: Set<string> }} input */
function validateSpecifier({ root, sourceRoot, filePath, specifier, allowedPorts }) {
  const relativeFile = path.relative(root, filePath).replaceAll(path.sep, "/");
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(filePath), specifier);
    const relativeTarget = path.relative(sourceRoot, target);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
      throw new CapsuleError(
        "CONSTRAINT_VIOLATION",
        `${relativeFile} imports ${JSON.stringify(specifier)} outside src/; move the target into src/ or expose it through a declared port`,
      );
    }
    return;
  }
  if (path.isAbsolute(specifier) || /^(?:file|https?|data):/i.test(specifier)) {
    throw new CapsuleError("CONSTRAINT_VIOLATION", `${relativeFile} imports forbidden external location ${JSON.stringify(specifier)}; capsule imports must stay in src/`);
  }
  if (!allowedPorts.has(specifier)) {
    throw new CapsuleError(
      "CONSTRAINT_VIOLATION",
      `${relativeFile} imports undeclared port ${JSON.stringify(specifier)}; add the exact specifier to module.sweetspot.json interfaces.ports or remove the import`,
    );
  }
}

/** @param {CapsuleManifest} manifest @param {string} runtimeTemp @returns {NodeJS.ProcessEnv} */
function childEnvironment(manifest, runtimeTemp) {
  const variables = manifest?.security?.env?.variables ?? [];
  if (!Array.isArray(variables)) {
    throw new CapsuleError("INVALID_MANIFEST", "module.sweetspot.json security.env.variables must be an array");
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    TMPDIR: runtimeTemp,
    TMP: runtimeTemp,
    TEMP: runtimeTemp,
  };
  for (const variable of variables) {
    const name = typeof variable === "string" ? variable : variable?.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new CapsuleError("INVALID_MANIFEST", "Every security.env.variables entry must be a name string or an object with a non-empty name");
    }
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  }
  return env;
}

async function runSelftest() {
  const workspace = await mkdtemp(path.join(tmpdir(), "sma-capsule-selftest-"));
  const root = path.join(workspace, "capsule");
  const previousAllowed = process.env.CAPSULE_ALLOWED;
  const previousSecret = process.env.CAPSULE_SECRET;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "fixtures"), { recursive: true });
    await writeFile(path.join(root, "module.sweetspot.json"), JSON.stringify({
      interfaces: { ports: ["node:path"] },
      security: { env: { variables: [{ name: "CAPSULE_ALLOWED" }] } },
    }));
    await writeFile(path.join(root, "src", "index.ts"), `
import { basename } from "node:path";
export default function run(inputs: { value: number }) {
  return { value: inputs.value, file: basename("/tmp/example.txt"), allowed: process.env.CAPSULE_ALLOWED ?? null, leaked: process.env.CAPSULE_SECRET ?? null };
}
`);
    process.env.CAPSULE_ALLOWED = "declared";
    process.env.CAPSULE_SECRET = "must-not-leak";
    const passingFixture = {
      schema_version: "1.0.0",
      fixtures: [{
        name: "isolated identity",
        inputs: { value: 7 },
        expected_outputs: { value: 7, file: "example.txt", allowed: "declared", leaked: null },
      }],
    };
    await writeFile(path.join(root, "fixtures", "run.json"), JSON.stringify(passingFixture));
    const passing = await runCapsule(root, { emit: false, strictSandbox: true });
    assertSelftest(passing[0]?.status === "PASS", "passing fixture was not detected");

    let strictRefusal = "";
    try {
      assertStrictSandboxAvailable({ permissionFlag: "", syncModuleHooks: false, netPermission: false, workerPermission: false });
    } catch (error) {
      strictRefusal = `${error && typeof error === "object" && "code" in error ? error.code : ""}: ${errorMessage(error)}`;
    }
    assertSelftest(
      strictRefusal.includes("STRICT_SANDBOX_UNSUPPORTED")
        && strictRefusal.includes("--unsafe-isolation-fallback")
        && strictRefusal.includes(process.version),
      "unsupported strict sandbox did not refuse with an honest versioned message",
    );

    const failingFixture = structuredClone(passingFixture);
    failingFixture.fixtures[0].expected_outputs.value = 8;
    await writeFile(path.join(root, "fixtures", "run.json"), JSON.stringify(failingFixture));
    const failing = await runCapsule(root, { emit: false, strictSandbox: true });
    assertSelftest(failing[0]?.status === "FAIL", "failing fixture was not detected");

    await writeFile(path.join(root, "src", "index.ts"), `import "node:fs"; export default function run(value) { return value; }\n`);
    let constraintMessage = "";
    try {
      await runCapsule(root, { emit: false, strictSandbox: true });
    } catch (error) {
      constraintMessage = errorMessage(error);
    }
    assertSelftest(
      constraintMessage.includes("node:fs") && constraintMessage.includes("interfaces.ports") && constraintMessage.includes("src/index.ts"),
      "undeclared import did not produce an actionable constraint error",
    );

    await writeSelftestCapsule(root, {
      ports: ["node:fs/promises", "node:path"],
      source: `import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default async function run() {
  const target = join(process.env.TMPDIR, "allowed.txt");
  await writeFile(target, "private-temp");
  return { value: await readFile(target, "utf8") };
}\n`,
      expectedOutputs: { value: "private-temp" },
    });
    const tempWriting = await runCapsule(root, { emit: false, strictSandbox: true });
    assertSelftest(tempWriting[0]?.status === "PASS", "private runtime temp was not writable and readable");

    const escapeChecks = await runEscapeSelftests({ root, workspace });
    const escaped = Object.entries(escapeChecks)
      .filter(([, blocked]) => !blocked)
      .map(([name]) => name);
    assertSelftest(escaped.length === 0, `sandbox escape attempts unexpectedly succeeded: ${escaped.join(", ")}`);

    printResult({
      fixture: "--selftest",
      status: "PASS",
      checks: [
        "fixture-pass",
        "fixture-fail",
        "strict-sandbox-refusal",
        "declared-port",
        "constraint-rejection",
        "environment-read-denied",
        "network-denied-by-default",
        "network-allow-opt-in",
        "low-level-network-denied",
        "low-level-network-allow-opt-in",
        "computed-dynamic-import-denied",
        "worker-thread-denied",
        "data-url-import-denied",
        "process-binding-denied",
        "parent-read-denied",
        "private-temp-write-allowed",
        "parent-write-denied",
        "symlink-write-denied",
      ],
    });
  } finally {
    restoreEnvironment("CAPSULE_ALLOWED", previousAllowed);
    restoreEnvironment("CAPSULE_SECRET", previousSecret);
    await rm(workspace, { recursive: true, force: true });
  }
}

/** @param {{ root: string, workspace: string }} input @returns {Promise<Record<string, boolean>>} */
async function runEscapeSelftests({ root, workspace }) {
  /** @type {Record<string, boolean>} */
  const checks = {};

  await writeSelftestCapsule(root, {
    source: `export default function run() { return { leaked: process.env.CAPSULE_SECRET ?? null }; }\n`,
    expectedOutputs: { leaked: "must-not-leak" },
  });
  checks["environment-read"] = await escapeAttemptFailed(root);

  const network = await startSelftestServer();
  try {
    await writeSelftestCapsule(root, {
      source: `export default async function run(inputs: { url: string }) { const response = await fetch(inputs.url); return { body: await response.text() }; }\n`,
      inputs: { url: network.url },
      expectedOutputs: { body: "network-escaped" },
    });
    checks.fetch = await escapeAttemptFailed(root);
    assertSelftest(network.requests() === 0, "network-denied fixture reached the local server");
    const allowedNetwork = await runCapsule(root, { allowNet: true, emit: false, strictSandbox: true });
    assertSelftest(allowedNetwork[0]?.status === "PASS", "--allow-net did not opt in to network access");
    assertSelftest(network.requests() === 1, "--allow-net fixture did not reach the local server exactly once");

    await writeSelftestCapsule(root, {
      ports: ["node:http"],
      source: `export default async function run(inputs: { url: string }) {
  const prefix = "node:";
  const { get } = await import(prefix + "http");
  const body = await new Promise((resolve, reject) => {
    const request = get(inputs.url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
  return { body };
}\n`,
      inputs: { url: network.url },
      expectedOutputs: { body: "network-escaped" },
    });
    checks["low-level-network"] = await escapeAttemptFailed(root);
    assertSelftest(network.requests() === 1, "network-denied low-level fixture reached the local server");
    const allowedLowLevelNetwork = await runCapsule(root, { allowNet: true, emit: false, strictSandbox: true });
    assertSelftest(allowedLowLevelNetwork[0]?.status === "PASS", "--allow-net did not opt in to low-level network access");
    assertSelftest(network.requests() === 2, "--allow-net low-level fixture did not reach the local server exactly once");
  } finally {
    await network.close();
  }

  const childEscape = path.join(workspace, "child-process-escape.txt");
  await writeSelftestCapsule(root, {
    ports: ["node:child_process"],
    source: `export default async function run(inputs: { target: string }) {
  const prefix = "node:";
  const { spawnSync } = await import(prefix + "child_process");
  const child = spawnSync(process.execPath, ["--eval", "require('node:fs').writeFileSync(process.argv[1], 'escaped')", inputs.target]);
  return { status: child.status };
}\n`,
    inputs: { target: childEscape },
    expectedOutputs: { status: 0 },
  });
  checks["computed-dynamic-import"] = await escapeAttemptFailed(root);
  assertSelftest(!await pathExists(childEscape), "computed dynamic import spawned a child process outside the permission boundary");

  await writeSelftestCapsule(root, {
    ports: ["node:worker_threads"],
    source: `export default async function run() {
  const prefix = "node:";
  const { Worker } = await import(prefix + "worker_threads");
  const worker = new Worker("0", { eval: true });
  await new Promise((resolve, reject) => { worker.once("online", resolve); worker.once("error", reject); });
  await worker.terminate();
  return { started: true };
}\n`,
    expectedOutputs: { started: true },
  });
  checks["worker-thread"] = await escapeAttemptFailed(root);

  await writeSelftestCapsule(root, {
    source: `export default async function run() {
  const scheme = "da" + "ta:";
  const loaded = await import(scheme + "text/javascript,export default 'escaped'");
  return { value: loaded.default };
}\n`,
    expectedOutputs: { value: "escaped" },
  });
  checks["data-url-import"] = await escapeAttemptFailed(root);

  await writeSelftestCapsule(root, {
    source: `export default function run() { return { exposed: typeof process.binding("fs") === "object" }; }\n`,
    expectedOutputs: { exposed: true },
  });
  checks["process-binding"] = await escapeAttemptFailed(root);

  const outsideRead = path.join(workspace, "outside-read.txt");
  await writeFile(outsideRead, "escaped-read");
  await writeSelftestCapsule(root, {
    ports: ["node:fs/promises"],
    source: `import { readFile } from "node:fs/promises"; export default async function run(inputs: { target: string }) { return { value: await readFile(inputs.target, "utf8") }; }\n`,
    inputs: { target: outsideRead },
    expectedOutputs: { value: "escaped-read" },
  });
  checks["parent-read"] = await escapeAttemptFailed(root);

  const parentEscape = path.join(workspace, "parent-escape.txt");
  await writeSelftestCapsule(root, {
    ports: ["node:fs/promises"],
    source: `import { writeFile } from "node:fs/promises"; export default async function run() { await writeFile("../parent-escape.txt", "escaped"); return { wrote: true }; }\n`,
    expectedOutputs: { wrote: true },
  });
  checks["parent-write"] = await escapeAttemptFailed(root);
  assertSelftest(!await pathExists(parentEscape), "parent write created a file outside the capsule cwd");

  const outside = path.join(workspace, "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(root, "escape-link"), "dir");
  await writeSelftestCapsule(root, {
    ports: ["node:fs/promises"],
    source: `import { writeFile } from "node:fs/promises"; export default async function run() { await writeFile("./escape-link/symlink-escape.txt", "escaped"); return { wrote: true }; }\n`,
    expectedOutputs: { wrote: true },
  });
  checks["symlink-write"] = await escapeAttemptFailed(root);
  assertSelftest(!await pathExists(path.join(outside, "symlink-escape.txt")), "symlink write created a file outside the capsule cwd");

  return checks;
}

/** @param {string} root @param {{ source: string, expectedOutputs: unknown, inputs?: unknown, ports?: string[] }} fixture */
async function writeSelftestCapsule(root, { source, expectedOutputs, inputs = {}, ports = [] }) {
  await writeFile(path.join(root, "module.sweetspot.json"), JSON.stringify({
    interfaces: { ports },
    security: { env: { variables: [{ name: "CAPSULE_ALLOWED" }] } },
  }));
  await writeFile(path.join(root, "src", "index.ts"), source);
  await writeFile(path.join(root, "fixtures", "run.json"), JSON.stringify({
    schema_version: "1.0.0",
    fixtures: [{ name: "escape attempt", inputs, expected_outputs: expectedOutputs }],
  }));
}

/** @param {string} root */
async function escapeAttemptFailed(root) {
  try {
    const results = await runCapsule(root, { emit: false, strictSandbox: true });
    return results[0]?.status === "FAIL";
  } catch {
    return true;
  }
}

async function startSelftestServer() {
  let requestCount = 0;
  const sockets = new Set();
  const server = createServer((/** @type {{ once: (arg0: string, arg1: () => boolean) => void; end: (arg0: string) => void; }} */ socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    requestCount += 1;
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nnetwork-escaped");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new CapsuleError("SELFTEST", "Could not determine local test server address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests: () => requestCount,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve(undefined));
      for (const socket of sockets) socket.destroy();
    }),
  };
}

/** @param {string} filePath */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
* @param {boolean} condition
* @param {string} message
*/
function assertSelftest(condition, message) {
  if (!condition) throw new CapsuleError("SELFTEST", message);
}

/**
* @param {string} name
* @param {string | undefined} value
*/
function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** @param {FixtureResult} result */
function printResult(result) {
  console.log(JSON.stringify(result));
}

/**
* @param {unknown} error
*/
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error */
function fixtureError(error) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return { code: error.code, message: errorMessage(error) };
  }
  return errorMessage(error);
}

main().catch((error) => {
  printResult({
    fixture: null,
    status: "FAIL",
    error: {
      code: error?.code || "RUNNER_ERROR",
      message: errorMessage(error),
    },
  });
  const code = error?.code || "RUNNER_ERROR";
  const exitCode = code === "USAGE" ? 2 : code === "MISSING_FILE" ? 3 : ["INVALID_JSON", "INVALID_FIXTURES", "INVALID_MANIFEST", "CONSTRAINT_VIOLATION", "STRICT_SANDBOX_UNSUPPORTED"].includes(code) ? 4 : 1;
  emitFailure("brick-run", new CliError(code, errorMessage(error), {
    exitCode,
    nextCommand: code === "USAGE" ? "Run `sma brick-run --help`." : "Fix the reported capsule input, then rerun `sma brick-run <directory> --json`.",
  }));
  process.exitCode = exitCode;
});
