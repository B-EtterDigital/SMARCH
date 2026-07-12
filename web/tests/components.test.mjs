import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("dashboard primitives expose all binding-spec states", () => {
  const stats = read("src/components/stats-tiles.tsx");
  assert.match(stats, /"loading" \| "empty" \| "error" \| "populated"/);
  assert.match(stats, /role="alert"/);
  assert.match(stats, /reportClientError\("dashboard\.stats-tiles"/);

  const verdict = read("src/components/verdict-stamp.tsx");
  for (const state of ["pass", "fail", "waived"]) assert.match(verdict, new RegExp(`${state}:`));
  assert.match(verdict, /aria-hidden="true"/);
});

test("theme keeps dark canonical, honors an explicit save, and persists on root", () => {
  const theme = read("src/components/theme-toggle.tsx");
  const html = read("index.html");
  assert.match(theme, /savedTheme === "dark" \|\| savedTheme === "light"/);
  assert.match(theme, /return "dark"/);
  assert.match(theme, /document\.documentElement\.dataset\.theme = activeTheme/);
  assert.match(theme, /localStorage\.setItem\(STORAGE_KEY, activeTheme\)/);
  assert.match(html, /localStorage\.getItem\("smarch-dashboard-theme"\)/);
  assert.match(html, /savedTheme === "light" \? "light" : "dark"/);
});

test("toast center caps, times, pauses, and announces notifications", () => {
  const toast = read("src/components/toast-center.tsx");
  assert.match(toast, /const MAX_TOASTS = 3/);
  assert.match(toast, /dismissAfterMs = 6_000/);
  assert.match(toast, /aria-live="polite"/);
  assert.match(toast, /onMouseEnter=.*setPaused\(true\)/);
  assert.match(toast, /onFocusIn=.*setPaused\(true\)/);
});

test("component CSS keeps exact geometry and motion contracts", () => {
  const css = read("src/app.css");
  assert.match(css, /\.stats-tiles \{[^}]*grid-template-columns: repeat\(4/);
  assert.match(css, /\.verdict-stamp \{[^}]*height: 24px/);
  assert.match(css, /\.toast-center \{[^}]*position: fixed/);
  assert.match(css, /@keyframes stamp-press/);
  assert.match(css, /animation: stamp-press 180ms ease-out 1/);
});
