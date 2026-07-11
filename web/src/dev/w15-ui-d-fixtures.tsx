import { render } from "preact";
import { useState } from "preact/hooks";
import { RegistryTable } from "../components/registry-table";
import { SealChip } from "../components/seal-chip";
import { SearchBar, type SearchResult } from "../components/search-bar";
import { SettingsPanel, type DashboardTheme } from "../components/settings-panel";
import type { RegistryBrick } from "../schema-types";
import "../tokens.css";

const rows: RegistryBrick[] = [
  { id: "registry-core", project: "smarch", status: "canonical", score: 100, health_status: "ok" },
  { id: "lease-coordinator", project: "smarch", status: "verified", score: 92, health_status: "ok" },
  { id: "legacy-adapter", project: "sample", status: "candidate", score: 61, health_status: "error" }
];
const results: SearchResult[] = [
  { id: "registry-core", kind: "brick", label: "registry-core", detail: "smarch" },
  { id: "dashboard", kind: "module", label: "dashboard", detail: "17 nodes" },
  { id: "w15-ui-d", kind: "lease", label: "w15-ui-d", detail: "codex-w15-ui-d" }
];

function Fixtures() {
  const [theme, setTheme] = useState<DashboardTheme>("dark");
  return <main style={{ padding: "32px", display: "grid", gap: "32px" }}>
    <section><h1>W15 UI D fixtures</h1><div style={{ display: "flex", gap: "8px" }}><SealChip status="pass" /><SealChip status="fail" /><SealChip status="waived" /><SealChip broken /></div></section>
    <section><SearchBar results={results} /></section>
    <section><RegistryTable rows={rows} /></section>
    <SettingsPanel theme={theme} onThemeChange={setTheme} sseEndpoint="/api/events" dataRootPath="/home/example/DEV/SMA" />
  </main>;
}

document.documentElement.dataset.theme = "dark";
const root = document.getElementById("app");
if (root) render(<Fixtures />, root);
