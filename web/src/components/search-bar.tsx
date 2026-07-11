import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import "./dashboard-components.css";

export type SearchResultKind = "brick" | "module" | "lease";
export interface SearchResult { id: string; kind: SearchResultKind; label: string; detail?: string; }
export interface SearchBarProps {
  results: readonly SearchResult[];
  value?: string;
  loading?: boolean;
  error?: Error | null;
  onQueryChange?: (query: string) => void;
  onSelect?: (result: SearchResult) => void;
  onRetry?: () => void;
}

const KINDS: readonly SearchResultKind[] = ["brick", "module", "lease"];

export function filterSearchResults(results: readonly SearchResult[], query: string): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...results];
  return results.filter((result) => `${result.label} ${result.detail ?? ""}`.toLocaleLowerCase().includes(needle));
}

/** Full-width command search with grouped ARIA listbox results and complete keyboard navigation. */
export function SearchBar({ results, value, loading = false, error = null, onQueryChange, onSelect, onRetry }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const reported = useRef<Error | null>(null);
  const listboxId = useId();
  const [internalValue, setInternalValue] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = value ?? internalValue;
  const filtered = useMemo(() => filterSearchResults(results, query), [results, query]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && document.activeElement !== inputRef.current) {
        event.preventDefault(); inputRef.current?.focus(); setOpen(true);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  useEffect(() => {
    if (error && reported.current !== error) { reported.current = error; reportClientError("dashboard.search-bar", "error", error); }
  }, [error]);

  const setQuery = (next: string) => { if (value === undefined) setInternalValue(next); onQueryChange?.(next); setActiveIndex(-1); setOpen(true); };
  const choose = (index: number) => { const result = filtered[index]; if (!result) return; onSelect?.(result); setQuery(result.label); setOpen(false); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(filtered.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
    else if (event.key === "Enter" && activeIndex >= 0) { event.preventDefault(); choose(activeIndex); }
    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); setActiveIndex(-1); }
  };

  return (
    <div class="search-bar">
      <label class="search-bar__field"><span class="visually-hidden">{STRINGS.components.searchBar.label}</span><input ref={inputRef} type="search" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId} aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined} value={query} placeholder={STRINGS.components.searchBar.placeholder} onFocus={() => setOpen(true)} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={onKeyDown} /><kbd title={STRINGS.components.searchBar.shortcutHint}>{STRINGS.components.searchBar.shortcut}</kbd></label>
      {open ? <div id={listboxId} class="search-bar__results" role="listbox" aria-label={STRINGS.components.searchBar.results}>
        {loading ? <p class="search-bar__message" role="status">{STRINGS.components.searchBar.loading}</p> : error ? <p class="search-bar__message search-bar__message--error" role="alert">{STRINGS.components.searchBar.error}{onRetry ? <button type="button" onClick={onRetry}>{STRINGS.components.searchBar.retry}</button> : null}</p> : filtered.length === 0 ? <p class="search-bar__message" role="status">{STRINGS.components.searchBar.empty}</p> : KINDS.map((kind) => {
          const group = filtered.map((result, index) => ({ result, index })).filter(({ result }) => result.kind === kind);
          return group.length ? <div class="search-bar__group" role="group" aria-label={STRINGS.components.searchBar.kinds[kind]} key={kind}><p class="search-bar__group-label">{STRINGS.components.searchBar.kinds[kind]}</p>{group.map(({ result, index }) => <button id={`${listboxId}-${index}`} type="button" role="option" class="search-bar__option" aria-selected={activeIndex === index} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)} key={`${result.kind}:${result.id}`}><span>{result.label}</span><small>{result.detail}</small></button>)}</div> : null;
        })}
      </div> : null}
    </div>
  );
}
