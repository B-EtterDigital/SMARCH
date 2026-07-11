import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const components = ["src/components/conflict-heat-strip.tsx", "src/components/conflict-ledger.tsx", "src/components/empty-states.tsx", "src/components/graph-view.tsx"];

test("w15 ui b copy is externalized", () => {
  for (const relative of components) {
    const source = read(relative);
    assert.match(source, /STRINGS\./, `${relative} must use the string registry`);
    assert.doesNotMatch(source, /aria-label="[A-Za-z]/, `${relative} has literal accessible copy`);
  }
});

test("conflict surfaces expose filter, ordering, dates, and labeled verdicts", () => {
  const heat = read(components[0]);
  const ledger = read(components[1]);
  assert.match(heat, /length: 30/);
  assert.match(heat, /onSelectModule/);
  assert.match(heat, /heat-strip__bar--today/);
  assert.match(ledger, /left\.status === "open" \? -1 : 1/);
  assert.match(ledger, /<time dateTime=/);
  assert.match(ledger, /VerdictStamp/);
  assert.match(ledger, /scope="col"/);
});

test("empty and graph states are actionable and keyboard reachable", () => {
  const empty = read(components[2]);
  const graph = read(components[3]);
  assert.match(empty, /navigator\.clipboard\.writeText/);
  assert.match(empty, /reportClientError/);
  assert.match(graph, /role="button" tabIndex=\{0\}/);
  assert.match(graph, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(graph, /onWheel=/);
  assert.match(graph, /setViewport\(INITIAL_VIEW\)/);
});

test("w15 ui b styling follows the binding motion and anti-slop contract", () => {
  const css = read("src/app.css");
  assert.match(css, /heat-strip__bar[^}]+min-width: 4px/);
  assert.match(css, /graph-hulls circle \{ opacity: 0\.08/);
  assert.match(css, /conflict-row--open \{ animation: conflict-pulse 300ms ease-out 1/);
  assert.doesNotMatch(css, /box-shadow|drop-shadow/i);
});

test("w15 ui b visual fixture renders every lane component", () => {
  const fixture = read("src/dev/w15-ui-b-fixture.tsx");
  for (const name of ["ConflictHeatStrip", "ConflictLedger", "EmptyState", "GraphView"]) assert.match(fixture, new RegExp(`<${name}`));
});
