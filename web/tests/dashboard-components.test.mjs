import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brickCloneCommand, brickGates, brickOwners, brickSize, brickTrust } from "../src/components/brick-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const baseBrick = {
  id: "registry-core",
  project: "smarch",
  status: "verified",
  score: 98,
  health_status: "ok"
};

test("brick view model normalizes trust and reuse spans", () => {
  assert.equal(brickTrust("canonical"), "canonical");
  assert.equal(brickTrust("verified"), "verified");
  assert.equal(brickTrust("draft"), "candidate");
  assert.equal(brickSize(0), "s");
  assert.equal(brickSize(4), "m");
  assert.equal(brickSize(10), "l");
});

test("brick view model supplies safe display fallbacks", () => {
  assert.deepEqual(brickOwners(baseBrick), ["smarch"]);
  assert.deepEqual(brickGates(baseBrick), [{ id: "health", label: "", verdict: "pass" }]);
  assert.equal(brickCloneCommand(baseBrick), "npx sma clone registry-core");
});

test("detail panel implements dialog semantics, Escape close, and a focus loop", () => {
  const source = read("src/components/brick-detail.tsx");
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /previousFocus\.current\?\.focus\(\)/);
});

test("component states, telemetry, i18n, and motion hooks stay present", () => {
  const files = ["app-shell", "brick-card", "brick-detail", "brick-wall"];
  for (const name of files) {
    const source = read(`src/components/${name}.tsx`);
    assert.match(source, /STRINGS\./, `${name} must source UI copy from strings.ts`);
    assert.doesNotMatch(source, /(?:aria-label|placeholder|title)="[A-Za-z][^"]+"/, `${name} contains literal accessible copy`);
  }
  assert.match(read("src/components/app-shell.tsx"), /ui\.app-shell/);
  assert.match(read("src/components/brick-card.tsx"), /ui\.brick-card\.copy/);
  assert.match(read("src/components/brick-detail.tsx"), /ui\.brick-detail\.focus/);
  assert.match(read("src/components/brick-wall.tsx"), /ui\.brick-wall\.select/);
  const css = read("src/app.css");
  assert.match(css, /transition: transform 200ms ease-out/);
  assert.match(css, /\.brick:hover \{ transform: translateY\(-1px\)/);
  assert.match(css, /animation: stamp-press 180ms ease-out 1/);
});

test("visual fixture exercises the shell and interactive brick suite", () => {
  const html = read("src/dev/dashboard-components.html");
  const fixture = read("src/dev/dashboard-components.tsx");
  assert.match(html, /dashboard-components\.tsx/);
  assert.match(fixture, /<AppShell/);
  assert.match(fixture, /<BrickWall/);
  assert.match(fixture, /reuse_count: 12/);
});
