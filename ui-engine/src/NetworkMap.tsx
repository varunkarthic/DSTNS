import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { mapFitLayout, metresToGeographic } from "./mapProjection";
import { InfoCard, Tooltip } from "./Tooltip";
import {
  demandColor,
  distanceToSegment,
  insideFootprint,
  placeKind,
  placeTitle,
  roadInspection,
  roadState,
  stateColors,
} from "./mapModel";
import type {
  Inspection,
  Layers,
  Point,
  Snapshot,
  Topology,
  TopologyEdge,
} from "./types";

// Imperative handle so the alpha layout can host the map controls in its own
// floating dock instead of inside the canvas.
export type MapControls = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Show the inspection card for a place, as hovering it would. */
  inspectFeature: (id: string) => void;
};
export type MapView = {
  scale: number;
  metresPerPixel: number;
};
type Props = {
  topology: Topology | null;
  snapshot: Snapshot | null;
  layers: Layers;
  reduceMotion: boolean;
  running: boolean;
  virtualTime: number;
  tickRate?: number;
  /** Where the camera should glide to next; a new token restarts the glide. */
  focus?: { x_m: number; y_m: number; scale?: number; token: number } | null;
  controls?: RefObject<MapControls | null>;
  onView?: (view: MapView) => void;
  onCursor?: (position: { lat: number; lon: number } | null) => void;
};
type View = { x: number; y: number; scale: number };
type Geo = {
  path: Path2D;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
function geometry(points: Point[], closed = false): Geo {
  const path = new Path2D();
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  points.forEach((p, i) => {
    const y = -p.y_m;
    i ? path.lineTo(p.x_m, y) : path.moveTo(p.x_m, y);
    minX = Math.min(minX, p.x_m);
    maxX = Math.max(maxX, p.x_m);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  if (closed) path.closePath();
  return { path, minX, maxX, minY, maxY };
}
function NetworkMap({
  topology,
  snapshot,
  layers,
  reduceMotion,
  running,
  virtualTime,
  tickRate = 1,
  focus,
  controls,
  onView,
  onCursor,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    base = useRef<HTMLCanvasElement>(null),
    dynamic = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 }),
    [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<{
    info: Inspection;
    x: number;
    y: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    hoverKey = useRef(""),
    drag = useRef<{ x: number; y: number; view: View } | null>(null);
  const vehicleMarkers = useRef<{ x: number; y: number; edge: number }[]>([]);
  const cached = useMemo(
    () =>
      topology
        ? {
            roads: topology.edges.map((e) => geometry(e.geometry)),
            features: topology.features.map((f) =>
              geometry(f.geometry, f.polygon),
            ),
            bounds: geometry(topology.nodes.map((n) => n.position)),
          }
        : null,
    [topology],
  );
  const state = useMemo(
    () => ({
      edges: new Map(snapshot?.edges.map((e) => [e.id, e])),
      signals: new Map(snapshot?.signals.map((s) => [s.junction_id, s])),
      demand: new Map(snapshot?.demand.map((d) => [d.feature_id, d])),
    }),
    [snapshot],
  );
  // Flow markers only ever appear on edges that carry traffic. Deriving that
  // list once per snapshot keeps the per-frame loop proportional to what is
  // actually drawn rather than to the whole network.
  const flowing = useMemo(() => {
    if (!topology) return [];
    const out: { edge: TopologyEdge; speed: number; count: number }[] = [];
    for (const e of topology.edges) {
      if (e.synthetic_reverse || e.geometry.length < 2) continue;
      const s = state.edges.get(e.id);
      if (!s?.vehicle_count) continue;
      out.push({ edge: e, speed: s.mean_speed_mps, count: s.vehicle_count });
    }
    return out;
  }, [topology, state]);
  // Adaptive detail. The draw cost of a frame is measured and fed back into how
  // many markers the next frame may place, so a dense district or a fast rate
  // degrades detail instead of dropping frames.
  const quality = useRef(1);
  // Place kinds depend only on the topology, so resolve them once rather than
  // re-deriving a regex match for every feature on every frame.
  const kinds = useMemo(
    () => (topology ? topology.features.map((f) => placeKind(f)) : []),
    [topology],
  );
  const fit = useCallback(() => {
    if (!cached) return;
    const b = cached.bounds;
    const layout = mapFitLayout(size.w, size.h);
    const scale = Math.min(
      layout.available / Math.max(1, b.maxX - b.minX),
      (size.h - 150) / Math.max(1, b.maxY - b.minY),
    );
    setView({
      scale,
      x: layout.centerX - ((b.minX + b.maxX) / 2) * scale,
      y: layout.centerY - ((b.minY + b.maxY) / 2) * scale,
    });
  }, [cached, size]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    fit();
  }, [fit]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const visible = (g: Geo, pad = 20) =>
    g.maxX * view.scale + view.x >= -pad &&
    g.minX * view.scale + view.x <= size.w + pad &&
    g.maxY * view.scale + view.y >= -pad &&
    g.minY * view.scale + view.y <= size.h + pad;
  const setup = (canvas: HTMLCanvasElement) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      canvas.width !== Math.round(size.w * dpr) ||
      canvas.height !== Math.round(size.h * dpr)
    ) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    return ctx;
  };
  useEffect(() => {
    if (!topology || !cached || !base.current) return;
    const ctx = setup(base.current);
    if (!ctx) return;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    if (layers.buildings)
      topology.features.forEach((f, i) => {
        const g = cached.features[i];
        if (!f.polygon || !visible(g)) return;
        ctx.fillStyle = [
          "park",
          "grass",
          "forest",
          "recreation_ground",
        ].includes(f.category)
          ? "#102c2d"
          : "#122430";
        ctx.strokeStyle = "#29424e";
        ctx.lineWidth = 0.7 / view.scale;
        ctx.fill(g.path);
        if (view.scale > 0.15) ctx.stroke(g.path);
      });
    topology.edges.forEach((e, i) => {
      if (e.synthetic_reverse || !visible(cached.roads[i])) return;
      ctx.strokeStyle = "#071420";
      ctx.lineWidth = (e.road_class === "primary" ? 5 : 3) / view.scale;
      ctx.stroke(cached.roads[i].path);
    });
    ctx.restore();
  }, [topology, cached, view, size, layers.buildings]); // Static geography never depends on a simulation tick.
  useEffect(() => {
    if (!topology || !cached || !dynamic.current) return;
    let frame = 0;
    const received = performance.now();
    const draw = () => {
      if (!dynamic.current) return;
      // One shared 0..1 clock so every animated overlay pulses in step.
      const pulse = reduceMotion
        ? 0
        : ((performance.now() - received) / 2400) % 1;
      const ctx = setup(dynamic.current);
      if (!ctx) return;
      const screen = (p: Point) => ({
        x: p.x_m * view.scale + view.x,
        y: -p.y_m * view.scale + view.y,
      });
      ctx.save();
      ctx.translate(view.x, view.y);
      ctx.scale(view.scale, view.scale);
      ctx.lineCap = "round";
      if (layers.roads)
      topology.edges.forEach((e, i) => {
        if (e.synthetic_reverse || !visible(cached.roads[i])) return;
        if (
          view.scale < 0.12 &&
          !["primary", "motorway", "secondary", "tertiary"].includes(
            e.road_class,
          )
        )
          return;
        const s = state.edges.get(e.id);
        let status = roadState(s);
        if (status === "flooded" && !layers.flooding)
          status = s?.closed
            ? "blocked"
            : s && s.congestion > 0.7
              ? "severe"
              : s && s.congestion > 0.35
                ? "moderate"
                : "clear";
        ctx.strokeStyle = layers.traffic ? stateColors[status] : "#4a626c";
        ctx.globalAlpha = e.road_class === "service" ? 0.45 : 0.83;
        ctx.lineWidth =
          (["primary", "motorway"].includes(e.road_class) ? 2.5 : 1.3) /
          view.scale;
        ctx.stroke(cached.roads[i].path);
      });
      ctx.restore();
      ctx.globalAlpha = 1;
      if (layers.weather)
        for (const w of snapshot?.active_weather ?? []) {
          const x = w.x_m * view.scale + view.x,
            y = -w.y_m * view.scale + view.y,
            r = w.radius_m * view.scale;
          if (x + r < 0 || x - r > size.w || y + r < 0 || y - r > size.h)
            continue;
          // Body of the cell: a soft core that breathes with the pulse clock,
          // so a storm reads as weather rather than a static blue disc.
          const breathe = 1 + Math.sin(pulse * Math.PI * 2) * 0.03;
          const gradient = ctx.createRadialGradient(
            x, y, r * 0.08,
            x, y, r * breathe,
          );
          gradient.addColorStop(0, `rgba(55,215,255,${0.1 + w.intensity * 0.2})`);
          gradient.addColorStop(0.55, `rgba(0,103,125,${0.05 + w.intensity * 0.1})`);
          gradient.addColorStop(1, "rgba(7,20,32,0)");
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(x, y, r * breathe, 0, Math.PI * 2);
          ctx.fill();

          // Rain: short slanted streaks falling inside the cell. They are laid
          // out on a fixed lattice and only their phase advances, so the field
          // stays stable as the map pans instead of reshuffling every frame.
          if (!reduceMotion && r > 26) {
            const spacing = Math.max(16, 26 - w.intensity * 8);
            const drop = ((pulse * 2) % 1) * spacing * 2;
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, r * 0.94, 0, Math.PI * 2);
            ctx.clip();
            ctx.strokeStyle = `rgba(147,255,222,${0.1 + w.intensity * 0.22})`;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            for (let gx = -r; gx <= r; gx += spacing) {
              for (let gy = -r; gy <= r; gy += spacing * 2) {
                const sx = x + gx + ((gy + drop) % spacing) * 0.35;
                const sy = y + ((gy + drop) % (r * 2 + spacing * 2)) - r;
                ctx.moveTo(sx, sy);
                ctx.lineTo(sx - 3.5, sy + 9);
              }
            }
            ctx.stroke();
            ctx.restore();
          }

          // Edge of the cell, and a label that stays outside the rain.
          ctx.setLineDash([4, 7]);
          ctx.lineDashOffset = -pulse * 22;
          ctx.strokeStyle = `rgba(55,215,255,${0.35 + w.intensity * 0.25})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          ctx.fillStyle = "#b2ebff";
          ctx.font = "10px Inter";
          ctx.fillText(`Rain ${(w.intensity * 100).toFixed(0)}%`, x + 8, y - r - 6);
        }
      const labels = new Set<string>();
      ctx.font = "10px Inter";
      if (layers.labels && view.scale > 0.3)
        topology.edges.forEach((e, i) => {
          if (!e.name || e.synthetic_reverse || !visible(cached.roads[i]))
            return;
          const a = screen(e.geometry[0]),
            b = screen(e.geometry[e.geometry.length - 1]);
          if (Math.hypot(b.x - a.x, b.y - a.y) < 65) return;
          const x = (a.x + b.x) / 2,
            y = (a.y + b.y) / 2,
            cell = `${Math.floor(x / 120)},${Math.floor(y / 35)}`;
          if (labels.has(cell)) return;
          labels.add(cell);
          ctx.fillStyle = "#c1d7df";
          ctx.fillText(e.name.slice(0, 30), x + 5, y - 5);
        });
      const poiCells = new Set<string>();
      if (layers.buildings)
        topology.features.forEach((f, i) => {
          if (!visible(cached.features[i])) return;
          const demand = state.demand.get(f.id);
          const kind = kinds[i];
          // Zoomed out, keep only the landmarks that orient the operator and
          // anything currently drawing traffic.
          if (
            view.scale < 0.65 &&
            !demand?.active &&
            !["School", "University", "Hospital", "Shopping Mall", "Transport Hub"].includes(
              kind.label,
            )
          )
            return;
          if (f.polygon && !demand) return;
          const p = screen(f.position);
          const cell = `${Math.floor(p.x / 28)},${Math.floor(p.y / 28)}`;
          if (poiCells.has(cell)) return;
          poiCells.add(cell);
          // Modelled places carry the demand ramp: white at rest, warming
          // through amber to red at peak, then cooling back the same way.
          const multiplier = demand?.multiplier ?? 1;
          const warm = kind.demand && multiplier > 1.01;
          const tint = warm ? demandColor(multiplier) : "#162e3b";
          ctx.fillStyle = tint;
          ctx.strokeStyle = warm ? tint : "#638591";
          ctx.lineWidth = warm ? 1.6 : 1.2;
          ctx.beginPath();
          ctx.roundRect(p.x - 8, p.y - 8, 16, 16, 5);
          ctx.fill();
          ctx.stroke();
          ctx.font = "bold 10px Inter";
          ctx.textAlign = "center";
          // Keep the glyph readable against whatever the ramp produced.
          ctx.fillStyle = warm && multiplier > 1.35 ? "#071420" : warm ? "#31210a" : "#d7e4f5";
          ctx.fillText(kind.icon, p.x, p.y + 3);
          ctx.textAlign = "start";
          if (layers.place_names && view.scale > 1 && f.name) {
            ctx.fillStyle = "#bbc9ce";
            ctx.fillText(f.name.slice(0, 24), p.x + 12, p.y + 3);
          }
        });
      if (layers.signals && view.scale > 0.15)
        for (const signal of snapshot?.signals ?? []) {
          const node = topology.nodes[signal.junction_id];
          if (!node) continue;
          const p = screen(node.position);
          if (p.x < 0 || p.x > size.w || p.y < 0 || p.y > size.h) continue;
          ctx.fillStyle = "#06131e";
          ctx.fillRect(p.x - 5, p.y - 7, 17, 12);
          [signal.group_a, signal.group_b].forEach((s, i) => {
            ctx.fillStyle = signal.enabled
              ? s === "green"
                ? "#57d9b0"
                : s === "amber"
                  ? "#ffca66"
                  : "#ff6577"
              : "#647681";
            ctx.beginPath();
            ctx.arc(p.x + i * 7, p.y - 1, 2.7, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      if (layers.events || layers.incidents)
        for (const inc of snapshot?.active_incidents ?? []) {
          const e = topology.edges[inc.edge_id];
          if (!e?.geometry.length) continue;
          const a = screen(e.geometry[0]),
            b = screen(e.geometry[e.geometry.length - 1]);
          const x = (a.x + b.x) / 2,
            y = (a.y + b.y) / 2;
          const flooded = inc.flood > 0.01;
          const hue = flooded ? "75,169,255" : "255,91,101";
          // Expanding radar rings, as in the alpha mockup: each ring grows from
          // the marker and fades out, staggered so the pulse reads continuously.
          if (!reduceMotion) {
            for (let ring = 0; ring < 2; ring++) {
              const phase = ((pulse + ring * 0.5) % 1);
              const radius = 10 + phase * 34;
              ctx.beginPath();
              ctx.arc(x, y, radius, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(${hue},${(1 - phase) * 0.55})`;
              ctx.lineWidth = 1.4;
              ctx.stroke();
            }
          }
          // Core disc, then the warning glyph.
          ctx.beginPath();
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.fillStyle = flooded ? "rgba(6,40,70,0.85)" : "rgba(105,0,5,0.85)";
          ctx.fill();
          ctx.strokeStyle = `rgb(${hue})`;
          ctx.lineWidth = 1.8;
          ctx.stroke();
          ctx.fillStyle = `rgb(${hue})`;
          ctx.beginPath();
          ctx.moveTo(x, y - 6);
          ctx.lineTo(x + 6, y + 4.5);
          ctx.lineTo(x - 6, y + 4.5);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = flooded ? "#062846" : "#690005";
          ctx.font = "bold 8px Inter";
          ctx.textAlign = "center";
          ctx.fillText(flooded ? "~" : "!", x, y + 3.5);
          ctx.textAlign = "start";
        }
      vehicleMarkers.current = [];
      const drawStarted = performance.now();
      // Above roughly 20x real time individual markers move further than they
      // are wide each frame, so they read as noise. Spend the budget on fewer,
      // and let the measured cost pull it down further on heavy scenes.
      const rateFactor = tickRate <= 4 ? 1 : tickRate <= 20 ? 0.6 : 0.3;
      const markerBudget = Math.round(1500 * quality.current * rateFactor);
      if (layers.vehicles && !reduceMotion && view.scale > 0.25 && markerBudget > 0) {
        let count = 0;
        const time =
          virtualTime +
          (running ? Math.min(1, (performance.now() - received) / 1000) : 0);
        for (const { edge: e, speed, count: vehicles } of flowing) {
          if (count >= markerBudget) break;
          if (!visible(cached.roads[e.id])) continue;
          const a = screen(e.geometry[0]),
            b = screen(e.geometry[e.geometry.length - 1]);
          const n = Math.min(5, vehicles);
          for (let i = 0; i < n && count < markerBudget; i++, count++) {
            const progress =
              ((i + 0.5) / n +
                (time * speed) / Math.max(1, e.length_m)) %
              1;
            vehicleMarkers.current.push({
              x: a.x + (b.x - a.x) * progress,
              y: a.y + (b.y - a.y) * progress,
              edge: e.id,
            });
            ctx.fillStyle = "#daf7f0";
            ctx.fillRect(
              a.x + (b.x - a.x) * progress - 1,
              a.y + (b.y - a.y) * progress - 1,
              2.5,
              2.5,
            );
          }
        }
      }
      // Aim to spend under 8ms drawing, leaving the rest of a 60Hz frame for
      // compositing and the rest of the page. Recover slowly, shed fast.
      const cost = performance.now() - drawStarted;
      quality.current = Math.min(
        1,
        Math.max(0.12, quality.current * (cost > 11 ? 0.82 : cost < 5 ? 1.05 : 1)),
      );
      if (running && !reduceMotion) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [
    topology,
    cached,
    snapshot,
    state,
    view,
    size,
    layers,
    reduceMotion,
    running,
    virtualTime,
    flowing,
    tickRate,
  ]);
  // Smooth camera glide. The operator should be carried to an incident rather
  // than teleported, so the view eases over ~900ms and any manual pan, zoom or
  // drag cancels it immediately.
  const glide = useRef<number | undefined>(undefined);
  const cancelGlide = useCallback(() => {
    if (glide.current !== undefined) cancelAnimationFrame(glide.current);
    glide.current = undefined;
  }, []);
  useEffect(() => cancelGlide, [cancelGlide]);
  useEffect(() => {
    if (!focus || !size.w) return;
    const layout = mapFitLayout(size.w, size.h);
    let from: View | null = null;
    const started = performance.now();
    const duration = reduceMotion ? 0 : 900;
    const step = (now: number) => {
      setView((current) => {
        from ??= current;
        const target: View = {
          scale: focus.scale ?? current.scale,
          x: 0,
          y: 0,
        };
        target.x = layout.centerX - focus.x_m * target.scale;
        target.y = layout.centerY + focus.y_m * target.scale;
        const t = duration ? Math.min(1, (now - started) / duration) : 1;
        // Ease-out cubic: quick departure, gentle arrival.
        const k = 1 - Math.pow(1 - t, 3);
        if (t >= 1) glide.current = undefined;
        return {
          scale: from.scale + (target.scale - from.scale) * k,
          x: from.x + (target.x - from.x) * k,
          y: from.y + (target.y - from.y) * k,
        };
      });
      if (glide.current !== undefined) glide.current = requestAnimationFrame(step);
    };
    cancelGlide();
    glide.current = requestAnimationFrame(step);
    return cancelGlide;
    // Only a new token starts a glide; view changes during it must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token, size.w, size.h, reduceMotion, cancelGlide]);

  const clearHover = () => {
    clearTimeout(timer.current);
    hoverKey.current = "";
    setHover(null);
  };
  const inspectAt = (clientX: number, clientY: number) => {
    if (!topology || !cached || !host.current) return;
    const rect = host.current.getBoundingClientRect(),
      x = (clientX - rect.left - view.x) / view.scale,
      y = (clientY - rect.top - view.y) / view.scale;
    let footprint: { key: string; info: Inspection } | undefined;
    let info: Inspection | undefined,
      key = "";
    if (layers.signals && view.scale > 0.15)
      for (const signal of snapshot?.signals ?? []) {
        const n = topology.nodes[signal.junction_id];
        if (
          n &&
          Math.hypot(n.position.x_m - x, -n.position.y_m - y) * view.scale < 12
        ) {
          key = `s${signal.signal_id}`;
          info = {
            title: `Signal J-${signal.junction_id}`,
            category: "Traffic control",
            status: signal.enabled ? signal.phase_name : "Disabled",
            description: `Group A (north/south): ${signal.group_a}. Group B (east/west): ${signal.group_b}.`,
            metrics: [
              [
                "Time in phase",
                signal.time_in_phase === null
                  ? "Operator override"
                  : `${signal.time_in_phase}s`,
              ],
              [
                "Next transition",
                signal.next_transition_at === null
                  ? "Held by operator"
                  : `${signal.next_transition_at}s virtual`,
              ],
              ["Cycle", `${signal.cycle_length}s`],
            ],
          };
          break;
        }
      }
    if (!info && layers.events)
      for (const incident of snapshot?.active_incidents ?? []) {
        const edge = topology.edges[incident.edge_id];
        if (!edge) continue;
        const a = edge.geometry[0],
          b = edge.geometry[edge.geometry.length - 1];
        if (
          Math.hypot((a.x_m + b.x_m) / 2 - x, -(a.y_m + b.y_m) / 2 - y) *
            view.scale <
          12
        ) {
          key = `e${edge.id}`;
          info = {
            ...roadInspection(edge, state.edges.get(edge.id), topology),
            title: `Incident on ${edge.name || `E-${edge.id}`}`,
            category: "Incident effect",
          };
          break;
        }
      }
    if (!info && layers.vehicles && !reduceMotion) {
      const marker = vehicleMarkers.current.find(
        (p) =>
          Math.hypot(p.x - (clientX - rect.left), p.y - (clientY - rect.top)) <
          6,
      );
      if (marker) {
        const edge = topology.edges[marker.edge];
        key = `v${edge.id}`;
        info = {
          ...roadInspection(edge, state.edges.get(edge.id), topology),
          title: "Modeled vehicle flow",
          category: `Edge E-${edge.id}`,
          description:
            "Representative flow marker from aggregate count and speed. Individual vehicle position and identity are not tracked.",
        };
      }
    }
    if (!info && view.scale > 1)
      for (const node of topology.nodes) {
        if (
          Math.hypot(node.position.x_m - x, -node.position.y_m - y) *
            view.scale <
          7
        ) {
          key = `n${node.id}`;
          info = {
            title: `Node N-${node.id}`,
            category: "Junction",
            metrics: [
              ["Connections", String(node.degree)],
              ["OSM node", String(node.osm_node_id)],
            ],
          };
          break;
        }
      }
    if (!info && layers.buildings)
      for (let i = topology.features.length - 1; i >= 0; i--) {
        const f = topology.features[i],
          g = cached.features[i];
        if (
          Math.hypot(f.position.x_m - x, -f.position.y_m - y) * view.scale <
            12 ||
          (f.polygon &&
            x >= g.minX &&
            x <= g.maxX &&
            y >= g.minY &&
            y <= g.maxY &&
            insideFootprint(x, y, f.geometry))
        ) {
          const d = state.demand.get(f.id);
          key = f.id;
          info = {
            title: placeTitle(f),
            category: f.category,
            status: d?.active ? "Demand increase" : "Normal",
            description: f.id,
            metrics: d
              ? [
                  ["Demand multiplier", `${d.multiplier.toFixed(2)}×`],
                  ["Influence radius", `${d.radius_m} m`],
                ]
              : [["Geometry", f.polygon ? "OSM footprint" : "OSM point"]],
          };
          // A road remains inspectable when it crosses a larger park/land-use outline.
          if (
            Math.hypot(f.position.x_m - x, -f.position.y_m - y) * view.scale >=
            12
          ) {
            footprint = { key, info };
            info = undefined;
            key = "";
          }
          break;
        }
      }
    if (!info) {
      let nearest = 7 / view.scale;
      for (const e of topology.edges) {
        if (e.synthetic_reverse) continue;
        const g = cached.roads[e.id];
        if (
          x < g.minX - nearest ||
          x > g.maxX + nearest ||
          y < g.minY - nearest ||
          y > g.maxY + nearest
        )
          continue;
        for (let i = 1; i < e.geometry.length; i++) {
          const a = e.geometry[i - 1],
            b = e.geometry[i];
          const d = distanceToSegment(x, y, a.x_m, -a.y_m, b.x_m, -b.y_m);
          if (d < nearest) {
            nearest = d;
            key = `e${e.id}`;
            info = roadInspection(e, state.edges.get(e.id), topology);
          }
        }
      }
    }
    if (!info && footprint) {
      info = footprint.info;
      key = footprint.key;
    }
    if (!info && view.scale > 1)
      for (const n of topology.nodes)
        if (
          Math.hypot(n.position.x_m - x, -n.position.y_m - y) * view.scale <
          8
        ) {
          key = `n${n.id}`;
          info = {
            title: `Node N-${n.id}`,
            category: "Junction",
            metrics: [
              ["Connections", String(n.degree)],
              ["OSM node", String(n.osm_node_id)],
            ],
          };
          break;
        }
    if (!info && layers.weather)
      for (const w of snapshot?.active_weather ?? [])
        if (Math.hypot(w.x_m - x, -w.y_m - y) < w.radius_m) {
          key = `w${w.id}`;
          info = {
            title: `Rain region ${w.id}`,
            category: "Weather",
            metrics: [
              ["Intensity", `${(w.intensity * 100).toFixed(0)}%`],
              ["Radius", `${w.radius_m.toFixed(0)} m`],
            ],
            description:
              "Rainfall and flood consequences are calculated separately.",
          };
          break;
        }
    if (key === hoverKey.current) return;
    clearHover();
    hoverKey.current = key;
    if (info)
      timer.current = setTimeout(
        () => setHover({ info, x: clientX + 18, y: clientY + 16 }),
        280,
      );
  };
  const zoom = (factor: number, cx = size.w / 2, cy = size.h / 2) => {
    cancelGlide();
    clearHover();
    setView((v) => {
      const scale = Math.min(8, Math.max(0.025, v.scale * factor)),
        ratio = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  };
  useImperativeHandle(
    controls,
    () => ({
      zoomIn: () => zoom(1.3),
      zoomOut: () => zoom(1 / 1.3),
      fit,
      inspectFeature: (id: string) => {
        const feature = topology?.features.find((f) => f.id === id);
        if (!feature) return;
        const kind = placeKind(feature);
        const demand = state.demand.get(feature.id);
        // Anchored at the centre of the visible map area, where the camera is
        // gliding to, rather than at a stale pointer position.
        const layout = mapFitLayout(size.w, size.h);
        const rect = host.current?.getBoundingClientRect();
        setHover({
          info: {
            title: placeTitle(feature),
            category: kind.label,
            description: feature.id,
            metrics: [
              ["Demand multiplier", `${(demand?.multiplier ?? 1).toFixed(2)}×`],
              ["Demand active", demand?.active ? "Yes" : "No"],
            ],
          },
          x: (rect?.left ?? 0) + layout.centerX + 18,
          y: (rect?.top ?? 0) + layout.centerY,
        });
      },
    }),
    // zoom and inspection close over the current size and state, so refresh
    // the handle when any of them changes.
    [fit, size.w, size.h, topology, state],
  );
  // view.scale is pixels per metre, so its reciprocal is metres per pixel: the
  // figure the scale bar and the coordinate readout are drawn from.
  useEffect(() => {
    onView?.({ scale: view.scale, metresPerPixel: 1 / view.scale });
  }, [view.scale, onView]);
  const reportCursor = useCallback(
    (clientX: number, clientY: number) => {
      if (!onCursor) return;
      const el = host.current;
      const projection = topology?.projection;
      if (!el || !projection) return;
      const rect = el.getBoundingClientRect();
      // Screen -> metre space is the inverse of the canvas transform; metre
      // space -> degrees uses the core's own projection origin.
      const x_m = (clientX - rect.left - view.x) / view.scale;
      const y_m = -(clientY - rect.top - view.y) / view.scale;
      onCursor(metresToGeographic(x_m, y_m, projection));
    },
    [onCursor, topology?.projection, view.x, view.y, view.scale],
  );
  let hoverInfo = hover?.info;
  if (hover && topology) {
    const key = hoverKey.current;
    if (/^[ev][0-9]+$/.test(key)) {
      const edge = topology.edges[Number(key.slice(1))];
      if (edge) {
        const current = roadInspection(
          edge,
          state.edges.get(edge.id),
          topology,
        );
        hoverInfo = key.startsWith("v")
          ? { ...hover.info, metrics: current.metrics }
          : current;
      }
    } else if (/^s[0-9]+$/.test(key)) {
      const signal = state.signals.get(Number(key.slice(1)));
      if (signal)
        hoverInfo = {
          ...hover.info,
          status: signal.enabled ? signal.phase_name : "Disabled",
          description: `Group A (north/south): ${signal.group_a}. Group B (east/west): ${signal.group_b}.`,
          metrics: [
            [
              "Time in phase",
              signal.time_in_phase === null
                ? "Operator override"
                : `${signal.time_in_phase}s`,
            ],
            [
              "Next transition",
              signal.next_transition_at === null
                ? "Held by operator"
                : `${signal.next_transition_at}s virtual`,
            ],
            ["Cycle", `${signal.cycle_length}s`],
          ],
        };
    } else {
      const demand = state.demand.get(key);
      if (demand)
        hoverInfo = {
          ...hover.info,
          status: demand.active ? "Demand increase" : "Normal",
          metrics: [
            ["Demand multiplier", `${demand.multiplier.toFixed(2)}×`],
            ["Influence radius", `${demand.radius_m} m`],
          ],
        };
    }
  }
  return (
    <div className="network-map" ref={host}>
      <canvas ref={base} className="map-canvas static-map" aria-hidden="true" />
      <canvas
        ref={dynamic}
        className="map-canvas"
        tabIndex={0}
        aria-label="Simulation map. Drag to pan, scroll or press plus and minus to zoom, arrow keys to move. Hover entities to inspect. Place search is in the map dock."
        onWheel={(e) => {
          cancelGlide();
          const r = e.currentTarget.getBoundingClientRect();
          zoom(e.deltaY > 0 ? 0.9 : 1.1, e.clientX - r.left, e.clientY - r.top);
        }}
        onPointerDown={(e) => {
          cancelGlide();
          clearHover();
          drag.current = { x: e.clientX, y: e.clientY, view };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            setView({
              ...drag.current.view,
              x: drag.current.view.x + e.clientX - drag.current.x,
              y: drag.current.view.y + e.clientY - drag.current.y,
            });
          } else inspectAt(e.clientX, e.clientY);
          reportCursor(e.clientX, e.clientY);
        }}
        onPointerLeave={() => {
          clearHover();
          onCursor?.(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") clearHover();
          else if (e.key === "+" || e.key === "=") zoom(1.2);
          else if (e.key === "-") zoom(0.8);
          else if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            setView((v) => ({
              ...v,
              x:
                v.x +
                (e.key === "ArrowLeft" ? 40 : e.key === "ArrowRight" ? -40 : 0),
              y:
                v.y +
                (e.key === "ArrowUp" ? 40 : e.key === "ArrowDown" ? -40 : 0),
            }));
          }
        }}
      />
      <div className="map-attribution">
        © OpenStreetMap contributors · {topology?.source || "Awaiting network"}
      </div>
      {hover && <InfoCard {...hover} info={hoverInfo ?? hover.info} />}
      <div className="map-vignette" aria-hidden="true" />
    </div>
  );
}
export default memo(NetworkMap);
