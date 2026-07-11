import { Component, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { VerdictStamp } from "./verdict-stamp";

export type AppShellRoute = keyof typeof STRINGS.routeTitles;
export type AppShellState = "ready" | "loading" | "empty" | "error";
export type AppShellTheme = "dark" | "light";

type AppShellProps = {
  activeRoute: AppShellRoute;
  children: ComponentChildren;
  onNavigate: (route: AppShellRoute, path: string) => void;
  onRetry?: () => void;
  onToggleTheme: () => void;
  state?: AppShellState;
  theme: AppShellTheme;
};

type BoundaryProps = { children: ComponentChildren };
type BoundaryState = { failed: boolean };

const ROUTES: ReadonlyArray<{ key: AppShellRoute; path: string; mark: string }> = [
  { key: "ledger", path: "/", mark: STRINGS.navMarks.ledger },
  { key: "bricks", path: "/bricks", mark: STRINGS.navMarks.bricks },
  { key: "leases", path: "/leases", mark: STRINGS.navMarks.leases },
  { key: "conflicts", path: "/conflicts", mark: STRINGS.navMarks.conflicts },
  { key: "graph", path: "/graph", mark: STRINGS.navMarks.graph },
  { key: "settings", path: "/settings", mark: STRINGS.navMarks.settings }
];

class ShellErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  componentDidCatch(error: Error): void {
    reportClientError("ui.app-shell", "fatal", error);
    this.setState({ failed: true });
  }

  render(): ComponentChildren {
    if (this.state.failed) {
      return <ShellState state="error" />;
    }
    return this.props.children;
  }
}

function ShellState({ state, onRetry }: { state: Exclude<AppShellState, "ready">; onRetry?: () => void }) {
  if (state === "loading") return <p class="loading" aria-live="polite">{STRINGS.loading}</p>;
  if (state === "empty") return <p class="shell-state">{STRINGS.appShell.empty}</p>;
  return (
    <div class="error-panel" role="alert">
      <VerdictStamp verdict="fail" />
      <h2>{STRINGS.errors.heading}</h2>
      <p>{STRINGS.errors.body}</p>
      {onRetry ? <button type="button" onClick={onRetry}>{STRINGS.errors.retry}</button> : null}
    </div>
  );
}

/**
 * Blueprint-ledger application frame. It owns rail collapse, global search focus,
 * theme access, route landmarks, and the top-level loading/empty/error states.
 */
export function AppShell({ activeRoute, children, onNavigate, onRetry, onToggleTheme, state = "ready", theme }: AppShellProps) {
  const [railCollapsed, setRailCollapsed] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      if (event.key === "/" && !isTyping) {
        const search = document.querySelector<HTMLInputElement>("[data-dashboard-search]");
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
      if (!isTyping && event.key === "[") setRailCollapsed(true);
      if (!isTyping && event.key === "]") setRailCollapsed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div class={railCollapsed ? "app app--rail-collapsed" : "app"}>
      <a class="skip-link" href="#main">{STRINGS.skipToContent}</a>
      <aside class="rail">
        <div class="rail__stamp"><span>{STRINGS.appName}</span><small>{STRINGS.appDescriptor}</small></div>
        <nav aria-label={STRINGS.navigation}>
          {ROUTES.map((item) => (
            <button
              type="button"
              class={activeRoute === item.key ? "nav-item nav-item--active" : "nav-item"}
              aria-current={activeRoute === item.key ? "page" : undefined}
              onClick={() => onNavigate(item.key, item.path)}
              key={item.key}
            >
              <span class="nav-item__mark" aria-hidden="true">{item.mark}</span>
              <span class="nav-item__label">{STRINGS.nav[item.key]}</span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          class="rail__toggle"
          onClick={() => setRailCollapsed((value) => !value)}
          aria-expanded={!railCollapsed}
          aria-label={railCollapsed ? STRINGS.rail.expand : STRINGS.rail.collapse}
        >
          <span aria-hidden="true">{railCollapsed ? "]" : "["}</span>
          <span class="nav-item__label">{STRINGS.railKeyHint}</span>
        </button>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div class="topbar__repo"><span>{STRINGS.appName}</span><b>{STRINGS.routeEyebrow}</b></div>
          <button type="button" class="theme-toggle" onClick={onToggleTheme} aria-label={theme === "dark" ? STRINGS.theme.light : STRINGS.theme.dark}>
            <span aria-hidden="true">{theme === "dark" ? STRINGS.themeMarks.light : STRINGS.themeMarks.dark}</span>
          </button>
        </header>
        <main id="main" tabIndex={-1} ref={mainRef}>
          <header class="page-heading">
            <p>{STRINGS.routeEyebrow}</p>
            <h1>{STRINGS.routeTitles[activeRoute]}</h1>
            <span>{STRINGS.routeDescriptions[activeRoute]}</span>
          </header>
          <ShellErrorBoundary>{state === "ready" ? children : <ShellState state={state} onRetry={onRetry} />}</ShellErrorBoundary>
        </main>
      </div>
    </div>
  );
}
