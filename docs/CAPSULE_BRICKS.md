# Capsule bricks

A capsule is the constraint-first brick tier: one entry point, no undeclared dependencies or environment access, explicit ports, and a mandatory runnable fixture. Those construction rules remove several failure modes before promotion.

## Promotion fast lane

`sma-promote` recognizes `tier: "capsule"`, `brick.tier: "capsule"`, and the current compatibility form `brick.kind: "capsule"`. Candidate semantics and score still apply. Canonical promotion then requires current passing fixture-run evidence in `sweetspot.verification` (or `verification`) whose command or evidence identifies `sma-brick-run` or a fixture run.

When that evidence passes, the promoter skips the generic sibling-test and RLS checks and prints a reason explaining that capsule construction makes them redundant. It does not skip provenance, license, leak, or source-scope gates. Missing fixture evidence keeps the brick at candidate with `capsule-fastlane:fixture-evidence-required`.
