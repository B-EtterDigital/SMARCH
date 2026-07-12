import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("registry table preserves ledger semantics, sorting, and the 500-row virtualization boundary", () => {
  const source = read("src/components/registry-table.tsx");
  assert.match(source, /VIRTUALIZE_AFTER = 500/);
  assert.match(source, /<table class="registry-table">/);
  assert.match(source, /scope="col"/);
  assert.match(source, /aria-sort=/);
  assert.match(source, /sortRegistryRows/);
});

test("search bar exposes shortcut and ARIA keyboard navigation", () => {
  const source = read("src/components/search-bar.tsx");
  for (const contract of [/role="combobox"/, /role="listbox"/, /role="option"/, /ArrowDown/, /ArrowUp/, /aria-activedescendant/, /event\.key === "\/"/]) assert.match(source, contract);
});

test("seal and settings never rely on verdict color alone", () => {
  const seal = read("src/components/seal-chip.tsx");
  const settings = read("src/components/settings-panel.tsx");
  assert.match(seal, /ICONS\[effectiveStatus\]/);
  assert.match(seal, /seal-chip__break/);
  assert.match(settings, /readOnlyDescription/);
  assert.match(settings, /aria-pressed=/);
  assert.match(settings, /<output aria-label=/);
});

test("component states report errors and all user-facing prose is keyed", () => {
  for (const relative of ["registry-table.tsx", "seal-chip.tsx", "search-bar.tsx", "settings-panel.tsx"]) {
    const source = read(`src/components/${relative}`);
    assert.match(source, /reportClientError\("dashboard\./);
    assert.match(source, /STRINGS\.components\./);
  }
  assert.match(read("src/strings.ts"), /registryTable:/);
  assert.match(read("src/strings.ts"), /settingsPanel:/);
});

test("component CSS honors the motion and anti-slop contract", () => {
  const css = read("src/components/dashboard-components.css");
  assert.match(css, /150ms ease-out/);
  assert.match(css, /180ms ease-out/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none/);
  assert.doesNotMatch(css, /gradient|box-shadow|drop-shadow|border-radius:\s*(?:1[6-9]|[2-9]\d)px/i);
});
