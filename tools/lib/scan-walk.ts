/**
 * Filesystem walk seam for the SMA scanner.
 * Extracted from sma-scan.ts; keep registry behavior byte-identical.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { rustWalkManifestPaths } from "./rust-core.ts";

export type ScanWalkOptions = {
  isExcludedDirName?: (name: string) => boolean;
  isExcludedPath?: (targetPath: string) => boolean;
};

export async function walk(root: string, options: ScanWalkOptions = {}, results: string[] = []): Promise<string[]> {
  if (results.length === 0) {
    const nativeFiles = rustWalkManifestPaths({ root });
    if (nativeFiles) {
      for (const file of nativeFiles) {
        const fullPath = path.resolve(file.path);
        const relativeParts = path.relative(path.resolve(root), fullPath).split(path.sep);
        if (relativeParts.some((name) => options.isExcludedDirName?.(name))) continue;
        if (options.isExcludedPath?.(fullPath)) continue;
        results.push(fullPath);
      }
      return results.sort((left, right) => left.localeCompare(right));
    }
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && options.isExcludedDirName?.(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (options.isExcludedPath?.(fullPath)) continue;
    if (entry.isDirectory()) {
      await walk(fullPath, options, results);
    } else if (entry.isFile() && (entry.name === "module.sweetspot.json" || entry.name.endsWith(".module.sweetspot.json"))) {
      results.push(fullPath);
    }
  }
  return results;
}
