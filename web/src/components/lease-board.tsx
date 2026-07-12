import { useEffect, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { LeaseRow, type LeaseRowValue } from "./lease-row";

export interface LeaseBoardProps {
  leases?: LeaseRowValue[];
  status?: "loading" | "ready" | "error";
  error?: unknown;
  onRetry?: () => void;
}

/**
 * Accessible active-lease departures board with one shared client-side TTL
 * clock. Loading, empty, error, and populated states are intentionally explicit.
 */
export function LeaseBoard({ leases = [], status = "ready", error, onRetry }: LeaseBoardProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== "ready" || leases.length === 0) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, [status, leases.length]);

  useEffect(() => {
    if (status === "error") reportClientError("dashboard.lease-board", "error", error ?? STRINGS.leaseBoard.error);
  }, [error, status]);

  if (status === "loading") return <p class="loading" aria-live="polite">{STRINGS.leaseBoard.loading}</p>;
  if (status === "error") {
    return (
      <div class="component-error" role="alert">
        <p>{STRINGS.leaseBoard.error}</p>
        {onRetry ? <button type="button" onClick={onRetry}>{STRINGS.leaseBoard.retry}</button> : null}
      </div>
    );
  }
  if (leases.length === 0) return <p class="empty-state__sentence">{STRINGS.empty.leases}</p>;

  return (
    <div class="ledger-scroll lease-board">
      <table class="ledger-table" aria-label={STRINGS.leaseBoard.label}>
        <thead>
          <tr>
            <th scope="col">{STRINGS.leaseColumns.agent}</th>
            <th scope="col">{STRINGS.leaseColumns.brick}</th>
            <th scope="col">{STRINGS.leaseColumns.intent}</th>
            <th scope="col">{STRINGS.leaseColumns.ttl}</th>
            <th scope="col">{STRINGS.leaseColumns.state}</th>
          </tr>
        </thead>
        <tbody>{leases.map((lease) => <LeaseRow lease={lease} now={now} key={lease.lease_id} />)}</tbody>
      </table>
    </div>
  );
}
