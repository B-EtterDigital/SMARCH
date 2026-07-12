import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import type { RegistryBrick } from "../schema-types";
import { STRINGS } from "../strings";
import { SealChip } from "./seal-chip";
import "./dashboard-components.css";

type SortKey = "id" | "project" | "status" | "score";
type SortDirection = "ascending" | "descending";

export interface RegistryTableProps {
  rows: readonly RegistryBrick[];
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  initialSort?: SortKey;
}

const ROW_HEIGHT = 40;
const VIRTUALIZE_AFTER = 500;
const WINDOW_ROWS = 18;

export function sortRegistryRows(rows: readonly RegistryBrick[], key: SortKey, direction: SortDirection): RegistryBrick[] {
  const factor = direction === "ascending" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left[key];
    const b = right[key];
    return (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))) * factor;
  });
}

/** Sortable registry ledger. It virtualizes its body after 500 rows while preserving table semantics. */
export function RegistryTable({ rows, loading = false, error = null, onRetry, initialSort = "id" }: RegistryTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>(initialSort);
  const [direction, setDirection] = useState<SortDirection>("ascending");
  const [scrollTop, setScrollTop] = useState(0);
  const reported = useRef<Error | null>(null);
  const sorted = useMemo(() => sortRegistryRows(rows, sortKey, direction), [rows, sortKey, direction]);
  const virtual = sorted.length > VIRTUALIZE_AFTER;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3) : 0;
  const end = virtual ? Math.min(sorted.length, start + WINDOW_ROWS + 6) : sorted.length;
  const visible = virtual ? sorted.slice(start, end) : sorted;

  useEffect(() => {
    if (error && reported.current !== error) {
      reported.current = error;
      reportClientError("dashboard.registry-table", "error", error);
    }
  }, [error]);

  const sort = (key: SortKey) => {
    if (sortKey === key) setDirection((value) => value === "ascending" ? "descending" : "ascending");
    else { setSortKey(key); setDirection("ascending"); }
  };

  if (loading) return <div class="component-state" role="status" aria-live="polite">{STRINGS.components.registryTable.loading}</div>;
  if (error) return <div class="component-state component-state--error" role="alert"><span>{STRINGS.components.registryTable.error}</span>{onRetry ? <button type="button" onClick={onRetry}>{STRINGS.components.registryTable.retry}</button> : null}</div>;
  if (rows.length === 0) return <div class="component-state" role="status">{STRINGS.components.registryTable.empty}</div>;

  const headers: [SortKey, string][] = [
    ["id", STRINGS.components.registryTable.columns.brick], ["project", STRINGS.components.registryTable.columns.project],
    ["status", STRINGS.components.registryTable.columns.status], ["score", STRINGS.components.registryTable.columns.score]
  ];

  return (
    <div class="registry-table__scroller" onScroll={(event) => { if (virtual) setScrollTop(event.currentTarget.scrollTop); }}>
      <table class="registry-table">
        <caption>{`${STRINGS.components.registryTable.caption}: ${String(rows.length)} ${STRINGS.components.registryTable.rowCount}`}</caption>
        <thead><tr>{headers.map(([key, title]) => <th scope="col" aria-sort={sortKey === key ? direction : "none"} key={key}><button type="button" onClick={() => { sort(key); }} aria-label={`${title}: ${sortKey === key && direction === "ascending" ? STRINGS.components.registryTable.sortDescending : STRINGS.components.registryTable.sortAscending}`}><span>{title}</span><span aria-hidden="true">{sortKey === key ? direction === "ascending" ? "↑" : "↓" : "↕"}</span></button></th>)}</tr></thead>
        <tbody>
          {virtual && start > 0 ? <tr class="registry-table__spacer" aria-hidden="true" style={{ "--registry-spacer-height": `${String(start * ROW_HEIGHT)}px` }}><td colSpan={4} /></tr> : null}
          {visible.map((row) => <tr class="registry-table__row" key={`${row.project}:${row.id}`}><td title={row.id}>{row.id}</td><td title={row.project}>{row.project}</td><td><SealChip status={row.health_status === "ok" ? "pass" : "fail"} label={row.status.toUpperCase()} /></td><td class="registry-table__score">{row.score.toLocaleString()}</td></tr>)}
          {virtual && end < sorted.length ? <tr class="registry-table__spacer" aria-hidden="true" style={{ "--registry-spacer-height": `${String((sorted.length - end) * ROW_HEIGHT)}px` }}><td colSpan={4} /></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
