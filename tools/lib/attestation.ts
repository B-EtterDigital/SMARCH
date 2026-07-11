/**
 * WHAT: Deterministically converts brick provenance and license facts into standard attestation documents.
 * WHY: Auditors and release tools need portable evidence they can regenerate instead of trusting internal records.
 * HOW: Callers pass a brick, optional components, and a timestamp; exporters return plain document objects.
 * The scanner, release store, provenance ledger, and verifier consume these objects without hidden input or output.
 * Given identical inputs, each exporter returns byte-stable data suitable for comparison and signing.
 * Format terms are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { intotoStatement } from './tools/lib/attestation.ts'; console.log(intotoStatement({ brick_id: 'demo', content_hash: 'abc' }).subject[0])"
 */
/**
 * attestation.ts — pure, deterministic exporters that turn a brick's
 * provenance + license + fingerprint facts into STANDARD-FORMAT attestations a
 * third party can consume with off-the-shelf tooling:
 *
 *   - intotoStatement()   in-toto Statement v1 wrapping a SLSA Provenance v1
 *                         predicate (builder id, seal head, materials).
 *   - spdxDocument()      SPDX 2.3 JSON SBOM (one package per brick + components).
 *   - cyclonedxDocument() CycloneDX 1.5 JSON SBOM.
 *
 * These are PURE: no filesystem, no network, and no Date.now() in any hashed
 * field — every timestamp is passed in. Given the same inputs they produce
 * byte-identical documents, so an auditor can regenerate and diff them.
 *
 * A `brick` is a plain object with (all optional except brick_id):
 *   { brick_id, project, content_hash, file_count, byte_count,
 *     spdx, license_class, openness, visibility, attribution_required,
 *     seal:{algo,anchor,head,chain_length}, created_by, contributors[], commit_count }
 * A `component` (sub-part) is { name?, brick_id?, content_hash?, spdx?, version?, uri? }.
 */

import { createHash } from 'node:crypto';

type Contributor = { actor_id?: string; name?: string; commits?: number; first?: string; last?: string };
type Brick = {
  brick_id: string;
  project?: string;
  content_hash?: string;
  file_count?: number;
  byte_count?: number;
  spdx?: string;
  license_class?: string;
  openness?: string;
  visibility?: string;
  attribution_required?: boolean;
  seal?: { algo?: string; anchor?: string; head?: string; chain_length?: number };
  created_by?: { actor_id?: string; role?: string; commit?: string; timestamp?: string };
  contributors?: Contributor[];
};
type Component = { name?: string; brick_id?: string; content_hash?: string; spdx?: string; version?: string | number; uri?: string };
type JsonDocument = Record<string, any>;
type CdxComponent = { type: string; 'bom-ref': string; name: string; version?: string; licenses?: JsonDocument[]; hashes?: JsonDocument[] };
type SpdxPackage = {
  SPDXID: string;
  name: string;
  downloadLocation: string;
  filesAnalyzed: boolean;
  licenseConcluded: string;
  licenseDeclared: string;
  copyrightText: string;
  supplier?: string;
  checksums: Array<{ algorithm: string; checksumValue: string }>;
  versionInfo?: string;
};

export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const SLSA_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
export const BUILDER_ID = 'https://sma.local/brick-scanner';
export const BUILD_TYPE = 'https://sma.local/brick-scan/v1';

const NOASSERTION = 'NOASSERTION';
const EPOCH = '1970-01-01T00:00:00Z'; // deterministic fallback when no timestamp given

const sha256Hex = (s: unknown): string => createHash('sha256').update(String(s)).digest('hex');

/** SPDXID element ids allow only [A-Za-z0-9.-]; map anything else to '-'. */
function sanitizeSpdxId(s: unknown): string {
  return String(s || 'unknown').replace(/[^A-Za-z0-9.-]/g, '-');
}

/** Format 32 hex chars as a well-formed (format-valid) UUID for CycloneDX urn. */
function toUuid(hex: unknown): string {
  const h = String(hex || '').replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function supplierOf(brick: Brick): string {
  const c = (brick.contributors && brick.contributors[0]) || null;
  const name = c?.name || c?.actor_id || brick.created_by?.actor_id || null;
  return name ? `Organization: ${name}` : NOASSERTION;
}

// --- in-toto Statement v1 + SLSA Provenance v1 -----------------------------

/**
 * Build an in-toto Statement v1 whose predicate is a SLSA Provenance v1 record.
 * The subject is the brick pinned by its content sha256; the predicate names the
 * builder, records the provenance seal head (as invocationId), and lists the
 * component + contributor inputs as resolvedDependencies (materials).
 */
export function intotoStatement(brick: Brick, components: Component[] = [], timestamp: string | null = null): JsonDocument {
  const contentHash = brick.content_hash || null;
  const subject = [{
    name: brick.brick_id,
    digest: contentHash ? { sha256: contentHash } : {},
  }];

  const resolvedDependencies: JsonDocument[] = [];
  if (brick.created_by?.commit) {
    resolvedDependencies.push({
      uri: `git+commit:${brick.created_by.commit}`,
      digest: { sha1: brick.created_by.commit },
      name: 'source-commit',
      annotations: {
        actor_id: brick.created_by.actor_id || null,
        role: brick.created_by.role || null,
        timestamp: brick.created_by.timestamp || null,
      },
    });
  }
  for (const c of brick.contributors || []) {
    resolvedDependencies.push({
      uri: `contributor:${c.actor_id || c.name || 'unknown'}`,
      name: c.name || c.actor_id || 'contributor',
      annotations: { commits: c.commits ?? null, first: c.first || null, last: c.last || null },
    });
  }
  (components || []).forEach((comp, i) => {
    const dep: JsonDocument = {
      uri: comp.uri || `component:${comp.brick_id || comp.name || `c${i}`}`,
      name: comp.name || comp.brick_id || `component-${i}`,
    };
    if (comp.content_hash) dep.digest = { sha256: comp.content_hash };
    if (comp.version) dep.annotations = { version: comp.version };
    resolvedDependencies.push(dep);
  });

  const predicate = {
    buildDefinition: {
      buildType: BUILD_TYPE,
      externalParameters: {
        brick_id: brick.brick_id,
        project: brick.project || null,
      },
      internalParameters: {
        seal: brick.seal ? {
          algo: brick.seal.algo || null,
          anchor: brick.seal.anchor || null,
          head: brick.seal.head || null,
          chain_length: brick.seal.chain_length ?? null,
        } : null,
        fingerprint: {
          content_hash: contentHash,
          file_count: brick.file_count ?? null,
          byte_count: brick.byte_count ?? null,
        },
        license: {
          spdx: brick.spdx || null,
          license_class: brick.license_class || null,
          openness: brick.openness || null,
          visibility: brick.visibility || null,
          attribution_required: brick.attribution_required ?? null,
        },
      },
      resolvedDependencies,
    },
    runDetails: {
      builder: { id: BUILDER_ID },
      metadata: {
        invocationId: brick.seal?.head || null, // the provenance seal head
        startedOn: timestamp || EPOCH,
        finishedOn: timestamp || EPOCH,
      },
    },
  };

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    predicateType: SLSA_PREDICATE_TYPE,
    subject,
    predicate,
  };
}

// --- SPDX 2.3 --------------------------------------------------------------

/** Minimal, valid SPDX 2.3 JSON SBOM: one package for the brick + one per component. */
export function spdxDocument(brick: Brick, components: Component[] = [], timestamp: string | null = null): JsonDocument {
  const contentHash = brick.content_hash || null;
  const created = timestamp || EPOCH;
  const brickTag = sanitizeSpdxId(brick.brick_id);
  const mainId = `SPDXRef-Package-${brickTag}`;
  const namespaceSeed = contentHash || sha256Hex(brick.brick_id);

  const packages: SpdxPackage[] = [{
    SPDXID: mainId,
    name: brick.brick_id,
    downloadLocation: NOASSERTION,
    filesAnalyzed: false,
    licenseConcluded: brick.spdx || NOASSERTION,
    licenseDeclared: brick.spdx || NOASSERTION,
    copyrightText: NOASSERTION,
    supplier: supplierOf(brick),
    checksums: contentHash ? [{ algorithm: 'SHA256', checksumValue: contentHash }] : [],
  }];
  const relationships = [{
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: mainId,
  }];

  (components || []).forEach((comp, i) => {
    const cid = `SPDXRef-Component-${sanitizeSpdxId(comp.brick_id || comp.name || `c${i}`)}`;
    const pkg: SpdxPackage = {
      SPDXID: cid,
      name: comp.name || comp.brick_id || `component-${i}`,
      downloadLocation: NOASSERTION,
      filesAnalyzed: false,
      licenseConcluded: comp.spdx || NOASSERTION,
      licenseDeclared: comp.spdx || NOASSERTION,
      copyrightText: NOASSERTION,
      checksums: comp.content_hash ? [{ algorithm: 'SHA256', checksumValue: comp.content_hash }] : [],
    };
    if (comp.version) pkg.versionInfo = String(comp.version);
    packages.push(pkg);
    relationships.push({ spdxElementId: mainId, relationshipType: 'CONTAINS', relatedSpdxElement: cid });
  });

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `sma-attestation-${brick.brick_id}`,
    documentNamespace: `https://sma.local/spdx/${brickTag}/${namespaceSeed}`,
    creationInfo: {
      created,
      creators: ['Tool: sma-attest-1.0.0', 'Organization: SMA brick-scanner'],
    },
    packages,
    relationships,
  };
}

// --- CycloneDX 1.5 ---------------------------------------------------------

function cdxLicenses(spdx?: string): JsonDocument[] {
  if (!spdx) return [{ license: { name: NOASSERTION } }];
  // SPDX license EXPRESSIONS (operators/spaces) go in `expression`; single ids in `license.id`.
  if (/\s|\bOR\b|\bAND\b|\bWITH\b/.test(spdx)) return [{ expression: spdx }];
  return [{ license: { id: spdx } }];
}

function cdxComponent(name: unknown, spdx?: string, contentHash?: string | null, version?: string | number): CdxComponent {
  const comp: CdxComponent = {
    type: 'library',
    'bom-ref': `component:${name}`,
    name: String(name),
  };
  if (version) comp.version = String(version).slice(0, 32);
  comp.licenses = cdxLicenses(spdx);
  comp.hashes = contentHash ? [{ alg: 'SHA-256', content: contentHash }] : [];
  return comp;
}

/** Minimal, valid CycloneDX 1.5 JSON SBOM. The brick is components[0]. */
export function cyclonedxDocument(brick: Brick, components: Component[] = [], timestamp: string | null = null): JsonDocument {
  const contentHash = brick.content_hash || null;
  const serialSeed = contentHash || sha256Hex(brick.brick_id);

  const comps = [cdxComponent(brick.brick_id, brick.spdx, contentHash, brick.seal?.head?.slice(0, 12))];
  for (const c of components || []) {
    comps.push(cdxComponent(c.name || c.brick_id, c.spdx, c.content_hash, c.version));
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${toUuid(serialSeed)}`,
    version: 1,
    metadata: {
      timestamp: timestamp || EPOCH,
      tools: [{ vendor: 'SMA', name: 'sma-attest', version: '1.0.0' }],
      component: { type: 'application', 'bom-ref': `subject:${brick.brick_id}`, name: brick.brick_id },
    },
    components: comps,
  };
}
