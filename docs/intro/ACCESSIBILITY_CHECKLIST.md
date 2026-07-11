# Intro lane accessibility checklist

This record documents the accessibility pass over every English page in `docs/intro/`. Re-run the checklist whenever a lesson adds headings, links, images, code, or tables.

## Checks completed

- [x] Link labels are descriptive; no lesson uses “click here”, “here”, or “this link” as the whole label.
- [x] Heading levels progress without skipped levels.
- [x] Every Markdown image has non-empty alternative text. Pages without images pass this check by absence.
- [x] Every opening fenced code block names a language such as `bash`, `json`, or `text`.
- [x] Every Markdown table has a header row and delimiter row.

## Verification boundary

The pass covers `START_HERE.md`, lessons `00` through `18`, and the intro support pages present in this directory. The journey runner executes the lesson command blocks; [`sma-doc-lint`](../../tools/sma-doc-lint.mjs) checks internal links and command registration. Visual focus, contrast, and screen-reader behavior belong to rendered UI surfaces and are not claimed by this Markdown-only audit.

<!-- docs-i18n: key=docs.intro.accessibility-checklist; source=en; media=../media/{locale}/intro-accessibility-checklist/ -->
