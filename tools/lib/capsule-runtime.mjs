import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_STREAM_LIMIT_BYTES = 64 * 1024;
const CONTROL_STREAM_LIMIT_BYTES = 1024 * 1024;

/** @typedef {{ permissionFlag: string, syncModuleHooks: boolean, netPermission: boolean, workerPermission: boolean }} IsolationCapabilities */
/** @typedef {{ allowNet?: boolean, allowedPorts: string[], runtimeTemp: string, strictSandbox: boolean }} FixtureOptions */

/** @type {IsolationCapabilities | undefined} */
let cachedIsolationCapabilities;
let isolationFallbackWarned = false;

class CapsuleRuntimeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "CapsuleRuntimeError";
    this.code = code;
  }
}

/** @param {string} root @param {unknown} inputs @param {NodeJS.ProcessEnv} env @param {number} timeoutMs @param {FixtureOptions} options */
export function executeFixture(root, inputs, env, timeoutMs, options) {
  const isolation = runtimeIsolationPlan({
    allowNet: options.allowNet === true,
    root,
    runtimeTemp: options.runtimeTemp,
    strictSandbox: options.strictSandbox,
  });
  const authToken = randomBytes(32).toString("hex");
  const childProgram = capsuleChildProgram({
    allowNet: options.allowNet === true,
    allowedPorts: options.allowedPorts ?? [],
    root,
    useRuntimeHooks: isolation.useRuntimeHooks,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...isolation.args,
      "--input-type=module",
      "--eval",
      childProgram,
    ], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    /** @type {Buffer[]} */
    const controlChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let controlBytes = 0;
    let settled = false;
    const timer = setTimeout(() => failAndKill(
      new CapsuleRuntimeError("TIMEOUT", `Fixture exceeded the ${timeoutMs}ms timeout`),
    ), timeoutMs);

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > OUTPUT_STREAM_LIMIT_BYTES) {
        failAndKill(new CapsuleRuntimeError(
          "OUTPUT_LIMIT",
          `Capsule stdout exceeded the ${OUTPUT_STREAM_LIMIT_BYTES}-byte limit`,
        ));
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > OUTPUT_STREAM_LIMIT_BYTES) {
        failAndKill(new CapsuleRuntimeError(
          "OUTPUT_LIMIT",
          `Capsule stderr exceeded the ${OUTPUT_STREAM_LIMIT_BYTES}-byte limit`,
        ));
        return;
      }
      stderrChunks.push(buffer);
    });
    const control = child.stdio[3];
    if (!control || typeof control.on !== "function") {
      failAndKill(new CapsuleRuntimeError("CHILD_PROTOCOL", "Authenticated capsule control pipe was not created"));
      return;
    }
    control.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      controlBytes += buffer.length;
      if (controlBytes > CONTROL_STREAM_LIMIT_BYTES) {
        failAndKill(new CapsuleRuntimeError(
          "OUTPUT_LIMIT",
          `Capsule control output exceeded the ${CONTROL_STREAM_LIMIT_BYTES}-byte limit`,
        ));
        return;
      }
      controlChunks.push(buffer);
    });
    child.on("error", (error) => finish(() => reject(
      new CapsuleRuntimeError("CHILD_PROCESS", errorMessage(error)),
    )));
    child.on("close", (code) => finish(() => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      let payload;
      try {
        payload = authenticateControlFrame(Buffer.concat(controlChunks).toString("utf8"), authToken);
      } catch (error) {
        reject(new CapsuleRuntimeError(
          "CHILD_PROTOCOL",
          `Capsule exited ${code} without a valid authenticated result${stderr ? `: ${stderr}` : ""}: ${errorMessage(error)}`,
        ));
        return;
      }
      if (!payload.ok) {
        reject(new CapsuleRuntimeError("CAPSULE_RUNTIME", payload.error || `Capsule exited ${code}`));
        return;
      }
      resolve(payload.output);
    }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ authToken, inputs }));

    /** @param {CapsuleRuntimeError} error */
    function failAndKill(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    }

    /** @param {() => void} callback */
    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    }
  });
}

/** @param {{ allowNet: boolean, allowedPorts: string[], root: string, useRuntimeHooks: boolean }} input */
function capsuleChildProgram({ allowNet, allowedPorts, root, useRuntimeHooks }) {
  const sourceRootUrl = pathToFileURL(`${path.join(root, "src")}${path.sep}`).href;
  const workerProgram = `
import { parentPort } from "node:worker_threads";
const safeAssign = Object.assign.bind(Object);
const sourceRootUrl = ${JSON.stringify(sourceRootUrl)};
const allowedPorts = new Set(${JSON.stringify(allowedPorts)});
const allowNet = ${JSON.stringify(allowNet)};
const useRuntimeHooks = ${JSON.stringify(useRuntimeHooks)};
const request = await new Promise((resolve) => parentPort.once("message", resolve));
const resultPort = request.resultPort;
const trustedPost = resultPort.postMessage.bind(resultPort);
if (useRuntimeHooks) {
  const { registerHooks } = await import("node:module");
  const deny = (message) => { throw safeAssign(new Error(message), { code: "ERR_ACCESS_DENIED" }); };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:worker_threads") return deny("Capsule access to the trusted worker transport is denied");
      if (/^(?:data|file|https?):/i.test(specifier) || specifier.startsWith("/") || /^[A-Za-z]:/.test(specifier)) {
        return deny("Capsule import denied by the runtime resolver: " + specifier);
      }
      if (specifier.startsWith(".")) {
        const resolved = nextResolve(specifier, context);
        if (typeof resolved?.url !== "string" || !resolved.url.startsWith(sourceRootUrl)) {
          return deny("Capsule relative import escaped src/: " + specifier);
        }
        return resolved;
      }
      if (!allowedPorts.has(specifier)) return deny("Capsule import is not a declared port: " + specifier);
      return nextResolve(specifier, context);
    },
  });
  const denyRuntimeAccess = () => deny("Process runtime internals are disabled inside capsule fixtures");
  for (const property of ["binding", "_linkedBinding", "getBuiltinModule", "_getActiveHandles", "_getActiveRequests"]) {
    if (property in process) {
      Object.defineProperty(process, property, { value: denyRuntimeAccess, configurable: false, enumerable: false, writable: false });
    }
  }
}
if (!allowNet) {
  const denyNetwork = () => Promise.reject(safeAssign(new Error("Capsule network access is disabled; rerun with --allow-net to opt in"), { code: "ERR_ACCESS_DENIED" }));
  Object.defineProperty(globalThis, "fetch", { value: denyNetwork, configurable: false, writable: false });
}
try {
  const capsule = await import("./src/index.ts");
  const run = typeof capsule.default === "function" ? capsule.default : capsule.run;
  if (typeof run !== "function") throw new Error("src/index.ts must default-export a function or export a function named run");
  trustedPost({ ok: true, output: await run(request.inputs) });
} catch (error) {
  trustedPost({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
resultPort.close();
`;
  return `
import { createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { MessageChannel, Worker } from "node:worker_threads";
const safeCreate = Object.create.bind(Object);
const safeParse = JSON.parse.bind(JSON);
const safeStringify = JSON.stringify.bind(JSON);
const trustedExit = process.exit.bind(process);
const control = createWriteStream(null, { fd: 3, autoClose: false });
const chunks = [];
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) chunks.push(chunk);
const request = safeParse(chunks.join(""));
const worker = new Worker(${JSON.stringify(workerProgram)}, { eval: true, stdout: true, stderr: true });
worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);
const { port1, port2 } = new MessageChannel();
let settled = false;

function authenticatedResult(result, exitCode) {
  if (settled) return;
  settled = true;
  const payload = safeCreate(null);
  payload.ok = result.ok === true;
  if (payload.ok) payload.output = result.output;
  else payload.error = typeof result.error === "string" ? result.error : "Capsule worker exited without a result";
  const payloadText = safeStringify(payload);
  const mac = createHmac("sha256", request.authToken).update(payloadText).digest("hex");
  const frame = "{\\\"payload\\\":" + safeStringify(payloadText) + ",\\\"mac\\\":" + safeStringify(mac) + "}\\n";
  void worker.terminate();
  control.end(frame, () => trustedExit(exitCode));
}

port1.once("message", (result) => authenticatedResult(result, result?.ok === true ? 0 : 1));
worker.once("error", (error) => authenticatedResult({ ok: false, error: error.message }, 1));
worker.once("exit", (code) => setTimeout(
  () => authenticatedResult({ ok: false, error: "Capsule worker exited " + code + " without a result" }, 1),
  25,
));
worker.postMessage({ inputs: request.inputs, resultPort: port2 }, [port2]);
`;
}
/** @param {string} frameText @param {string} authToken */
function authenticateControlFrame(frameText, authToken) {
  const lines = frameText.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error(`expected exactly one control frame, received ${lines.length}`);
  const frame = JSON.parse(lines[0]);
  if (!frame || typeof frame.payload !== "string" || typeof frame.mac !== "string") {
    throw new Error("control frame shape is invalid");
  }
  const expected = createHmac("sha256", authToken).update(frame.payload).digest();
  const received = Buffer.from(frame.mac, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("control frame authentication failed");
  }
  const payload = JSON.parse(frame.payload);
  if (!payload || typeof payload.ok !== "boolean") throw new Error("control payload shape is invalid");
  return payload;
}

/** @param {{ root: string, runtimeTemp: string, allowNet: boolean, strictSandbox: boolean }} input */
function runtimeIsolationPlan({ root, runtimeTemp, allowNet, strictSandbox }) {
  const capabilities = isolationCapabilities();
  if (strictSandbox) assertStrictSandboxAvailable(capabilities);

  if (!capabilities.permissionFlag || !capabilities.workerPermission) {
    warnIsolationFallback("this Node runtime cannot grant the trusted wrapper its private worker while enforcing the permission model; isolation enforcement is unavailable");
    return { args: [], useRuntimeHooks: false };
  }

  const args = [
    capabilities.permissionFlag,
    "--allow-worker",
    `--allow-fs-read=${root}`,
    `--allow-fs-read=${runtimeTemp}`,
    `--allow-fs-write=${runtimeTemp}`,
  ];
  if (allowNet && capabilities.netPermission) args.push("--allow-net");
  else if (allowNet) warnIsolationFallback("this Node permission model has no compatible --allow-net capability; network behavior follows the runtime's legacy default");
  else if (!capabilities.netPermission) warnIsolationFallback("this Node permission model cannot deny low-level network APIs; only global fetch is disabled");

  if (!capabilities.syncModuleHooks) {
    warnIsolationFallback("synchronous node:module resolver hooks are unavailable; computed import enforcement falls back to the permission model and the fast-feedback source scan");
  }

  return { args, useRuntimeHooks: capabilities.syncModuleHooks };
}

/** @returns {IsolationCapabilities} */
function isolationCapabilities() {
  if (process.env.NODE_ENV === "test" && process.env.SMA_BRICK_RUN_TEST_CAPABILITIES === "none") {
    return { permissionFlag: "", syncModuleHooks: false, netPermission: false, workerPermission: false };
  }
  if (cachedIsolationCapabilities) return cachedIsolationCapabilities;
  const permissionFlag = ["--permission", "--experimental-permission"]
    .find((flag) => probeNode([
      flag,
      "--input-type=module",
      "--eval",
      "if (!process.permission || process.permission.has('fs.read') || process.permission.has('fs.write') || process.permission.has('child') || process.permission.has('worker')) process.exit(1)",
    ])) ?? "";
  const syncModuleHooks = Boolean(permissionFlag) && probeNode([
    permissionFlag,
    "--input-type=module",
    "--eval",
    "const api = await import('node:module'); if (typeof api.registerHooks !== 'function') process.exit(1)",
  ]);
  const netPermission = Boolean(permissionFlag)
    && probeNode([
      permissionFlag,
      "--input-type=module",
      "--eval",
      "if (!process.permission || process.permission.has('net')) process.exit(1)",
    ])
    && probeNode([
      permissionFlag,
      "--allow-net",
      "--input-type=module",
      "--eval",
      "if (!process.permission?.has('net')) process.exit(1)",
    ]);
  const workerPermission = Boolean(permissionFlag) && probeNode([
    permissionFlag,
    "--allow-worker",
    "--input-type=module",
    "--eval",
    "if (!process.permission?.has('worker')) process.exit(1)",
  ]);
  cachedIsolationCapabilities = { permissionFlag, syncModuleHooks, netPermission, workerPermission };
  return cachedIsolationCapabilities;
}

/** @param {string[]} args */
function probeNode(args) {
  const result = spawnSync(process.execPath, args, { env: {}, stdio: "ignore", timeout: 5_000 });
  return result.status === 0 && !result.error;
}

/** @param {IsolationCapabilities} [capabilities] */
export function assertStrictSandboxAvailable(capabilities = isolationCapabilities()) {
  const missing = [];
  if (!capabilities.permissionFlag) missing.push("Node permission model (--permission; experimental form accepted)");
  if (!capabilities.syncModuleHooks) missing.push("synchronous module.registerHooks (Node >=22.15.0 or >=23.5.0)");
  if (!capabilities.netPermission) missing.push("permission-scoped network control (--allow-net; standard in Node >=25.0.0, compatible backports accepted)");
  if (!capabilities.workerPermission) missing.push("permission-scoped worker control (--allow-worker for the trusted wrapper realm)");
  if (missing.length === 0) return;
  throw new CapsuleRuntimeError(
    "STRICT_SANDBOX_UNSUPPORTED",
    `Strict capsule isolation is unavailable on ${process.version}; missing: ${missing.join("; ")}. Upgrade Node or explicitly pass --unsafe-isolation-fallback to accept reduced isolation.`,
  );
}

/** @param {string} message */
function warnIsolationFallback(message) {
  if (isolationFallbackWarned) return;
  isolationFallbackWarned = true;
  process.stderr.write(`sma brick-run UNSAFE isolation fallback: ${message}\n`);
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
