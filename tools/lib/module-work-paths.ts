/**
 * WHAT: Compares module path patterns while respecting declared exclusions.
 * WHY: Parallel assignments are unsafe when glob patterns hide an overlap or shared hot path.
 * HOW: Reduces patterns to stable bases and literal tokens, then reports covering or overlapping pairs.
 * INPUTS: Module path arrays, exclusion arrays, and shared-hot-path declarations.
 * OUTPUTS: Boolean overlap answers, matching path pairs, and compact path samples.
 * CALLERS: The module-work planner uses these helpers before offering or claiming slots.
 * @example node --input-type=module -e "import { modulesOverlap } from './tools/lib/module-work-paths.ts'; console.log(modulesOverlap({ paths: ['src/a/**'] }, { paths: ['src/a/file.mjs'] }));"
 */
/** Path-overlap helpers for sma-module-work-packets.mjs. */

export type ModulePathSpec = {
  paths?: string[];
  excludePaths?: string[];
};

export type SharedHotPath = ModulePathSpec & {
  id: string;
  label?: string;
  risk?: string;
  requiredGates?: string[];
};

export type PathOverlapPair = { left: string; right: string };

export function modulePathSamples(module: ModulePathSpec): string[] {
  return (module.paths || []).slice(0, 12);
}

export function overlappingSharedHotPaths(sharedHotPaths: SharedHotPath[], module: ModulePathSpec) {
  return sharedHotPaths
    .filter((hot) => overlappingPathPairsWithExcludes(module.paths || [], hot.paths || [], module.excludePaths || [], []).length > 0)
    .map((hot) => ({
      id: hot.id,
      label: hot.label || hot.id,
      risk: hot.risk || 'unknown',
      required_gates: hot.requiredGates || [],
    }));
}

export function modulesOverlap(left: ModulePathSpec | null | undefined, right: ModulePathSpec | null | undefined): boolean {
  if (!left || !right) return false;
  return overlappingModulePathPairs(left, right).length > 0;
}

export function pathsOverlap(leftPaths: string[], rightPaths: string[]): boolean {
  return overlappingPathPairs(leftPaths, rightPaths).length > 0;
}

export function overlappingPathPairs(leftPaths: string[], rightPaths: string[]): PathOverlapPair[] {
  return overlappingPathPairsWithExcludes(leftPaths, rightPaths, [], []);
}

export function overlappingModulePathPairs(leftModule: ModulePathSpec | null | undefined, rightModule: ModulePathSpec | null | undefined): PathOverlapPair[] {
  return overlappingPathPairsWithExcludes(
    leftModule?.paths || [],
    rightModule?.paths || [],
    leftModule?.excludePaths || [],
    rightModule?.excludePaths || [],
  );
}

export function overlappingPathPairsWithExcludes(leftPaths: string[], rightPaths: string[], leftExcludePaths: string[], rightExcludePaths: string[]): PathOverlapPair[] {
  const pairs: PathOverlapPair[] = [];
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      if (!pathPatternOverlap(left, right)) continue;
      if (patternCoveredByAnyExclude(right, leftExcludePaths)) continue;
      if (patternCoveredByAnyExclude(left, rightExcludePaths)) continue;
      pairs.push({ left, right });
    }
  }
  return pairs;
}

export function patternCoveredByAnyExclude(pattern: string, excludePaths: string[]): boolean {
  return (excludePaths || []).some((exclude) => pathPatternCovers(exclude, pattern));
}

export function pathPatternCovers(coverPattern: string, targetPattern: string): boolean {
  const coverBase = globBase(coverPattern);
  const targetBase = globBase(targetPattern);
  if (!coverBase || !targetBase) return false;
  const coverHasWildcard = /[*{[]/.test(String(coverPattern || ''));
  const baseCovers = coverBase === targetBase
    || targetBase.startsWith(`${coverBase}/`)
    || (coverHasWildcard && targetBase.startsWith(coverBase));
  if (!baseCovers) return false;
  const coverTokens = literalFileTokens(coverPattern);
  const targetTokens = literalFileTokens(targetPattern);
  if (coverTokens.length && targetTokens.length && !coverTokens.every((token) => targetTokens.includes(token))) {
    return false;
  }
  return true;
}

export function pathPatternOverlap(left: string, right: string): boolean {
  const a = globBase(left);
  const b = globBase(right);
  if (!a || !b) return false;
  const maybeOverlap = a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (!maybeOverlap) return false;
  const leftTokens = literalFileTokens(left);
  const rightTokens = literalFileTokens(right);
  if (leftTokens.length && rightTokens.length && !leftTokens.some((token) => rightTokens.includes(token))) {
    return false;
  }
  return true;
}

export function globBase(pattern: string): string {
  let value = String(pattern || '').replace(/\\/g, '/').trim();
  if (!value) return '';
  const wildcard = value.search(/[*{[]/);
  if (wildcard >= 0) value = value.slice(0, wildcard);
  value = value.replace(/\/+$/, '');
  if (value.endsWith('/**')) value = value.slice(0, -3).replace(/\/+$/, '');
  if (value.endsWith('/')) value = value.slice(0, -1);
  const parts = value.split('/').filter(Boolean);
  if (!parts.length) return '';
  return parts.join('/');
}

export function literalFileTokens(pattern: string): string[] {
  const file = String(pattern || '').replace(/\\/g, '/').split('/').pop() || '';
  return file
    .replace(/\*\*/g, '*')
    .split(/[*{}[\]().,_\-\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .filter((part) => !['tsx', 'ts', 'jsx', 'js', 'json', 'md', 'yml', 'yaml'].includes(part));
}
