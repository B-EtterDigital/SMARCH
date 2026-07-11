# Sweetspot Visual Demo (SVD)

This document defines how a Sweetspot walkthrough becomes repeatable visual proof. Product teams, implementers, and reviewers need it when a feature claim depends on screenshots, recorded flows, or visual acceptance. Read it before planning the demo and again before accepting its proof packet. Remember that every captured step must map to a real product state and a stated outcome.

Sweetspot Visual Demo is a known optional SMA module for demo, walkthrough, onboarding, and release-proof flows. It is not a required gate for every brick. Use it when a project needs visual proof that a user journey works, can be replayed, and can be reviewed without guessing what happened.

The repository currently ships SVD as a `candidate`, `guided` contract in
`examples/sweetspot-visual-demo.module.sweetspot.json`; it does not ship a
standalone SVD capture or gallery generator. A consuming project must wire the
driver, artifact storage, validation, redaction, and gallery surfaces listed in
the manifest's adaptation points before claiming a live SVD implementation.

SVD turns a walkthrough into a structured proof packet:

- a script with persona, route, flags, version, and expected outcomes
- numbered step-by-step claims that say exactly what each step proves
- ordered screenshots or video frames
- screenshot quality checks that confirm the feature is visible before the artifact is accepted
- subtle annotations that link claim numbers to the exact UI being discussed
- a gallery that can be opened, exited, replayed, and shared
- [SRS](GLOSSARY.md#srs) breadcrumbs for every important step and failure
- privacy-safe artifact metadata for review and regression testing

## When To Use It

Use SVD for:

- product demos that must prove real flows, not marketing slides
- release candidate walkthroughs
- onboarding tours
- admin or support reproduction guides
- multi-user or live-session proof
- visual regression packets for complex UI

Do not use SVD as a replacement for unit, integration, security, or performance tests. It complements [SSTF](GLOSSARY.md#sstf), SRS, [SSI](GLOSSARY.md#ssi), and SSRA by making user-visible behavior reviewable.

## SVD Levels

SVD has two depths.

| Level | Purpose | Output |
|-------|---------|--------|
| `SVD-L1` | Prove a user flow works and can be reviewed | replayable walkthrough, screenshots/video, annotations, gallery, SRS links |
| `SVD-L2` | Pitch and evaluate a feature internally like an investor-grade product story | narrative proof deck, business thesis, before/after value, proof gallery, risk/market/readiness evidence |

`SVD-L1` is the default proof layer. It answers: "Did this flow work, can we see it, and can we replay it?" It is not acceptable unless the feature is visible in the captured UI and every important claim is tied to a numbered step, screenshot, annotation, and replay pointer.

`SVD-L2` is the deeper internal pitch layer. It answers: "Why should this feature exist, what value does it unlock, what proof do we have, what risks remain, and what decision should leadership make?" It must stay honest: a polished pitch with weak screenshots, hidden assumptions, or unclear proof fails SVD.

## SMA Position

SVD is a module, not a new mandatory gate.

Manifest guidance:

- `brick.kind`: `module`
- `brick.domain`: include `visual-demo`, `walkthrough`, and `proof-gallery`
- `classification`: include the highest data class visible in captured media
- `sweetspot.srs`: passing only when SVD emits privacy-safe breadcrumbs
- `sweetspot.sstf`: passing only when replay or artifact validation is automated
- `sweetspot.sva`: passing only when screenshot/video redaction is checked
- `clone.adaptation_points`: include route registry, screenshot driver, redaction policy, and artifact storage path

## Proof Claims And Step Numbers

SVD evidence starts with numbered claims, not screenshots. Screenshots prove claims; they do not replace them.

Every meaningful step gets a stable number and a short claim, for example: `1. Claim: User can open the billing workspace from account settings. Evidence: screenshots/001-open-billing.png. UI Link: 1A Billing nav, 1B loaded Billing header.`

Rules:
- Use plain numbers for the journey order: `1`, `2`, `3`.
- Use annotation ids derived from the step number: `1A`, `1B`, `2A`.
- Put the claim number in the gallery rail, caption, report, `svd-run.json`, and annotated screenshot.
- Each claim must link to at least one screenshot, clip timestamp, metric, test result, or SRS breadcrumb.
- The screenshot must show the UI named in the claim. If the feature is offscreen, hidden behind a menu, covered by an overlay, too blurred to read, or cropped to the wrong area, the claim is not proven.
- Failure or degraded steps still get numbers and screenshots. They must show what failed, what the user saw, and which SRS breadcrumb recorded it.

Recommended step object:

```json
{
  "step_no": 1,
  "claim_id": "1",
  "claim": "User can open the billing workspace from account settings.",
  "route": "/settings/account",
  "action": "click Billing",
  "expected": "Billing workspace loads for an entitled user.",
  "observed": "Billing workspace loaded with current plan and payment controls visible.",
  "status": "pass",
  "screenshot": "screenshots/001-open-billing.png",
  "annotation_ids": ["1A", "1B"],
  "feature_visibility": {
    "subject": "Billing workspace header and plan controls",
    "visible": true,
    "not_occluded": true,
    "text_readable": true
  },
  "srs_event_ids": ["srs_billing_opened_001"]
}
```

## Screenshot Quality Gate

An SVD screenshot is valuable only when it proves something a reviewer can inspect. A screenshot that is pretty, cropped, empty, covered, blurred, or taken before the feature appears is a failed artifact.

Required capture rules:
- Wait for the target feature state to be stable before capture: loading complete, skeletons gone, critical network calls settled, and realtime state visible when relevant.
- Capture enough surrounding UI for orientation: route, panel, modal, or workspace context should be visible unless intentionally zoomed for detail.
- Capture the result of the action, not only the button before the action.
- Include before/after pairs when the value is a change in state, layout, content, status, access, or performance.
- Capture failure, empty, loading, denied, offline, and degraded states when they are part of the reviewed flow.
- Avoid screenshots where browser chrome, debug panels, proof UI, cookie banners, popovers, or toasts hide the feature.
- Keep text readable at normal review size; add a focused detail screenshot when context alone is not legible.
- For responsive UI, capture the viewport where the claim matters. If the feature exists on mobile and desktop, include both when layout changes materially.

Each screenshot must pass a visibility check:

| Check | Pass Criteria |
|-------|---------------|
| Feature visible | The UI named in the claim is inside the screenshot bounds. |
| Result visible | The expected result or failure state can be seen without guessing. |
| Not occluded | No annotation, proof overlay, toast, menu, or modal hides the subject. |
| Readable | Primary labels, values, statuses, and errors are legible. |
| Oriented | The reviewer can tell where they are in the product. |
| Honest | Mocked, fixture, stale, delayed, or incomplete states are labeled. |

If any check fails, retake the screenshot or mark the step as `warning` or `fail` with the reason.

## SVD-L2 Deepness

SVD-L2 turns a working demo into an internal investor pitch for a feature, module, or product direction. It should feel like a high-quality product decision room: visual, fast to understand, proof-backed, and honest about risk.

Required sections:

- `Thesis`: one sentence explaining why this feature matters now.
- `Audience`: who benefits, who pays, who operates it, and who is blocked without it.
- `Pain`: the current workflow, friction, wasted time, or missed opportunity.
- `Promise`: the new capability and the outcome it should create.
- `Before/After`: side-by-side screenshots or clips that show the delta.
- `Moment Of Magic`: the one visual moment that makes the feature obvious.
- `Proof Run`: the underlying SVD-L1 walkthrough with ordered artifacts.
- `Step Claims`: the numbered claims that the pitch relies on, with links to screenshots, clips, metrics, tests, or assumptions.
- `Value Evidence`: time saved, quality improved, risk reduced, revenue enabled, retention improved, or cost avoided.
- `Readiness`: what is real, what is simulated, what is blocked, and what still needs validation.
- `Risk Register`: privacy, security, reliability, performance, UX, data, rollout, and support risks.
- `Decision Ask`: approve, continue, redesign, pause, release, or cut.

Recommended SVD-L2 artifacts:

- `pitch.md`: concise narrative for a human reviewer.
- `summary-card.json`: machine-readable thesis, value, risk, and decision ask.
- `screenshots/`: raw and annotated proof images.
- `clips/`: short clips for the strongest moments.
- `gallery/`: interactive proof gallery.
- `metrics.json`: measured value and performance signals.
- `risks.json`: open risks with owner and severity.
- `decision-log.md`: reviewer decision, date, and follow-up.

SVD-L2 visual requirements:

- Open with the feature name, status, target audience, and decision ask.
- Show the strongest visual proof in the first viewport.
- Include a short narrative spine: problem -> old way -> new way -> proof -> value -> ask.
- Keep screenshots readable; prefer fewer stronger images over a wall of thumbnails.
- Link each major claim to a numbered proof step. Do not make visual, business, readiness, or value claims that have no evidence link.
- Render proof metadata around the screenshot, not over important UI.
- Keep in-app proof toasts small enough that the product still looks like the product.
- Use annotations to explain the action, value, and decision relevance.
- Include at least one before/after comparison when the feature changes an existing workflow.
- Include at least one "why this is credible" proof block: live data, real run, test command, artifact hash, or SRS evidence.
- Include a fallback slide or state for anything simulated.

SVD-L2 scoring rubric:

| Area | Question | Minimum |
|------|----------|---------|
| Story | Can a reviewer understand the feature in 60 seconds? | thesis, audience, promise |
| Visual proof | Does the artifact show the feature instead of describing it? | numbered screenshots or clips where the feature is visible |
| Value | Is the value concrete enough to compare against alternatives? | one measured or reasoned value signal |
| Trust | Is the proof tied to a run, version, commit, SRS trail, and visible UI evidence? | proof metadata, numbered claims, and artifact links |
| Risk | Are unknowns visible instead of hidden? | risk register with owners |
| Decision | Does the artifact ask for a clear next step? | approve, continue, redesign, pause, release, or cut |

SVD-L2 is not allowed to hide uncertainty. If a capability is mocked, fixture-backed, not wired, not performant, or not release-ready, the pitch must say so in the readiness section.

## Required Proof Packet

Every SVD run produces an artifact folder. Recommended layout:

```text
docs/handover/artifacts/<module>/<svd-run-id>/
  svd-run.json
  screenshots/
    001-open-module.png
    002-start-action.annotated.png
    003-result-state.png
  video/
    walkthrough.webm
  gallery/
    index.html
  report.md
```

`svd-run.json` must include:

- `svd_run_id`
- `module_id`
- `scenario_id`
- `app_version`
- `commit`
- `created_at`
- `persona`
- `role_or_entitlement`
- `feature_flags`
- `viewport`
- `theme`
- `steps`
- `claims`
- `artifacts`
- `redaction_status`
- `srs_event_ids`
- `verification`
- `screenshot_quality`

For `SVD-L2`, also include:

- `svd_level`
- `thesis`
- `decision_ask`
- `value_evidence`
- `readiness_status`
- `risk_register_path`
- `pitch_artifact_path`

## Gallery Requirements

The gallery is part of the module, not an afterthought. It must be useful for a human reviewer.

Required controls:

- `Exit` or close button visible at all viewport sizes
- `Esc` closes the gallery
- browser/app back returns to the previous surface when applicable
- `Replay demo` reruns the scripted walkthrough or replays the recorded proof
- `Open artifact folder` or equivalent link opens the evidence location
- `Copy report link` copies a stable path
- `Download manifest` exports `svd-run.json`
- no non-dismissible completion toast

Required gallery behavior:

- ordered step rail with current, previous, next, and failed step states
- thumbnails lazy-loaded so large proof packs do not freeze the app
- full-size image view with zoom and pan
- captions that state the numbered claim, action, expected result, actual result, and evidence status
- visible viewport, theme, role, app version, and run id
- pass/fail/warning status per step
- visible screenshot quality status per step: `visible`, `occluded`, `unreadable`, `wrong-state`, or `missing`
- annotation toggle that preserves the raw screenshot view
- missing image and broken link states that are readable and actionable

## Toast And Overlay Requirements

SVD proof UI must not cover the product UI being reviewed.

Required:

- proof toasts must be small, subtle, dismissible, and time-bounded
- proof toasts must avoid primary navigation, action buttons, forms, charts, media, success states, and error states
- proof toasts must not cover the clicked element or the result of the click
- completion proof should prefer a side rail, bottom proof bar, header proof chip, or gallery chrome around the screenshot
- proof metadata belongs around the screenshot whenever possible, not over the screenshot subject
- if an overlay is unavoidable, it must be movable, collapsible, or hideable
- screenshots should capture the product state cleanly before proof UI is layered on top

Forbidden:

- large centered proof toasts over the product UI
- non-dismissible proof toasts
- proof overlays that hide the exact UI state under review
- repeated replay toasts that make the demo feel noisy

## Screenshot Annotation Requirements

Annotations should guide the eye without making the screenshot unreadable.

Required annotation features:

- subtle arrows, rings, pins, outlines, or spotlights that point at the active UI
- labels that start with the linked step id, such as `1A`, `1B`, or `2A`
- short labels that explain the action or state change
- before/after markers when a step changes state
- toggle to show or hide annotations
- light and dark theme readability
- labels must not cover the clicked control, success state, error text, or primary content
- annotations must be stored separately or reproducibly generated so raw screenshots remain available

Annotation clarity rules:

- Use one primary annotation for the claim subject and at most two secondary annotations for supporting context.
- Put labels outside the subject when possible, with the pointer touching the relevant UI edge or center.
- Use short labels: action verb + object + state, for example `1A Billing nav`, `1B Plan loaded`.
- Use consistent colors per status: pass, warning, fail, and info. Do not rely on color alone; include the label text.
- If a screenshot needs more than three annotations to make sense, split it into multiple steps or add a detail screenshot.

Forbidden annotation patterns:

- giant red scribbles as the default proof style
- annotations that hide the bug or success state
- labels with unclear words such as "here" without action context
- labels that are not connected to a numbered claim
- lossy screenshots that make text unreadable

## Flow Visualization Requirements

An SVD run must show the user journey, not just isolated images.

Required flow view:

- step timeline from entry to exit
- numbered claims in the same order as the screenshots and report
- source route and destination route for navigation steps
- user action type: click, keyboard, drag, upload, wait, network, realtime, permission, or system event
- expected state and observed state
- related SRS event ids or local breadcrumb ids
- failure branch when a step degrades
- replay pointer that highlights the current screenshot/video moment

For social, streaming, or multi-user modules, include:

- actor list
- online/offline/reachable state proof
- room/session id redacted to a safe alias
- viewer count or participant count evidence
- toast/notification proof when presence changes

## Privacy And Security

SVD can capture sensitive information. Treat screenshots and video as data.

Hard rules:

- no secrets, tokens, session cookies, private keys, or service-role values in artifacts
- redact email addresses, access tokens, credentials, payment data, health data, and private user text unless the proof explicitly requires safe fixture data
- prefer fixture users and fixture content for public proof
- record `redaction_status` in the run manifest
- do not upload artifacts to public storage without explicit release approval
- SRS payloads must contain references and safe summaries, not raw screenshots or private content

## Performance Requirements

SVD must not make the app feel heavy.

Required:

- thumbnail generation or downscaled previews for gallery grids
- lazy loading for full-size images and video
- bounded artifact retention policy
- no capture loop that runs while hidden or inactive
- gallery first interaction should remain fast with at least 50 screenshots

## Acceptance Checklist

An SVD implementation is acceptable when:

- the demo can start, finish, exit, and replay
- the proof gallery opens from the completion state
- the proof gallery can always be closed
- every important user-visible claim has a step number and evidence link
- every screenshot has order, numbered claim, caption, route, viewport, theme, role, and version metadata
- every screenshot passes the feature visibility check or is explicitly marked `warning` or `fail`
- key screenshots have clear, subtle, numbered annotations that can be toggled
- annotations point to the UI named in the claim and do not hide the subject
- the flow visualization shows action, expected result, actual result, and SRS evidence
- privacy redaction is recorded
- broken artifact links produce readable errors
- responsive proof covers narrow, normal, and wide layouts when the module is UI-heavy
- light and dark mode proof exists when the project supports both themes
- the run can be validated without a dev server

An SVD-L2 artifact is acceptable when:

- the reviewer can understand the feature, value, proof, risk, and decision ask without a live presenter
- the first viewport communicates the feature and why it matters
- every major claim links to a numbered screenshot, clip, metric, test, SRS event, or explicit assumption
- every visual proof screenshot makes the feature or result visible without a presenter explaining where to look
- simulated or incomplete parts are labeled
- risks have owners and severity
- the decision ask is clear and actionable
- the artifact can be replayed from the proof gallery

## Known Traps

- Treating the gallery as a toast instead of a review surface.
- Capturing only the happy path and missing empty, error, permission, offline, and loading states.
- Letting annotations cover the exact UI state being proven.
- Capturing screenshots where the feature is offscreen, hidden, unreadable, or blocked by proof UI.
- Making claims in the pitch that do not have numbered step evidence.
- Using annotation labels that do not match the step-by-step claims.
- Making a demo that cannot be exited.
- Letting proof toasts cover the UI, buttons, result state, or screenshot subject.
- Saving screenshots without role, version, viewport, theme, or feature flag context.
- Recording private data in proof artifacts and then treating the folder as shareable.
- Calling a demo "done" when the buttons in the proof UI are not wired.
- Turning SVD-L2 into marketing copy without evidence.
- Hiding mocks, missing wiring, or unresolved risks inside a beautiful pitch.
- Making the decision ask vague.
