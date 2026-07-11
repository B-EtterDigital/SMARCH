import { useEffect, useRef } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { SealChip } from "./seal-chip";
import "./dashboard-components.css";

export type DashboardTheme = "dark" | "light";
export interface SettingsPanelProps {
  theme: DashboardTheme;
  sseEndpoint: string;
  dataRootPath: string;
  loading?: boolean;
  error?: Error | null;
  onThemeChange: (theme: DashboardTheme) => void;
  onRetry?: () => void;
}

/** Read-only connection facts and the only client-owned preference: dashboard theme. */
export function SettingsPanel({ theme, sseEndpoint, dataRootPath, loading = false, error = null, onThemeChange, onRetry }: SettingsPanelProps) {
  const reported = useRef<Error | null>(null);
  useEffect(() => {
    if (error && reported.current !== error) { reported.current = error; reportClientError("dashboard.settings-panel", "error", error); }
  }, [error]);
  if (loading) return <div class="component-state" role="status" aria-live="polite">{STRINGS.components.settingsPanel.loading}</div>;
  if (error) return <div class="component-state component-state--error" role="alert"><span>{STRINGS.components.settingsPanel.error}</span>{onRetry ? <button type="button" onClick={onRetry}>{STRINGS.components.settingsPanel.retry}</button> : null}</div>;
  return (
    <section class="settings-panel" aria-labelledby="settings-panel-heading">
      <header class="settings-panel__header"><h2 id="settings-panel-heading">{STRINGS.components.settingsPanel.heading}</h2></header>
      <div class="settings-panel__grid">
        <section class="settings-panel__section"><h3>{STRINGS.components.settingsPanel.appearance}</h3><div class="settings-panel__theme"><button type="button" aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}>{STRINGS.components.settingsPanel.dark}</button><button type="button" aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}>{STRINGS.components.settingsPanel.light}</button></div></section>
        <section class="settings-panel__section"><h3>{STRINGS.components.settingsPanel.endpoint}</h3><output aria-label={STRINGS.components.settingsPanel.endpoint}>{sseEndpoint}</output></section>
        <section class="settings-panel__section"><h3>{STRINGS.components.settingsPanel.dataRoot}</h3><output aria-label={STRINGS.components.settingsPanel.dataRoot}>{dataRootPath}</output></section>
        <section class="settings-panel__section"><h3>{STRINGS.components.settingsPanel.readOnly}</h3><div class="settings-panel__policy"><SealChip status="pass" label={STRINGS.components.settingsPanel.readOnly} /><p>{STRINGS.components.settingsPanel.readOnlyDescription}</p></div></section>
      </div>
    </section>
  );
}
