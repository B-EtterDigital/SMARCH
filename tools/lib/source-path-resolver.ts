/**
 * WHAT: Resolves a registry brick to an existing absolute and repository-relative path.
 * WHY: Prefixed source paths can otherwise duplicate the project directory and miss real files.
 * HOW: Prefers the manifest location, then tries direct and stripped source-path candidates.
 * OUTPUTS: Returns path details for planners, scanners, and runners, or null when unresolved.
 * CALLERS: Similarity, provenance, and installation tools share this resolver.
 * @example
 * const resolved = resolveBrickPath(brick, "/workspace/project");
 * Glossary: [SMA](../../docs/GLOSSARY.md).
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';

type BrickPathInput = {
  manifest_path?: string;
  source_paths?: string[];
};

type ResolvedBrickPath = {
  absolutePath: string;
  gitRelativePath: string;
  source: 'manifest' | 'src-direct' | 'src-stripped';
};

/**
 * Returns { absolutePath, gitRelativePath, source } or null.
 *
 *   absolutePath     — the brick's source directory on disk (best guess)
 *   gitRelativePath  — POSIX-style path from projectAbs to absolutePath
 *   source           — 'manifest' | 'src-direct' | 'src-stripped'
 */
export function resolveBrickPath(brick: BrickPathInput | null | undefined, projectAbs: string): ResolvedBrickPath | null {
  if (!brick || !projectAbs) return null;

  // 1. manifest_path is the most reliable signal
  if (brick.manifest_path && existsSync(brick.manifest_path)) {
    let dir = dirname(brick.manifest_path);
    // For file-style manifests like Foo.module.sweetspot.json, the manifest
    // sits next to the file, not in the file's directory. Try to detect by
    // looking at the source_paths[0] basename for a file extension.
    const src = brick.source_paths?.[0];
    if (src && /\.[a-z0-9]{1,8}$/i.test(src)) {
      // It's likely a file-style brick. The "dir" we want is dirname(src) or
      // the actual file path. Use manifest_dir as parent and try combining.
      const manifestName = brick.manifest_path.split(sep).pop() || '';
      const fileGuess = resolve(dir, /** strip the manifest prefix */
        manifestName
          .replace(/\.module\.sweetspot\.json$/, '.' + (src.split('.').pop() || 'ts'))
          .replace(/^module\.sweetspot\.json$/, '')
      );
      if (fileGuess && existsSync(fileGuess)) {
        return {
          absolutePath: fileGuess,
          gitRelativePath: posix(relative(projectAbs, fileGuess)),
          source: 'manifest',
        };
      }
    }
    if (existsSync(dir)) {
      return {
        absolutePath: dir,
        gitRelativePath: posix(relative(projectAbs, dir)),
        source: 'manifest',
      };
    }
  }

  // 2. source_paths[0] direct against project root
  const src = brick.source_paths?.[0];
  if (src) {
    const direct = resolve(projectAbs, src);
    if (existsSync(direct)) {
      return {
        absolutePath: direct,
        gitRelativePath: posix(relative(projectAbs, direct)),
        source: 'src-direct',
      };
    }
    // 3. source_paths[0] with first segment stripped (doubled-prefix case)
    const segments = src.split(/[/\\]/).filter(Boolean);
    if (segments.length > 1) {
      const stripped = resolve(projectAbs, segments.slice(1).join('/'));
      if (existsSync(stripped)) {
        return {
          absolutePath: stripped,
          gitRelativePath: posix(relative(projectAbs, stripped)),
          source: 'src-stripped',
        };
      }
    }
  }

  return null;
}

/**
 * Convenience: just the git-relative path (POSIX style), or null.
 */
export function gitRelativePath(brick: BrickPathInput | null | undefined, projectAbs: string): string | null {
  const r = resolveBrickPath(brick, projectAbs);
  return r ? r.gitRelativePath : null;
}

function posix(p: string): string {
  return String(p).split(sep).join('/');
}
