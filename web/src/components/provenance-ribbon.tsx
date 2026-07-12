/* eslint-disable @typescript-eslint/restrict-template-expressions -- Provenance counters intentionally retain their current primitive display formatting. */
/* eslint-disable max-lines-per-function -- The component owns one small loading-to-result state machine; keeping it together prevents duplicated transition logic. */
import { useEffect, useMemo, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";

export interface ProvenanceSeal {
  hash: string;
  attestation: unknown;
}

export interface ProvenanceRibbonProps {
  seals?: ProvenanceSeal[];
  status?: "loading" | "ready" | "error";
  error?: unknown;
  onRetry?: () => void;
}

export function hashPrefix(hash: string): string {
  return hash.replace(/^sha(?:256|512):/i, "").slice(0, 6).toLowerCase();
}

/**
 * Ordered provenance seals. Each keyboard-reachable seal reveals its complete
 * attestation JSON and exposes an explicit copy action.
 */
export function ProvenanceRibbon({ seals = [], status = "ready", error, onRetry }: ProvenanceRibbonProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const json = useMemo(() => seals.map((seal) => JSON.stringify(seal.attestation, null, 2)), [seals]);

  useEffect(() => {
    if (status === "error") reportClientError("dashboard.provenance-ribbon", "error", error ?? STRINGS.provenance.error);
  }, [error, status]);

  const copy = async (index: number) => {
    try {
      await navigator.clipboard.writeText(json[index] ?? "");
      setCopied(index);
    } catch (value) {
      reportClientError("dashboard.provenance-ribbon.copy", "error", value);
    }
  };

  if (status === "loading") return <p class="loading" aria-live="polite">{STRINGS.provenance.loading}</p>;
  if (status === "error") {
    return (
      <div class="component-error" role="alert">
        <p>{STRINGS.provenance.error}</p>
        {onRetry ? <button type="button" onClick={onRetry}>{STRINGS.provenance.retry}</button> : null}
      </div>
    );
  }
  if (seals.length === 0) return <p class="empty-state__sentence">{STRINGS.provenance.empty}</p>;

  return (
    <div class="provenance-ribbon" aria-label={STRINGS.provenance.label}>
      {seals.map((seal, index) => {
        const popoverId = `provenance-attestation-${index}`;
        const expanded = open === index;
        return (
          <div
            class="provenance-ribbon__item"
            onMouseEnter={() => { setOpen(index); }}
            onMouseLeave={() => { setOpen(null); }}
            onFocusIn={() => { setOpen(index); }}
            onFocusOut={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null);
            }}
            key={`${seal.hash}:${index}`}
          >
            <button
              type="button"
              class="provenance-seal"
              aria-label={`${STRINGS.provenance.sealLabel} ${hashPrefix(seal.hash)}`}
              aria-expanded={expanded}
              aria-controls={popoverId}
              onClick={() => { setOpen(expanded ? null : index); }}
            >
              {hashPrefix(seal.hash)}
            </button>
            {expanded ? (
              <div class="provenance-popover" id={popoverId} role="dialog" aria-label={STRINGS.provenance.attestationLabel}>
                <pre>{json[index]}</pre>
                <button type="button" onClick={() => void copy(index)}>{copied === index ? STRINGS.provenance.copied : STRINGS.provenance.copy}</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
