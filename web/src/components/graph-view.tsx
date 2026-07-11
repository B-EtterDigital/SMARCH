import { useMemo, useRef, useState } from "preact/hooks";
import type { ModuleGraph } from "../schema-types";
import { STRINGS } from "../strings";
import { EmptyState, type SurfaceState } from "./empty-states";

type GraphPoint = ModuleGraph & { x: number; y: number; radius: number; color: string };
type Viewport = { x: number; y: number; scale: number };

const WIDTH = 760;
const HEIGHT = 420;
const MODULE_COLORS = ["var(--structure)", "var(--muted)"] as const;
const INITIAL_VIEW: Viewport = { x: 0, y: 0, scale: 1 };

function layoutGraph(modules: ModuleGraph[]): GraphPoint[] {
  const points = modules.map((module, index) => {
    const angle = (index / Math.max(1, modules.length)) * Math.PI * 2 - Math.PI / 2;
    const ring = 112 + (index % 3) * 38;
    return {
      ...module,
      x: WIDTH / 2 + Math.cos(angle) * ring,
      y: HEIGHT / 2 + Math.sin(angle) * ring,
      radius: Math.min(24, 9 + Math.sqrt(module.nodes)),
      color: MODULE_COLORS[index % MODULE_COLORS.length] ?? MODULE_COLORS[0]
    };
  });
  const iterations = Math.min(56, 20 + modules.length * 2);
  for (let step = 0; step < iterations; step += 1) {
    for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
      const left = points[leftIndex];
      if (!left) continue;
      let forceX = (WIDTH / 2 - left.x) * 0.0025;
      let forceY = (HEIGHT / 2 - left.y) * 0.0025;
      for (let rightIndex = 0; rightIndex < points.length; rightIndex += 1) {
        if (leftIndex === rightIndex) continue;
        const right = points[rightIndex];
        if (!right) continue;
        const dx = left.x - right.x || 0.1;
        const dy = left.y - right.y || 0.1;
        const distanceSquared = Math.max(256, dx * dx + dy * dy);
        forceX += (dx / Math.sqrt(distanceSquared)) * (120 / distanceSquared);
        forceY += (dy / Math.sqrt(distanceSquared)) * (120 / distanceSquared);
      }
      left.x = Math.min(WIDTH - 48, Math.max(48, left.x + forceX));
      left.y = Math.min(HEIGHT - 48, Math.max(48, left.y + forceY));
    }
  }
  return points;
}

export type GraphViewProps = { modules: ModuleGraph[]; state?: "populated" | SurfaceState; error?: unknown };

/** Read-only, dependency-free SVG graph with keyboard selection and zoom/pan controls. */
export function GraphView({ modules, state = "populated", error }: GraphViewProps) {
  const points = useMemo(() => layoutGraph(modules), [modules]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEW);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const selected = points.find((point) => point.id === selectedId) ?? null;

  if (state !== "populated") return <EmptyState state={state} sentence={STRINGS.empty.graph} command={STRINGS.empty.graphCommand} error={error} telemetryArea="dashboard.graph-view" />;
  if (!points.length) return <EmptyState sentence={STRINGS.empty.graph} command={STRINGS.empty.graphCommand} />;

  const zoom = (delta: number) => setViewport((value) => ({ ...value, scale: Math.min(2.5, Math.max(0.6, value.scale + delta)) }));
  const onPointerMove = (event: PointerEvent) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setViewport((value) => ({ ...value, x: value.x + event.clientX - drag.current!.x, y: value.y + event.clientY - drag.current!.y }));
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  return (
    <div class="graph-view" data-visual-fixture="graph-view">
      <div class="graph-view__controls" aria-label={STRINGS.graph.controls}>
        <button type="button" onClick={() => zoom(0.2)} aria-label={STRINGS.graph.zoomIn}>+</button>
        <button type="button" onClick={() => zoom(-0.2)} aria-label={STRINGS.graph.zoomOut}>−</button>
        <button type="button" onClick={() => setViewport(INITIAL_VIEW)}>{STRINGS.graph.reset}</button>
      </div>
      <div class="graph-view__canvas">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={STRINGS.routeDescriptions.graph}
          onWheel={(event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 0.12 : -0.12); }}
          onPointerDown={(event) => { drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}>
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
            <g class="graph-hulls">{points.map((point) => <circle cx={point.x} cy={point.y} r={point.radius + 18} fill={point.color} key={`hull-${point.id}`} />)}</g>
            <g class="graph-links">{points.map((point, index) => { const next = points[(index + 1) % points.length]; return next && next !== point ? <line key={`link-${point.id}`} x1={point.x} y1={point.y} x2={next.x} y2={next.y} /> : null; })}</g>
            <g>{points.map((point) => <g class="graph-node" transform={`translate(${point.x} ${point.y})`} key={point.id}>
              <circle r={point.radius} fill={point.color} />
              <text y={point.radius + 16} text-anchor="middle">{point.id}</text>
              <title>{STRINGS.graph.summary(point.id, point.nodes, point.links)}</title>
              <circle class="graph-node__hit" r={Math.max(22, point.radius)} role="button" tabIndex={0} aria-label={STRINGS.graph.selectNode(point.id)} aria-pressed={selectedId === point.id}
                onClick={(event) => { event.stopPropagation(); setSelectedId(point.id); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(point.id); } }} />
            </g>)}</g>
          </g>
        </svg>
        {selected ? <aside class="graph-detail" aria-live="polite"><button type="button" onClick={() => setSelectedId(null)} aria-label={STRINGS.close}>×</button><h3>{selected.id}</h3><dl><div><dt>{STRINGS.graph.nodes}</dt><dd>{selected.nodes}</dd></div><div><dt>{STRINGS.graph.links}</dt><dd>{selected.links}</dd></div><div><dt>{STRINGS.graph.updated}</dt><dd>{selected.updated_at ?? STRINGS.unknown}</dd></div></dl></aside> : null}
      </div>
    </div>
  );
}
