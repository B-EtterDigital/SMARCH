import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("both themes keep normal text at WCAG AA contrast", () => {
  const pairs = [
    ["0E1420", "E8E6E1"], ["0E1420", "8A93A6"], ["0E1420", "5FD4F4"],
    ["F3EFE6", "1A2233"], ["F3EFE6", "596276"], ["F3EFE6", "08758F"],
    ["F3EFE6", "8A5A00"], ["F3EFE6", "23713A"], ["F3EFE6", "B5272D"]
  ];
  for (const [ground, foreground] of pairs) {
    assert.ok(contrast(ground, foreground) >= 4.5, `${foreground} on ${ground} must be at least 4.5:1`);
  }
});

test("font assets are local woff2 only and forbidden visual effects stay absent", () => {
  const css = `${read("src/tokens.css")}\n${read("src/app.css")}`;
  assert.match(css, /ibm-plex-mono[^\"]+\.woff2/);
  assert.match(css, /space-grotesk[^\"]+\.woff2/);
  assert.doesNotMatch(css, /\.woff[\"')]/);
  assert.doesNotMatch(css, /box-shadow|drop-shadow/i);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient/i);
  assert.doesNotMatch(css, /#[a-f0-9]{0,2}(?:7c3aed|8b5cf6|a855f7)/i);
});

test("JSX contains no literal user-facing prose", () => {
  for (const relative of ["src/App.tsx", "src/main.tsx"]) {
    const source = read(relative);
    const withoutSelfClosingTags = source.replace(/<(?:input|div|span|circle|line)[\s\S]*?\/>/g, "");
    assert.doesNotMatch(withoutSelfClosingTags, /<[a-z][^>]*>\s*[A-Za-z][^<{]*<\//, `${relative} has literal rendered prose outside strings.ts`);
    assert.doesNotMatch(source, /(?:aria-label|placeholder|title)=["'][^"']+["']/, `${relative} has literal accessible prose outside strings.ts`);
  }
});
