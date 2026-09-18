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
  distanceToSegment,
  insideFootprint,
  roadInspection,
  roadState,
  stateColors,
} from "./mapModel";
import type { Inspection, Layers, Point, Snapshot, Topology } from "./types";

// Imperative handle so the alpha layout can host the map controls in its own
// floating dock instead of inside the canvas.
export type MapControls = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
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
const poiIcon = (category: string) =>
  ({
    school: "S",
    college: "S",
    university: "U",
    hospital: "H",
    mall: "M",
    office: "O",
    station: "T",
    bus_station: "B",
    park: "P",
  })[category] || "•";
function NetworkMap({
  topology,
  snapshot,
  layers,
  reduceMotion,
  running,
  virtualTime,
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
    } | null>(null),
    [query, setQuery] = useState("");
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
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
          gradient.addColorStop(
            0,
            `rgba(55,215,255,${0.06 + w.intensity * 0.16})`,
          );
          gradient.addColorStop(1, "rgba(55,215,255,0)");
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.setLineDash([3, 6]);
          ctx.strokeStyle = "#37d7ff66";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#b2ebff";
          ctx.font = "10px Inter";
          ctx.fillText(`Rain ${(w.intensity * 100).toFixed(0)}%`, x + 8, y - 8);
        }
      const labels = new Set<string>();
      ctx.font = "10px Inter";
      if (view.scale > 0.3)
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
          if (
            view.scale < 0.65 &&
            !demand?.active &&
            ![
              "school",
              "hospital",
              "university",
              "college",
              "station",
              "mall",
            ].includes(f.category)
          )
            return;
          if (f.polygon && !demand) return;
          const p = screen(f.position);
          const cell = `${Math.floor(p.x / 28)},${Math.floor(p.y / 28)}`;
          if (poiCells.has(cell)) return;
          poiCells.add(cell);
          ctx.fillStyle = demand?.active ? "#ff6577" : "#162e3b";
          ctx.strokeStyle = demand?.active ? "#ffb4ab" : "#638591";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.roundRect(p.x - 8, p.y - 8, 16, 16, 5);
          ctx.fill();
          ctx.stroke();
          ctx.font = "bold 10px Inter";
          ctx.textAlign = "center";
          ctx.fillStyle = demand?.active ? "#071420" : "#d7e4f5";
          ctx.fillText(poiIcon(f.category), p.x, p.y + 3);
          ctx.textAlign = "start";
          if (view.scale > 1 && f.name) {
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
      if (layers.events)
        for (const inc of snapshot?.active_incidents ?? []) {
          const e = topology.edges[inc.edge_id];
          if (!e) continue;
          const a = screen(e.geometry[0]),
            b = screen(e.geometry[e.geometry.length - 1]);
          const x = (a.x + b.x) / 2,
            y = (a.y + b.y) / 2;
          ctx.fillStyle = inc.flood > 0.01 ? "#4ba9ff" : "#ff6577";
          ctx.beginPath();
          ctx.moveTo(x, y - 9);
          ctx.lineTo(x + 8, y + 6);
          ctx.lineTo(x - 8, y + 6);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#071420";
          ctx.font = "bold 10px Inter";
          ctx.fillText("!", x - 2, y + 3);
        }
      vehicleMarkers.current = [];
      if (layers.traffic && !reduceMotion && view.scale > 0.25) {
        let count = 0;
        const time =
          virtualTime +
          (running ? Math.min(1, (performance.now() - received) / 1000) : 0);
        for (const e of topology.edges) {
          const s = state.edges.get(e.id);
          if (
            e.synthetic_reverse ||
            !s?.vehicle_count ||
            !visible(cached.roads[e.id])
          )
            continue;
          const a = screen(e.geometry[0]),
            b = screen(e.geometry[e.geometry.length - 1]);
          const n = Math.min(5, s.vehicle_count);
          for (let i = 0; i < n && count < 1500; i++, count++) {
            const progress =
              ((i + 0.5) / n +
                (time * s.mean_speed_mps) / Math.max(1, e.length_m)) %
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
  ]);
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
    if (!info && layers.traffic && !reduceMotion) {
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
            title: f.name || `Unnamed ${f.category}`,
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
    }),
    // zoom closes over the current size, so refresh the handle when either changes.
    [fit, size.w, size.h],
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
  const results = useMemo(
    () =>
      query.trim() && topology
        ? topology.features
            .filter((f) =>
              (f.name + " " + f.category + " " + f.id)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .slice(0, 6)
        : [],
    [topology, query],
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
        aria-label="Simulation map. Drag to pan, scroll or press plus and minus to zoom. Hover entities to inspect. Search places for keyboard inspection."
        onWheel={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          zoom(e.deltaY > 0 ? 0.9 : 1.1, e.clientX - r.left, e.clientY - r.top);
        }}
        onPointerDown={(e) => {
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
      <div className="place-search glass">
        <label className="sr-only" htmlFor="place-search">
          Search places
        </label>
        <input
          id="place-search"
          placeholder="Search places / POIs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results.length > 0 && (
          <ul>
            {results.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => {
                    setView((v) => ({
                      ...v,
                      scale: Math.max(v.scale, 1),
                      x: size.w / 2 - f.position.x_m * Math.max(v.scale, 1),
                      y: size.h / 2 + f.position.y_m * Math.max(v.scale, 1),
                    }));
                    setHover({
                      info: {
                        title: f.name || `Unnamed ${f.category}`,
                        category: f.category,
                        description: f.id,
                        metrics: [
                          [
                            "Demand multiplier",
                            `${(state.demand.get(f.id)?.multiplier ?? 1).toFixed(2)}×`,
                          ],
                        ],
                      },
                      x: size.w / 2 + 18,
                      y: size.h / 2,
                    });
                    setQuery("");
                  }}
                >
                  {f.name || f.category}
                  <small>{f.id}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="map-attribution">
        © OpenStreetMap contributors · {topology?.source || "Awaiting network"}
      </div>
      {hover && <InfoCard {...hover} info={hoverInfo ?? hover.info} />}
      <div className="map-vignette" aria-hidden="true" />
    </div>
  );
}
export default memo(NetworkMap);
