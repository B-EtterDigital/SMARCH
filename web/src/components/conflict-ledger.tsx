/* eslint-disable @typescript-eslint/restrict-template-expressions -- Conflict identifiers are rendered with their existing primitive interpolation to preserve displayed ledger text. */
import { useMemo } from "preact/hooks";
import type { Conflict } from "../schema-types";
import { STRINGS } from "../strings";
import { EmptyState, type SurfaceState } from "./empty-states";
import { VerdictStamp } from "./verdict-stamp";

export interface ConflictLedgerProps {
  conflicts: Conflict[];
  moduleFilter?: string | null;
  state?: "populated" | SurfaceState;
  onRetry?: () => void;
  error?: unknown;
}

function sortConflicts(conflicts: Conflict[]): Conflict[] {
  return [...conflicts].sort((left, right) => {
    if (left.status !== right.status) return left.status === "open" ? -1 : 1;
    return Date.parse(right.timestamp) - Date.parse(left.timestamp);
  });
}

function relativeConflictTime(timestamp: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000));
  if (minutes < 1) return STRINGS.relativeNow;
  if (minutes < 60) return `${minutes}${STRINGS.minuteSuffix}`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}${STRINGS.hourSuffix}`;
  return `${Math.floor(minutes / 1_440)}${STRINGS.daySuffix}`;
}

/** Audit ledger with open conflicts first, ISO timestamps, and non-color verdict labels. */
export function ConflictLedger({ conflicts, moduleFilter = null, state = "populated", onRetry, error }: ConflictLedgerProps) {
  const visible = useMemo(
    () => sortConflicts(moduleFilter ? conflicts.filter((conflict) => conflict.project === moduleFilter) : conflicts),
    [conflicts, moduleFilter]
  );

  if (state !== "populated") {
    return <EmptyState state={state} sentence={state === "error" ? STRINGS.empty.conflictsError : STRINGS.empty.conflicts} command={STRINGS.empty.conflictsCommand} onRetry={onRetry} error={error} telemetryArea="dashboard.conflict-ledger" />;
  }
  if (!visible.length) return <EmptyState sentence={STRINGS.empty.conflicts} command={STRINGS.empty.conflictsCommand} />;

  return (
    <div class="ledger-scroll" data-visual-fixture="conflict-ledger">
      <table class="ledger-table conflict-ledger">
        <caption class="sr-only">{STRINGS.conflictLedger.caption}</caption>
        <thead><tr><th scope="col">{STRINGS.conflictColumns.when}</th><th scope="col">{STRINGS.conflictColumns.module}</th><th scope="col">{STRINGS.conflictColumns.brick}</th><th scope="col">{STRINGS.conflictColumns.agents}</th><th scope="col">{STRINGS.conflictColumns.resolution}</th></tr></thead>
        <tbody>{visible.map((conflict) => {
          const open = conflict.status === "open";
          return (
            <tr class={open ? "conflict-row conflict-row--open" : "conflict-row"} key={conflict.event_id}>
              <td class="conflict-row__when" data-label={STRINGS.conflictColumns.when}><time dateTime={conflict.timestamp} title={new Date(conflict.timestamp).toISOString()}>{relativeConflictTime(conflict.timestamp)}</time></td>
              <td class="conflict-row__what" data-label={STRINGS.mobileColumns.what}>{conflict.project}</td><td class="conflict-row__brick">{conflict.brick_id}</td>
              <td class="conflict-row__who" data-label={STRINGS.mobileColumns.who}>{conflict.agents.join(STRINGS.agentSeparator) || STRINGS.unknown}</td>
              <td class="conflict-row__state" data-label={STRINGS.conflictColumns.resolution}><VerdictStamp verdict={open ? "fail" : "pass"} label={open ? STRINGS.verdicts.open : STRINGS.verdicts.resolved} /></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
