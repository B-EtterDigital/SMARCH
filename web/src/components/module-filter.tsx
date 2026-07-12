import { useEffect, useMemo, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";

export interface ModuleFilterProps {
  modules: string[];
  selected?: string[];
  paramName?: string;
  status?: "loading" | "ready" | "error";
  error?: unknown;
  onChange?: (selected: string[]) => void;
}

export function readModuleSelection(paramName = "module", search = location.search): string[] {
  return [...new Set(new URLSearchParams(search).getAll(paramName).filter(Boolean))];
}

export function writeModuleSelection(selected: string[], paramName = "module"): void {
  const url = new URL(location.href);
  url.searchParams.delete(paramName);
  for (const module of selected) url.searchParams.append(paramName, module);
  history.replaceState(history.state, "", url);
}

/** Multi-select module chips whose current selection is reflected in URL params. */
export function ModuleFilter({
  modules,
  selected,
  paramName = "module",
  status = "ready",
  error,
  onChange
}: ModuleFilterProps) {
  const available = useMemo(() => [...new Set(modules)].sort((left, right) => left.localeCompare(right)), [modules]);
  const [internal, setInternal] = useState<string[]>(() => selected ?? readModuleSelection(paramName));
  const current = selected ?? internal;
  const controlledSelectionKey = selected?.join("\u0000");

  useEffect(() => {
    if (status === "error") reportClientError("dashboard.module-filter", "error", error ?? STRINGS.filter.error);
  }, [error, status]);

  useEffect(() => {
    if (selected === undefined) return;
    try {
      writeModuleSelection(selected, paramName);
    } catch (value) {
      reportClientError("dashboard.module-filter.url", "error", value);
    }
  }, [controlledSelectionKey, paramName]);

  const update = (next: string[]) => {
    if (selected === undefined) setInternal(next);
    try {
      writeModuleSelection(next, paramName);
    } catch (value) {
      reportClientError("dashboard.module-filter.url", "error", value);
    }
    onChange?.(next);
  };

  const toggle = (module: string) => {
    const next = current.includes(module) ? current.filter((item) => item !== module) : [...current, module];
    update(next);
  };

  if (status === "loading") return <p class="loading" aria-live="polite">{STRINGS.filter.loading}</p>;
  if (status === "error") return <p class="component-error" role="alert">{STRINGS.filter.error}</p>;
  if (available.length === 0) return <p class="empty-state__sentence">{STRINGS.filter.empty}</p>;

  return (
    <div class="module-filter" aria-label={STRINGS.filter.label} role="group">
      <button type="button" aria-pressed={current.length === 0} onClick={() => { update([]); }}>{STRINGS.filter.all}</button>
      {available.map((module) => (
        <button type="button" aria-pressed={current.includes(module)} onClick={() => { toggle(module); }} key={module}>{module}</button>
      ))}
    </div>
  );
}
