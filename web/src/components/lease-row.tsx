import { useEffect, useRef, useState } from "preact/hooks";
import type { Lease } from "../schema-types";
import { STRINGS } from "../strings";

export type LeaseRowValue = Lease & { state?: string };

export type LeaseRowProps = {
  lease: LeaseRowValue;
  now?: number;
};

export function formatLeaseTtl(expiresAt: string, now = Date.now()): string {
  const parsed = Date.parse(expiresAt);
  const remaining = Number.isFinite(parsed) ? Math.max(0, parsed - now) : 0;
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function truncateLeaseIntent(intent: string): string {
  return intent.length > 48 ? `${intent.slice(0, 47)}…` : intent;
}

/**
 * One 40px departures-board row. The parent supplies a once-per-second `now`
 * value so every TTL advances from one shared timer between SSE updates.
 */
export function LeaseRow({ lease, now = Date.now() }: LeaseRowProps) {
  const state = lease.state ?? "active";
  const fingerprint = `${lease.resource_id}:${lease.intent}:${lease.expires_at}:${state}`;
  const previousFingerprint = useRef(fingerprint);
  const [flip, setFlip] = useState(false);

  useEffect(() => {
    if (previousFingerprint.current === fingerprint) return;
    previousFingerprint.current = fingerprint;
    setFlip(false);
    const frame = requestAnimationFrame(() => setFlip(true));
    const timer = window.setTimeout(() => setFlip(false), 150);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [fingerprint]);

  const remaining = Date.parse(lease.expires_at) - now;
  const urgent = remaining > 0 && remaining < 300_000;
  const active = remaining > 0 && state === "active";
  const stateLabel = active ? STRINGS.verdicts.active : state === "active" ? STRINGS.verdicts.expired : state.toUpperCase();

  return (
    <tr class={`lease-row${flip ? " lease-row--flip" : ""}`} data-state={state}>
      <td>{lease.agent_id}</td>
      <td>{lease.resource_id}</td>
      <td class="truncate" title={lease.intent}>{truncateLeaseIntent(lease.intent)}</td>
      <td class={urgent ? "ttl ttl--urgent" : "ttl"}>{formatLeaseTtl(lease.expires_at, now)}</td>
      <td>
        <span class={active ? "verdict verdict--active" : "verdict verdict--fail"}>
          <span aria-hidden="true">{active ? STRINGS.verdictIcons.pass : STRINGS.verdictIcons.fail}</span>
          {stateLabel}
        </span>
      </td>
    </tr>
  );
}
