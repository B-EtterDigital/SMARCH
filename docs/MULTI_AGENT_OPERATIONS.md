# Multi-Agent Operations Guide

The operator's guide for the SMA Gen3 multi-agent layer.

This is the operator's manual for the lease, agent-context, merge, and release-store layers. If you only read one section, read **The 30-second flow**.

## The 30-second flow

1. Before edits: `start:edit` a brick lease. It also saves a local dirty baseline and stamps the current agent/session.
2. If the lease is held, the blocked agent must leave a conflict report and back off.
3. While editing: `append` to the agent-context log.
4. When done: `end:edit` to record the outcome, release the lease, and print the dirty delta plus `cleanup ok` or `cleanup required`. It also prints the Gen3 big-picture TLDR so every completion keeps the overall state visible.
5. Before respawning agents or posting an interim status: `npm run gen3:status` for the low-token big-picture TLDR, or `npm run parallel:preflight -- --launch-plan` when you need spawn-ready cleanup slots or current module-dispatch claim slots. Use `--limit <n>` only when intentionally launching a smaller fixed wave.
6. Before global visibility regen: use `npm run portfolio:refresh` so `scan + state + dashboard` is queued/debounced. Use the raw `:safe` variants only for a specific artifact when a controller asks for it.
7. Before commit: `npm run context:check -- check --project <id>` to verify every modified manifest has matching context.
8. Before integration: `npm run conflict:check -- --project <id> --strict`, `npm run controller:dirty-check -- --project <id>`, or `npm run ci:gen3` to block unresolved collisions and unclaimed dirty work.

That's the whole protocol. The rest of this doc is "what to do when X."

## Clean-as-you-work and quiet status

Agents should reduce dirty-tree noise while they work, not at the end of the
day. Clean scratch files created by the current task, commit verified
task-scoped changes in narrow batches, then release the lease with `end:edit`.
Never clean another agent's files.

User-facing dirty reports are count-first:

```bash
# start:edit/end:edit do this automatically for leased work.
# For old sessions or unleased controller audits, save once at task start:
npm run dirty:save -- --project <project_id>

# report only what changed since that baseline:
npm run dirty:delta -- --project <project_id>

npm run controller:snapshot:quiet -- --project <project_id>
# equivalent:
npm run controller:snapshot -- --project <project_id> --dirty-limit 0

# controller-wide action queue:
npm run controller:sweep

# one-command auto-sized readiness score before launching a wave:
npm run parallel:preflight

# same big-picture report with the name agents should use in status updates:
npm run gen3:status

# live wave monitor after agents are launched:
npm run gen3:watch

# persist observed outcome after a launched or simulated wave:
npm run gen3:observe -- --dispatch latest
npm run gen3:observe:write -- --dispatch latest
# equivalent umbrella CLI:
sma gen3 observe --dispatch latest --write

# same check plus one spawn-ready cleanup/module line per agent slot:
npm run parallel:preflight -- --launch-plan

# persist the shared queue and cleanup packets:
npm run controller:sweep:write
```

Only list paths owned by the current task or paths that overlap/block it.
Summarize unrelated dirty files in one line: `unrelated dirty work exists: N
files, M untracked; left untouched`. Use `--dirty-limit <n>` or `--dirty-full`
only for controller audits.

`end:edit` treats newly dirty paths and status-changed paths since the start
baseline as `cleanup required`. Commit task-scoped work, delete scratch output,
or leave an explicit classified handoff before integration. Unchanged dirty
paths are reported as a hidden count so unrelated work does not consume status
tokens.

After releasing the lease, `end:edit` also runs a read-only
`parallel:preflight -- --no-auto-refresh` summary and prints a compact Gen3
big-picture block: TLDR, readiness score, recommended agents, launch slots,
conflicts, graph packets, active leases, current slice, the next three slices,
horizon, and next command. This keeps every agent completion tied to the
overall multi-slice plan. Use
`--no-preflight-tldr` only for scripted paths that require minimal output.

Interim user reports should start with the same big picture, not only the local
slice. When a status update has to answer "where are we overall?", run
`npm run gen3:status -- --no-auto-refresh` and report the TLDR, readiness
percent, recommended agents, launch slots, conflicts, graph packets, active
leases, current slice, and the next two or more slices/outlook. Keep dirty-tree
detail out of the status unless it is the owned blocker.

During or immediately after a parallel cleanup wave, use
`npm run gen3:watch -- --no-auto-refresh` for the live controller view. It
combines preflight, cleanup progress, and conflict SLA into one report: paths
reduced/remaining, cleared/reduced/grew/held/stale packets, conflict age,
graph gaps, active leases, gains, blockers, outlook, and next command. If it
shows any open conflict or critical SLA item, stop reassignment until the
conflict report is resolved or explicitly handed off.

`start:edit`, `end:edit`, `lease`, and `context` default attribution from the
runtime when explicit flags are omitted. Codex sessions use `CODEX_THREAD_ID`,
Claude sessions can use `CLAUDE_SESSION_ID`, and scripted agents can set
`SMA_AGENT` plus `SMA_SESSION_ID`. This keeps parallel cleanup and conflict
history attributable without every agent spelling out `--session`.

Use `end:edit --require-cleanup-ok` for controller-owned integration,
release-train, and strict cleanup-agent closeout. It checks the dirty delta
before logging/releasing; if the task still has new or status-changed dirty
paths, it exits `4` and leaves the lease held so the agent can clean, commit, or
write an explicit handoff.

`dirty:save` and `dirty:delta` store baselines under
`~/.cache/sma-gen3/dirty-baselines`, outside every repo. They do not clean or
stash anything. Use them to prove which dirty paths are new, cleared, or changed
during the current agent's task; unchanged unrelated dirty work stays a count.

This keeps the safety signal while cutting repeated dirty-tree status text by
roughly 90-98% on multi-agent runs with many unrelated files.

Tracked generated snapshots are stable by design. `SMA_STATE.generated.json`
and `GEN3_DASHBOARD.generated.html` omit volatile lease TTLs and SMA's own
transient regen leases, and they skip writes when only timestamps or TTLs moved.
If those files are dirty, treat it as a meaningful controller/state change or a
bug in the stable-generation filter, not normal heartbeat churn.

`controller:sweep` is the current action queue for the whole portfolio. It is
summary-only by design: blockers first, then graph warnings, then active leases
to watch. `active-dirty-scope` is a blocker: active leases exist, but one or
more dirty ownership groups look uncovered by the active lease resource/intent.
Normal output is capped to the top 25 items; use
`npm run controller:snapshot -- --all --actions-only --action-limit <n>` for a
larger controller audit. Use it before assigning agents and after large
parallel waves.

`controller:sweep:write` writes the same queue to:

- `handoffs/controller-actions.generated.json`
- `handoffs/controller-actions.generated.md`
- `handoffs/cleanup-packets.generated.json`
- `handoffs/cleanup-packets.generated.md`
- `handoffs/graph-packets.generated.json`
- `handoffs/graph-packets.generated.md`

Use the generated controller Markdown as the human handoff surface, the JSON for
automation, and `cleanup-packets.generated.md` as the low-token dispatch sheet
for cleanup agents. Cleanup packets include both `dirty-unleased` work and
`active-dirty-scope` uncovered groups, so agents can claim scope hygiene without
reading the full controller queue. Use `graph-packets.generated.md` as the
low-token dispatch sheet for project/module graph repair. Each cleanup packet
has one claim command, one optional inspect command, one conflict command, and a
finish rule. Each graph packet has one claim command, one bounded repair
command, one verify command, one inspect command, and a finish rule. Regenerate
them after large parallel waves or before assigning the next set of agents.
When a graph packet is `target-drift`, the repair command prints source-map
candidate fixes; update the module ownership/source map first, then refresh
module graphs. Do not retry graph refreshes against known-missing target paths.

Cleanup agents can claim a packet by rank without copy-pasting long shell
commands:

```bash
npm run cleanup:packets
npm run cleanup:progress -- --limit 20
npm run cleanup:wave -- --limit 12
npm run gen3:dispatch -- --limit 12
npm run cleanup:show -- --rank 1
npm run cleanup:claim -- --rank 1
npm run cleanup:claim -- --next
```

Use `cleanup:wave` when respawning a cleanup wave. It prints one assignment per
agent with the packet rank, claim command, mandatory prompt, sample paths, wave
gain percent, and project dirty reduction percent. The JSON form is suitable for
a controller UI or launcher. Each assignment also carries `monitor_command`
(`npm run gen3:watch -- --no-auto-refresh`) and `status_command`
(`npm run gen3:status -- --no-auto-refresh`) so spawned agents and controllers
share the same big-picture surface. The prompt explicitly makes conflict
reporting mandatory for overlap, uncertainty, or shared-path contention. The
output starts with a readiness summary so the controller can tell whether the
selected wave is fully claimable, partially held, stale, or empty before
spending tokens on agent launches:

```bash
npm run cleanup:wave -- --limit 12 --json
npm run cleanup:wave -- --limit 12 --write-dispatch
npm run gen3:dispatch -- --limit 12
```

`--write-dispatch` persists the exact launch manifest under
`handoffs/waves/` as JSON and Markdown. Use it immediately before real agent
respawn so the controller has durable proof of which packet ranks, prompts,
monitor commands, and conflict commands were launched. The Markdown file is the
human handoff; the JSON file is for launcher automation. Dispatch writing
refuses stale, held, or blocked waves by default; use
`--allow-blocked-dispatch` only for an explicit controller override.

After launching agents, persist an observation before assigning the next wave:

```bash
npm run gen3:observe -- --dispatch latest
npm run gen3:observe:write -- --dispatch latest
```

`gen3:observe` compares the dispatch manifest with `gen3:watch` output:
baseline paths, remaining paths, reduced paths, held/stale/grew packets,
conflicts, graph packets, active leases, and actual reduction percentage. The
`:write` form stores JSON and Markdown under `handoffs/waves/observations/`.
Use those observation artifacts as the real wave proof: predicted gains are not
treated as achieved until an observation shows the actual cleanup movement and
conflict state.

The Gen3 dashboard shows the same dispatch-to-observation proof chain. If it
shows `missing` or `dispatch-only`, the next controller action is to write the
dispatch manifest or persist the observation before launching another wave.

For controller decisions, prefer the combined preflight first:

```bash
npm run parallel:preflight
```

It rolls controller sweep, conflict SLA, cleanup wave readiness, and graph
packet readiness into one score. The command reports a readiness percentage,
recommended agent count, claimable path percentage, top wave/project gains, and
the next claim or refresh command. It also carries a big-picture TLDR, ETA band,
next three slices, and longer-horizon scale ceiling so operators do not lose the
overall direction during a long run. By default it lets packet tools refresh
stale handoffs once and auto-sizes the wave to the largest currently safe local
cleanup launch, capped at 12 agents. Use `--limit <n>` for fixed-size launches,
`--max-agents <n>` to change the auto cap, and `--launch-plan` when the
controller needs cleanup claim lines or dispatch-pinned module claim lines for
the active lane. Module launch lines are self-contained: they include the claim
command, module graph query, owned paths, gates, and dispatch prompt from the
module-wave manifest.
When `--no-auto-refresh` is used for a read-only status surface and generated
cleanup packets are stale, preflight can use the live controller cleanup wave as
`controller-parallel-wave` instead of reporting a false stale-packet blocker.
Refresh or observe after the wave so durable handoffs catch up.
The actual `module:claim` command prints the same receipt after acquiring its
lease, so the spawned agent should use that receipt as its local scope contract.
Use `--no-auto-refresh` only for read-only dashboards or audits where mutation
is not acceptable.

Generated cleanup packet handoffs and the dashboard store the default full-wave
gain percentages. `cleanup:wave -- --limit <n>` recalculates gain for the launch
size you ask for, so a 3-agent wave can show different wave percentages than the
12-agent dashboard while using the same packet ranks. The Gen3 dashboard reads
the generated cleanup packet summary for the default-wave agent count, dirty-path
coverage, top-wave gain, and overflow.

Use `cleanup:progress` when a controller wants live cleanup-wave movement without
printing paths. It compares each packet's generated dirty count to the current
dirty count for the same ownership group and reports remaining/reduced/cleared
counts. It reads `git status --short` per packet project, caches each project
once, and never cleans or stages files. The summary separates claimable packet
progress from held/stale packet progress so controllers can assign fresh work
without misreading blocked ranks as available.

`cleanup:claim` invokes `start:edit` with the packet's project, brick, intent,
packet rank/type/group, cleanup task id, and sample paths from the dirty group.
If the brick is already held, `start:edit` records the collision with that same
file context and the agent backs off. Use `--next` for parallel cleanup waves;
it skips packets that already have an active brick lease and claims the first
available packet. For `active-dirty-scope` packets, the agent must explain,
split, clean, or conflict report the uncovered group before integration.
Agent-context logs are considered covered only when an active brick lease
matches the log name exactly, for example
`.smarch/agent-context/<brick>.ndjson`. Source and proof files use narrow
brick/path tokens from the dirty group and sample paths; generic tokens such as
`src`, `renderer`, `docs`, and `context` must not hide sibling-module work.

Packet lists and claims refuse stale handoff files by default. `cleanup:packets`,
`cleanup:progress`, and `graph:packets` mark the whole packet file stale when
the global active-lease fingerprint changes, even if the file is still younger
than 900 seconds. `cleanup:claim` and `graph:claim` also require the selected
packet project's active-lease fingerprint to match. Default list/progress/show
commands and real claim commands auto-refresh stale default handoffs once and
retry, which removes the manual refresh round trip for normal agents. Use
`--allow-stale` only when a controller explicitly accepts the risk; `--dry-run`,
`--packet-file`, and `--no-auto-refresh` stay strict/read-only.

Graph repair agents use the same packet pattern:

```bash
npm run graph:packets
npm run graph:show -- --rank 1
npm run graph:claim -- --rank 1
npm run graph:claim -- --next
```

`graph:claim` invokes `start:edit` for the target project with either
`graphify-project` or `graphify-modules`. After claiming, run the generated
bounded `repair_command`, then the generated `verify_command`, then refresh the
controller packet files with `npm run controller:sweep:write`.

## Why this exists

GitHub stores **what changed**. SMARCH already stored **who and how**. What was missing — and what Theo's video / Pierre / Entire / Zed all flag as the Gen-3 gap — was **why** and **without two agents tripping over each other**.

These tools add three things on top of the existing brick layer:

- **Lease registry** — soft locks with TTL on bricks and regen targets. Stops the most common collision: two agents simultaneously regenerating `.generated.json` files or editing the same manifest. The live registry file is a local runtime cache, not a git-tracked artifact.
- **Agent-context log** — append-only NDJSON per brick. Records intent, decision, rejected alternatives, links to backlog, actor, and session. The "why" that survives session boundaries.
- **Conflict reports** — when an agent hits a held lease or overlapping work, it records the blocked intent, holder, and resolution plan before backing off.
- **Merge proposals** — when chains diverge, surface conflicting *intents* alongside conflicting bytes.

## Lease cheatsheet

```bash
# Acquire + log edit_planned (recommended)
npm run start:edit -- \
  --intent "what you are about to do" \
  --project <project_id> \
  --brick <brick_id> \
  --ttl 1200

# Wrap any command in a lease (recommended)
npm run lease -- run \
  --resource-kind state-regen \
  --resource global \
  --intent "regen state" \
  --ttl 600 \
  --auto-context \
  --project <project_id> --brick <brick_id> \
  -- node tools/sma-state.mjs

# Renew during long jobs (or use --renew-every with run)
npm run lease -- renew --lease <lease_id> --ttl 600

# Release
npm run lease -- release --lease <lease_id> --reason "done" --auto-context

# Check status (exit 0 free, 10 held by other, 11 held by self)
npm run lease -- status --resource-kind brick --resource <brick_id>

# List active
npm run lease:list

# Drop expired
npm run lease:expire
```

`--agent` defaults to `$SMA_AGENT` then `$USER`. Set `SMA_AGENT=claude-opus-4-7@sma-operator` (or whatever) in your shell profile so lease ownership is unambiguous across tools.

For edits to the SMA control plane itself (`~/DEV/SMARCH`), use `--project sma` with a descriptive control-plane brick id. The SMA project logs to its own `.smarch/agent-context/` directory just like regular modular projects.

Before broad SMA control-plane reads, use the self graph:

```bash
npm run graphify:refresh:self   # local code-only by default; --semantic is opt-in
npm run graphify:query:self -- -- "where is conflict gating wired?"
```

For project work, module graphs are the mandatory daily retrieval surface:

```bash
npm run graphify:check:modules -- --project acme-desktop --strict
npm run graphify:check:modules -- --project acme-desktop --strict --summary-json
npm run graphify:refresh:modules -- --project acme-desktop --missing-only --limit 100
npm run graphify:project-from-modules -- --project acme-desktop
npm run graphify:target-fixes -- --project acme-desktop
```

`graphify:check:modules` is concise by default so agents see only actionable
gaps. Known-empty code-only graphs count as satisfied because they are a real
generated result with an empty-graph reason. Use `--verbose` only when a
controller needs the full per-module listing. Use `--summary-json` for
machine-readable status; do not use full `--json` in normal agent status
because it prints every module row.
Use `graphify:target-fixes` when module graph gaps are missing targets rather
than missing graph files; it prints stale source paths, candidate replacement
paths, and the exact verification/refresh commands.

The global Gen3 dashboard also shows a cheap cached module-graph inventory from
`graphify-out/modules/**/graph.json` so controllers can see graph coverage
without running a full module check for every project.

Controller graph-gap repair commands use local code-only `--no-cluster` refreshes
with a bounded timeout by default. That makes broad portfolio graph coverage fast
enough for parallel agent work and prevents one oversized project from blocking
the controller queue; use clustered or semantic Graphify only when a controller
explicitly needs deeper graph enrichment.

Global Graphify indexing is opportunistic. If the local global graph hits its size cap,
continue refreshing module graphs and raise `GRAPHIFY_MAX_GRAPH_BYTES` only when a
controller explicitly needs a larger portfolio graph.

Portfolio scans intentionally skip agent worktree containers such as
`*-worktrees`. Worktrees are coordination surfaces for isolated branches, not
canonical module ownership sources. Scan the real project root, then let module
graphs carry the branch-local retrieval load.

## Conflict reports (mandatory)

Every collision must become a durable context event. This includes:

- `start:edit` fails because another live lease holds the brick.
- `git status` shows another agent already edited a file you planned to own.
- a shared hot path is active and your work would overlap it.
- a regen/global write is already leased.

`npm run start:edit` automatically records `conflict_detected` when brick lease acquisition exits with a held-resource conflict. For manual collisions, report explicitly:

```bash
npm run conflict -- report \
  --project <project_id> \
  --brick <brick_id> \
  --intent "what I was blocked from doing" \
  --resource-kind brick \
  --resource <brick_id> \
  --resolution-plan "back off until holder releases or split to another module"
```

When the collision is resolved:

```bash
npm run conflict -- resolve \
  --project <project_id> \
  --brick <brick_id> \
  --intent "resolved collision by waiting/splitting/merging" \
  --decision "agent moved to a non-overlapping module"
```

Controllers can inspect a brick:

```bash
npm run conflict -- list --project <project_id> --brick <brick_id> --open
```

Controllers can inspect the whole portfolio conflict SLA before respawning or
integrating agents:

```bash
npm run conflict:summary
npm run conflict:summary -- --json
```

The summary reports open conflicts by age bucket and flags warning/critical
collision reports. Use it as the low-token controller radar; use
`conflict:check` or `ci:gen3` as the strict integration gate.

Controllers can inspect the whole project and fail a gate when conflicts remain:

```bash
npm run conflict:check -- --project <project_id> --strict
```

Controllers can also fail fast when a project has dirty files without a Gen3
lease or outside the scope of its active Gen3 lease:

```bash
npm run controller:dirty-check -- --project <project_id>
# equivalent:
npm run controller:snapshot -- --project <project_id> --dirty-strict
```

`DIRTY-UNLEASED` means the project has uncommitted work that is not visible to
the lease layer. `ACTIVE-DIRTY-SCOPE` means dirty groups exist while a lease is
active, but at least one group does not look covered by that lease. In both
cases the owner must run `start:edit`, clean or split the worktree, or file a
`conflict_detected` report before integration continues.

For live controller visibility across agents, use the queued portfolio refresh or stats:

```bash
npm run controller:snapshot:quiet -- --project acme-desktop
npm run controller:sweep
npm run controller:sweep:write
npm run portfolio:refresh -- --project acme-desktop --changed-file .smarch/agent-context/<brick>.ndjson
npm run stats:summary -- --since 7d --project sma
npm run stats:top -- --metric session --since 7d
```

`npm run portfolio:refresh -- --project <id>` scans only the named project,
merges `scans/all-projects/latest.registry.json`, then refreshes state and the
Gen3 dashboard. Project-scoped refreshes share one
`registry-regen:portfolio-projects` lease so concurrent agents do not write the
merged portfolio registry at the same time. Bare project refreshes also reuse a
fresh `scans/<id>/latest.registry.json` for a short window, which keeps old
sessions from launching repeated full scans after another agent just refreshed
the same project.

When changed files are known, pass each with `--changed-file <path>`. The
controller becomes phase-aware:

- normal module code: skips the scan phase and keeps fresh state/dashboard,
- `.smarch/agent-context/**` and conflict logs: skips scan, refreshes
  state/dashboard,
- manifests, `*.module.sweetspot.json` source maps, agent rules,
  package/build/deploy surfaces: forces the project scan.

`npm run portfolio:refresh` without `--project` shares the
`registry-regen:global-modules` lease with `npm run scan:safe`. If another
registry scan is active, it waits for the lease. If the target artifact is fresh
after the wait, it reuses that output; if the artifact is still stale, it runs
the requested scan instead of incorrectly treating the wait as a refresh.
`scan:safe` is also debounced for old sessions.
Use `npm run scan:safe:force` or `npm run portfolio:refresh:force` only when
the controller explicitly needs a fresh full portfolio scan.

Do not force-acquire over a live agent without a written `conflict_detected`
event and an explicit human/controller reason.

## The `:safe` script variants

The scripts most likely to collide between agents now have `:safe` wrappers in `package.json`:

| Script | Wraps | Resource |
|---|---|---|
| `npm run state:safe` | `sma-state.mjs` | `state-regen:global` |
| `npm run wiki:safe` | `sma-wiki.mjs` | `wiki-regen:wiki/all-projects` |
| `npm run doctor:safe` | `sma-doctor.mjs` | `state-regen:global` |
| `npm run scan:safe` | `sma-portfolio-refresh.mjs --no-state --no-dashboard` | `registry-regen:global-modules` when stale |
| `npm run scan:safe:force` | `sma-scan.mjs` | `registry-regen:global-modules` |
| `npm run portfolio:refresh -- --project <id> --changed-file <path>` | phase-aware project refresh | `registry-regen:portfolio-projects` only when scan is needed |
| `npm run portfolio:refresh -- --project <id>` | debounced project scan + merge + state/dashboard | `registry-regen:portfolio-projects` when project registry is stale |
| `npm run ci:safe` | `sma-ci.mjs` | `state-regen:ci-pipeline` |

For normal Gen3 controller visibility, prefer:

```bash
npm run portfolio:refresh
```

This command skips fresh artifacts, waits on an active `registry-regen:global-modules`
lease, and then refreshes state/dashboard without launching another full scan.
For module-local work in a known project, prefer
`npm run portfolio:refresh -- --project <id> --changed-file <path>` so
code-only work avoids scanning and context-only work refreshes only
state/dashboard.

The unsafe (existing) scripts still exist and still work. The `:safe` ones are opt-in. As you build the multi-agent muscle, switch to `:safe` first.

## Agent-context cheatsheet

```bash
# Append an event (every meaningful action)
npm run context -- append \
  --project <project_id> \
  --brick <brick_id> \
  --kind edit_applied \
  --intent "rename helper for clarity" \
  --decision "previous name implied a different return type" \
  --rejected "do nothing::worth the rename now" \
  --linked-backlog acme-lang-007 \
  --lease <lease_id> \
  --file path/to/file.ts

# Tail recent events
npm run context -- tail --project <id> --brick <id> -n 20

# Summarize a brick's full intent history
npm run context -- summarize --project <id> --brick <id>

# List bricks with any context log
npm run context -- list-bricks --project <id>
```

**Required** on every append: `--kind`, `--intent`. **Strongly encouraged**: `--decision`, `--lease`, `--linked-backlog` when applicable.

## Merge cheatsheet

```bash
# Detect divergence and write a proposal
npm run merge:propose -- \
  --project <project_id> --brick <brick_id> --write

# List pending proposals
npm run merge:list -- --project <project_id> --unresolved

# Show a proposal in detail
node tools/sma-merge.mjs show --project <id> --proposal <proposal_id>

# Resolve
node tools/sma-merge.mjs resolve \
  --project <id> --proposal <id> \
  --kind accepted_a \
  --notes "chain A had verified tests; chain B's intent superseded but not implemented"
```

Resolution kinds: `accepted_a`, `accepted_b`, `manual_merge`, `discarded_a`, `discarded_b`, `fork`.

## Context and conflict checks (CI gates)

```bash
# Warn on missing context for modified bricks
npm run context:check -- check --project <id>

# Strict mode — exit 3 if any brick modified without context
npm run context:check -- check --project <id> --strict

# Audit lifetime context coverage across all bricks
npm run context:check -- audit --project <id>

# Normalize legacy proof records into valid Gen3 note events
npm run context:normalize -- --project <id>

# Fail if unresolved Gen3 conflict reports remain
npm run conflict:check -- --project <id> --strict

# Portfolio Gen3 CI: context required, unresolved conflicts forbidden, dirty work must be leased
npm run ci:gen3
```

Wire `--strict` into your pre-commit hook or CI when you're ready. Don't enable it before you've used the tool for a sprint — the false-positive rate matters and you'll want to tune `--max-age-minutes` first.
Conflict strictness is different: once agents are reporting collisions, unresolved reports should block integration because they mean an overlap still needs a controller decision. Dirty-claim strictness is the parallel-work companion: if `git status` is dirty and no lease is active for that project, the controller cannot tell who owns the work, so integration waits until the work is claimed, cleaned, or conflict-reported.

## Backfill cheatsheet

```bash
# Add a touch_event with structured why
npm run touch:backfill -- add \
  --manifest path/to/module.sweetspot.json \
  --intent "extract canvas helper to lib/" \
  --role refactor \
  --actor-kind ai_model \
  --actor claude-opus-4-7 \
  --decision "needed for acme-lang reskin" \
  --linked-backlog acme-lang-006 \
  --project acme-lang

# From a git commit (auto-fills actor, timestamp, message)
npm run touch:backfill -- from-git \
  --manifest path/to/module.sweetspot.json \
  --commit abc1234 \
  --intent-from-message \
  --project acme-lang

# Cross-link an existing context event into the manifest's last touch_event
npm run touch:backfill -- sync-touch \
  --manifest path/to/module.sweetspot.json \
  --event-id ctx-1778143588506-4fffbe90
```

## Patterns

### Pattern A — agent edits a single brick

```bash
# 1. Acquire
LEASE=$(npm run lease -- acquire \
  --resource-kind brick --resource $BRICK \
  --project $PROJECT --brick $BRICK \
  --intent "$INTENT" --ttl 1200 --auto-context --json | jq -r .lease_id)

# 2. Edit files. Append context as you go.
npm run context -- append \
  --project $PROJECT --brick $BRICK \
  --kind edit_planned --intent "$INTENT" --lease $LEASE

# (do the work)

npm run context -- append \
  --project $PROJECT --brick $BRICK \
  --kind edit_applied --intent "$INTENT" --lease $LEASE \
  --decision "$DECISION" --file <file>...

# 3. Release
npm run lease -- release --lease $LEASE --auto-context \
  --project $PROJECT --brick $BRICK
```

### Pattern B — agent runs a regen tool

```bash
npm run state:safe          # already wrapped; no extra steps
npm run wiki:safe
```

### Pattern C — long-running agent with heartbeat

```bash
npm run lease -- run \
  --resource-kind brick --resource $BRICK \
  --intent "long refactor pass" \
  --ttl 1200 --renew-every 600 \
  --auto-context --project $PROJECT --brick $BRICK \
  -- bash -c 'do_long_work'
```

### Pattern D — second agent picks up where first left off

```bash
# Read prior intent before doing anything
npm run context -- summarize --project $PROJECT --brick $BRICK

# Acquire after the previous lease released or expired
npm run lease -- status --resource-kind brick --resource $BRICK
# If exit 10 → wait, force-acquire only with --reason
```

## Failure modes and how they're handled

| Scenario | Behavior |
|---|---|
| Agent crashes mid-edit | Lease TTL expires; next agent can acquire after `expires_at`. Optionally `force-acquire --reason` sooner. |
| Two agents try to edit the same brick | Second `acquire` exits 1 with the holding lease's id, agent, and intent printed. Agent backs off or force-acquires with reason. |
| `start:edit` hits a held brick | `conflict_detected` is appended automatically, then the blocked agent backs off. |
| Two agents both run `:safe` regen | Second waits to acquire, fails fast if held. Run `npm run lease:list` to see who has it. |
| Network split / multiple machines | Single-machine guard only. For now, keep regen pinned to one machine. Federation deferred to when there's a second instance. |
| Sentinel lockfile orphaned by `kill -9` | After 5s the sentinel is considered stale and replaced. Atomic-rename keeps the registry consistent. |
| Manifest edited without context | `npm run context:check -- check --strict` fails with exit 3. Backfill with `npm run touch:backfill`. |
| Unresolved conflict report before integration | `npm run conflict:check -- --project <id> --strict` and `npm run ci:gen3` fail with exit 3. Resolve or split the work first. |
| Dirty project with no active lease | `npm run controller:dirty-check -- --project <id>` and `npm run ci:gen3` fail with exit 4. Claim the work, clean it, or record the conflict. |

## When to ignore this

- One-off scripts in throwaway projects.
- Brand-new bricks during initial scaffolding (no other agents touching them).
- Read-only analysis runs.

The system is designed to be free for the easy path and meaningful for the multi-agent path. Don't make it a religion. Use it where it pays.

## See also

- [`TOKEN_ACCOUNTING_AND_BACKLOG.md`](TOKEN_ACCOUNTING_AND_BACKLOG.md) — backlog conventions; `--linked-backlog` ties context events to backlog entries
- [`SECURITY_AND_SWARM_GATES.md`](SECURITY_AND_SWARM_GATES.md) — the wider gate model
- `schemas/active-leases.schema.json`, `schemas/agent-context-event.schema.json`, `schemas/merge-proposal.schema.json` — the underlying data contracts
