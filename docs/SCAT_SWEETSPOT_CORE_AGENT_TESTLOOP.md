# SCAT — Sweetspot Core Agent Testloop

**Status:** optional SMA Gen3 addon · **Scope:** acme-desktop only (initial) · **Created:** 2026-07-05 (live-proven the same night on MODDIC Nemotron)

## What it is

SCAT is the opt-in live-application test loop: the orchestrating agent (the
"core agent") drives the REAL running app — not a test double — through the
Chrome DevTools Protocol, and closes the loop itself:

```
steer (CDP click/eval/IPC) → observe (screenshot + runtime state)
      → assert (visible text / IPC responses / provider state)
      → fix (dispatch packet or hotfix) → re-steer … until green
```

It complements, never replaces, the normal gates: unit/jest suites prove code
paths; SCAT proves the product — the thing the user actually sees — including
provider registries, IPC allowlists, model residency, live audio, and UI state
that no jest test reaches.

## Hard rules

1. **Opt-in only.** Trigger tokens: literal `SCAT`, `/scat`, or
   "Sweetspot Core Agent Testloop". Never self-trigger; a task that "would
   benefit" is not a trigger.
2. **Gen3-bound.** SCAT runs under the project's Electron testing rules:
   authenticated profile, isolated `--remote-debugging-port`, max 3 parallel
   MODVIBE instances, adopt-don't-spawn at the cap, kill only lanes you own.
3. **Real surfaces only.** Steering goes through the app's own contracts:
   DOM the user sees, `window.electronAPI.invoke` on ALLOWLISTED channels
   (an "Unauthorized IPC channel" error is a test FINDING, not something to
   bypass), and the app's persisted settings. No reaching into internals the
   renderer itself could not reach.
4. **Evidence or it didn't happen.** Every SCAT pass stores screenshots and
   state dumps under a run directory (`~/.cache/<project>-scat/` or the
   session scratchpad) and the final report cites them. A SCAT claim without
   a screenshot/state artifact is invalid.
5. **Loop discipline.** Each iteration ends in one of: PASS (assert green),
   FIX (defect found → packet/hotfix dispatched, then re-steer), or BLOCKED
   (needs user/hardware — say exactly what). No silent retries past 3 of the
   same failing step.
6. **Injection OFF during dictation tests (standing rule).** Before
   any SCAT session that produces transcription finals, set
   `voice.injectionEnabled=false` via the settings IPC so transcripts never
   type into whatever the user is working on in parallel. Restore the prior
   value at loop teardown unless the user says to keep it off.
7. **One SCAT instance, ever (standing rule).** SCAT owns at most ONE
   app instance per run and reuses it across every loop iteration — never a
   second "fresh" launch while a SCAT instance is alive; relaunch only after
   the owned instance is confirmed dead. User-owned instances are never
   counted as reusable and never touched.
8. **Auth is never part of the loop (standing rule).** Always launch
   on the shared authenticated profile; never a fresh user-data dir (login
   walls invalidate the test), never auth/bypass flags. If the profile is
   signed out, that is BLOCKED — report it, don't work around it.
9. **Spawn floating ("Super+V mode", standing rule).** SCAT windows
   must not disturb the user's tiling: float the SCAT instance on spawn
   (session-scoped Hyprland rule or `hyprctl dispatch setfloating` matched by
   the SCAT instance's own PID — never by class, which would catch the
   user's windows).

## Reference implementation (Acme Desktop)

- Driver: `scripts/scat/scat-steer.mjs` — sequential CDP commands:
  `eval` · `invoke` · `click-text` · `click-aria` · `assert-text` · `wait` · `shot`.
  Target window selected by URL regex (`SCAT_TARGET_RE`, default the main
  renderer `dist/renderer/index.html`); floating/child windows reachable by
  overriding it.
- Launch pattern, ports, and instance caps: see acme-desktop `CLAUDE.md`
  → "Electron Launcher Testing".
- First proven loop (2026-07-05): MODDIC offline Nemotron — provider switch via
  real settings IPC, model pre-warm, Start Recording via aria-label, live TV
  audio transcribed on-device, transcript tiles asserted from screenshots;
  loop caught and drove fixes for 6 runtime defects (deps, device mapping,
  prompt-language plumbing, VAD tuning, tag stripping, mode-toggle mis-click).

## Relationship to the family

- SMA Gen3: SCAT is an optional layer like SUP/SMOA/SFF — it changes how
  runtime proof is gathered, never how work is gated.
- SMOA: under SMOA, SCAT steering/asserting is the ORCHESTRATOR's work
  (planning + verification), while fixes it discovers go to the codex
  workforce as packets. Screenshots feed the design/behavior gates.
- Claims & Completion: a SCAT PASS satisfies the "real runtime proof"
  requirement for the flows it exercised; everything else still needs its own
  evidence.
