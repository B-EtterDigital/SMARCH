# Build Verification Harness Templates

This folder is a small working kit for repo-level repair on a curated build.

Use it when a build is still `candidate` and you need to gather enough
evidence to decide whether it can move to `verified`.

Use these files together:

- `verification-checklist.md`
- `smoke-commands.example.json`
- `evidence-record.example.json`

## What This Harness Is For

The harness is for disciplined evidence capture during repair work.

It helps you answer:

- what must be checked for this build
- which commands or flows should be exercised
- what actually happened when they were run
- what is still missing afterward

It is not a test framework and it is not a guarantee of correctness.

## Suggested Use During Repo Repair

1. Copy these templates into a build-specific working folder or adapt them next
   to the build manifest.
2. Start with `verification-checklist.md` and mark the risk areas that matter
   for the build.
3. Turn `smoke-commands.example.json` into the smallest honest command set that
   exercises the build.
4. Run the commands or reviews you can actually perform.
5. Record every result in an evidence record instead of summarizing from memory.
6. Promote the build only as far as the recorded evidence supports.

## How To Keep It Honest

- Do not mark a command as passed if it was not actually run.
- Do not turn review-only notes into runtime proof.
- Do not hide missing prerequisites.
- Do not collapse multiple checks into one vague sentence.
- Do not claim publish safety from verification evidence alone.

## Minimum Output Expected

For a serious verification pass, you should end up with:

- one checked checklist
- one build-specific smoke-command file
- one or more evidence records from actual commands or reviews

If all you have is a checklist and no evidence records, the build is still
probably only `candidate`.

## Practical Placement

Good temporary locations:

- a repo-local working folder used for the repair pass
- a build-specific notes folder outside the published package surface

Do not treat these examples as final release artifacts. They are working
templates to support repo-level repair and later build-manifest updates.
