import { memo } from "preact/compat";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { VerdictStamp, type Verdict } from "./verdict-stamp";

interface ToastMessage {
  id: string;
  message: string;
  verdict?: Verdict;
  error?: Error;
}

export interface ToastCenterProps {
  toasts: readonly ToastMessage[];
  onDismiss?: (id: string) => void;
  dismissAfterMs?: number;
}

const MAX_TOASTS = 3;

/**
 * Polite bottom-right notification ledger. It displays at most three entries,
 * dismisses each after six seconds, and pauses the timer while hovered/focused.
 */
export const ToastCenter = memo(function ToastCenter({ toasts, onDismiss, dismissAfterMs = 6_000 }: ToastCenterProps) {
  const toastKey = toasts.map((toast) => `${toast.id}:${toast.verdict ?? "pass"}:${toast.message}`).join("|");
  const incoming = useMemo(() => toasts.slice(-MAX_TOASTS), [toastKey]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [paused, setPaused] = useState(false);
  const visible = incoming.filter((toast) => !dismissed.has(toast.id));

  const dismiss = useCallback((id: string) => {
    setDismissed((current) => new Set(current).add(id));
    onDismiss?.(id);
  }, [onDismiss]);

  useEffect(() => {
    const activeIds = new Set(incoming.map((toast) => toast.id));
    setDismissed((current) => {
      const next = new Set([...current].filter((id) => activeIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [incoming]);

  useEffect(() => {
    for (const toast of incoming) {
      if (toast.verdict === "fail") {
        reportClientError("dashboard.toast-center", "error", toast.error ?? new Error(toast.message));
      }
    }
  }, [incoming]);

  useEffect(() => {
    if (paused || visible.length === 0) return;
    const timers = visible.map((toast) => window.setTimeout(() => { dismiss(toast.id); }, dismissAfterMs));
    return () => { timers.forEach((timer) => { clearTimeout(timer); }); };
  }, [dismiss, dismissAfterMs, paused, visible]);

  if (visible.length === 0) return null;
  return (
    <aside
      class="toast-center"
      aria-label={STRINGS.toast.centerLabel}
      aria-live="polite"
      aria-atomic="false"
      onMouseEnter={() => { setPaused(true); }}
      onMouseLeave={() => { setPaused(false); }}
      onFocusIn={() => { setPaused(true); }}
      onFocusOut={() => { setPaused(false); }}
    >
      {visible.map((toast) => {
        const verdict = toast.verdict ?? "pass";
        return (
          <div class={`toast-line toast-line--${verdict}`} role="status" key={toast.id}>
            <VerdictStamp verdict={verdict} />
            <p>{toast.message}</p>
            <button type="button" aria-label={STRINGS.toast.dismiss} onClick={() => { dismiss(toast.id); }}>×</button>
          </div>
        );
      })}
    </aside>
  );
});
