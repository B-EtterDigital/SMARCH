#!/usr/bin/env node

import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE_TIMEOUT_MS = 30_000;
const RESULT_MARKER = "__SMA_CAPSULE_RESULT__";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
let isolationFallbackWarned = false;

class CapsuleError extends Error {
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

  const results = await runCapsule(options.capsulePath || process.cwd(), { allowNet: options.allowNet });
  if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
}

function parseArgs(args) {
  const options = { allowNet: false, selftest: false, capsulePath: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--allow-net") {
      options.allowNet = true;
    } else if (arg === "--capsule") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new CapsuleError("USAGE", "--capsule requires a directory path");
      options.capsulePath = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/sma-brick-run.mjs [--allow-net] [--capsule] <capsule-directory> | --selftest");
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new CapsuleError("USAGE", `Unknown option: ${arg}`);
    } else if (options.capsulePath) {
      throw new CapsuleError("USAGE", "Only one capsule directory may be supplied");
    } else {
      options.capsulePath = arg;
    }
  }
  return options;
}

async function runCapsule(capsulePath, options = {}) {
  const root = path.resolve(capsulePath);
  const manifest = await readJson(path.join(root, "module.sweetspot.json"), "capsule manifest");
  const fixtureDocument = await readJson(path.join(root, "fixtures", "run.json"), "capsule fixture file");
  const fixtures = validateFixtures(fixtureDocument);
  await enforceConstraints(root, manifest);

  const env = childEnvironment(manifest);
  const results = [];
  for (const fixture of fixtures) {
    let result;
    try {
      const actual = await executeFixture(root, fixture.inputs, env, options.timeoutMs || FIXTURE_TIMEOUT_MS, {
        allowNet: options.allowNet === true,
      });
      const passed = isDeepStrictEqual(actual, fixture.expected_outputs);
      result = passed
        ? { fixture: fixture.name, status: "PASS" }
        : { fixture: fixture.name, status: "FAIL", expected_outputs: fixture.expected_outputs, actual_outputs: actual };
    } catch (error) {
      result = { fixture: fixture.name, status: "FAIL", error: errorMessage(error) };
    }
    results.push(result);
    if (options.emit !== false) printResult(result);
  }
  return results;
}

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

function validateFixtures(document) {
  if (!document || !Array.isArray(document.fixtures) || document.fixtures.length === 0) {
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
  return document.fixtures;
}

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

async function collectSourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new CapsuleError("CONSTRAINT_VIOLATION", `Cannot read capsule src directory ${directory}: ${errorMessage(error)}`);
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(entryPath));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

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

function childEnvironment(manifest) {
  const variables = manifest?.security?.env?.variables ?? [];
  if (!Array.isArray(variables)) {
    throw new CapsuleError("INVALID_MANIFEST", "module.sweetspot.json security.env.variables must be an array");
  }
  const env = {};
  for (const variable of variables) {
    const name = typeof variable === "string" ? variable : variable?.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new CapsuleError("INVALID_MANIFEST", "Every security.env.variables entry must be a name string or an object with a non-empty name");
    }
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  }
  return env;
}

function executeFixture(root, inputs, env, timeoutMs, options = {}) {
  const childProgram = `
const marker = ${JSON.stringify(RESULT_MARKER)};
const allowNet = ${JSON.stringify(options.allowNet === true)};
if (!allowNet) {
  const denyNetwork = () => Promise.reject(Object.assign(new Error("Capsule network access is disabled; rerun with --allow-net to opt in"), { code: "ERR_ACCESS_DENIED" }));
  Object.defineProperty(globalThis, "fetch", { value: denyNetwork, configurable: false, writable: false });
}
const chunks = [];
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const inputs = JSON.parse(chunks.join(""));
  const capsule = await import("./src/index.ts");
  const run = typeof capsule.default === "function" ? capsule.default : capsule.run;
  if (typeof run !== "function") throw new Error("src/index.ts must default-export a function or export a function named run");
  const output = await run(inputs);
  process.stdout.write(marker + JSON.stringify({ ok: true, output }) + "\\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(marker + JSON.stringify({ ok: false, error: message }) + "\\n");
  process.exitCode = 1;
}`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...runtimeIsolationArguments(root, options.allowNet === true),
      "--input-type=module",
      "--eval",
      childProgram,
    ], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new CapsuleError("TIMEOUT", `Fixture exceeded the ${timeoutMs}ms timeout`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(() => reject(new CapsuleError("CHILD_PROCESS", errorMessage(error)))));
    child.on("close", (code) => finish(() => {
      const lines = stdout.split(/\r?\n/);
      let line = "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].startsWith(RESULT_MARKER)) {
          line = lines[index];
          break;
        }
      }
      if (!line) {
        reject(new CapsuleError("CHILD_PROTOCOL", `Capsule exited ${code} without a result${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(line.slice(RESULT_MARKER.length));
      } catch (error) {
        reject(new CapsuleError("CHILD_PROTOCOL", `Capsule returned invalid result JSON: ${errorMessage(error)}`));
        return;
      }
      if (!payload.ok) reject(new CapsuleError("CAPSULE_RUNTIME", payload.error || `Capsule exited ${code}`));
      else resolve(payload.output);
    }));
    child.stdin.end(JSON.stringify(inputs));

    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    }
  });
}

function runtimeIsolationArguments(root, allowNet) {
  const allowedFlags = process.allowedNodeEnvironmentFlags;
  const permissionFlag = allowedFlags?.has("--permission")
    ? "--permission"
    : allowedFlags?.has("--experimental-permission")
      ? "--experimental-permission"
      : "";

  if (!permissionFlag) {
    warnIsolationFallback("this Node runtime has no permission model; filesystem isolation is limited to source-specifier checks and symlink rejection");
    return [];
  }

  const args = [
    permissionFlag,
    `--allow-fs-read=${root}`,
    `--allow-fs-read=${path.join(root, "*")}`,
  ];
  if (allowNet) {
    if (allowedFlags.has("--allow-net")) args.push("--allow-net");
    else warnIsolationFallback("this Node permission model has no --allow-net flag; network opt-in depends on the runtime's legacy behavior");
  } else if (!allowedFlags.has("--allow-net")) {
    warnIsolationFallback("this Node permission model cannot deny all network APIs; global fetch is disabled, but declared low-level network ports remain a documented fallback boundary");
  }
  return args;
}

function warnIsolationFallback(message) {
  if (isolationFallbackWarned) return;
  isolationFallbackWarned = true;
  process.stderr.write(`sma brick-run isolation warning: ${message}\n`);
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
    const passing = await runCapsule(root, { emit: false });
    assertSelftest(passing[0]?.status === "PASS", "passing fixture was not detected");

    const failingFixture = structuredClone(passingFixture);
    failingFixture.fixtures[0].expected_outputs.value = 8;
    await writeFile(path.join(root, "fixtures", "run.json"), JSON.stringify(failingFixture));
    const failing = await runCapsule(root, { emit: false });
    assertSelftest(failing[0]?.status === "FAIL", "failing fixture was not detected");

    await writeFile(path.join(root, "src", "index.ts"), `import "node:fs"; export default function run(value) { return value; }\n`);
    let constraintMessage = "";
    try {
      await runCapsule(root, { emit: false });
    } catch (error) {
      constraintMessage = errorMessage(error);
    }
    assertSelftest(
      constraintMessage.includes("node:fs") && constraintMessage.includes("interfaces.ports") && constraintMessage.includes("src/index.ts"),
      "undeclared import did not produce an actionable constraint error",
    );

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
        "declared-port",
        "constraint-rejection",
        "environment-read-denied",
        "network-denied-by-default",
        "network-allow-opt-in",
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

async function runEscapeSelftests({ root, workspace }) {
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
    const allowedNetwork = await runCapsule(root, { allowNet: true, emit: false });
    assertSelftest(allowedNetwork[0]?.status === "PASS", "--allow-net did not opt in to network access");
    assertSelftest(network.requests() === 1, "--allow-net fixture did not reach the local server exactly once");
  } finally {
    await network.close();
  }

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

async function escapeAttemptFailed(root) {
  try {
    const results = await runCapsule(root, { emit: false });
    return results[0]?.status === "FAIL";
  } catch {
    return true;
  }
}

async function startSelftestServer() {
  let requestCount = 0;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    requestCount += 1;
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nnetwork-escaped");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new CapsuleError("SELFTEST", "Could not determine local test server address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests: () => requestCount,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertSelftest(condition, message) {
  if (!condition) throw new CapsuleError("SELFTEST", message);
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function printResult(result) {
  console.log(JSON.stringify(result));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  process.exitCode = 1;
});
