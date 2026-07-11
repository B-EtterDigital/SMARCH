#!/usr/bin/env node
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_ROOT } from "./lib/sma-paths.mjs";

const dashboardServerPath = fileURLToPath(import.meta.url);
const smaRoot = path.resolve(path.dirname(dashboardServerPath), "..");

const defaults = {
  wiki: path.join(smaRoot, "wiki"),
  scans: path.join(smaRoot, "scans"),
  allowRoot: DEV_ROOT,
  host: "127.0.0.1",
  port: 4777,
  unsafeMutations: false,
  selftest: false
};

const browseExcludedDirs = new Set([
  ".git",
  ".netlify",
  ".next",
  ".tmp",
  ".turbo",
  "node_modules"
]);

function parseArgs(argv, env = process.env) {
  const options = {
    ...defaults,
    authToken: env.SMA_DASHBOARD_AUTH_TOKEN?.trim() || ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--wiki" && next) {
      options.wiki = path.resolve(next);
      i += 1;
    } else if (arg === "--scans" && next) {
      options.scans = path.resolve(next);
      i += 1;
    } else if (arg === "--allow-root" && next) {
      options.allowRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--host" && next) {
      options.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      i += 1;
    } else if (arg === "--unsafe-mutations") {
      options.unsafeMutations = true;
    } else if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA dashboard server

Usage:
  node tools/sma-dashboard-server.mjs --wiki scans/acme-studio/wiki --port 4777

Options:
  --wiki        Wiki directory to serve
  --scans       Directory where triggered scans are written
  --allow-root  Highest folder the browser may browse or scan
  --host        Bind host. Default: 127.0.0.1
  --port        Bind port. Default: 4777
  --unsafe-mutations
                Enable POST /api/scan and /api/setup. Loopback only unless
                SMA_DASHBOARD_AUTH_TOKEN is set; non-loopback requests must
                send Authorization: Bearer <token>.
`);
      process.exit(0);
    }
  }

  return options;
}

function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

function validateStartupPolicy(options) {
  if (options.unsafeMutations && !isLoopbackHost(options.host) && !options.authToken) {
    throw new Error(
      "Refusing non-loopback dashboard mutation mode without SMA_DASHBOARD_AUTH_TOKEN"
    );
  }
}

function suppliedBearerToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function tokensMatch(supplied, expected) {
  if (!supplied || !expected) return false;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function mutationAuthorized(req, options) {
  if (!options.unsafeMutations) return false;
  if (isLoopbackHost(options.host)) return true;
  return tokensMatch(suppliedBearerToken(req), options.authToken);
}

function denyMutation(res, options) {
  if (!options.unsafeMutations) {
    sendJson(res, 403, {
      error: "Dashboard mutations are disabled; restart with --unsafe-mutations to enable them"
    });
    return;
  }

  sendJson(res, 401, {
    error: "Valid bearer token required for dashboard mutations on a non-loopback bind"
  });
}

function expectUnsafeNonLoopbackStartupRefusal() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.SMA_DASHBOARD_AUTH_TOKEN;

    const child = spawn(process.execPath, [
      dashboardServerPath,
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--unsafe-mutations"
    ], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("selftest: unsafe non-loopback startup did not refuse before binding"));
    }, 2000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || !output.includes("Refusing non-loopback dashboard mutation mode")) {
        reject(new Error(
          `selftest: expected authenticated startup refusal, got exit ${code}: ${output.trim()}`
        ));
        return;
      }
      resolve();
    });
  });
}

async function runSelftest() {
  await expectUnsafeNonLoopbackStartupRefusal();

  const readOnlyOptions = parseArgs([], {});
  if (mutationAuthorized({ headers: {} }, readOnlyOptions)) {
    throw new Error("selftest: dashboard mutations were enabled by default");
  }

  const authenticatedRemoteOptions = parseArgs([
    "--host",
    "0.0.0.0",
    "--unsafe-mutations"
  ], { SMA_DASHBOARD_AUTH_TOKEN: "selftest-token" });
  validateStartupPolicy(authenticatedRemoteOptions);

  if (!mutationAuthorized({
    headers: { authorization: "Bearer selftest-token" }
  }, authenticatedRemoteOptions)) {
    throw new Error("selftest: valid non-loopback bearer token was rejected");
  }

  if (mutationAuthorized({
    headers: { authorization: "Bearer wrong-token" }
  }, authenticatedRemoteOptions)) {
    throw new Error("selftest: invalid non-loopback bearer token was accepted");
  }

  console.log("sma-dashboard-server selftest passed");
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";

  return "application/octet-stream";
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

async function readBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `${command} exited ${code}`));
      }
    });
  });
}

function scanSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "project";
}

function registrySlug(registry, fallback) {
  const id = registry.scanned_project_roots?.[0]?.id || registry.projects?.[0]?.id || fallback;
  return String(id || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

async function runScan(root, registryPath) {
  await run("node", [path.join(smaRoot, "tools", "sma-scan.mjs"), "--root", root, "--out", registryPath, "--json"], smaRoot);
  return JSON.parse(await fs.readFile(registryPath, "utf8"));
}

async function runWiki(registryPath, wikiPath) {
  await run("node", [path.join(smaRoot, "tools", "sma-wiki.mjs"), "--registry", registryPath, "--out", wikiPath], smaRoot);
}

async function runSecurity(root, reportPath) {
  const result = await run("node", [
    path.join(smaRoot, "tools", "sma-security-gate.mjs"),
    "--root",
    root,
    "--max-files",
    "20000",
    "--json",
    "--soft"
  ], smaRoot);
  await fs.writeFile(reportPath, result.stdout);
  return JSON.parse(result.stdout);
}

async function copyProjectReports(projectRoot, registryPath, securityPath = "") {
  const scansDir = path.join(projectRoot, ".sweetspot", "scans");
  await fs.mkdir(scansDir, { recursive: true });
  await fs.copyFile(registryPath, path.join(scansDir, "latest.registry.json"));

  if (securityPath) {
    await fs.copyFile(securityPath, path.join(scansDir, "security-gate.json"));
  }
}

async function updateProjectMetadata(projectRoot, registry, security = null) {
  const projectFile = path.join(projectRoot, ".sweetspot", "project.json");
  /** @type {{schema_version?: string, project?: any, sma?: any, [key: string]: any}} */
  let metadata = {};

  try {
    metadata = JSON.parse(await fs.readFile(projectFile, "utf8"));
  } catch {
    metadata = {
      schema_version: "1.0.0",
      project: {
        id: registry.projects?.[0]?.id || path.basename(projectRoot),
        name: registry.projects?.[0]?.id || path.basename(projectRoot),
        root: projectRoot,
        repository: "",
        stack: ["sma"]
      }
    };
  }

  const project = registry.projects?.[0] || {};
  const securityBlocked = (security?.high_or_critical || 0) > 0;
  const validationBlocked = (project.error_count || 0) > 0 || (project.health_counts?.fail || 0) > 0;
  const warningCount = project.warning_count || 0;

  metadata.sma = {
    ...(metadata.sma || {}),
    status: securityBlocked
      ? "indexed_security_blocked"
      : validationBlocked
        ? "indexed_validation_blocked"
        : warningCount > 0
          ? "indexed_with_warnings"
          : "indexed_clean",
    latest_registry: ".sweetspot/scans/latest.registry.json",
    security_gate: security ? {
      status: securityBlocked ? "blocked" : "pass",
      report: ".sweetspot/scans/security-gate.json",
      findings: security.count || 0,
      high_or_critical: security.high_or_critical || 0,
      scanned_files: security.scanned_files || 0,
      truncated: Boolean(security.truncated)
    } : metadata.sma?.security_gate,
    promotion_backlog: {
      manifest_warnings: warningCount,
      validation_errors: project.error_count || 0,
      unmanifested: registry.unmanifested_count || 0
    }
  };

  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(projectFile, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function listDirs(res, options, requestUrl) {
  const requested = path.resolve(requestUrl.searchParams.get("path") || options.allowRoot);

  if (!inside(options.allowRoot, requested)) {
    sendJson(res, 403, { error: `Path is outside allow-root: ${options.allowRoot}` });
    return;
  }

  const entries = await fs.readdir(requested, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !browseExcludedDirs.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(requested, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = requested === options.allowRoot ? "" : path.dirname(requested);

  sendJson(res, 200, { path: requested, parent, dirs });
}

async function scanProject(res, options, req) {
  const body = await readBody(req);
  const root = path.resolve(body.root || "");

  if (!root || !inside(options.allowRoot, root)) {
    sendJson(res, 403, { error: `Scan root must be inside ${options.allowRoot}` });
    return;
  }

  let slug = scanSlug(root);
  let scanDir = path.join(options.scans, slug);
  let registryPath = path.join(scanDir, "latest.registry.json");
  let wikiPath = path.join(scanDir, "wiki");

  await fs.mkdir(scanDir, { recursive: true });
  const registry = await runScan(root, registryPath);
  const canonicalSlug = registrySlug(registry, slug);

  if (canonicalSlug !== slug) {
    slug = canonicalSlug;
    scanDir = path.join(options.scans, slug);
    registryPath = path.join(scanDir, "latest.registry.json");
    wikiPath = path.join(scanDir, "wiki");
    await fs.mkdir(scanDir, { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  await runWiki(registryPath, wikiPath);

  sendJson(res, 200, {
    root,
    registry: registryPath,
    wiki: wikiPath,
    dashboard: `/scans/${encodeURIComponent(slug)}/wiki/DASHBOARD.generated.html`,
    brick_wall: `/scans/${encodeURIComponent(slug)}/wiki/BRICK_WALL.generated.html`,
    count: registry.count || 0,
    unmanifested_count: registry.unmanifested_count || 0,
    validation_error_count: registry.validation_error_count || 0,
    validation_warning_count: registry.validation_warning_count || 0
  });
}

async function setupProject(res, options, req) {
  const body = await readBody(req);
  const root = path.resolve(body.root || "");

  if (!root || !inside(options.allowRoot, root)) {
    sendJson(res, 403, { error: `Setup root must be inside ${options.allowRoot}` });
    return;
  }

  let slug = scanSlug(root);
  let scanDir = path.join(options.scans, slug);
  let registryPath = path.join(scanDir, "latest.registry.json");
  let securityPath = path.join(scanDir, "security-gate.json");
  let wikiPath = path.join(scanDir, "wiki");

  await fs.mkdir(scanDir, { recursive: true });
  const initialRegistry = await runScan(root, registryPath);
  const canonicalSlug = registrySlug(initialRegistry, slug);

  if (canonicalSlug !== slug) {
    slug = canonicalSlug;
    scanDir = path.join(options.scans, slug);
    registryPath = path.join(scanDir, "latest.registry.json");
    securityPath = path.join(scanDir, "security-gate.json");
    wikiPath = path.join(scanDir, "wiki");
    await fs.mkdir(scanDir, { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(initialRegistry, null, 2)}\n`);
  }

  let bootstrap = null;

  if ((initialRegistry.unmanifested_count || 0) > 0) {
    const result = await run("node", [
      path.join(smaRoot, "tools", "sma-bootstrap-manifests.mjs"),
      "--registry",
      registryPath,
      "--write"
    ], smaRoot);
    bootstrap = JSON.parse(result.stdout);
  }

  const registry = await runScan(root, registryPath);
  await runWiki(registryPath, wikiPath);

  const projectRoot = registry.scanned_project_roots?.[0]?.root || root;
  const security = await runSecurity(projectRoot, securityPath);
  await copyProjectReports(projectRoot, registryPath, securityPath);
  await updateProjectMetadata(projectRoot, registry, security);

  sendJson(res, 200, {
    root,
    project_root: projectRoot,
    registry: registryPath,
    wiki: wikiPath,
    dashboard: `/scans/${encodeURIComponent(slug)}/wiki/DASHBOARD.generated.html`,
    brick_wall: `/scans/${encodeURIComponent(slug)}/wiki/BRICK_WALL.generated.html`,
    bootstrap,
    count: registry.count || 0,
    unmanifested_count: registry.unmanifested_count || 0,
    validation_error_count: registry.validation_error_count || 0,
    validation_warning_count: registry.validation_warning_count || 0,
    security_findings: security.count || 0,
    security_high_or_critical: security.high_or_critical || 0
  });
}

async function serveStatic(res, options, requestUrl) {
  let relativePath = decodeURIComponent(requestUrl.pathname);

  if (relativePath === "/") {
    relativePath = "/DASHBOARD.generated.html";
  }

  let root = options.wiki;

  if (relativePath.startsWith("/scans/")) {
    root = smaRoot;
  }

  const filePath = path.resolve(root, `.${relativePath}`);

  if (!inside(root, filePath)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    const target = stat.isDirectory() ? path.join(filePath, "DASHBOARD.generated.html") : filePath;
    const content = await fs.readFile(target);
    send(res, 200, content, contentType(target));
  } catch {
    send(res, 404, "Not found");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.selftest) {
    await runSelftest();
    return;
  }

  options.wiki = path.resolve(options.wiki);
  options.scans = path.resolve(options.scans);
  options.allowRoot = path.resolve(options.allowRoot);
  validateStartupPolicy(options);

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && requestUrl.pathname === "/api/list") {
        await listDirs(res, options, requestUrl);
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/scan") {
        if (!mutationAuthorized(req, options)) {
          denyMutation(res, options);
          return;
        }
        await scanProject(res, options, req);
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/setup") {
        if (!mutationAuthorized(req, options)) {
          denyMutation(res, options);
          return;
        }
        await setupProject(res, options, req);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(res, options, requestUrl);
        return;
      }

      send(res, 405, "Method not allowed");
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(options.port, options.host, () => {
    console.log(`SMA dashboard server running at http://${options.host}:${options.port}/`);
    console.log(`Serving ${options.wiki}`);
    console.log(`Allow-root ${options.allowRoot}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
