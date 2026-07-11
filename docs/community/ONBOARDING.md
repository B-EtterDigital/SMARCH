# Community brick submissions

Community bricks enter SMARCH through one gated path:

**submission → automated gates → curator review → promotion**

The first curator is the repository owner. A submitted brick is not trusted, published, or promoted merely because its local checks pass.

## 1. Prepare the brick

Work from the repository that contains the brick. The brick directory must contain one `module.sweetspot.json` (or exactly one `*.module.sweetspot.json`) and its source files. Keep generated dependencies, build output, secrets, private data, symlinks, and unrelated files out of the directory.

The repository must expose these scripts:

- `npm run gate:all`
- `npm run gate:leaks`

Run the packager from that repository root:

```bash
node /path/to/SMARCH/tools/sma-submit.mjs \
  --root . \
  --brick path/to/brick \
  --out submissions
```

`sma-submit` validates the manifest, runs `gate:all`, runs the leak gate explicitly, hashes every packaged file, and emits:

- a ready-to-attach `.tar.gz` containing `bundle.json`, `manifest.json`, the brick files, an automated attestation, and the curator checklist;
- a sidecar curator checklist;
- the archive SHA-256.

No archive is emitted when manifest validation or either local gate fails. `bundle.json` uses the inline-v1 identifier implemented by `schemas/submission-bundle-schema.json`; the shared schema deliberately preserves the shipped identifier so existing archives and the verifier remain compatible.

Verify the finished archive before attaching it:

```bash
node /path/to/SMARCH/tools/sma-submit.mjs \
  --verify submissions/<brick>-<version>-<timestamp>.tar.gz
```

Verification rejects unsafe archive paths and links, undeclared files, missing roles, identity drift, size changes, hash changes, and missing gate evidence.

## 2. Open the submission

Choose **Community brick submission** in GitHub Issues. Complete every required field, attach the generated `.tar.gz`, and paste the SHA-256 printed by the tool. The form records the source revision, SPDX license, verification notes, authorization to submit, and data-safety attestations.

Do not attach a hand-built archive or replace files inside a generated bundle. Re-run `sma-submit` after any change and attach the new archive and digest.

## 3. Automated gates

Repository automation treats every attachment as untrusted input. It quarantines the bundle and must reproduce a passing verdict before human review begins. The intake verdict covers, at minimum:

- bundle self-verification and file hashes;
- the full SMA gate suite and explicit leak gate;
- manifest, security, license, provenance, scope, and source-size checks;
- any additional trusted similarity or policy checks configured by the repository.

Local evidence is useful preflight evidence, not a waiver. If the issue has no trusted automated verdict, or if the archive digest differs from the issue, the submission remains blocked. The repository owner requests a rerun or a corrected bundle; they do not review or promote it manually around the gate.

## 4. Curator review

After automation passes, the repository owner is the first curator and works through the bundled checklist. The curator checks that the brick is reusable, narrowly bounded, licensed for the proposed visibility, free of private material, supported by honest evidence, and not a disguised duplicate or unsafe fork.

The curator records one outcome on the issue:

- **changes requested** — the submitter publishes a new bundle and digest;
- **rejected** — the rationale is recorded and no registry change is made;
- **approved for promotion** — the exact verified digest advances to the promotion gate.

Approval applies only to the reviewed archive digest. Any source or manifest change restarts automated gates and review.

## 5. Promotion

Promotion is a separate repository-owner action. The curator imports the exact approved bundle, registers its provenance and license evidence, runs the promotion gates, and only then changes the brick to the approved lifecycle status. Candidate or canonical promotion still requires all normal SMA rules, passing gates, and an empty or explicitly resolved backlog.

The issue closes only after the promoted record points back to the submission issue and approved archive digest. Until that happens, the brick remains a community submission, not a released SMARCH brick.
