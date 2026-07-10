#!/usr/bin/env bash

# Claude Code PostToolUse hook. Like pre-write.sh, this always exits zero so
# context telemetry can never turn a successful write into a failed tool call.

warn() {
  printf '[sma-ambient] WARN: %s\n' "$*" >&2
}

main() {
  local input parsed project_root relative_path project_id module intent output

  if ! input="$(cat)"; then
    warn "could not read PostToolUse input; continuing"
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
    warn "invalid or out-of-project PostToolUse write input; continuing"
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

  intent="${SMA_TASK_TITLE:-Ambient write applied to $module}"
  if ! output="$(node "$SMA_ROOT/tools/sma-context.mjs" append \
    --project "$project_id" \
    --brick "$module" \
    --kind edit_applied \
    --intent "$intent" \
    --file "$relative_path" \
    --json 2>&1)"; then
    warn "context append failed for $module: $output"
    return 0
  fi

  printf '[sma-ambient] logged write context for %s (%s)\n' "$module" "$relative_path" >&2
  return 0
}

SMA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
main "$@" || warn "unexpected post-write hook error; continuing"
exit 0
