# [MCP](../GLOSSARY.md): connect your agent

## Why this matters

A coding agent is most useful when it can ask your project precise questions
instead of rummaging through the whole checkout. SMARCH offers a small doorway
to its registry so an agent can search bricks and inspect trust facts with
named tools.

*Made with love for creators of all kind.*

## The idea

Model Context Protocol (MCP) is a common way for an agent program to connect to
external tools. An MCP *server* is the program offering those tools; an MCP
*client* is the agent-side program calling them. In this lesson, SMARCH is the
server and the short Node.js script acts like a tiny client preflight.

Think of MCP as the USB socket on a workshop robot. The socket defines
how to connect. Each named tool is an attachment the robot can recognize, such
as `brick-search` for searching the [registry](../GLOSSARY.md#registry) or
`brick-trust` for reading a [brick's](../GLOSSARY.md#brick) current evidence.

The SMARCH server uses standard input/output, shortened to `stdio`, as its
transport. A transport describes how messages travel. Your agent starts
`tools/mcp/server.mjs`, then the two programs exchange messages through that
private text channel. They need no web server or open network port.

## Try it

Run this block from the SMARCH folder. It regenerates
`tools/evals/fixtures/portfolio`, scans it into a temporary MCP root, writes a
temporary client configuration, and loads the exact tools exposed by the
SMARCH server. It leaves your real agent settings alone.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
MCP_ROOT="$SMARCH_LESSON_TMP/lesson-15-mcp-root"
MCP_REGISTRY="$MCP_ROOT/scans/all-projects/latest.registry.json"
MCP_CONFIG="$MCP_ROOT/mcp.json"
export SMARCH_DIR MCP_ROOT MCP_CONFIG
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
mkdir -p "$MCP_ROOT/scans/all-projects"
node tools/sma-scan.mjs \
  --root "$SMARCH_FIXTURE_PORTFOLIO" \
  --out "$MCP_REGISTRY"

SMA_ROOT="$MCP_ROOT" node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { loadToolModules } from "./tools/mcp/server.mjs";

const config = {
  mcpServers: {
    "smarch-registry": {
      command: "node",
      args: [path.join(process.env.SMARCH_DIR, "tools/mcp/server.mjs")],
      env: { SMA_ROOT: process.env.MCP_ROOT },
    },
  },
};
fs.writeFileSync(process.env.MCP_CONFIG, JSON.stringify(config, null, 2) + "\n");

const tools = await loadToolModules();
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const card = await byName.get("server-card").handler({});
const search = await byName.get("brick-search").handler({
  query: "activity feed",
  limit: 1,
});

console.log("Config server: " + Object.keys(config.mcpServers)[0]);
console.log("Server: " + card.name);
console.log("Transport: " + card.transport.type);
console.log("Tools available: " + tools.length);
console.log("Fixture match: " + search.results[0].id);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
SMA scan complete: 40 manifest brick(s) ...
Config server: smarch-registry
Server: smarch-registry
Transport: stdio
Tools available: 8
Fixture match: acme-desktop.activity-feed
```

The temporary `mcp.json` contains the three facts an MCP client needs: the
server name, the command to start it, and the `SMA_ROOT` folder containing the
registry. The preflight then loaded all eight real server tools and used
`brick-search` against the fixture portfolio.

When you are ready to connect a real agent, copy the `smarch-registry` entry
into that client's MCP settings and change `SMA_ROOT` to your SMARCH folder.
Client setting screens differ, but the command, argument, and environment
field keep the same meaning. Keep this lesson's temporary root while learning;
pointing an agent at a production registry should be a deliberate choice.

## What you just did

You made a safe MCP connection recipe, verified the server card, counted its
tools, and asked one tool to find Activity Feed in the practice registry. The
agent-facing doorway now has a name and a tested command instead of a hopeful
configuration pasted from the internet.

## Where to go next

Return to the [lesson path](START_HERE.md#the-lesson-path). The next lesson will
build on the same fixture portfolio and show another real workflow, one careful
piece at a time.
