# 06 — I18N Plan

**Reasoned scope decision:** the framework's CLI output, docs, and skills are
intentionally English-only at launch — the audience is developers and AI
agents, and agent instructions in mixed locales measurably degrade agent
behavior. This is a deliberate N/A for M0–M2, not an omission.

What is prepared anyway (so the decision stays reversible):

- **Dashboard (V-18, M3):** all user-facing strings live in one
  `web/src/strings.ts` module from the first commit — no hardcoded strings in
  components. ICU message shapes for counts/dates via `Intl` APIs. This is
  enforced by a dashboard-scoped lint task (UV-DA-i18n-strings-guard), not a
  repo-wide CI gate.
- **Hardcoded-string audit count:** CLI tools — N/A by decision above;
  dashboard — 0 at start (module doesn't exist yet), guard keeps it 0.
- **RTL / pseudo-locale:** deferred until a second locale is actually
  requested; the strings-module architecture is the preparation.
- **Launch languages:** en. **Prepared:** structure-ready for de/th (the
  operator's locales) without commitment.
