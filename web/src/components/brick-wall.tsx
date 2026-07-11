import { memo } from "preact/compat";
import { useCallback, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { BrickDetail } from "./brick-detail";
import { brickSize, brickTrust, type BrickRecord } from "./brick-model";

export type BrickWallState = "populated" | "loading" | "empty" | "error";

type BrickWallProps = {
  bricks: BrickRecord[];
  onRetry?: () => void;
  state?: BrickWallState;
};

const BrickTile = memo(function BrickTile({ brick, onSelect }: { brick: BrickRecord; onSelect: (brick: BrickRecord) => void }) {
  const trust = brickTrust(brick.status);
  const size = brickSize(brick.reuse_count);
  return (
    <button
      type="button"
      role="listitem"
      class={`brick brick--${trust} brick--${size}`}
      onClick={() => onSelect(brick)}
      title={brick.id}
      aria-label={STRINGS.brickWall.openDetail(brick.id)}
    >
      <span class="brick__identity"><span>{brick.project}</span><strong>{brick.id}</strong></span>
      <span class={`trust-stamp trust-stamp--${trust}`}><span aria-hidden="true">{STRINGS.trustIcons[trust]}</span>{STRINGS.trust[trust]}</span>
      <span class="brick__reuse">{STRINGS.brickWall.reuseCount(brick.reuse_count ?? 0)}</span>
    </button>
  );
});

/**
 * Responsive 2:1 masonry wall. Reuse count controls S/M/L spans, trust controls
 * elevation treatment, and each keyboard-reachable brick opens BrickDetail.
 */
export function BrickWall({ bricks, onRetry, state = bricks.length ? "populated" : "empty" }: BrickWallProps) {
  const [selected, setSelected] = useState<BrickRecord | null>(null);

  if (state === "loading") return <p class="loading" aria-live="polite">{STRINGS.brickWall.loading}</p>;
  if (state === "error") return <div class="component-error" role="alert"><p>{STRINGS.brickWall.error}</p>{onRetry ? <button type="button" onClick={onRetry}>{STRINGS.errors.retry}</button> : null}</div>;
  if (state === "empty" || !bricks.length) return <p class="component-empty">{STRINGS.brickWall.empty}</p>;

  const openBrick = useCallback((brick: BrickRecord) => {
    try {
      setSelected(brick);
    } catch (error) {
      reportClientError("ui.brick-wall.select", "error", error);
    }
  }, []);

  return (
    <>
      <div class="brick-wall" role="list" aria-label={STRINGS.brickWall.label}>
        {bricks.map((brick) => <BrickTile brick={brick} onSelect={openBrick} key={`${brick.project}:${brick.id}`} />)}
      </div>
      <BrickDetail brick={selected} open={selected !== null} onClose={() => setSelected(null)} />
    </>
  );
}
