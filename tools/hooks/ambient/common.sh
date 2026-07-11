#!/usr/bin/env bash

# Shared fail-soft discovery for the ambient pre/post write hooks.

warn() {
  printf '[sma-ambient] WARN: %s\n' "$*" >&2
}

ambient_parse_write_input() {
  printf '%s' "$1" | node -e '
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
  ' 2>/dev/null
}

ambient_project_id() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const config = JSON.parse(fs.readFileSync(path.join(root, "sma.gen3.json"), "utf8"));
    const smaRoot = path.resolve(process.argv[2]);
    process.stdout.write(path.resolve(root) === smaRoot ? "sma" : String(config.project?.id ?? path.basename(root)));
  ' "$1" "$SMA_ROOT" 2>/dev/null
}

ambient_module() {
  local output
  output="$(cd "$1" && node "$SMA_ROOT/tools/sma-gen3-classify.mjs" --changed-file "$2" 2>&1)" || return $?
  printf '%s' "$output" | node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(0, "utf8"));
    if (result.module) process.stdout.write(String(result.module));
  ' 2>/dev/null
}
