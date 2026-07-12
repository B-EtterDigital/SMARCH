/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Existing logical-OR fallbacks intentionally treat every falsy value as absent; replacing them with ?? would change behavior. */
/* eslint-disable @typescript-eslint/no-base-to-string -- String() deliberately preserves the prior template-literal coercion contract for human-readable reports. */


export type LooseRecord = Record<string, unknown>;

export function slugify(value: unknown): string {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function mdTableRow(values: unknown[]): string {
  return `| ${values.map((value) => String(value ?? "").replaceAll("\n", " ")).join(" | ")} |`;
}

export function countBy<T>(items: T[], getKey: (item: T) => string | null | undefined): [string, number][] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = getKey(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

