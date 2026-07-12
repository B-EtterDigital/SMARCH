import { memo } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { STRINGS } from "../strings";

export type Theme = "dark" | "light";

const STORAGE_KEY = "smarch-dashboard-theme";

export function resolveInitialTheme(
  savedTheme?: string | null,
  _prefersLight = false
): Theme {
  if (savedTheme === "dark" || savedTheme === "light") return savedTheme;
  return "dark";
}

function browserInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return resolveInitialTheme(
    window.localStorage.getItem(STORAGE_KEY),
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

export interface ThemeToggleProps {
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  disabled?: boolean;
}

/**
 * Switches the blueprint between dark and paper themes. With no controlled
 * `theme`, it restores local preference and otherwise follows the OS setting.
 */
export const ThemeToggle = memo(function ThemeToggle({ theme, onThemeChange, disabled = false }: ThemeToggleProps) {
  const [localTheme, setLocalTheme] = useState<Theme>(browserInitialTheme);
  const activeTheme = theme ?? localTheme;

  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
    window.localStorage.setItem(STORAGE_KEY, activeTheme);
  }, [activeTheme]);

  const toggle = () => {
    const nextTheme: Theme = activeTheme === "dark" ? "light" : "dark";
    setLocalTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  return (
    <button
      type="button"
      class="theme-toggle"
      aria-label={activeTheme === "dark" ? STRINGS.theme.light : STRINGS.theme.dark}
      aria-pressed={activeTheme === "light"}
      disabled={disabled}
      onClick={toggle}
    >
      <span aria-hidden="true">{activeTheme === "dark" ? STRINGS.themeIcons.light : STRINGS.themeIcons.dark}</span>
    </button>
  );
});
