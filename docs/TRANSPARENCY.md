# Moderation and platform-safety transparency

This page explains what SMARCH currently provides for moderation and
platform-safety review. Product owners, contributors, and reviewers should read
it before treating a compliance result as proof of a live moderation service.
Remember that SMARCH detects evidence in a consuming project; it does not host
or moderate user content itself.

## Current boundary

The SMARCH repository has no public-project-sign service, upload API, hosted
moderation model, report queue, or appeals runtime. It therefore makes no claim
that text or images are automatically moderated before publication.

Community conduct reports for this repository follow
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md). Product-specific notices, reports,
decisions, appeals, and retention rules belong to the deployed product and must
be documented from its real implementation.

## What the compliance gate checks

The compliance gate statically inspects a target project for evidence including:

- a report action that reaches a real persisted endpoint instead of a
  toast-only acknowledgement;
- a safety taxonomy that covers child-safety and CSAM handling;
- a triageable moderation queue with a consumer or operator surface;
- recorded moderation decisions, reasons, notifications, and an appeal path;
- abuse scanning for stored or served media;
- privacy controls such as relay-only transport where peer-IP disclosure is a
  risk.

Run the report with:

```bash
npm run compliance
```

Run the blocking form used by the aggregate gate with:

```bash
npm run gate:compliance
```

The result can be `covered`, `partial`, or `missing` per control. `covered`
means the scanner found the expected code evidence; it is not live-runtime,
legal, or policy proof. If no discoverable manifests are available, the tool
warns that there is nothing to check instead of inventing a passing result.

## Honest product disclosure

A product built with SMARCH should publish its actual moderation providers,
blocked categories, failure behavior, reporting path, appeal process, storage,
retention, regions, and human-review responsibilities. Do not copy provider,
residency, or retention claims from an example or an older deployment.

See [Privacy, data protection, and residency](PRIVACY.md) for the local data
boundary of the SMARCH tooling.

<!-- docs-i18n: key=docs.transparency; source=en; media=media/{locale}/transparency/ -->
