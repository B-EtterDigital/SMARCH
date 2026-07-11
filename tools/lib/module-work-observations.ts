/**
 * WHAT: Finds the newest persisted observation for one module-work dispatch.
 * WHY: Controllers need the latest proof file without guessing names or reading an entire directory.
 * HOW: Filters timestamped observation files by dispatch identifier and returns repository-relative paths.
 * INPUTS: A dispatch identifier, observation directory, and optional repository root.
 * OUTPUTS: Paths to the newest structured-data file and optional Markdown companion, or null.
 * CALLERS: Module watch, observe, and dispatch-status flows use this lookup.
 * @example node --input-type=module -e "import { latestObservationForDispatch } from './tools/lib/module-work-observations.ts'; console.log(latestObservationForDispatch({ dispatchId: 'demo', observationDir: '/tmp/missing' }));"
 */
import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function latestObservationForDispatch({ dispatchId, observationDir, rootDir }: {
  dispatchId: string;
  observationDir: string;
  rootDir?: string;
}): { json_path: string; markdown_path: string | null } | null {
  const id = String(dispatchId || '').trim();
  if (!id || !observationDir || !existsSync(observationDir)) return null;
  const prefix = `${id}-observed-`;
  const latestJson = readdirSync(observationDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .reverse()[0];
  if (!latestJson) return null;
  const jsonPath = resolve(observationDir, latestJson);
  const markdownPath = jsonPath.replace(/\.json$/i, '.md');
  const local = (filePath: string): string => (rootDir ? relative(rootDir, filePath) : filePath);
  return {
    json_path: local(jsonPath),
    markdown_path: existsSync(markdownPath) ? local(markdownPath) : null,
  };
}
