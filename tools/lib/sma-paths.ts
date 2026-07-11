/**
 * sma-paths.ts — single source of truth for where SMA lives on disk.
 *
 * Every tool derives its roots from here instead of hardcoding machine paths.
 *
 * Resolution order:
 *   SMA_ROOT       — env SMA_ROOT, else the repository containing this file.
 *   DEV_ROOT       — env SMA_DEV_ROOT, else the parent of SMA_ROOT.
 *   PROJECTS_ROOT  — env SMA_PROJECTS_ROOT, else <DEV_ROOT>/Projects.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SMA_ROOT = process.env.SMA_ROOT
  ? path.resolve(process.env.SMA_ROOT)
  : path.resolve(__dirname, "..", "..");

export const DEV_ROOT = process.env.SMA_DEV_ROOT
  ? path.resolve(process.env.SMA_DEV_ROOT)
  : path.resolve(SMA_ROOT, "..");

export const PROJECTS_ROOT = process.env.SMA_PROJECTS_ROOT
  ? path.resolve(process.env.SMA_PROJECTS_ROOT)
  : path.resolve(DEV_ROOT, "Projects");

/** Absolute path inside the SMA control-plane repo. */
export function smaPath(...segments: string[]): string {
  return path.join(SMA_ROOT, ...segments);
}

/** Absolute path inside the projects portfolio root. */
export function projectsPath(...segments: string[]): string {
  return path.join(PROJECTS_ROOT, ...segments);
}
