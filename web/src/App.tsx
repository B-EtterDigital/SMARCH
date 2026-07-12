import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ConflictHeatStrip } from "./components/conflict-heat-strip";
import { ConflictLedger } from "./components/conflict-ledger";
import { EmptyState } from "./components/empty-states";
import { GraphView } from "./components/graph-view";
import { LeaseBoard } from "./components/lease-board";
import { fetchSnapshot, reportClientError, subscribeToDashboardEvents } from "./lib/api";
import { countConflicts30d } from "./lib/conflict-count";
import type { DashboardSnapshot, RegistryBrick } from "./schema-types";
import { STRINGS } from "./strings";
import { StatsTiles } from "./components/stats-tiles";
import { resolveInitialTheme, ThemeToggle, type Theme } from "./components/theme-toggle";
import { ToastCenter } from "./components/toast-center";
import { VerdictStamp } from "./components/verdict-stamp";

type RouteKey = keyof typeof STRINGS.routeTitles;

const ROUTES: { key: RouteKey; path: string; mark: string }[] = [
  { key: "ledger", path: "/", mark: STRINGS.navMarks.ledger },
  { key: "bricks", path: "/bricks", mark: STRINGS.navMarks.bricks },
  { key: "leases", path: "/leases", mark: STRINGS.navMarks.leases },
  { key: "conflicts", path: "/conflicts", mark: STRINGS.navMarks.conflicts },
  { key: "graph", path: "/graph", mark: STRINGS.navMarks.graph },
  { key: "settings", path: "/settings", mark: STRINGS.navMarks.settings }
];

function routeFromPath(pathname: string): RouteKey {
  return ROUTES.find((route) => route.path === pathname)?.key ?? "ledger";
}

function Verdict({ kind, label }: { kind: "pass" | "fail" | "waived" | "active"; label: string }) {
  return <VerdictStamp verdict={kind === "active" ? "pass" : kind} label={label} className={kind === "active" ? "verdict-stamp--active" : ""} />;
}

function Frame({ title, children, className = "" }: { title: string; children: ComponentChildren; className?: string }) {
  return (
    <section class={`frame ${className}`}>
      <div class="corner corner--tl" aria-hidden="true" />
      <div class="corner corner--br" aria-hidden="true" />
      <header class="frame__header"><h2>{title}</h2><span class="frame__rule" /></header>
      {children}
    </section>
  );
}

function Stats({ snapshot }: { snapshot: DashboardSnapshot }) {
  return <StatsTiles values={{ bricks: snapshot.registry.summary.bricks, canonical: snapshot.registry.summary.canonical, leases: snapshot.leases.stats.active, conflicts: countConflicts30d(snapshot.conflicts) }} />;
}

function BrickRegistry({ bricks }: { bricks: RegistryBrick[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>(STRINGS.filter.all);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => { removeEventListener("keydown", onKey); };
  }, []);
  const projects = useMemo(() => [STRINGS.filter.all, ...new Set(bricks.map((brick) => brick.project))], [bricks]);
  const filtered = useMemo(() => bricks.filter((brick) => {
    const projectMatches = project === STRINGS.filter.all || brick.project === project;
    const queryMatches = `${brick.id} ${brick.project}`.toLowerCase().includes(query.toLowerCase());
    return projectMatches && queryMatches;
  }), [bricks, project, query]);
  return (
    <>
      <div class="search-row">
        <label><span>{STRINGS.search.label}</span><input ref={inputRef} type="search" value={query} placeholder={STRINGS.search.placeholder} onInput={(event) => { setQuery(event.currentTarget.value); }} /></label>
        <kbd>{STRINGS.search.hint}</kbd>
      </div>
      <div class="module-filter" aria-label={STRINGS.filter.label}>{projects.map((item) => <button type="button" aria-pressed={project === item} onClick={() => { setProject(item); }} key={item}>{item}</button>)}</div>
      {!bricks.length ? <EmptyState sentence={STRINGS.empty.bricks} command={STRINGS.empty.bricksCommand} /> : filtered.length === 0 ? <p class="no-results">{STRINGS.search.noResults}</p> : <div class="brick-wall">{filtered.map((brick) => {
        const reuseCount = brick.reuse_count ?? 0;
        const tooltip = `${brick.id} · ${brick.status} · ${String(reuseCount)} reuses`;
        return <article class={`brick brick--${brick.status}`} tabIndex={0} aria-describedby={`brick-tooltip-${brick.project}-${brick.id}`} key={`${brick.project}:${brick.id}`}><div><span>{brick.project}</span><strong>{brick.id}</strong></div><Verdict kind={brick.health_status === "ok" ? "pass" : "fail"} label={brick.status.toUpperCase()} /><small>{brick.score}</small><span class="brick__tooltip" id={`brick-tooltip-${brick.project}-${brick.id}`} role="tooltip">{tooltip}</span></article>;
      })}</div>}
    </>
  );
}

function Settings({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return <div class="settings-grid"><Frame title={STRINGS.settings.appearance}><div class="setting-options"><button type="button" aria-pressed={theme === "dark"} onClick={() => { onTheme("dark"); }}>{STRINGS.settings.dark}</button><button type="button" aria-pressed={theme === "light"} onClick={() => { onTheme("light"); }}>{STRINGS.settings.light}</button></div></Frame><Frame title={STRINGS.settings.mode}><Verdict kind="pass" label={STRINGS.settings.mode} /><p>{STRINGS.settings.modeDescription}</p></Frame><Frame title={STRINGS.settings.endpoint}><code>{STRINGS.settings.endpointValue}</code></Frame><Frame title={STRINGS.settings.dataRoot}><code>{STRINGS.settings.dataRootValue}</code></Frame></div>;
}

function AppContent({ route, snapshot, theme, onTheme, leaseFlipSignal }: { route: RouteKey; snapshot: DashboardSnapshot; theme: Theme; onTheme: (theme: Theme) => void; leaseFlipSignal: number }) {
  const [conflictModule, setConflictModule] = useState<string | null>(null);
  if (route === "bricks") return <Frame title={STRINGS.section.registry}><BrickRegistry bricks={snapshot.registry.bricks} /></Frame>;
  if (route === "leases") return <Frame title={STRINGS.section.activeLeases}><LeaseBoard leases={snapshot.leases.leases} flipSignal={leaseFlipSignal} /></Frame>;
  if (route === "conflicts") return <div class="conflict-view"><Frame title={STRINGS.section.conflictHeat}><ConflictHeatStrip conflicts={snapshot.conflicts.conflicts} selectedModule={conflictModule} onSelectModule={setConflictModule} /></Frame><Frame title={STRINGS.section.recentConflicts}><ConflictLedger conflicts={snapshot.conflicts.conflicts} moduleFilter={conflictModule} /></Frame></div>;
  if (route === "graph") return <Frame title={STRINGS.section.graphCoverage}><GraphView modules={snapshot.graph.modules} /></Frame>;
  if (route === "settings") return <Settings theme={theme} onTheme={onTheme} />;
  return <><Stats snapshot={snapshot} /><div class="dashboard-grid"><Frame title={STRINGS.section.activeLeases} className="dashboard-grid__wide"><LeaseBoard leases={snapshot.leases.leases} flipSignal={leaseFlipSignal} /></Frame><Frame title={STRINGS.section.recentConflicts}><ConflictLedger conflicts={snapshot.conflicts.conflicts.slice(0, 5)} /></Frame><Frame title={STRINGS.section.moduleActivity}><GraphView modules={snapshot.graph.modules.slice(0, 10)} /></Frame></div></>;
}

export function App() {
  const [route, setRoute] = useState<RouteKey>(() => routeFromPath(location.pathname));
  const [theme, setTheme] = useState<Theme>(() => resolveInitialTheme(localStorage.getItem("smarch-dashboard-theme"), matchMedia("(prefers-color-scheme: light)").matches));
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [leaseFlipSignal, setLeaseFlipSignal] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => { document.title = STRINGS.documentTitle; }, []);

  const load = async (flipLeases = false) => {
    try {
      setError(null);
      setSnapshot(await fetchSnapshot());
      if (flipLeases) setLeaseFlipSignal((value) => value + 1);
    } catch (value) {
      const next = value instanceof Error ? value : new Error(String(value));
      setError(next);
      reportClientError("dashboard.fetch", "error", next);
    }
  };

  useEffect(() => { void load(); return subscribeToDashboardEvents((event) => void load(event.type === "leases"), () => { reportClientError("dashboard.sse", "error", new Error(STRINGS.toast.disconnected)); }); }, []);
  useEffect(() => {
    const onPop = () => { setRoute(routeFromPath(location.pathname)); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "[") setRailCollapsed(true);
      if (event.key === "]") setRailCollapsed(false);
    };
    addEventListener("popstate", onPop);
    addEventListener("keydown", onKey);
    return () => { removeEventListener("popstate", onPop); removeEventListener("keydown", onKey); };
  }, []);

  const navigate = (next: typeof ROUTES[number]) => {
    history.pushState({}, "", next.path);
    setRoute(next.key);
  };

  return (
    <div class={railCollapsed ? "app app--rail-collapsed" : "app"}>
      <a class="skip-link" href="#main">{STRINGS.skipToContent}</a>
      <aside class="rail">
        <div class="rail__stamp"><span>{STRINGS.appName}</span><small>{STRINGS.appDescriptor}</small></div>
        <nav aria-label={STRINGS.navigation}>{ROUTES.map((item) => <button type="button" class={route === item.key ? "nav-item nav-item--active" : "nav-item"} aria-current={route === item.key ? "page" : undefined} onClick={() => { navigate(item); }} key={item.key}><span class="nav-item__mark" aria-hidden="true">{item.mark}</span><span class="nav-item__label">{STRINGS.nav[item.key]}</span></button>)}</nav>
        <button type="button" class="rail__toggle" onClick={() => { setRailCollapsed((value) => !value); }} aria-label={railCollapsed ? STRINGS.rail.expand : STRINGS.rail.collapse}><span aria-hidden="true">{railCollapsed ? "]" : "["}</span><span class="nav-item__label">{STRINGS.railKeyHint}</span></button>
      </aside>
      <div class="workspace">
        <header class="topbar"><div class="topbar__repo"><span>{STRINGS.appName}</span><b>{STRINGS.routeEyebrow}</b></div><ThemeToggle theme={theme} onThemeChange={setTheme} /></header>
        <main id="main" tabIndex={-1}>
          <header class="page-heading"><p>{STRINGS.routeEyebrow}</p><h1>{STRINGS.routeTitles[route]}</h1><span>{STRINGS.routeDescriptions[route]}</span></header>
          {error ? <div class="error-panel" role="alert"><Verdict kind="fail" label={STRINGS.verdicts.fail} /><h2>{STRINGS.errors.heading}</h2><p>{STRINGS.errors.body}</p><button type="button" onClick={() => void load()}>{STRINGS.errors.retry}</button></div> : snapshot ? <AppContent route={route} snapshot={snapshot} theme={theme} onTheme={setTheme} leaseFlipSignal={leaseFlipSignal} /> : <p class="loading" aria-live="polite">{STRINGS.loading}</p>}
        </main>
      </div>
      <ToastCenter toasts={error ? [{ id: "dashboard-load-error", message: STRINGS.errors.body, verdict: "fail", error }] : []} />
    </div>
  );
}
