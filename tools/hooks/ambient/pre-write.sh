#!/usr/bin/env bash

# Claude Code PreToolUse hook. Coordination errors stay fail-soft, but a
# confirmed live lease conflict must block the requested write.

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
    need_you "Lease conflict for module $module while writing $relative_path; conflict_detected was logged and the write was blocked."
    return 2
  fi

  warn "auto-lease failed for $module with exit $status: $output"
  return 0
}

run_selftest() {
  local mode="conflict" payload status

  node() {
    if [[ "$1" == "-e" && "$2" == *"writtenPath"* ]]; then
      printf '%s\n%s' "$SMA_ROOT" "tools/hooks/ambient/pre-write.sh"
      return 0
    fi
    if [[ "$1" == "-e" && "$2" == *"const config"* ]]; then
      printf 'sma'
      return 0
    fi
    if [[ "$1" == */sma-gen3-classify.mjs ]]; then
      [[ "$mode" == "error" ]] && return 99
      printf '{"module":"coord"}\n'
      return 0
    fi
    if [[ "$1" == "-e" && "$2" == *"result.module"* ]]; then
      printf 'coord'
      return 0
    fi
    if [[ "$1" == */sma-lease.mjs ]]; then
      return 10
    fi
    return 99
  }
  npm() {
    printf 'confirmed live conflict\n'
    return 10
  }

  payload="{\"tool_input\":{\"file_path\":\"tools/hooks/ambient/pre-write.sh\"},\"cwd\":\"$SMA_ROOT\"}"
  status=0
  main <<<"$payload" >/dev/null 2>&1 || status=$?
  [[ "$status" -eq 2 ]] || {
    warn "selftest expected confirmed conflict exit 2, received $status"
    return 1
  }

  mode="error"
  status=0
  main <<<"$payload" >/dev/null 2>&1 || status=$?
  [[ "$status" -eq 0 ]] || {
    warn "selftest expected hook error exit 0, received $status"
    return 1
  }

  printf 'SMA ambient pre-write selftest: passed\n'
}

SMA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
if [[ "${1:-}" == "--selftest" ]]; then
  run_selftest
  exit $?
fi

status=0
main "$@" || status=$?
if [[ "$status" -eq 2 ]]; then
  exit 2
fi
if [[ "$status" -ne 0 ]]; then
  warn "unexpected pre-write hook error; continuing"
fi
exit 0
