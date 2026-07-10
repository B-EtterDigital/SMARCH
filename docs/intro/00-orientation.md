# What even is all this?

Welcome. You might make websites, automations, games, tools, art, experiments,
or something without a tidy label. You belong here. We will introduce the
vocabulary one useful idea at a time.

*Made with love for creators of all kind.*

## First: what is a module registry?

A **module** is a bounded part of a software project with a job of its own. It
might handle sign-in, render a button, process a payment, or coordinate a group
of AI agents.

A **module registry** is a searchable inventory of those parts. It records what
exists, where it lives, what it is for, and what evidence says it is ready to
use. The code lives in its projects. The registry lets you find, compare,
understand, and reuse that code without relying on somebody's memory.

SMARCH calls a small, isolated, reviewable module a **brick**. Lesson 01 explains
bricks. For now, the registry keeps track of the useful pieces in a portfolio of
projects.

## Why do AI agents need coordination?

An AI agent can read and change code. Several agents can do that at the same
time. Without coordination, they can edit the same file, duplicate the same
feature, work from stale assumptions, or each pass a local check while the whole
project becomes less reliable.

Agents and humans need shared facts: who is working on what, why a change is
happening, which conflicts remain open, and which checks must pass before a
piece is ready. SMARCH records those facts in files you can inspect after the
agent chat ends.

## One honest metaphor

SMARCH is a **city building code for code**. You decide what to build, and your
team writes the product. SMARCH provides shared rules for identifying parts,
recording who is working where, checking boundaries, and deciding when a module
is safe to reuse.

Teams remain responsible for design and engineering choices. Like a real
building code, SMARCH makes requirements visible and skipped checks harder to
ignore.

## A 60-second map of this repository

- **`tools/`** contains the scanners, checks, coordination tools, and dashboards
  that do the practical work.
- **`schemas/`** defines the shapes of records SMARCH can validate, including
  modules, builds, releases, leases, and agent context.
- **`registry/`** holds the indexed view of modules and builds across projects.
- **`docs/`** explains the architecture, security model, governance, and working
  practices. This beginner lane lives here too.
- **`skills/` and `agent-skills/`** teach compatible AI agents how to work with
  the system and how to install those instructions.
- **`examples/` and `templates/`** provide fictional samples and starting points
  you can inspect without risking a real project.
- **`SPE/`, `SRS/`, and `SSTF-v1/`** contain source material for performance,
  observability, and testing practices.

You can leave that list here. The lessons return to each area when you need it.

## Where next?

Open [Start Here](START_HERE.md) for the complete lesson path and the skills you
will have by the end.
