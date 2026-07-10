#!/usr/bin/env bash

# Claude Code PreToolUse hook. This hook is deliberately fail-soft: no failure
# in ambient coordination may prevent the requested write tool from running.

warn() {
  printf '[sma-ambient] WARN: %s\n' "$*" >&2
}

need_you() {
  printf '> 🟡 **NEED YOU** — %s\n' "$*" >&2
}

main() {
  local input parsed project_root relative_path project_id module intent status output

  if ! input="$(cat)"; then
    warn "could not read PreToolUse input; continuing"
    return 0
  fi

  if ! parsed="$(printf '%s' "$input" | node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const toolInput = payload.tool_input ?? {};
    const writtenPath = toolInput.file_path
      ?? toolInput.notebook_path
      ?? toolInput.path
      ?? toolInput.files?.[0]?.file_path
      ?? toolInput.files?.[0]?.path;
    if (!writtenPath) process.exit(3);
    let root = path.resolve(payload.cwd ?? process.cwd());
    while (!fs.existsSync(path.join(root, "sma.gen3.json"))) {
      const parent = path.dirname(root);
      if (parent === root) process.exit(4);
      root = parent;
    }
    const absolute = path.isAbsolute(writtenPath)
      ? path.resolve(writtenPath)
      : path.resolve(payload.cwd ?? process.cwd(), writtenPath);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (relative === ".." || relative.startsWith("../")) process.exit(5);
    process.stdout.write(`${root}\n${relative}`);
  ' 2>/dev/null)"; then
    warn "invalid or out-of-project PreToolUse write input; continuing"
    return 0
  fi

  project_root="${parsed%%$'\n'*}"
  relative_path="${parsed#*$'\n'}"

  if ! project_id="$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const config = JSON.parse(fs.readFileSync(path.join(root, "sma.gen3.json"), "utf8"));
    const smaRoot = path.resolve(process.argv[2]);
    process.stdout.write(path.resolve(root) === smaRoot ? "sma" : String(config.project?.id ?? path.basename(root)));
  ' "$project_root" "$SMA_ROOT" 2>/dev/null)"; then
    warn "could not resolve the SMA project id; continuing"
    return 0
  fi

  if ! output="$(cd "$project_root" && node "$SMA_ROOT/tools/sma-gen3-classify.mjs" --changed-file "$relative_path" 2>&1)"; then
    warn "module classification failed for $relative_path: $output"
    return 0
  fi

  if ! module="$(printf '%s' "$output" | node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(0, "utf8"));
    if (result.module) process.stdout.write(String(result.module));
  ' 2>/dev/null)"; then
    warn "module classification returned invalid JSON for $relative_path; continuing"
    return 0
  fi
  if [[ -z "$module" ]]; then
    return 0
  fi

  status=0
  node "$SMA_ROOT/tools/sma-lease.mjs" status \
    --resource-kind brick \
    --resource "$module" \
    --json >/dev/null 2>&1 || status=$?

  if [[ "$status" -eq 11 ]]; then
    return 0
  fi
  if [[ "$status" -ne 0 && "$status" -ne 10 ]]; then
    warn "lease status failed for $module with exit $status; continuing"
    return 0
  fi

  intent="${SMA_TASK_TITLE:-Ambient write to $module ($relative_path)}"
  status=0
  output="$(cd "$project_root" && npm run start:edit --silent -- \
    --project "$project_id" \
    --brick "$module" \
    --intent "$intent" \
    --file "$relative_path" 2>&1)" || status=$?

  if [[ "$status" -eq 0 ]]; then
    printf '[sma-ambient] auto-acquired lease for %s (%s)\n' "$module" "$relative_path" >&2
    return 0
  fi

  if [[ "$status" -eq 10 ]]; then
    printf '%s\n' "$output" >&2
    need_you "Lease conflict for module $module while writing $relative_path; conflict_detected was logged and the write will continue."
    return 0
  fi

  warn "auto-lease failed for $module with exit $status: $output"
  return 0
}

SMA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
main "$@" || warn "unexpected pre-write hook error; continuing"
exit 0
