import { useEffect, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";

export type SurfaceState = "loading" | "empty" | "error";

export interface EmptyStateProps {
  state?: SurfaceState;
  sentence: string;
  command: string;
  onRetry?: () => void;
  error?: unknown;
  telemetryArea?: string;
}

/** Warm, actionable fallback for loading, empty, and error surfaces. */
export function EmptyState({ state = "empty", sentence, command, onRetry, error, telemetryArea = "dashboard.empty-state" }: EmptyStateProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state === "error") reportClientError(telemetryArea, "error", error ?? new Error(sentence));
  }, [error, sentence, state, telemetryArea]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      reportClientError(`${telemetryArea}.copy`, "error", error);
    }
  };

  return (
    <div class={`empty-state empty-state--${state}`} role={state === "error" ? "alert" : "status"} aria-live="polite">
      <p>{state === "loading" ? STRINGS.loading : sentence}</p>
      <div class="copy-block">
        <code>{command}</code>
        <button type="button" onClick={() => void copy()} aria-label={STRINGS.copy}>{copied ? STRINGS.copied : STRINGS.copy}</button>
      </div>
      {state === "error" && onRetry ? <button class="empty-state__retry" type="button" onClick={onRetry}>{STRINGS.errors.retry}</button> : null}
    </div>
  );
}
