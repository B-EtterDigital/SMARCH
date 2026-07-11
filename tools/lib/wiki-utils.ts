

export type LooseRecord = Record<string, any>;

export function slugify(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function mdTableRow(values) {
  return `| ${values.map((value) => String(value ?? "").replaceAll("\n", " ")).join(" | ")} |`;
}

export function countBy(items, getKey) {
  const counts = new Map();

  for (const item of items) {
    const key = getKey(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}


