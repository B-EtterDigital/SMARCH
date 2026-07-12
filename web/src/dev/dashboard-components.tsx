import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AppShell, type AppShellTheme } from "../components/app-shell";
import { BrickWall } from "../components/brick-wall";
import type { BrickRecord } from "../components/brick-model";
import { STRINGS } from "../strings";
import "../tokens.css";
import "../app.css";

const BRICKS: BrickRecord[] = [
  { id: "registry-core", project: "smarch", status: "canonical", score: 100, health_status: "ok", reuse_count: 12, owner_trail: ["platform", "registry"], gates: [{ id: "typecheck", label: "Typecheck", verdict: "pass" }, { id: "security", label: "Security", verdict: "pass" }] },
  { id: "lease-coordinator", project: "coord", status: "verified", score: 94, health_status: "ok", reuse_count: 6, owner_trail: ["platform", "coord"] },
  { id: "graph-retrieval", project: "graph", status: "candidate", score: 78, health_status: "warning", reuse_count: 1, owner_trail: ["platform", "graph"] }
];

function Fixture() {
  const [theme, setTheme] = useState<AppShellTheme>("dark");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return (
    <AppShell activeRoute="bricks" theme={theme} onToggleTheme={() => { setTheme((value) => value === "dark" ? "light" : "dark"); }} onNavigate={() => undefined}>
      <section class="frame" aria-label={STRINGS.brickWall.label}><BrickWall bricks={BRICKS} /></section>
    </AppShell>
  );
}

const root = document.getElementById("fixture");
if (!root) throw new Error(STRINGS.appRootMissing);
render(<Fixture />, root);
