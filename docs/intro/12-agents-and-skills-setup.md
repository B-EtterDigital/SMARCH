# [Agents and skills](../GLOSSARY.md#gen3) setup

## Why this matters

A coding agent can move quickly, but speed is only useful when it knows the
project rules. Local instructions and reusable skills give the agent the same
map, safety rails, and vocabulary that a human contributor receives.

## The idea

A coding agent is a tool that can inspect and change a project on your behalf.
A skill is a folder of focused instructions that teaches the agent one
workflow, such as checking SMA boundaries. Think of the agent as a new crew
member, `AGENTS.md` as the workshop rules on the wall, and each skill as a
small, labeled field guide in the toolbox.

For Codex, the coding-agent platform used in this example, the installer copies
the Sweetspot Modular Architecture (SMA) skills into `.codex/skills/` and adds
the SMA instruction section to `AGENTS.md`. Those instructions teach the agent
to use [leases](../GLOSSARY.md#lease), respect ownership, and run the required
[gates](../GLOSSARY.md#gate) before claiming success.

## Try it

Run this block from the SMARCH folder. It regenerates the fixture portfolio and
installs the Codex setup only inside the `acme-desktop` practice project. Your
real project instructions and personal agent settings are not changed.
The `--platform codex` option tells the installer to create only Codex's files.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
PRACTICE_PROJECT="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop"
export PRACTICE_PROJECT
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
node tools/install-agent-skills.mjs \
  --target "$PRACTICE_PROJECT" \
  --platform codex

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const target = process.env.PRACTICE_PROJECT;
const skills = fs.readdirSync(path.join(target, ".codex", "skills")).sort();
const instructions = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");

console.log(`Skills: ${skills.join(", ")}`);
console.log(`AGENTS.md has SMA Enforcement: ${instructions.includes("# SMA Enforcement") ? "yes" : "no"}`);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
Installed SMA skills for codex
Skills: sma-course-builder, sma-enforcer, sma-gen3
AGENTS.md has SMA Enforcement: yes
```

The three skill folders are real files the agent can load when their work
matches. The `yes` confirms that project-level SMA rules were added too, so the
agent receives both the field guides and the workshop rules.

## What you just did

You prepared a safe practice project for a Codex agent, then verified both
halves of the setup: reusable skills and project instructions. It is a small
handoff made with love for creators of all kind—and for the next agent trying
to do careful work without guessing.

## Where to go next

Return to the [lesson path](START_HERE.md#the-lesson-path) and continue with
lesson 13, Skills in practice. You will choose a skill for a real task and see
how focused instructions change the agent's workflow.
