import { memo } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";

interface StatsTileValues {
  bricks: number;
  canonical: number;
  leases: number;
  conflicts: number;
}

type StatsTilesState = "loading" | "empty" | "error" | "populated";
const CHOREOGRAPHY_KEY = "smarch-stats-stamped";

export interface StatsTilesProps {
  values?: StatsTileValues;
  state?: StatsTilesState;
  error?: Error;
  onRetry?: () => void;
}

function formatStatValue(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

/**
 * Four-tile portfolio summary. Callers may explicitly select loading, empty,
 * error, or populated states; omitted state is inferred from `values`.
 */
export const StatsTiles = memo(function StatsTiles({ values, state, error, onRetry }: StatsTilesProps) {
  const resolvedState = state ?? (values ? "populated" : "empty");
  const [stampIn, setStampIn] = useState(false);

  useEffect(() => {
    if (resolvedState === "error") {
      reportClientError("dashboard.stats-tiles", "error", error ?? new Error(STRINGS.statsStates.error));
    }
  }, [error, resolvedState]);

  useEffect(() => {
    if (resolvedState !== "populated") return;
    try {
      if (window.sessionStorage.getItem(CHOREOGRAPHY_KEY)) return;
      window.sessionStorage.setItem(CHOREOGRAPHY_KEY, "1");
      setStampIn(true);
    } catch {
      setStampIn(true);
    }
  }, [resolvedState]);

  if (resolvedState === "loading") {
    return <p class="stats-tiles__message" role="status" aria-live="polite">{STRINGS.loading}</p>;
  }
  if (resolvedState === "error") {
    return (
      <div class="stats-tiles__message stats-tiles__message--error" role="alert">
        <span>{STRINGS.statsStates.error}</span>
        {onRetry ? <button type="button" onClick={onRetry}>{STRINGS.errors.retry}</button> : null}
      </div>
    );
  }
  if (resolvedState === "empty" || !values) {
    return <p class="stats-tiles__message" role="status">{STRINGS.statsStates.empty}</p>;
  }

  const tiles = [
    { key: "bricks", label: STRINGS.stats.bricks, value: values.bricks },
    { key: "canonical", label: STRINGS.stats.canonical, value: values.canonical },
    { key: "leases", label: STRINGS.stats.leases, value: values.leases },
    { key: "conflicts", label: STRINGS.stats.conflicts, value: values.conflicts }
  ] as const;

  return (
    <dl class={`stats-tiles${stampIn ? " stats-tiles--stamp-in" : ""}`} aria-label={STRINGS.statsStates.label}>
      {tiles.map((tile, index) => (
        <div class={`stats-tile stats-tile--${String(index + 1)}`} key={tile.key}>
          <dt>{tile.label}</dt>
          <dd>{formatStatValue(tile.value)}</dd>
        </div>
      ))}
    </dl>
  );
});
