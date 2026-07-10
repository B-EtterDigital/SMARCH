/**
 * source-path-resolver.mjs — resolve a brick's directory and git-relative
 * path consistently across planner + runner.
 *
 * The registry occasionally stores `source_paths` with the project name as
 * the first segment (e.g. project="acme-agent", source_paths[0]="acme-agent/...").
 * When we resolve that against a project root that already ends in the
 * project name, we get a doubled prefix and the path doesn't exist on disk.
 * The manifest_path field is always correct, so we use its directory as the
 * source of truth.
 *
 * Resolution order:
 *   1. dirname(manifest_path) — trusted; the scanner verified this
 *   2. resolve(projectAbs, source_paths[0]) — direct
 *   3. resolve(projectAbs, source_paths[0] minus first segment) — strip
 *      doubled prefix
 *
 * Returns absolute path on disk + relative-to-project path for git operations.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';

/**
 * Returns { absolutePath, gitRelativePath, source } or null.
 *
 *   absolutePath     — the brick's source directory on disk (best guess)
 *   gitRelativePath  — POSIX-style path from projectAbs to absolutePath
 *   source           — 'manifest' | 'src-direct' | 'src-stripped'
 */
export function resolveBrickPath(brick, projectAbs) {
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
      const fileGuess = resolve(dir, /** strip the manifest prefix */
        brick.manifest_path.split(sep).pop()
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
export function gitRelativePath(brick, projectAbs) {
  const r = resolveBrickPath(brick, projectAbs);
  return r ? r.gitRelativePath : null;
}

function posix(p) {
  return String(p).split(sep).join('/');
}
