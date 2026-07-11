import { memo } from "preact/compat";
import { STRINGS } from "../strings";

export type Verdict = "pass" | "fail" | "waived";

export interface VerdictStampProps {
  verdict: Verdict;
  label?: string;
  className?: string;
}

const ICONS: Record<Verdict, string> = {
  pass: STRINGS.verdictIcons.pass,
  fail: STRINGS.verdictIcons.fail,
  waived: STRINGS.verdictIcons.waived
};

/**
 * Compact, non-interactive audit verdict. Every state is conveyed by an icon,
 * an uppercase label, and a matching border so color is never the sole cue.
 */
export const VerdictStamp = memo(function VerdictStamp({ verdict, label, className = "" }: VerdictStampProps) {
  const visibleLabel = label ?? STRINGS.verdicts[verdict];
  return (
    <span class={`verdict-stamp verdict-stamp--${verdict} ${className}`.trim()} data-verdict={verdict}>
      <span class="verdict-stamp__icon" aria-hidden="true">{ICONS[verdict]}</span>
      <span>{visibleLabel}</span>
    </span>
  );
});
