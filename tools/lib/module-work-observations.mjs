import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function latestObservationForDispatch({ dispatchId, observationDir, rootDir }) {
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
  const local = (filePath) => (rootDir ? relative(rootDir, filePath) : filePath);
  return {
    json_path: local(jsonPath),
    markdown_path: existsSync(markdownPath) ? local(markdownPath) : null,
  };
}
