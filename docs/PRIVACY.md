# Privacy, data protection, and residency

This document describes the privacy boundary of the SMARCH repository as it
exists today. Operators, engineers, and privacy reviewers need it when they
change scanning, telemetry, generated artifacts, or an optional remote
integration. Read it before pointing SMARCH at a repository that contains
personal or confidential data. Remember that generated evidence can repeat
paths, identifiers, and command text from the source project.

## Current product boundary

SMARCH is a local-first architecture toolkit. This repository does not provide
a hosted user service, authentication system, upload endpoint, moderation
provider, or data-subject-request API. In particular, it does not implement the
previously documented WorkOS, Netlify Blobs, `MOD_PROVIDER`, or
`/api/march-erase` flows.

Do not use this page as a GDPR or Swiss FADP register for a product built with
SMARCH. Each consuming product must document its own controllers, processors,
legal bases, regions, transfers, retention periods, and rights workflows from
its deployed implementation.

## Data the local tools can record

Depending on the command, SMARCH can read source files, manifests, git state,
and configured project paths, then write local artifacts such as:

- registry, scan, state, wiki, security, release, and handoff outputs;
- `.smarch/agent-context/<brick-id>.ndjson`, including agent and session
  attribution, intent, decisions, evidence, and touched paths;
- local logs and generated reports containing command output or findings.

These artifacts can contain repository-relative or absolute paths, agent or
session identifiers, commit metadata, and snippets or diagnostics derived from
the inspected project. They are not automatically anonymized merely because
they are generated files.

## Operator responsibilities

- Run SMARCH only against repositories you are authorized to inspect.
- Keep secrets and unnecessary personal data out of manifests, prompts,
  evidence commands, agent-context notes, and generated documentation.
- Review generated artifacts before publishing, syncing, or attaching them to
  an issue or release.
- Apply filesystem permissions, repository access controls, retention, backup,
  and deletion policies appropriate to the source project's data.
- Treat optional remote stores, model providers, CI systems, and publication
  targets as separate processors; review their configuration and terms before
  enabling them.

## Retention and deletion

SMARCH does not impose a universal retention period. Local artifacts remain
until the operator removes them or the repository's own cleanup and version
control policy does. Deleting a working-tree file does not remove copies from
git history, backups, CI logs, published releases, or remote services.

## Compliance evidence, not certification

`npm run compliance` and `npm run gate:compliance` inspect declared projects
for implementation evidence and report covered, partial, or missing controls.
They do not provide hosting, consent management, legal advice, or regulatory
certification. A passing technical gate is only one input to a product-specific
privacy review.

See [Moderation transparency](TRANSPARENCY.md) for the current moderation and
platform-safety audit boundary.
