import { useState } from "preact/hooks";
import { memo } from "preact/compat";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { brickCloneCommand, brickGates, brickOwners, brickTrust, type BrickRecord } from "./brick-model";
import { VerdictStamp } from "./verdict-stamp";

export type BrickCardState = "populated" | "loading" | "empty" | "error";

type BrickCardProps = {
  brick?: BrickRecord | null;
  state?: BrickCardState;
};

/**
 * Full brick record card for detail surfaces. It renders provenance, trust,
 * gate verdicts, and a copyable clone command without fetching its own data.
 */
export const BrickCard = memo(function BrickCard({ brick, state = brick ? "populated" : "empty" }: BrickCardProps) {
  const [copied, setCopied] = useState(false);

  if (state === "loading") return <p class="loading" aria-live="polite">{STRINGS.brickCard.loading}</p>;
  if (state === "error") return <p class="component-error" role="alert">{STRINGS.brickCard.error}</p>;
  if (state === "empty" || !brick) return <p class="component-empty">{STRINGS.brickCard.empty}</p>;

  const trust = brickTrust(brick.status);
  const command = brickCloneCommand(brick);
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      reportClientError("ui.brick-card.copy", "error", error);
    }
  };

  return (
    <article class="brick-card" aria-labelledby={`brick-card-${brick.id}`}>
      <header class="brick-card__header">
        <div><p>{STRINGS.brickCard.idLabel}</p><h2 id={`brick-card-${brick.id}`}>{brick.id}</h2></div>
        <span class={`trust-stamp trust-stamp--${trust}`}><span aria-hidden="true">{STRINGS.trustIcons[trust]}</span>{STRINGS.trust[trust]}</span>
      </header>
      <section class="brick-card__section" aria-labelledby={`brick-owner-${brick.id}`}>
        <h3 id={`brick-owner-${brick.id}`}>{STRINGS.brickCard.ownerTrail}</h3>
        <ol class="provenance-ribbon">{brickOwners(brick).map((owner) => <li key={owner}>{owner}</li>)}</ol>
      </section>
      <section class="brick-card__section" aria-labelledby={`brick-gates-${brick.id}`}>
        <h3 id={`brick-gates-${brick.id}`}>{STRINGS.brickCard.gates}</h3>
        <table class="gates-table">
          <thead><tr><th scope="col">{STRINGS.brickCard.gate}</th><th scope="col">{STRINGS.brickCard.verdict}</th></tr></thead>
          <tbody>{brickGates(brick).map((gate) => <tr key={gate.id}><th scope="row">{gate.label || STRINGS.brickCard.health}</th><td><VerdictStamp verdict={gate.verdict} /></td></tr>)}</tbody>
        </table>
      </section>
      <section class="brick-card__section" aria-labelledby={`brick-clone-${brick.id}`}>
        <h3 id={`brick-clone-${brick.id}`}>{STRINGS.brickCard.clone}</h3>
        <div class="copy-block"><code>{command}</code><button type="button" onClick={() => void copyCommand()}>{copied ? STRINGS.copied : STRINGS.copy}</button></div>
      </section>
    </article>
  );
});
