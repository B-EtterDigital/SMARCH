/**
 * WHAT: Calls the optional smarch-core binary through its versioned JSON protocol.
 * WHY: Native acceleration must remain transparent and never become a runtime prerequisite.
 * HOW: Resolves SMA_CORE_BIN before PATH, validates responses, and returns null for fallback.
 * INPUTS: Kernel command arguments and SMA_CORE/SMA_CORE_BIN environment controls.
 * OUTPUTS: Parsed protocol data, null when unavailable, or an error when SMA_CORE=required.
 */
import { spawnSync } from "node:child_process";

const protocolMajor = "1";

export type RustScanFile = {
  path: string;
  relative_path: string;
  size?: number;
  xxh3?: string;
  sha256?: string;
};

type KernelEnvelope<T> = {
  protocol_version: string;
  command: string;
  data: T;
};

export type RustWalkOptions = {
  root: string;
  excludedRoots?: string[];
  excludedDirNames?: string[];
  excludedDirPatterns?: string[];
  includeHashes?: boolean;
};

function failOrFallback(message: string, cause?: unknown): null {
  if (String(process.env.SMA_CORE || "").trim().toLowerCase() === "required") {
    throw new Error(message, cause ? { cause } : undefined);
  }
  return null;
}

export function runRustCore<T>(command: string, args: string[]): T | null {
  if (String(process.env.SMA_CORE || "").trim().toLowerCase() === "off") return null;
  const binary = String(process.env.SMA_CORE_BIN || "").trim() || "smarch-core";
  const result = spawnSync(binary, [command, "--json", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) return failOrFallback(`smarch-core unavailable at ${binary}`, result.error);
  if (result.status !== 0) {
    return failOrFallback(`smarch-core ${command} failed (${result.status}): ${String(result.stderr || "").trim()}`);
  }
  try {
    const envelope = JSON.parse(String(result.stdout || "")) as KernelEnvelope<T>;
    if (String(envelope.protocol_version || "").split(".")[0] !== protocolMajor) {
      return failOrFallback(`smarch-core protocol mismatch: ${envelope.protocol_version || "missing"}`);
    }
    if (envelope.command !== command || !envelope.data || typeof envelope.data !== "object") {
      return failOrFallback(`smarch-core returned an invalid ${command} envelope`);
    }
    return envelope.data;
  } catch (error) {
    return failOrFallback(`smarch-core returned invalid JSON for ${command}`, error);
  }
}

export function rustWalkManifestPaths(options: RustWalkOptions): RustScanFile[] | null {
  const args = [options.root];
  for (const root of options.excludedRoots || []) args.push("--exclude-root", root);
  for (const name of options.excludedDirNames || []) args.push("--exclude-dir", name);
  for (const pattern of options.excludedDirPatterns || []) args.push("--exclude-pattern", pattern);
  if (options.includeHashes) args.push("--include-hashes");
  const data = runRustCore<{ root: string; files: RustScanFile[] }>("scan", args);
  if (!data) return null;
  if (!Array.isArray(data.files) || data.files.some((file) => !file || typeof file.path !== "string")) {
    return failOrFallback("smarch-core returned an invalid scan file list");
  }
  return data.files;
}

export function rustHashFile(path: string) {
  return runRustCore<{ path: string; size: number; xxh3: string; sha256: string }>("hash", [path]);
}

export function rustSimilarity(leftPath: string, rightPath: string) {
  return runRustCore<{ left: string; right: string; score: number }>("sim", [leftPath, rightPath]);
}

