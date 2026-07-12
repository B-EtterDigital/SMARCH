import { useMemo } from "preact/hooks";
import type { Conflict } from "../schema-types";
import { STRINGS } from "../strings";
import { EmptyState, type SurfaceState } from "./empty-states";

interface HeatStripDay { date: string; count: number; today: boolean }
export interface HeatStripRow { module: string; days: HeatStripDay[]; total: number }

export interface ConflictHeatStripProps {
  conflicts: Conflict[];
  selectedModule?: string | null;
  state?: "populated" | SurfaceState;
  onSelectModule: (module: string | null) => void;
  now?: Date;
  error?: unknown;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildConflictHeatRows(conflicts: Conflict[], now = new Date()): HeatStripRow[] {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const keys = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (29 - index));
    return dateKey(date);
  });
  const modules = [...new Set(conflicts.map((conflict) => conflict.project))].sort();
  return modules.map((module) => {
    const counts = new Map<string, number>();
    for (const conflict of conflicts) {
      if (conflict.project !== module) continue;
      const key = dateKey(new Date(conflict.timestamp));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const days = keys.map((date) => ({ date, count: counts.get(date) ?? 0, today: date === dateKey(today) }));
    return { module, days, total: days.reduce((sum, day) => sum + day.count, 0) };
  });
}

/** Thirty-day conflict activity by module. Selecting a row filters the ledger. */
export function ConflictHeatStrip({ conflicts, selectedModule = null, state = "populated", onSelectModule, now, error }: ConflictHeatStripProps) {
  const rows = useMemo(() => buildConflictHeatRows(conflicts, now), [conflicts, now]);
  const max = Math.max(1, ...rows.flatMap((row) => row.days.map((day) => day.count)));

  if (state !== "populated") return <EmptyState state={state} sentence={STRINGS.empty.heatStrip} command={STRINGS.empty.conflictsCommand} error={error} telemetryArea="dashboard.conflict-heat-strip" />;
  if (!rows.length) return <EmptyState sentence={STRINGS.empty.heatStrip} command={STRINGS.empty.conflictsCommand} />;

  return (
    <div class="heat-strip" data-visual-fixture="conflict-heat-strip">
      <div class="heat-strip__axis" aria-hidden="true"><span>{STRINGS.heatStrip.thirtyDaysAgo}</span><span>{STRINGS.heatStrip.today}</span></div>
      {rows.map((row) => {
        const selected = selectedModule === row.module;
        return (
          <button class="heat-strip__row" type="button" aria-pressed={selected} onClick={() => { onSelectModule(selected ? null : row.module); }} key={row.module}>
            <span class="heat-strip__module">{row.module}</span>
            <span class="heat-strip__bars" aria-hidden="true">{row.days.map((day) => {
              const heat = day.count / max;
              return <span class={day.today ? "heat-strip__bar heat-strip__bar--today" : "heat-strip__bar"} style={{ "--heat-height": `${String(Math.max(2, 4 + heat * 18))}px`, "--heat-percent": `${String(Math.round((0.12 + heat * 0.88) * 100))}%` }} key={day.date} />;
            })}</span>
            <span class="sr-only">{STRINGS.heatStrip.summary(row.module, row.total)}</span>
            <span class="heat-strip__total" aria-hidden="true">{row.total}</span>
          </button>
        );
      })}
    </div>
  );
}
