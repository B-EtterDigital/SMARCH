import { useEffect, useRef } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import "./dashboard-components.css";

export type SealStatus = "pass" | "fail" | "waived" | "active";

export interface SealChipProps {
  status?: SealStatus;
  label?: string;
  broken?: boolean;
  loading?: boolean;
  error?: Error | null;
}

const ICONS: Record<SealStatus, string> = { pass: "✓", fail: "×", waived: "–", active: "✓" };

/** Compact provenance verdict. Color is always paired with an icon and explicit label. */
export function SealChip({ status = "pass", label, broken = false, loading = false, error = null }: SealChipProps) {
  const reported = useRef<Error | null>(null);
  const effectiveStatus: SealStatus = broken || error ? "fail" : status;
  const text = loading
    ? STRINGS.components.sealChip.loading
    : error
      ? STRINGS.components.sealChip.error
      : broken
        ? STRINGS.components.sealChip.broken
        : label ?? STRINGS.components.sealChip.labels[effectiveStatus];

  useEffect(() => {
    if (error && reported.current !== error) {
      reported.current = error;
      reportClientError("dashboard.seal-chip", "error", error);
    }
  }, [error]);

  return (
    <span class={`seal-chip seal-chip--${effectiveStatus}${broken ? " seal-chip--broken" : ""}`} role="status" aria-live={loading ? "polite" : "off"}>
      {broken ? <span class="seal-chip__chain" aria-hidden="true"><span class="seal-chip__link" /><span class="seal-chip__break" /><span class="seal-chip__link" /></span> : null}
      <span aria-hidden="true">{loading ? "…" : ICONS[effectiveStatus]}</span>
      <span>{text}</span>
    </span>
  );
}
