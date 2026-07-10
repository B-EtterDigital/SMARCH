# Ambient SMA Hooks

SMA supports two coordination modes. They use the same lease and context CLIs,
so teams can mix them without creating a second source of truth.

## Explicit mode

Explicit mode is unchanged. Acquire the module lease before editing, then close
the edit when the work is complete:

```bash
npm run start:edit -- --project <id> --brick <module> --intent "<task>"
npm run end:edit -- --project <id> --brick <module> --lease <lease-id> --intent "<result>"
```

Use explicit mode for controllers, planned multi-agent work, shared hot paths,
and any workflow that needs to retain the lease id for a later closeout.

## Ambient mode

Ambient mode wires Claude Code `PreToolUse` and `PostToolUse` hooks to the
`Write`, `Edit`, `MultiEdit`, and `NotebookEdit` tools:

```bash
node tools/install-agent-skills.mjs --target /path/to/project --hooks
```

The installer merges entries into `.claude/settings.json`. Existing settings,
hook events, and hook commands are preserved, and rerunning the installer does
not duplicate the SMA commands.

Before a write, `pre-write.sh` finds the nearest `sma.gen3.json`, classifies the
first written path, and skips acquisition when `$SMA_AGENT` already holds that
module lease. Otherwise it runs the project's `npm run start:edit --silent`
command. A collision is recorded by the existing `start:edit` conflict path and
prints the standard `NEED YOU` marker, but never blocks the write.

After a write, `post-write.sh` appends an `edit_applied` event with the touched
file. Set `SMA_TASK_TITLE` to use the active task title as the event intent;
otherwise the hook supplies an ambient-write intent.

Both scripts are fail-soft. Malformed input, missing project configuration, CLI
errors, and telemetry failures emit a `[sma-ambient] WARN:` line and exit zero,
so a hook can never fail the underlying tool call.
