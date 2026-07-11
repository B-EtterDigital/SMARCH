/**
 * WHAT: Decides whether a generated controller packet still matches current lease state.
 * WHY: A young packet can still be unsafe when ownership changes after it was generated.
 * HOW: Normalizes active leases, hashes the stable fields, and combines fingerprint and age checks.
 * INPUTS: Packet metadata, active leases, expected fingerprints, and a maximum age.
 * OUTPUTS: Freshness results, assertion failures, and concise human-readable explanations.
 * CALLERS: Cleanup, graph, and module packet commands use this before listing or claiming work.
 * @example node --input-type=module -e "import { maxAgeSeconds } from './tools/lib/packet-freshness.mjs'; console.log(maxAgeSeconds('30'));"
 */
import { createHash } from 'node:crypto';

export const DEFAULT_PACKET_MAX_AGE_SECONDS = 900;
export const PACKET_LEASE_FINGERPRINT_ALGORITHM = 'sha256:active-leases-v1';

const TRANSIENT_LEASE_KINDS = new Set(['registry-regen', 'state-regen', 'wiki-regen']);

export function maxAgeSeconds(value, fallback = DEFAULT_PACKET_MAX_AGE_SECONDS) {
  if (value === undefined || value === null || value === true) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --max-age-seconds value: ${value}`);
  }
  return Math.floor(parsed);
}

export function packetLeaseFingerprint(activeLeases, { project = null } = {}) {
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

export function normalizePacketLeases(activeLeases, { project = null } = {}) {
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

export function packetFreshness(report, {
  currentLeaseFingerprint = null,
  expectedLeaseFingerprint = null,
  maxAge = DEFAULT_PACKET_MAX_AGE_SECONDS,
} = {}) {
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

export function assertFreshPacketReport(report, {
  allowStale = false,
  currentLeaseFingerprint = null,
  expectedLeaseFingerprint = null,
  label = 'packet',
  maxAge = DEFAULT_PACKET_MAX_AGE_SECONDS,
  refreshCommand = 'npm run controller:sweep:write',
} = {}) {
  const freshness = packetFreshness(report, { currentLeaseFingerprint, expectedLeaseFingerprint, maxAge });
  if (!allowStale && freshness.stale) {
    throw new Error(`${label} packet file is stale (${packetFreshnessReason(freshness)}). Run ${refreshCommand} or pass --allow-stale.`);
  }
  return freshness;
}

export function formatPacketFreshness(freshness) {
  const age = freshness.age_seconds === null ? 'unknown age' : `${freshness.age_seconds}s old`;
  const lease = freshness.lease_fingerprint || {};
  const leaseInfo = lease.packet_hash
    ? `lease ${shortHash(lease.packet_hash)}${freshness.lease_stale ? ', active leases changed' : ''}`
    : null;
  return `generated ${freshness.generated_at || 'unknown'} (${[
    age,
    `max ${freshness.max_age_seconds}s`,
    leaseInfo,
    freshness.stale ? 'stale' : null,
  ].filter(Boolean).join(', ')})`;
}

function packetFreshnessReason(freshness) {
  const reasons = [];
  if (freshness.age_stale) {
    const age = freshness.age_seconds === null ? 'unknown age' : `${freshness.age_seconds}s old`;
    reasons.push(`${age}; max ${freshness.max_age_seconds}s`);
  }
  if (freshness.lease_stale) {
    const lease = freshness.lease_fingerprint || {};
    reasons.push(`active leases changed ${shortHash(lease.packet_hash)} -> ${shortHash(lease.current_hash)}`);
  }
  return reasons.join('; ') || 'unknown freshness failure';
}

function shortHash(value) {
  return value ? String(value).slice(0, 12) : 'none';
}

function isTransientPacketLease(lease) {
  const kind = normalizeString(lease?.resource_kind);
  const resource = normalizeString(lease?.resource_id);
  return TRANSIENT_LEASE_KINDS.has(kind)
    || (kind === 'other' && resource === 'controller-actions');
}

function normalizeString(value) {
  return value === undefined || value === null ? null : String(value);
}
