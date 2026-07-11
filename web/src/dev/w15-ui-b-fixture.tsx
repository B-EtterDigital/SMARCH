import { render } from "preact";
import { ConflictHeatStrip } from "../components/conflict-heat-strip";
import { ConflictLedger } from "../components/conflict-ledger";
import { EmptyState } from "../components/empty-states";
import { GraphView } from "../components/graph-view";
import type { Conflict, ModuleGraph } from "../schema-types";
import { STRINGS } from "../strings";
import "../tokens.css";
import "../app.css";

const conflicts: Conflict[] = [
  { event_id: "open-1", timestamp: new Date().toISOString(), project: "coord", brick_id: "lease-ledger", agents: ["agent-a", "agent-b"], intent: "fixture", status: "open" },
  { event_id: "resolved-1", timestamp: new Date(Date.now() - 86_400_000).toISOString(), project: "graph", brick_id: "module-map", agents: ["agent-c", "agent-d"], intent: "fixture", status: "resolved" }
];
const modules: ModuleGraph[] = [
  { id: "coord", nodes: 26, links: 38, updated_at: new Date().toISOString() },
  { id: "graph", nodes: 18, links: 21, updated_at: new Date().toISOString() },
  { id: "dash", nodes: 34, links: 49, updated_at: new Date().toISOString() }
];

function Fixture() {
  return <main><header class="page-heading"><p>{STRINGS.routeEyebrow}</p><h1>{STRINGS.routeTitles.conflicts}</h1></header><div class="conflict-view"><ConflictHeatStrip conflicts={conflicts} onSelectModule={() => undefined} /><ConflictLedger conflicts={conflicts} /><GraphView modules={modules} /><EmptyState sentence={STRINGS.empty.conflicts} command={STRINGS.empty.conflictsCommand} /></div></main>;
}

const root = document.getElementById("app");
if (!root) throw new Error(STRINGS.appRootMissing);
render(<Fixture />, root);
