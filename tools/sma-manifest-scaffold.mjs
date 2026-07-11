#!/usr/bin/env node
/**
 * WHAT: Generates repair scaffolds for incomplete curated-build manifests and companion evidence.
 * WHY: Missing fields and declared documents need explicit machine-readable repair work.
 * HOW: Inspects selected builds and emits field patches, document stubs, and evidence templates.
 * INPUTS: Optional build filters, output path, standard-output mode, and dry-run mode.
 * OUTPUTS: A structured scaffold document on standard output or in a generated handoff file.
 * CALLERS: Registry maintainers repairing curated builds before verification or publication.
 * Usage: `node tools/sma-manifest-scaffold.mjs --help`
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  buildHandoffPaths,
  filterCuratedBuilds,
  loadCuratedBuildContext,
  parseArgs,
  toArray,
  uniqueStrings,
} from "./lib/curated-build-utils.ts";

const DEFAULT_OUT = "scaffolds/build-manifest-repairs.generated.json";

const HELP_TEXT = `Usage: node tools/sma-manifest-scaffold.mjs [options]

Generate machine-readable manifest repair scaffolds for curated builds.

Options:
  --build <id>    Limit output to one build id. Repeatable.
  --out <file>    Output JSON path. Default: ${DEFAULT_OUT}
  --stdout        Print the generated JSON.
  --dry-run       Print only, do not write a file.
  --help          Show this help text.
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const context = await loadCuratedBuildContext(args);
  const builds = filterCuratedBuilds(context.curatedBuilds, args).map(buildManifestScaffolds);

  const document = {
    generated_at: new Date().toISOString(),
    schema_version: "manifest.repair.v1",
    summary: {
      build_count: builds.length,
      scaffold_count: builds.reduce((sum, entry) => sum + entry.scaffolds.length, 0),
      high_priority_count: builds.reduce((sum, entry) => sum + entry.scaffolds.filter((item) => item.priority === "high").length, 0),
      companion_stub_count: builds.reduce((sum, entry) => sum + entry.companion_stubs.length, 0),
    },
    builds,
  };

  if (args.stdout || args["dry-run"]) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!args["dry-run"]) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

function buildManifestScaffolds(build) {
  const manifest = build.manifest || {};
  const source = manifest.source || {};
  const owner = manifest.owner || {};
  const provenance = manifest.provenance || {};
  const verification = manifest.verification || {};
  const contracts = manifest.contracts || {};
  const clone = manifest.clone || {};
  const upgrade = manifest.upgrade || {};
  const buildSlug = String(manifest.build?.slug || build.build_id || "build").trim();
  const missingDocs = collectMissingDeclaredDocs(build);
  const evidenceStatuses = toArray(verification.evidence).map((entry) => String(entry.status || "").toLowerCase());

  const scaffolds = [];
  const add = (category, mode, priority, jsonPaths, reason, requiredInputs, seed, status = "scaffold") => {
    scaffolds.push({
      category,
      mode,
      priority,
      status,
      json_paths: jsonPaths,
      reason,
      required_inputs: requiredInputs,
      seed,
    });
  };

  if (!String(source.repository || "").trim() || !String(source.commit || "").trim()) {
    add(
      "source_identity",
      "patch",
      "high",
      ["source.repository", "source.commit", "source.archive_hash"],
      "Source identity is still blank, which weakens deterministic provenance and later update reasoning.",
      ["canonical repository URL", "current commit sha", "optional archive hash"],
      {
        repository: source.repository || "https://github.com/<owner>/<repo>",
        commit: source.commit || "<commit-sha>",
        archive_hash: source.archive_hash || "<optional-source-tree-hash>",
      },
      "missing"
    );
  }

  if (toArray(source.supporting_artifacts).length === 0) {
    add(
      "supporting_artifacts",
      "scaffold",
      "medium",
      ["source.supporting_artifacts"],
      "Supporting artifacts are empty, so docs, fixtures, migrations, and runbooks are not explicitly tied to the build.",
      ["doc paths", "fixture paths", "migration or runbook paths"],
      [
        { kind: "doc", path: `docs/${buildSlug}.md`, required: true },
        { kind: "verification_record", path: `security/build-evidence/${buildSlug}.verification.json`, required: true },
      ],
      "missing"
    );
  }

  if (toArray(owner.reviewers).length === 0 || !Array.isArray(provenance.reviewed_by) || provenance.reviewed_by.length === 0 || !verification.last_verified_at) {
    add(
      "review_chain",
      "scaffold",
      "medium",
      ["owner.reviewers", "provenance.reviewed_by", "verification.last_verified_at"],
      "Reviewer lineage and last verification timestamp are still too thin for trustworthy promotion.",
      ["reviewer names or ids", "review date", "review scope"],
      {
        owner_reviewers: owner.reviewers && owner.reviewers.length ? owner.reviewers : ["<reviewer-id>"],
        reviewed_by: Array.isArray(provenance.reviewed_by) && provenance.reviewed_by.length ? provenance.reviewed_by : [
          {
            actor_kind: "human",
            actor_id: "<reviewer-id>",
            role: "reviewer",
            timestamp: "<ISO-8601>",
            summary: "Reviewed build scope, verification posture, and publish lane.",
          },
        ],
        last_verified_at: verification.last_verified_at || "<ISO-8601>",
      },
      "thin"
    );
  }

  if (toArray(verification.fixture_targets).length === 0 || evidenceStatuses.every((status) => status !== "pass" || String(verification.status || "").toLowerCase() === "planned")) {
    add(
      "verification_fixture_pack",
      "scaffold",
      "high",
      ["verification.fixture_targets", "verification.evidence", "verification.last_verified_at"],
      "Verification still relies on review-only or blocked/skipped evidence instead of build-level fixtures and captured results.",
      ["fixture or smoke target path", "real command output", "operator or reviewer", "execution timestamp"],
      {
        fixture_targets: toArray(verification.fixture_targets).length ? toArray(verification.fixture_targets) : [`security/build-evidence/${buildSlug}.fixture.md`],
        evidence_append: toArray(verification.smoke_commands).map((command) => ({
          command,
          status: "skipped",
          operator: "<operator-id>",
          executed_at: "<ISO-8601>",
          notes: "Replace placeholder with real build-level verification evidence.",
        })),
        last_verified_at: verification.last_verified_at || "<ISO-8601>",
      },
      toArray(verification.fixture_targets).length === 0 ? "missing" : "thin"
    );
  }

  if (String(build.build_id).includes("workos-auth-billing")) {
    add(
      "workos_entitlement_rls",
      "scaffold",
      "high",
      ["contracts.data.tables", "contracts.rls.tables", "contracts.rls.matrix_path"],
      "Auth and billing verification needs explicit table/matrix grounding for account linking, entitlements, and negative-path checks.",
      ["billing tables", "entitlement tables", "RLS matrix doc path"],
      {
        data_tables: toArray(contracts.data?.tables).length ? contracts.data.tables : ["subscriptions", "entitlements", "linked_identities"],
        rls_tables: toArray(contracts.rls?.tables).length ? contracts.rls.tables : ["subscriptions", "entitlements", "linked_identities"],
        matrix_path: contracts.rls?.matrix_path || "docs/rls/workos-auth-billing.matrix.md",
      },
      "missing"
    );
  }

  if (String(build.build_id).includes("admin-ops-control-plane")) {
    add(
      "admin_authz_audit",
      "scaffold",
      "high",
      ["contracts.data.tables", "contracts.rls.tables", "contracts.rls.matrix_path", "verification.evidence"],
      "Privileged admin capability still lacks explicit authz/audit proof and matrix-backed negative-path evidence.",
      ["admin tables", "audit log tables", "approval path notes", "RLS matrix doc path"],
      {
        data_tables: toArray(contracts.data?.tables).length ? contracts.data.tables : ["admin_actions", "provider_balances", "rate_limits", "credit_adjustments"],
        rls_tables: toArray(contracts.rls?.tables).length ? contracts.rls.tables : ["admin_actions", "provider_balances", "rate_limits", "credit_adjustments"],
        matrix_path: contracts.rls?.matrix_path || "docs/rls/admin-ops-control-plane.matrix.md",
        evidence_append: [
          {
            command: "manual admin smoke and authorization review",
            status: "blocked",
            operator: "<reviewer-id>",
            executed_at: "<ISO-8601>",
            notes: "Replace placeholder with real privileged-auth verification and audit evidence.",
          },
        ],
      },
      "missing"
    );
  }

  if (String(build.build_id).includes("ai-image-generation")) {
    add(
      "image_regression_evidence",
      "patch",
      "high",
      ["verification.evidence", "verification.last_verified_at"],
      "The harness exists, but the build still lacks captured regression evidence and proxy-isolation proof.",
      ["fixture output path", "proxy smoke result", "execution timestamp"],
      {
        evidence_append: [
          {
            command: "npm run test -- 86-image-generation",
            status: "pass",
            operator: "<operator-id>",
            executed_at: "<ISO-8601>",
            artifact_path: `security/build-evidence/${buildSlug}.verification.json`,
            notes: "Capture the real regression result instead of leaving it as skipped.",
          },
          {
            command: "manual proxy ownership and tenant isolation smoke",
            status: "pass",
            operator: "<operator-id>",
            executed_at: "<ISO-8601>",
            notes: "Record proxy-only delivery and tenant isolation proof.",
          },
        ],
        last_verified_at: verification.last_verified_at || "<ISO-8601>",
      },
      "thin"
    );
    add(
      "rls_matrix_patch",
      "patch",
      "medium",
      ["contracts.rls.matrix_path", "contracts.rls.tables"],
      "The image build is ahead of the others, but the RLS matrix anchor is still too soft for later promotion.",
      ["storage tables", "job tables", "RLS matrix doc path"],
      {
        rls_tables: toArray(contracts.rls?.tables).length ? contracts.rls.tables : ["generation_jobs", "generated_assets"],
        matrix_path: contracts.rls?.matrix_path || "docs/rls/ai-image-generation.matrix.md",
      },
      "thin"
    );
  }

  if (toArray(clone.target_docs).length < 3 || missingDocs.length > 0) {
    add(
      "clone_doc_bundle",
      "scaffold",
      "medium",
      ["clone.target_docs", "source.supporting_artifacts"],
      "Clone/install docs are still too thin and at least one declared doc path is unresolved.",
      ["install doc", "ports doc", "rollback doc", "known-traps doc"],
      {
        target_docs: uniqueStrings([
          ...toArray(clone.target_docs),
          `docs/${buildSlug}.md`,
          `docs/${buildSlug}.ports.md`,
          `docs/${buildSlug}.rollback.md`,
          `docs/${buildSlug}.known-traps.md`,
        ]),
      },
      missingDocs.length > 0 ? "missing" : "thin"
    );
  }

  if (toArray(upgrade.supersedes).length === 0) {
    add(
      "upgrade_lineage",
      "scaffold",
      "low",
      ["upgrade.supersedes"],
      "Upgrade lineage is empty, which will make replacement-chain reasoning weak once multiple releases exist.",
      ["prior build ids or release ids, if any"],
      {
        supersedes: ["<prior-build-or-release-id>"],
      },
      "missing"
    );
  }

  return {
    build_id: build.build_id,
    name: build.name,
    source_project: build.source_project,
    manifest_path: build.manifest_path,
    handoff_refs: buildHandoffPaths(build),
    scaffolds,
    companion_stubs: buildCompanionStubs(build, missingDocs, buildSlug),
  };
}

function collectMissingDeclaredDocs(build) {
  return toArray(build.publishBundle?.report?.findings)
    .filter((entry) => entry.rule_id === "missing-declared-path")
    .map((entry) => String(entry.evidence || "").trim())
    .filter(Boolean);
}

function buildCompanionStubs(build, missingDocs, buildSlug) {
  /** @type {Array<{
   * kind: string,
   * path: string,
   * template_ref?: string,
   * template?: {title: string, sections: string[]},
   * reason: string
   * }>} */
  const stubs = [
    {
      kind: "verification_record",
      path: `security/build-evidence/${buildSlug}.verification.json`,
      template_ref: "templates/build-verification/evidence-record.example.json",
      reason: "Curated build still lacks an attached build-level evidence artifact.",
    },
  ];
  for (const docPath of missingDocs) {
    stubs.push({
      kind: "doc_stub",
      path: docPath,
      template: {
        title: build.name,
        sections: ["What This Build Does", "Install Steps", "Required Ports", "Verification", "Known Traps", "Rollback"],
      },
      reason: "Manifest declares this doc path, but the publish lane could not resolve it.",
    });
  }
  return stubs;
}
