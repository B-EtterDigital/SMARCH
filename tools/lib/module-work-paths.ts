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

export function modulePathSamples(module) {
  return (module.paths || []).slice(0, 12);
}

export function overlappingSharedHotPaths(sharedHotPaths, module) {
  return sharedHotPaths
    .filter((hot) => overlappingPathPairsWithExcludes(module.paths || [], hot.paths || [], module.excludePaths || [], []).length > 0)
    .map((hot) => ({
      id: hot.id,
      label: hot.label || hot.id,
      risk: hot.risk || 'unknown',
      required_gates: hot.requiredGates || [],
    }));
}

export function modulesOverlap(left, right) {
  if (!left || !right) return false;
  return overlappingModulePathPairs(left, right).length > 0;
}

export function pathsOverlap(leftPaths, rightPaths) {
  return overlappingPathPairs(leftPaths, rightPaths).length > 0;
}

export function overlappingPathPairs(leftPaths, rightPaths) {
  return overlappingPathPairsWithExcludes(leftPaths, rightPaths, [], []);
}

export function overlappingModulePathPairs(leftModule, rightModule) {
  return overlappingPathPairsWithExcludes(
    leftModule?.paths || [],
    rightModule?.paths || [],
    leftModule?.excludePaths || [],
    rightModule?.excludePaths || [],
  );
}

export function overlappingPathPairsWithExcludes(leftPaths, rightPaths, leftExcludePaths, rightExcludePaths) {
  const pairs = [];
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

export function patternCoveredByAnyExclude(pattern, excludePaths) {
  return (excludePaths || []).some((exclude) => pathPatternCovers(exclude, pattern));
}

export function pathPatternCovers(coverPattern, targetPattern) {
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

export function pathPatternOverlap(left, right) {
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

export function globBase(pattern) {
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

export function literalFileTokens(pattern) {
  const file = String(pattern || '').replace(/\\/g, '/').split('/').pop() || '';
  return file
    .replace(/\*\*/g, '*')
    .split(/[*{}[\]().,_\-\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .filter((part) => !['tsx', 'ts', 'jsx', 'js', 'json', 'md', 'yml', 'yaml'].includes(part));
}
