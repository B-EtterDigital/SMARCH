import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("lease SSE refresh drives row flip and the two TTL thresholds", () => {
  const app = read("src/App.tsx");
  const row = read("src/components/lease-row.tsx");
  const css = read("src/app.css");
  assert.match(app, /event\.type === "leases"/);
  assert.match(app, /flipSignal=\{leaseFlipSignal\}/);
  assert.match(row, /remaining < 300_000/);
  assert.match(row, /remaining <= 60_000/);
  assert.match(css, /\.lease-row--flip \{ animation: row-flip 150ms/);
  assert.match(css, /\.ttl--pulse \{ animation: ttl-pulse 300ms/);
});

test("brick wall and provenance motion match the elevation contract", () => {
  const app = read("src/App.tsx");
  const ribbon = read("src/components/provenance-ribbon.tsx");
  const css = read("src/app.css");
  assert.match(app, /\u00b7 \$\{brick\.status\} \u00b7/);
  assert.match(app, /class="brick__tooltip"/);
  assert.match(css, /transition: transform 80ms ease-out/);
  assert.match(css, /\.brick--canonical:hover::before/);
  assert.match(ribbon, /provenance-ribbon--draw-in/);
  assert.match(ribbon, /provenance-ribbon__item--broken/);
  assert.match(css, /animation: provenance-draw 400ms/);
  assert.match(css, /border-top: 1px dashed var\(--fail\)/);
});

test("first paint, dark theme, mobile cards, and hard bans stay enforced", () => {
  const stats = read("src/components/stats-tiles.tsx");
  const css = read("src/app.css");
  const componentCss = read("src/components/dashboard-components.css");
  const strings = read("src/strings.ts");
  assert.match(stats, /sessionStorage\.getItem\(CHOREOGRAPHY_KEY\)/);
  for (const delay of ["60ms", "120ms", "180ms"]) assert.match(css, new RegExp(`animation-delay: ${delay}`));
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /\.ledger-table thead \{ display: none; \}/);
  assert.match(componentCss, /\.registry-table thead, \.registry-table__spacer \{ display: none; \}/);
  assert.doesNotMatch(`${css}\n${componentCss}`, /(?:linear|radial|conic)-gradient|box-shadow/i);
  assert.doesNotMatch(`${css}\n${componentCss}\n${strings}`, /shimmer|skeleton|purple/i);
  for (const match of strings.matchAll(/loading:\s*"([^"]+)"/g)) assert.equal(match[1], "…loading ledger");
});
