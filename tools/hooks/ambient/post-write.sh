#!/usr/bin/env bash

# Claude Code PostToolUse hook. Like pre-write.sh, this always exits zero so
# context telemetry can never turn a successful write into a failed tool call.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

main() {
  local input parsed project_root relative_path project_id module intent output

  if ! input="$(cat)"; then
    warn "could not read PostToolUse input; continuing"
    return 0
  fi

  if ! parsed="$(ambient_parse_write_input "$input")"; then
    warn "invalid or out-of-project PostToolUse write input; continuing"
    return 0
  fi

  project_root="${parsed%%$'\n'*}"
  relative_path="${parsed#*$'\n'}"

  if ! project_id="$(ambient_project_id "$project_root")"; then
    warn "could not resolve the SMA project id; continuing"
    return 0
  fi

  if ! module="$(ambient_module "$project_root" "$relative_path")"; then
    warn "module classification failed for $relative_path: $output"
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
