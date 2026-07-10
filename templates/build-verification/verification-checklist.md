# Verification Checklist

Build id:

Build manifest:

Verifier report reviewed:

Date:

Owner:

## 1. Scope

- [ ] The build boundary is still accurate.
- [ ] Required vs optional bricks are still correct.
- [ ] Source paths still match the real capability.
- [ ] The build summary does not overclaim.

## 2. Contracts

- [ ] Required env vars are listed and still accurate.
- [ ] Auth assumptions are explicit.
- [ ] RLS or tenant-isolation expectations are explicit when relevant.
- [ ] External providers, queues, or storage assumptions are explicit.

## 3. Smoke Coverage

- [ ] At least one real smoke or fixture command was chosen.
- [ ] Preconditions for each command are documented.
- [ ] Expected result for each command is documented.
- [ ] At least one negative-path or failure-path check exists if the build is risky.

## 4. Clone And Install Reality

- [ ] Install steps are specific enough for another engineer to follow.
- [ ] Post-clone checks are specific enough to confirm a healthy install.
- [ ] Rollback steps are specific enough to execute.
- [ ] Current clone readiness is still honestly labeled.

## 5. Evidence Quality

- [ ] Every claimed run has a matching evidence record.
- [ ] Review-only notes are clearly labeled as review-only.
- [ ] Runtime proof is not inferred from scanner or manifest output.
- [ ] Remaining gaps are written down explicitly.

## 6. Publish Safety Preparation

- [ ] Internal-only URLs are identified.
- [ ] Absolute local paths are identified.
- [ ] Customer-specific data or naming is identified.
- [ ] Secrets or private prompts are not exposed in the intended package surface.

## Decision

- [ ] Keep as `candidate`
- [ ] Strong enough to consider `verified`
- [ ] Strong enough to start private publish review

Reason:

Next actions:
