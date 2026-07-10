#!/usr/bin/env bash
# pre-commit-context-check.sh — block commits that include modified brick
# manifests without a matching agent-context event.
#
# Designed to be invoked from any pre-commit framework (husky, plain
# .git/hooks/pre-commit, lefthook, simple-git-hooks):
#
#   #!/bin/sh
#   ~/DEV/SMARCH/tools/hooks/pre-commit-context-check.sh
#
# Or, project-local install:
#
#   ln -s ~/DEV/SMARCH/tools/hooks/pre-commit-context-check.sh \
#         .git/hooks/pre-commit
#
# Behavior:
#   - Inspects `git diff --cached --name-only` for staged
#     `module.sweetspot.json` / `build.sweetspot.json` files
#   - Resolves the project id from the closest ancestor under
#     ~/DEV/Projects/
#   - Runs `sma context-check check --strict --project <id>` for each
#     affected project
#   - Exits non-zero if any project fails (blocks the commit)
#
# Bypass with: git commit --no-verify (use sparingly)
# Set SMA_CONTEXT_CHECK_WARN=1 to warn-only (does not block).

set -euo pipefail

PROJECTS_ROOT="${SMA_PROJECTS_ROOT:-~/DEV/Projects}"
SMA_ROOT="${SMA_ROOT:-~/DEV/SMARCH}"
WARN_ONLY="${SMA_CONTEXT_CHECK_WARN:-0}"

# Collect staged manifest paths
staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null \
  | grep -E '(module|build)\.sweetspot\.json$' || true)"

if [ -z "${staged}" ]; then
  exit 0
fi

# Map each staged manifest back to a project id by walking up to PROJECTS_ROOT.
# Repo-relative paths from `git diff --cached` are interpreted from the repo
# root, but we need the absolute path. We assume the repo lives under
# PROJECTS_ROOT/<project_id>/...
repo_top="$(git rev-parse --show-toplevel)"
projects=""
while IFS= read -r rel; do
  [ -z "${rel}" ] && continue
  abs="${repo_top}/${rel}"
  # Walk up until parent is PROJECTS_ROOT
  cur="$(dirname "${abs}")"
  pid=""
  while [ "${cur}" != "/" ] && [ "${cur}" != "." ]; do
    parent="$(dirname "${cur}")"
    if [ "${parent}" = "${PROJECTS_ROOT}" ]; then
      pid="$(basename "${cur}")"
      break
    fi
    cur="${parent}"
  done
  if [ -n "${pid}" ]; then
    case " ${projects} " in
      *" ${pid} "*) ;;
      *) projects="${projects} ${pid}" ;;
    esac
  fi
done <<< "${staged}"

if [ -z "${projects}" ]; then
  # Manifests staged but not under a recognized project root — let it pass.
  exit 0
fi

failed=0
for pid in ${projects}; do
  echo "[pre-commit] context-check project ${pid}"
  if [ "${WARN_ONLY}" = "1" ]; then
    if ! node "${SMA_ROOT}/tools/sma-context-check.mjs" check --project "${pid}"; then
      echo "[pre-commit] (warn-only) context-check failed for ${pid}"
    fi
  else
    if ! node "${SMA_ROOT}/tools/sma-context-check.mjs" check --project "${pid}" --strict; then
      failed=$((failed + 1))
    fi
  fi
done

if [ "${failed}" -gt 0 ]; then
  echo ""
  echo "[pre-commit] BLOCKED: ${failed} project(s) have staged brick manifests without matching agent-context events."
  echo "Fix with:"
  echo "  sma context append --project <id> --brick <id> --kind edit_applied --intent \"...\""
  echo "Or backfill from the staged commit's intended message:"
  echo "  sma backfill add --manifest <path> --intent \"...\" --role implementer --actor-kind ai_model --project <id>"
  echo ""
  echo "Bypass (last resort):"
  echo "  git commit --no-verify"
  echo "  or: SMA_CONTEXT_CHECK_WARN=1 git commit"
  exit 1
fi

exit 0
