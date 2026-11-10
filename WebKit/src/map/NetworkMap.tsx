// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { canvasGlyph } from "./placeGlyphs";
import { FlowTraffic } from "./flowTraffic";
import type { RoadFlow } from "./flowTraffic";
import { buildTiles, MARKER_BUDGET, placeNameShows, PLACE_NAME_BUDGET, sizeTier, STREET_NAME_BUDGET, streetNameShows, tierShows, tileOnScreen } from "./mapTiles";
import { animate, createVelocityTracker, SPRINGS, stepSpring } from "../CoreMotion/motion";
import { appearance } from "../core/appearance";
import { currentFeatures } from "../core/features";
import type { RainCells } from "../core/mapModel";
import { resistClamp, resistZoomOut, ZOOM_REST } from "../CoreMotion/resistance";
import type { SpringPreset } from "../CoreMotion/motion";
import { mapFitLayout, mapInsets, metresToGeographic } from "../core/mapProjection";
import { viewportFor } from "../notifications/autoFocus";
import type { Bounds } from "../notifications/autoFocus";
import { InfoCard, Tooltip } from "../components/Tooltip";
import {
  demandColor,
  distanceToSegment,
  insideFootprint,
  footprintOf,
  hasMarker,
  placeInspection,
  placeKind,
  roadInspection,
  roadState,
  stateColors,
  stepRainCells,
} from "../core/mapModel";
import type {
  EdgeState,
  IncidentState,
  MapFeature,
  Inspection,
  Layers,
  PlaceVisibility,
  Point,
  Snapshot,
  Topology,
  TopologyEdge,
} from "../core/types";

// Imperative handle so the alpha layout can host the map controls in its own
// floating dock instead of inside the canvas.
export type MapControls = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Show the inspection card for a place, as hovering it would. */
  inspectFeature: (id: string) => void;
};
const FOUND_FLASH_MS = 2400;
const FOUND_RGB = "255,196,77";

/** What the hover card says about an incident, in the same terms as a place. */
function incidentInspection(incident: IncidentState, edge: TopologyEdge, edgeState: EdgeState | undefined, topology: Topology): Inspection {
  const road = roadInspection(edge, edgeState, topology);
  const kind = incident.flood > 0.01 ? "Flooding" : incident.type ? incident.type.charAt(0).toUpperCase() + incident.type.slice(1).toLowerCase().replace(/_/g, " ") : "Incident";
  const effect = [
    incident.speed_multiplier !== undefined && !incident.closed ? `Traffic moves at ${Math.round(incident.speed_multiplier * 100)}% of its normal speed.` : "",
    incident.vehicle_count ? `Vehicles on this road: ${incident.vehicle_count.toLocaleString()}.` : "",
  ].filter(Boolean);
  return {
    ...road,
    title: `${kind} on ${edge.name || "an unnamed road"}`,
    category: "Incident",
    status: incident.closed ? "Road closed" : incident.flood > 0.01 ? "Flooded" : "Open, slowed",
    description: [incident.description && `${incident.description.replace(/\.$/, "")}.`, ...effect].filter(Boolean).join(" ") || road.description,
  };
}

/** Pixels per metre; a map point (x_m, y_m) sits at (x + x_m * scale, y - y_m * scale). */
export type MapTransform = { x: number; y: number; scale: number };
export type MapView = {
  scale: number;
  metresPerPixel: number;
};
type Props = {
  topology: Topology | null;
  snapshot: Snapshot | null;
  layers: Layers;
  /** Which place kinds to draw; a kind absent from this is drawn. */
  places: PlaceVisibility;
  reduceMotion: boolean;
  running: boolean;
  virtualTime: number;
  tickRate?: number;
  /**
   * Where the camera should glide to next; a new token starts a new glide.
   * `bounds` (metres, y north) frames an event's footprint; a point with a
   * scale centres on it.
   */
  focus?: { whole?: boolean; zoomBy?: number; span_m?: number; bounds?: Bounds; x_m?: number; y_m?: number; scale?: number; padding?: number; token: number } | null;
  /** True until the panels arrive: the network waits in the middle of the window. */
  arriving?: boolean;
  /** A person moved the camera, so nothing else should. */
  onCameraTaken?: () => void;
  controls?: RefObject<MapControls | null>;
  onView?: (view: MapView) => void;
  onTransform?: (view: MapTransform) => void;
  advanced?: boolean;
  /** Changes when the palette does, so the map repaints in the new colours. */
  appearanceKey?: number;
  /** Width taken from the map's left by an application's sidebar. */
  leftInset?: number;
  /** When a click is wanted as a place on the map, it goes here. Returns whether it was taken. */
  onMapPick?: (point: { x_m: number; y_m: number; lat?: number; lon?: number }) => boolean;
  onCursor?: (position: { lat: number; lon: number } | null) => void;
  /** The telemetry deck is collapsed to its strip, freeing the right side. */
  deckCompact?: boolean;
};
type View = { x: number; y: number; scale: number };
type Geo = {
  path: Path2D;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
/** Kinds kept on screen when zoomed out, because they orient the viewer. */
const LANDMARKS = new Set(["school", "university", "hospital", "mall", "transport"]);

/**
 * The extent of what is drawn, which is what looks centred or not: the roads, and the
 * buildings and land around them. A lake or a park may run on for kilometres past the
 * last road, so the land counts for a little beyond the roads and no further.
 */
function drawnBounds(roads: Geo[], land: Geo[]) {
  // A loop, because a large city's buildings are too many to spread into Math.min.
  const extent = (list: Geo[]) => {
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const g of list) {
      box.minX = Math.min(box.minX, g.minX);
      box.maxX = Math.max(box.maxX, g.maxX);
      box.minY = Math.min(box.minY, g.minY);
      box.maxY = Math.max(box.maxY, g.maxY);
    }
    return box;
  };
  const r = extent(roads);
  if (!land.length) return r;
  const l = extent(land);
  const padX = (r.maxX - r.minX) * 0.08;
  const padY = (r.maxY - r.minY) * 0.08;
  return {
    minX: Math.min(r.minX, Math.max(l.minX, r.minX - padX)),
    maxX: Math.max(r.maxX, Math.min(l.maxX, r.maxX + padX)),
    minY: Math.min(r.minY, Math.max(l.minY, r.minY - padY)),
    maxY: Math.max(r.maxY, Math.min(l.maxY, r.maxY + padY)),
  };
}

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
  places,
  reduceMotion,
  running,
  virtualTime,
  tickRate = 1,
  focus,
  controls,
  onView,
  onTransform,
  advanced = true,
  appearanceKey = 0,
  leftInset = 0,
  onMapPick,
  arriving = false,
  onCameraTaken,
  onCursor,
  deckCompact = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    base = useRef<HTMLCanvasElement>(null),
    slow = useRef<HTMLCanvasElement>(null),
    dynamic = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 }),
    [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  // The place last chosen from search, marked on the map until the map is next touched.
  const [found, setFound] = useState<{ feature: MapFeature; at: number; outline: Point[] | null } | null>(null);
  const [hover, setHover] = useState<{
    info: Inspection;
    x: number;
    y: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    hoverKey = useRef(""),
    drag = useRef<{ x: number; y: number; view: View } | null>(null);
  const vehicleMarkers = useRef<{ x: number; y: number; edge: number }[]>([]);
  const cached = useMemo(() => {
    if (!topology) return null;
    const roads = topology.edges.map((e) => geometry(e.geometry));
    const features = topology.features.map((f) => geometry(f.geometry, f.polygon));
    return { roads, features, bounds: drawnBounds(roads, features) };
  }, [topology]);
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
  // The core's figures for each road, which the markers on the map stand for.
  const flows = useMemo(() => {
    const out = new Map<number, RoadFlow>();
    for (const e of state.edges.values()) {
      out.set(e.id, { count: e.vehicle_count, speed: e.mean_speed_mps, signal: e.signal_multiplier, closed: e.closed });
    }
    return out;
  }, [state]);
  const traffic = useMemo(() => (topology ? new FlowTraffic(topology.edges) : null), [topology]);
  const trafficAt = useRef(0);
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
  // Read through a ref: collapsing the deck changes where the next framing
  // lands, but must not refit or move the map the operator is looking at.
  const leftRef = useRef(leftInset);
  const compactRef = useRef(deckCompact);
  compactRef.current = deckCompact;
  /** The view that frames `bounds` (metres, y north) clear of the chrome. */
  const viewForBounds = useCallback(
    (bounds: Bounds, padding: number, minSpan?: number): View => {
      const v = viewportFor(bounds, { width: size.w, height: size.h, insets: mapInsets(size.w, size.h, compactRef.current, leftRef.current) }, { padding, maxScale: 8, minScale: 0.025, minSpan });
      return { scale: v.scale, x: v.screen.x - v.centre.x * v.scale, y: v.screen.y + v.centre.y * v.scale };
    },
    [size],
  );
  const networkView = useCallback((): View | null => {
    if (!cached) return null;
    const b = cached.bounds;
    // Cached geometry is in canvas orientation (y down); bounds are y north.
    return viewForBounds({ minX: b.minX, maxX: b.maxX, minY: -b.maxY, maxY: -b.minY }, 0.03, 0);
  }, [cached, viewForBounds]);
  const fitScale = useRef(0);
  const arrivingRef = useRef(arriving);
  const centred = useRef(false);
  const fit = useCallback(() => {
    const next = networkView();
    if (next) {
      fitScale.current = next.scale;
      if (!arrivingRef.current || !cached) return setView(next);
      // Alone on screen, the network belongs in the middle of the window. It moves
      // over as the panels arrive.
      centred.current = true;
      const b = cached.bounds;
      const box = host.current?.getBoundingClientRect();
      setView({
        scale: next.scale,
        x: window.innerWidth / 2 - (box?.left ?? 0) - ((b.minX + b.maxX) / 2) * next.scale,
        y: window.innerHeight / 2 - (box?.top ?? 0) - ((b.minY + b.maxY) / 2) * next.scale,
      });
    }
  }, [networkView, cached, size]);
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
  // A pinch over the map zooms the map, not the page. Only here does a wheel have to be
  // able to refuse its default, so scrolling everywhere else stays with the compositor.
  useEffect(() => {
    const el = dynamic.current;
    if (!el) return;
    const refuse = (event: WheelEvent) => event.preventDefault();
    el.addEventListener("wheel", refuse, { passive: false });
    return () => el.removeEventListener("wheel", refuse);
  }, []);
  const visible = (g: Geo, pad = 20) =>
    g.maxX * view.scale + view.x >= -pad &&
    g.minX * view.scale + view.x <= size.w + pad &&
    g.maxY * view.scale + view.y >= -pad &&
    g.minY * view.scale + view.y <= size.h + pad;
  const setup = (canvas: HTMLCanvasElement) => {
    const dpr = Math.min(window.devicePixelRatio || 1, currentFeatures().presentation.render_scale);
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
  // ---- Geography, grouped once: see mapTiles.ts ------------------------------
  const baseTiles = useMemo(() => {
    if (!topology || !cached) return null;
    return {
      land: buildTiles(topology.features, (_, i) => cached.features[i], (f, i) => {
        if (!f.polygon) return null;
        const park = ["park", "grass", "forest", "recreation_ground"].includes(f.category);
        return `${park ? "park" : "land"}|${sizeTier(cached.features[i])}`;
      }),
      beds: buildTiles(topology.edges, (_, i) => cached.roads[i], (e) => (e.synthetic_reverse ? null : e.road_class === "primary" ? "wide" : "narrow")),
    };
  }, [topology, cached]);
  // What traffic has done to the roads, grouped once per snapshot rather than per frame.
  const roadTiles = useMemo(() => {
    if (!topology || !cached || !layers.roads) return [];
    return buildTiles(topology.edges, (_, i) => cached.roads[i], (e) => {
      if (e.synthetic_reverse) return null;
      const s = state.edges.get(e.id);
      let status = roadState(s);
      if (status === "flooded" && !layers.flooding) status = s?.closed ? "blocked" : s && s.congestion > 0.7 ? "severe" : s && s.congestion > 0.35 ? "moderate" : "clear";
      const weight = ["primary", "motorway"].includes(e.road_class) ? "major" : ["secondary", "tertiary"].includes(e.road_class) ? "mid" : e.road_class === "service" ? "service" : "minor";
      return `${layers.traffic ? status : "neutral"}|${weight}`;
    });
  }, [topology, cached, state, layers.roads, layers.traffic, layers.flooding]);
  // Which street names to try first: the important roads win the space.
  const nameOrder = useMemo(() => {
    if (!topology) return [];
    const rank = (road: string) => (["motorway", "primary"].includes(road) ? 0 : road === "secondary" ? 1 : road === "tertiary" ? 2 : 3);
    return topology.edges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.name && !e.synthetic_reverse && e.geometry.length >= 2)
      .sort((a, b) => rank(a.e.road_class) - rank(b.e.road_class));
  }, [topology]);

  useEffect(() => {
    if (!topology || !cached || !base.current || !baseTiles) return;
    const ctx = setup(base.current);
    if (!ctx) return;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    if (layers.buildings) {
      ctx.lineWidth = 0.7 / view.scale;
      ctx.strokeStyle = appearance.land.buildingLine;
      for (const tile of baseTiles.land) {
        if (!tileOnScreen(tile, view, size.w, size.h)) continue;
        for (const [key, path] of tile.batches) {
          const [kind, tier] = key.split("|") as ["park" | "land", "small" | "medium" | "large"];
          // Too small to see at this zoom: not drawn, as a map leaves out small buildings.
          if (!tierShows(tier, view.scale)) continue;
          ctx.fillStyle = kind === "park" ? appearance.land.park : appearance.land.land;
          ctx.fill(path);
          if (view.scale > 0.15) ctx.stroke(path);
        }
      }
    }
    ctx.strokeStyle = appearance.land.roadBed;
    for (const tile of baseTiles.beds) {
      if (!tileOnScreen(tile, view, size.w, size.h)) continue;
      for (const [key, path] of tile.batches) {
        ctx.lineWidth = (key === "wide" ? 5 : 3) / view.scale;
        ctx.stroke(path);
      }
    }
    ctx.restore();
  }, [topology, cached, baseTiles, view, size, layers.buildings, appearanceKey]); // Static geography never depends on a simulation tick.

  // The camera is moving: names wait until it stops, as they do on any good map.
  const lastView = useRef(view);
  const [settled, setSettled] = useState(0);
  // Roads, names, markers and signals. They change with a snapshot or the camera, so they
  // are drawn once for each, not on every frame of the flow markers above them.
  useEffect(() => {
    if (!topology || !cached || !slow.current) return;
    const ctx = setup(slow.current);
    if (!ctx) return;
    const moving = lastView.current !== view;
    lastView.current = view;
    const screen = (p: Point) => ({ x: p.x_m * view.scale + view.x, y: -p.y_m * view.scale + view.y });
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.lineCap = "round";
    for (const tile of roadTiles) {
      if (!tileOnScreen(tile, view, size.w, size.h)) continue;
      for (const [key, path] of tile.batches) {
        const [status, weight] = key.split("|");
        if (view.scale < 0.12 && (weight === "minor" || weight === "service")) continue;
        if (view.scale < 0.2 && weight === "service") continue;
        ctx.strokeStyle = status === "neutral" ? appearance.land.neutralRoad : stateColors[status as keyof typeof stateColors];
        ctx.globalAlpha = weight === "service" ? 0.45 : 0.83;
        ctx.lineWidth = (weight === "major" ? 2.5 : 1.3) / view.scale;
        ctx.stroke(path);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.font = "10px Inter";
    if (layers.labels && !moving) {
      const cells = new Set<string>();
      let written = 0;
      ctx.fillStyle = appearance.land.label;
      for (const { e, i } of nameOrder) {
        if (written >= STREET_NAME_BUDGET) break;
        if (!streetNameShows(e.road_class, view.scale) || !visible(cached.roads[i])) continue;
        const a = screen(e.geometry[0]),
          b = screen(e.geometry[e.geometry.length - 1]);
        if (Math.hypot(b.x - a.x, b.y - a.y) < 65) continue;
        const x = (a.x + b.x) / 2,
          y = (a.y + b.y) / 2,
          cell = `${Math.floor(x / 120)},${Math.floor(y / 35)}`;
        if (cells.has(cell)) continue;
        cells.add(cell);
        written++;
        ctx.fillText(e.name.slice(0, 30), x + 5, y - 5);
      }
    }
    const poiCells = new Set<string>();
    const nameCells = new Set<string>();
    const cellSize = view.scale < 0.3 ? 44 : 28;
    let shownNames = 0;
    markerHits.current.length = 0;
    // Setting the font makes the browser settle the page's styles, so it is done once, not per place.
    ctx.font = "bold 10px Inter";
    ctx.textAlign = "start";
    if (layers.buildings)
      topology.features.forEach((f, i) => {
        if (markerHits.current.length >= MARKER_BUDGET || !visible(cached.features[i])) return;
        const demand = state.demand.get(f.id);
        const kind = kinds[i];
        if (kind.group === "other" && !layers.other_places) return;
        // A kind absent from the record is drawn, so a kind added to the
        // taxonomy shows up without anyone having to opt in to it.
        if (places[kind.id] === false) return;
        // Zoomed out, keep only the landmarks that orient the operator and
        // anything currently drawing traffic.
        const landmark = LANDMARKS.has(kind.id);
        if (view.scale < 0.65 && !demand?.active && !landmark) return;
        if (!hasMarker(f)) return;
        const p = screen(f.position);
        const cell = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
        if (poiCells.has(cell)) return;
        poiCells.add(cell);
        markerHits.current.push({ x: p.x, y: p.y, index: i });
        // Modelled places carry the demand ramp: white at rest, warming
        // through amber to red at peak, then cooling back the same way.
        const multiplier = demand?.multiplier ?? 1;
        // Demand exists only where the core models it for this feature.
        const warm = !!demand && multiplier > 1.01;
        const tint = warm ? demandColor(multiplier) : appearance.land.marker;
        ctx.fillStyle = tint;
        ctx.strokeStyle = warm ? tint : appearance.land.markerLine;
        ctx.lineWidth = warm ? 1.6 : 1.2;
        ctx.beginPath();
        ctx.roundRect(p.x - 8, p.y - 8, 16, 16, 8);
        ctx.fill();
        ctx.stroke();
        // Keep the glyph readable against whatever the ramp produced.
        const ink = warm && multiplier > 1.35 ? "#071420" : warm ? "#31210a" : appearance.land.markerInk;
        const glyph = canvasGlyph(kind.id);
        if (glyph) {
          // The glyphs are drawn in the icon set's 24-unit box; scale that
          // box onto the marker so the map and the legend show one shape.
          ctx.save();
          ctx.translate(p.x - 7, p.y - 7);
          ctx.scale(14 / 24, 14 / 24);
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2.6;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          for (const path of glyph) ctx.stroke(path);
          ctx.restore();
        } else {
          // No Path2D here: a dot still says a place is present.
          ctx.fillStyle = ink;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        if (layers.place_names && !moving && f.name && shownNames < PLACE_NAME_BUDGET && placeNameShows(landmark, view.scale)) {
          const nameCell = `${Math.floor(p.x / 110)},${Math.floor(p.y / 18)}`;
          if (!nameCells.has(nameCell)) {
            nameCells.add(nameCell);
            shownNames++;
            ctx.fillStyle = appearance.land.label;
            ctx.fillText(f.name.slice(0, 24), p.x + 12, p.y + 3);
          }
        }
      });
      if (layers.signals && view.scale > 0.15)
        for (const signal of snapshot?.signals ?? []) {
          const node = topology.nodes[signal.junction_id];
          if (!node) continue;
          const p = screen(node.position);
          if (p.x < 0 || p.x > size.w || p.y < 0 || p.y > size.h) continue;
          ctx.fillStyle = appearance.land.signal;
          ctx.fillRect(p.x - 5, p.y - 7, 17, 12);
          [signal.group_a, signal.group_b].forEach((s, i) => {
            ctx.fillStyle = signal.enabled
              ? s === "green"
                ? stateColors.clear
                : s === "amber"
                  ? stateColors.moderate
                  : stateColors.severe
              : "#647681";
            ctx.beginPath();
            ctx.arc(p.x + i * 7, p.y - 1, 2.7, 0, Math.PI * 2);
            ctx.fill();
          });
        }
    if (moving) {
      const timer = setTimeout(() => setSettled((n) => n + 1), 140);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, cached, roadTiles, nameOrder, state, snapshot, view, size, layers, places, appearanceKey, settled]);

  // What actually moves between snapshots: rain, the pulse on incidents and flow markers.
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
      // Rain cells move, grow and fade on springs, between the core's once-a-second states.
      const paintedAt = performance.now();
      const rainNow = stepRainCells(rain.current, snapshot?.active_weather ?? [], reduceMotion ? 1000 : Math.min(0.05, (paintedAt - lastPaint.current) / 1000));
      lastPaint.current = paintedAt;
      if (layers.weather)
        for (const w of rainNow) {
          const fade = w.alpha;
          ctx.globalAlpha = fade;
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
          ctx.fillStyle = appearance.land.label;
          ctx.font = "10px Inter";
          ctx.fillText(`Rain ${(w.intensity * 100).toFixed(0)}%`, x + 8, y - r - 6);
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
      // Above roughly 10x real time individual markers move further than they
      // are wide each frame, so they read as noise. Spend the budget on fewer,
      // and let the measured cost pull it down further on heavy scenes.
      const rateFactor = tickRate <= 4 ? 1 : tickRate <= 10 ? 0.6 : 0.3;
      const markerBudget = Math.round(1500 * quality.current * rateFactor);
      let settling = false;
      if (traffic && layers.vehicles && !reduceMotion && view.scale > 0.25 && markerBudget > 0) {
        const now = performance.now();
        const real = Math.min(0.1, (now - trafficAt.current) / 1000);
        trafficAt.current = now;
        traffic.step(running ? real * tickRate : 0, real, flows, (edge) => visible(cached.roads[edge.id]), markerBudget);
        // Sized to the road as it is drawn, which does not widen as the map zooms: never smaller
        // than can be read, and never so large that a car dwarfs the street it is on.
        const halfLength = Math.min(7, Math.max(2.1, 2.3 * view.scale));
        const halfWidth = halfLength * 0.45;
        // Each direction keeps to its own side of the line.
        const lane = halfWidth + 0.8;
        const body = (x: number, y: number, cx: number, cy: number, from: number, to: number, side: number) => {
          // Along the vehicle from `from` to `to`, in halves of its length; across it by `side`.
          ctx.moveTo(x + cx * from * halfLength - cy * side * halfWidth, y + cy * from * halfLength + cx * side * halfWidth);
          ctx.lineTo(x + cx * to * halfLength - cy * side * halfWidth, y + cy * to * halfLength + cx * side * halfWidth);
          ctx.lineTo(x + cx * to * halfLength + cy * side * halfWidth, y + cy * to * halfLength - cx * side * halfWidth);
          ctx.lineTo(x + cx * from * halfLength + cy * side * halfWidth, y + cy * from * halfLength - cx * side * halfWidth);
          // Only ever filled, and a fill closes each shape itself: closing thousands of them by hand was the map's
          // single largest cost.
        };
        const sx = (m: { x: number; angle: number }) => m.x * view.scale + view.x + Math.sin(m.angle) * lane;
        const sy = (m: { y: number; angle: number }) => -m.y * view.scale + view.y + Math.cos(m.angle) * lane;
        // The solid ones at once, as one path. Only those fading need an alpha of their own.
        ctx.fillStyle = appearance.land.flow;
        ctx.beginPath();
        for (const m of traffic.markers) {
          if (m.alpha < 1) {
            settling = true;
            continue;
          }
          const x = sx(m);
          const y = sy(m);
          vehicleMarkers.current.push({ x, y, edge: m.edge });
          body(x, y, Math.cos(m.angle), -Math.sin(m.angle), -1, 1, 1);
        }
        ctx.fill();
        for (const m of traffic.markers) {
          if (m.alpha >= 1) continue;
          ctx.globalAlpha = m.alpha;
          ctx.beginPath();
          body(sx(m), sy(m), Math.cos(m.angle), -Math.sin(m.angle), -1, 1, 1);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        // Near enough to see one: a windscreen, and which way it faces.
        if (halfLength > 4.4) {
          ctx.fillStyle = appearance.land.roadBed;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          for (const m of traffic.markers) {
            if (m.alpha >= 1) body(sx(m), sy(m), Math.cos(m.angle), -Math.sin(m.angle), 0.18, 0.56, 0.74);
          }
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // Brake lights, wherever one is slowing or waiting.
        ctx.fillStyle = appearance.meaning.severe;
        ctx.beginPath();
        for (const m of traffic.markers) {
          if (m.braking && m.alpha >= 1) body(sx(m), sy(m), Math.cos(m.angle), -Math.sin(m.angle), -1, -0.68, 1);
        }
        ctx.fill();
      }
      // Aim to spend under 8ms drawing, leaving the rest of a 60Hz frame for
      // compositing and the rest of the page. Recover slowly, shed fast.
      const cost = performance.now() - drawStarted;
      quality.current = Math.min(
        1,
        Math.max(0.12, quality.current * (cost > 11 ? 0.82 : cost < 5 ? 1.05 : 1)),
      );
      ctx.globalAlpha = 1;
      const flashing = !!found && !reduceMotion && performance.now() - found.at < FOUND_FLASH_MS;
      if (found) {
        const age = reduceMotion ? FOUND_FLASH_MS : performance.now() - found.at;
        const p = screen(found.feature.position);
        // Three flashes, then it stays lit.
        const lit = age < FOUND_FLASH_MS ? 0.35 + 0.65 * Math.abs(Math.cos((age / FOUND_FLASH_MS) * Math.PI * 3)) : 1;
        if (found.outline) {
          // The whole building, traced round its walls as it is found, then lit, with a soft glow while it flashes.
          const corners = found.outline.map(screen);
          let perimeter = 0;
          corners.forEach((q, i) => (perimeter += Math.hypot(q.x - corners[(i + 1) % corners.length].x, q.y - corners[(i + 1) % corners.length].y)));
          const traced = reduceMotion ? 1 : 1 - (1 - Math.min(1, age / 700)) ** 3;
          ctx.beginPath();
          corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.closePath();
          ctx.fillStyle = `rgba(${FOUND_RGB},${0.2 * traced * lit})`;
          ctx.fill();
          ctx.save();
          ctx.lineJoin = "round";
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = `rgba(${FOUND_RGB},${0.55 + 0.45 * lit})`;
          if (flashing) {
            ctx.shadowColor = `rgba(${FOUND_RGB},${0.6 * lit})`;
            ctx.shadowBlur = 16;
          }
          if (traced < 1) ctx.setLineDash([perimeter * traced, perimeter]);
          ctx.stroke();
          ctx.restore();
        } else {
          // A place with no building of its own: a ring concentric with its marker, and nothing larger.
          ctx.strokeStyle = `rgba(${FOUND_RGB},${0.55 + 0.45 * lit})`;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.roundRect(p.x - 13, p.y - 13, 26, 26, 13);
          ctx.stroke();
        }
      }
      // A camera move redraws at once through this effect, and rain on a spring asks for
      // every frame.
      const moving = rainNow.some((cell) => cell.moving);
      if (moving || flashing) frame = requestAnimationFrame(draw);
      else if (running && !reduceMotion && (layers.vehicles || (snapshot?.active_incidents.length ?? 0) > 0)) {
        // Every frame while it can afford to; a heavy scene falls back to every other. The operator may fix either.
        const fps = currentFeatures().presentation.map_fps;
        if (fps === 60 || (fps !== 30 && quality.current >= 0.7) || settling) frame = requestAnimationFrame(draw);
        else frame = requestAnimationFrame(() => (frame = requestAnimationFrame(draw)));
      } else if (settling) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [
    topology,
    cached,
    snapshot,
    state,
    view,
    size,
    layers,
    places,
    reduceMotion,
    running,
    found,
    flows,
    traffic,
    virtualTime,
    tickRate,
  ]);
  // Smooth camera glide. The operator is carried to an event rather than
  // teleported: the view eases over a duration scaled to the distance, and any
  // manual pan, zoom or drag cancels it immediately.
  const coasting = useRef<(() => void) | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // The markers actually drawn, in screen space, so pointing at an icon is pointing
  // at that place and not at whatever footprint happens to lie beneath it.
  const markerHits = useRef<{ x: number; y: number; index: number }[]>([]);
  const trackX = useRef(createVelocityTracker());
  const trackY = useRef(createVelocityTracker());
  const dragMoved = useRef(false);
  const rain = useRef<RainCells>(new Map());
  const lastPaint = useRef(performance.now());
  // The camera runs on three springs: the centre in map space, and zoom on a log
  // scale so it feels uniform in speed. They hold their velocity, so a new target
  // redirects a move in flight rather than stopping and restarting it.
  const camera = useRef<{ cx: number; cy: number; zoom: number; vx: number; vy: number; vz: number; tx: number; ty: number; tz: number; preset: SpringPreset; cancel: () => void } | null>(null);
  const cancelGlide = useCallback(() => {
    camera.current?.cancel();
    camera.current = null;
    coasting.current?.();
    coasting.current = null;
  }, []);
  useEffect(() => cancelGlide, [cancelGlide]);
  const glideTo = useCallback(
    (target: View, preset: SpringPreset = SPRINGS.camera) => {
      coasting.current?.();
      coasting.current = null;
      if (reduceMotion) {
        cancelGlide();
        setView(target);
        return;
      }
      const layout = mapFitLayout(size.w, size.h, compactRef.current, leftRef.current);
      const current = viewRef.current;
      const tx = (layout.centerX - target.x) / target.scale;
      const ty = (layout.centerY - target.y) / target.scale;
      const tz = Math.log(target.scale);
      if (camera.current) {
        Object.assign(camera.current, { tx, ty, tz, preset });
        return;
      }
      const state = {
        cx: (layout.centerX - current.x) / current.scale,
        cy: (layout.centerY - current.y) / current.scale,
        zoom: Math.log(current.scale),
        vx: 0, vy: 0, vz: 0, tx, ty, tz, preset,
        cancel: () => {},
      };
      camera.current = state;
      state.cancel = animate((dt) => {
        [state.cx, state.vx] = stepSpring(state.cx, state.vx, state.tx, state.preset, dt);
        [state.cy, state.vy] = stepSpring(state.cy, state.vy, state.ty, state.preset, dt);
        [state.zoom, state.vz] = stepSpring(state.zoom, state.vz, state.tz, state.preset, dt);
        const scale = Math.exp(state.zoom);
        const place = mapFitLayout(size.w, size.h, compactRef.current, leftRef.current);
        // Half a screen pixel and barely moving: as good as there.
        const settled =
          Math.hypot(state.cx - state.tx, state.cy - state.ty) * scale < 0.5 &&
          Math.abs(state.zoom - state.tz) < 0.001 &&
          Math.hypot(state.vx, state.vy) * scale < 5 &&
          Math.abs(state.vz) < 0.01;
        if (settled) {
          camera.current = null;
          const final = Math.exp(state.tz);
          setView({ scale: final, x: place.centerX - state.tx * final, y: place.centerY - state.ty * final });
          return false;
        }
        setView({ scale, x: place.centerX - state.cx * scale, y: place.centerY - state.cy * scale });
        return true;
      });
    },
    [cancelGlide, reduceMotion, size.w, size.h],
  );
  // How far the network may be dragged: part of it stays on screen. Past that it
  // resists, and springs back on release.
  const panLimits = useCallback(
    (scale: number) => {
      if (!cached) return null;
      const b = cached.bounds;
      const margin = 60;
      return {
        minX: margin - b.maxX * scale,
        maxX: size.w - margin - b.minX * scale,
        minY: margin - b.maxY * scale,
        maxY: size.h - margin - b.minY * scale,
      };
    },
    [cached, size.w, size.h],
  );
  const settlePan = useCallback(() => {
    const limits = panLimits(viewRef.current.scale);
    if (!limits) return;
    const v = viewRef.current;
    const x = Math.min(limits.maxX, Math.max(limits.minX, v.x));
    const y = Math.min(limits.maxY, Math.max(limits.minY, v.y));
    if (x !== v.x || y !== v.y) glideTo({ scale: v.scale, x, y }, SPRINGS.spatialSlow);
  }, [panLimits, glideTo]);
  // Released with speed, the map coasts to rest under friction.
  const coast = useCallback(
    (vx: number, vy: number) => {
      cancelGlide();
      if (reduceMotion || Math.hypot(vx, vy) < 80) {
        settlePan();
        return;
      }
      coasting.current = animate((dt) => {
        const decay = Math.exp(-5.5 * dt);
        vx *= decay;
        vy *= decay;
        const v = viewRef.current;
        const limits = panLimits(v.scale);
        const out = limits && (v.x < limits.minX || v.x > limits.maxX || v.y < limits.minY || v.y > limits.maxY);
        if (out || Math.hypot(vx, vy) < 12) {
          coasting.current = null;
          settlePan();
          return false;
        }
        setView((c) => ({ ...c, x: c.x + vx * dt, y: c.y + vy * dt }));
        return true;
      });
    },
    [cancelGlide, reduceMotion, panLimits, settlePan],
  );
  // An application's sidebar taking or giving back room refits what is on screen.
  useEffect(() => {
    if (leftRef.current === leftInset) return;
    leftRef.current = leftInset;
    const next = networkView();
    if (next) {
      fitScale.current = next.scale;
      glideTo(next, SPRINGS.spatialSlow);
    }
  }, [leftInset, networkView, glideTo]);
  useEffect(() => {
    arrivingRef.current = arriving;
    if (arriving || !centred.current) return;
    centred.current = false;
    const next = networkView();
    if (next) glideTo(next, SPRINGS.spatialSlow);
  }, [arriving, networkView, glideTo]);
  useEffect(() => {
    if (!focus || !size.w) return;
    if (focus.whole) {
      const next = networkView();
      if (next) glideTo(next, SPRINGS.spatialSlow);
      return;
    }
    if (focus.bounds) {
      glideTo(viewForBounds(focus.bounds, focus.padding ?? 0.18));
      return;
    }
    const layout = mapFitLayout(size.w, size.h, compactRef.current, leftRef.current);
    // What an application asks for stays within what a person could reach with a gesture.
    const within = (asked: number) => Math.min(8, Math.max(fitScale.current ? fitScale.current * ZOOM_REST : 0.025, asked));
    if (focus.zoomBy) {
      const from = viewRef.current;
      const scale = within(from.scale * focus.zoomBy);
      const ratio = scale / from.scale;
      glideTo({ scale, x: layout.centerX - (layout.centerX - from.x) * ratio, y: layout.centerY - (layout.centerY - from.y) * ratio });
      return;
    }
    if (focus.x_m === undefined || focus.y_m === undefined) return;
    const scale = focus.span_m ? within(size.w / focus.span_m) : focus.scale ?? viewRef.current.scale;
    glideTo({ scale, x: layout.centerX - focus.x_m * scale, y: layout.centerY + focus.y_m * scale });
    // Only a new token starts a glide; view changes during it must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token, size.w, size.h]);

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
    // Incidents are drawn over everything, so they are found before anything under them.
    if (layers.events || layers.incidents)
      for (const incident of snapshot?.active_incidents ?? []) {
        const edge = topology.edges[incident.edge_id];
        if (!edge?.geometry.length) continue;
        const a = edge.geometry[0],
          b = edge.geometry[edge.geometry.length - 1];
        if (Math.hypot((a.x_m + b.x_m) / 2 - x, -(a.y_m + b.y_m) / 2 - y) * view.scale < 18) {
          key = `i${edge.id}`;
          info = incidentInspection(incident, edge, state.edges.get(edge.id), topology);
          break;
        }
      }
    if (!info && layers.buildings) {
      let nearest = 15;
      let hit = -1;
      for (const marker of markerHits.current) {
        const distance = Math.hypot(marker.x + rect.left - clientX, marker.y + rect.top - clientY);
        if (distance < nearest) {
          nearest = distance;
          hit = marker.index;
        }
      }
      if (hit >= 0) {
        const f = topology.features[hit];
        key = f.id;
        info = placeInspection(f, state.demand.get(f.id));
      }
    }
    if (!info && layers.signals && view.scale > 0.15)
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
          category: "Modelled flow",
          description:
            "Representative flow marker from aggregate count and speed. Individual vehicle position and identity are not tracked.",
        };
      }
    }
    if (!info && advanced && view.scale > 1)
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
        if (kinds[i]?.group === "other" && !layers.other_places && !f.polygon) continue;
        // A nameless outline with no demand has nothing to say: "Residential" is not
        // what someone pointing at the map wants to read.
        if (!f.name?.trim() && !f.demand_type) continue;
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
          key = f.id;
          info = placeInspection(f, state.demand.get(f.id));
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
  // Zooming accumulates on the value it is heading for, so a burst of wheel
  // events is one smooth move about the pointer, not a series of steps.
  const zoomTarget = useRef<View | null>(null);
  const rawScale = useRef<number | null>(null);
  const zoom = (factor: number, cx = size.w / 2, cy = size.h / 2) => {
    clearHover();
    onCameraTaken?.();
    const from = camera.current && zoomTarget.current ? zoomTarget.current : viewRef.current;
    const fitted = fitScale.current ? networkView() : null;
    const rest = fitScale.current * ZOOM_REST;
    // Asked-for zoom is kept apart from what is shown: past fit, the map resists
    // however hard it is pushed, and turning back answers immediately.
    const asked = Math.min(8, Math.max(Math.max(0.005, rest * 0.75), (from.scale < rest && rawScale.current) || from.scale) * factor);
    rawScale.current = asked;
    const scale = fitScale.current ? resistZoomOut(asked, fitScale.current) : Math.max(0.025, asked);
    const ratio = scale / from.scale;
    const target = { scale, x: cx - (cx - from.x) * ratio, y: cy - (cy - from.y) * ratio };
    // Zooming out brings the whole network back to the middle as it comes into view,
    // so nothing has to move once the gesture stops.
    if (factor < 1 && fitted) {
      const near = Math.min(1, Math.max(0, 3 - (2 * scale) / fitted.scale));
      const layout = mapFitLayout(size.w, size.h, compactRef.current, leftRef.current);
      target.x += (layout.centerX - (layout.centerX - fitted.x) * (scale / fitted.scale) - target.x) * near;
      target.y += (layout.centerY - (layout.centerY - fitted.y) * (scale / fitted.scale) - target.y) * near;
    }
    zoomTarget.current = target;
    glideTo(target, SPRINGS.cameraZoom);
  };
  useImperativeHandle(
    controls,
    () => ({
      zoomIn: () => zoom(1.3),
      zoomOut: () => zoom(1 / 1.3),
      fit: () => {
        onCameraTaken?.();
        const next = networkView();
        if (next) glideTo(next);
      },
      inspectFeature: (id: string) => {
        const feature = topology?.features.find((f) => f.id === id);
        if (!feature) return;
        // Anchored at the centre of the visible map area, where the camera is
        // gliding to, rather than at a stale pointer position.
        const layout = mapFitLayout(size.w, size.h, compactRef.current, leftRef.current);
        const rect = host.current?.getBoundingClientRect();
        setFound({ feature, at: performance.now(), outline: footprintOf(feature, topology?.features ?? []) });
        setHover({
          info: placeInspection(feature, state.demand.get(feature.id)),
          x: (rect?.left ?? 0) + layout.centerX + 18,
          y: (rect?.top ?? 0) + layout.centerY,
        });
      },
    }),
    // zoom and inspection close over the current size and state, so refresh
    // the handle when any of them changes.
    [networkView, glideTo, size.w, size.h, topology, state],
  );
  // view.scale is pixels per metre, so its reciprocal is metres per pixel: the
  // figure the scale bar and the coordinate readout are drawn from.
  useEffect(() => {
    onView?.({ scale: view.scale, metresPerPixel: 1 / view.scale });
  }, [view.scale, onView]);
  // Every frame of a pan or glide: handed straight to whatever draws over the
  // map, because routing it through React state would re-render the whole shell.
  useLayoutEffect(() => {
    onTransform?.(view);
  }, [view, onTransform]);
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
    } else if (/^i[0-9]+$/.test(key)) {
      const edge = topology.edges[Number(key.slice(1))];
      const incident = snapshot?.active_incidents.find((i) => i.edge_id === edge?.id);
      if (edge && incident) hoverInfo = incidentInspection(incident, edge, state.edges.get(edge.id), topology);
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
      <canvas ref={slow} className="map-canvas map-slow" aria-hidden="true" />
      <canvas
        ref={dynamic}
        className="map-canvas"
        tabIndex={0}
        aria-label="Simulation map. Drag to pan, scroll or press plus and minus to zoom, arrow keys to move. Hover entities to inspect. Place search is in the map dock."
        onWheel={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // In proportion to the gesture: a trackpad sends dozens of small events, a pinch
          // smaller ones still, and a wheel a few large ones.
          zoom(2 ** (-e.deltaY * (e.deltaMode ? 120 : 1) * (e.ctrlKey ? 0.02 : 0.002)), e.clientX - r.left, e.clientY - r.top);
        }}
        onPointerDown={(e) => {
          cancelGlide();
          clearHover();
          setFound(null);
          drag.current = { x: e.clientX, y: e.clientY, view };
          trackX.current.reset();
          trackY.current.reset();
          dragMoved.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          const started = drag.current;
          drag.current = null;
          if (!dragMoved.current && started && onMapPick) {
            const r = e.currentTarget.getBoundingClientRect();
            const x_m = (e.clientX - r.left - view.x) / view.scale;
            const y_m = -(e.clientY - r.top - view.y) / view.scale;
            const place = topology?.projection ? metresToGeographic(x_m, y_m, topology.projection) : undefined;
            if (onMapPick({ x_m, y_m, lat: place?.lat, lon: place?.lon })) return;
          }
          // A pause before letting go means the map was placed, not thrown.
          coast(trackX.current.velocity(), trackY.current.velocity());
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            if (!dragMoved.current && Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) > 3) {
              dragMoved.current = true;
              onCameraTaken?.();
            }
            trackX.current.add(e.clientX, e.timeStamp);
            trackY.current.add(e.clientY, e.timeStamp);
            const rawX = drag.current.view.x + e.clientX - drag.current.x;
            const rawY = drag.current.view.y + e.clientY - drag.current.y;
            const limits = panLimits(drag.current.view.scale);
            setView({
              ...drag.current.view,
              x: limits ? resistClamp(rawX, limits.minX, limits.maxX, 90) : rawX,
              y: limits ? resistClamp(rawY, limits.minY, limits.maxY, 90) : rawY,
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
            onCameraTaken?.();
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
      {hover && <InfoCard {...hover} info={advanced ? hoverInfo ?? hover.info : { ...(hoverInfo ?? hover.info), metrics: undefined, technical: undefined }} />}
      <div className="map-vignette" aria-hidden="true" />
    </div>
  );
}
export default memo(NetworkMap);
