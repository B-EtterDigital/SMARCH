/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Existing logical-OR fallbacks intentionally treat every falsy value as absent; replacing them with ?? would change behavior. */
/* eslint-disable @typescript-eslint/no-base-to-string -- String() deliberately preserves the prior template-literal coercion contract for human-readable reports. */
/**
 * WHAT: Decides whether a generated controller packet still matches current lease state.
 * WHY: A young packet can still be unsafe when ownership changes after it was generated.
 * HOW: Normalizes active leases, hashes the stable fields, and combines fingerprint and age checks.
 * INPUTS: Packet metadata, active leases, expected fingerprints, and a maximum age.
 * OUTPUTS: Freshness results, assertion failures, and concise human-readable explanations.
 * CALLERS: Cleanup, graph, and module packet commands use this before listing or claiming work.
 * @example node --input-type=module -e "import { maxAgeSeconds } from './tools/lib/packet-freshness.ts'; console.log(maxAgeSeconds('30'));"
 */
import { createHash } from 'node:crypto';

const DEFAULT_PACKET_MAX_AGE_SECONDS = 900;
const PACKET_LEASE_FINGERPRINT_ALGORITHM = 'sha256:active-leases-v1';

const TRANSIENT_LEASE_KINDS = new Set(['registry-regen', 'state-regen', 'wiki-regen']);

interface PacketLease {
  lease_id?: unknown;
  resource_kind?: unknown;
  resource_id?: unknown;
  project?: unknown;
  agent_id?: unknown;
  acquired_at?: unknown;
  intent?: unknown;
}

type PacketLeaseSource = PacketLease[] | { leases?: PacketLease[] } | null | undefined;
type NormalizedPacketLease = Record<'lease_id' | 'resource_kind' | 'resource_id' | 'project' | 'agent_id' | 'acquired_at' | 'intent', string | null>;
export interface LeaseFingerprint { algorithm: string; hash: string; lease_count: number; lease_ids?: (string | null)[] }
type PacketReport = { generated_at?: string | null; lease_fingerprint?: LeaseFingerprint | null } | null | undefined;
export interface PacketFreshness {
  generated_at: string | null;
  age_seconds: number | null;
  max_age_seconds: number;
  age_stale: boolean;
  lease_stale: boolean;
  lease_fingerprint: {
    packet_hash: string | null;
    current_hash: string | null;
    packet_lease_count: number | null;
    current_lease_count: number | null;
    algorithm: string | null;
  };
  stale: boolean;
}

export function maxAgeSeconds(value: unknown, fallback = DEFAULT_PACKET_MAX_AGE_SECONDS): number {
  if (value === undefined || value === null || value === true) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --max-age-seconds value: ${String(value)}`);
  }
  return Math.floor(parsed);
}

export function packetLeaseFingerprint(activeLeases: PacketLeaseSource, { project = null }: { project?: string | null } = {}): LeaseFingerprint {
  const leases = normalizePacketLeases(activeLeases, { project });
  const payload = JSON.stringify({
    algorithm: PACKET_LEASE_FINGERPRINT_ALGORITHM,
    project: normalizeString(project),
    leases,
  });
  return {
    algorithm: PACKET_LEASE_FINGERPRINT_ALGORITHM,
    hash: createHash('sha256').update(payload).digest('hex'),
    lease_count: leases.length,
    lease_ids: leases.map((lease) => lease.lease_id).slice(0, 25),
  };
}

function normalizePacketLeases(activeLeases: PacketLeaseSource, { project = null }: { project?: string | null } = {}): NormalizedPacketLease[] {
  const projectFilter = normalizeString(project);
  const source = Array.isArray(activeLeases)
    ? activeLeases
    : Array.isArray(activeLeases?.leases)
      ? activeLeases.leases
      : [];
  return source
    .filter((lease) => !isTransientPacketLease(lease))
    .filter((lease) => !projectFilter || normalizeString(lease.project) === projectFilter)
    .map((lease) => ({
      lease_id: normalizeString(lease.lease_id),
      resource_kind: normalizeString(lease.resource_kind),
      resource_id: normalizeString(lease.resource_id),
      project: normalizeString(lease.project),
      agent_id: normalizeString(lease.agent_id),
      acquired_at: normalizeString(lease.acquired_at),
      intent: normalizeString(lease.intent),
    }))
    .sort((a, b) => [
      a.resource_kind,
      a.project,
      a.resource_id,
      a.lease_id,
      a.agent_id,
      a.acquired_at,
      a.intent,
    ].join('\0').localeCompare([
      b.resource_kind,
      b.project,
      b.resource_id,
      b.lease_id,
      b.agent_id,
      b.acquired_at,
      b.intent,
    ].join('\0')));
}

// eslint-disable-next-line complexity -- Compatibility fallback expressions inflate the branch metric although this normalization and report assembly remains linear.
export function packetFreshness(report: PacketReport, {
  currentLeaseFingerprint = null,
  expectedLeaseFingerprint = null,
  maxAge = DEFAULT_PACKET_MAX_AGE_SECONDS,
}: { currentLeaseFingerprint?: LeaseFingerprint | null; expectedLeaseFingerprint?: LeaseFingerprint | null; maxAge?: number } = {}): PacketFreshness {
  const generatedAt = report?.generated_at || null;
  const generatedMs = Date.parse(generatedAt || '');
  const ageSeconds = Number.isFinite(generatedMs)
    ? Math.max(0, Math.floor((Date.now() - generatedMs) / 1000))
    : null;
  const packetLease = expectedLeaseFingerprint || report?.lease_fingerprint || null;
  const leaseStale = Boolean(
    packetLease?.hash
      && currentLeaseFingerprint?.hash
      && packetLease.hash !== currentLeaseFingerprint.hash,
  );
  const ageStale = ageSeconds === null || ageSeconds > maxAge;
  return {
    generated_at: generatedAt,
    age_seconds: ageSeconds,
    max_age_seconds: maxAge,
    age_stale: ageStale,
    lease_stale: leaseStale,
    lease_fingerprint: {
      packet_hash: packetLease?.hash || null,
      current_hash: currentLeaseFingerprint?.hash || null,
      packet_lease_count: packetLease?.lease_count ?? null,
      current_lease_count: currentLeaseFingerprint?.lease_count ?? null,
      algorithm: packetLease?.algorithm || currentLeaseFingerprint?.algorithm || null,
    },
    stale: ageStale || leaseStale,
  };
}

export function assertFreshPacketReport(report: PacketReport, {
  allowStale = false,
  currentLeaseFingerprint = null,
  expectedLeaseFingerprint = null,
  label = 'packet',
  maxAge = DEFAULT_PACKET_MAX_AGE_SECONDS,
  refreshCommand = 'npm run controller:sweep:write',
}: { allowStale?: boolean; currentLeaseFingerprint?: LeaseFingerprint | null; expectedLeaseFingerprint?: LeaseFingerprint | null; label?: string; maxAge?: number; refreshCommand?: string } = {}): PacketFreshness {
  const freshness = packetFreshness(report, { currentLeaseFingerprint, expectedLeaseFingerprint, maxAge });
  if (!allowStale && freshness.stale) {
    throw new Error(`${label} packet file is stale (${packetFreshnessReason(freshness)}). Run ${refreshCommand} or pass --allow-stale.`);
  }
  return freshness;
}

export function formatPacketFreshness(freshness: PacketFreshness): string {
  const age = freshness.age_seconds === null ? 'unknown age' : `${String(freshness.age_seconds)}s old`;
  const lease = freshness.lease_fingerprint;
  const leaseInfo = lease.packet_hash
    ? `lease ${shortHash(lease.packet_hash)}${freshness.lease_stale ? ', active leases changed' : ''}`
    : null;
  return `generated ${freshness.generated_at || 'unknown'} (${[
    age,
    `max ${String(freshness.max_age_seconds)}s`,
    leaseInfo,
    freshness.stale ? 'stale' : null,
  ].filter(Boolean).join(', ')})`;
}

function packetFreshnessReason(freshness: PacketFreshness): string {
  const reasons: string[] = [];
  if (freshness.age_stale) {
    const age = freshness.age_seconds === null ? 'unknown age' : `${String(freshness.age_seconds)}s old`;
    reasons.push(`${age}; max ${String(freshness.max_age_seconds)}s`);
  }
  if (freshness.lease_stale) {
    const lease = freshness.lease_fingerprint;
    reasons.push(`active leases changed ${shortHash(lease.packet_hash)} -> ${shortHash(lease.current_hash)}`);
  }
  return reasons.join('; ') || 'unknown freshness failure';
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : 'none';
}

function isTransientPacketLease(lease: PacketLease): boolean {
  const kind = normalizeString(lease.resource_kind);
  const resource = normalizeString(lease.resource_id);
  return (kind !== null && TRANSIENT_LEASE_KINDS.has(kind))
    || (kind === 'other' && resource === 'controller-actions');
}

function normalizeString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}
