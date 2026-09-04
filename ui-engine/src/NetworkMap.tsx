import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Snapshot, Topology, TopologyNode, TopologyEdge, EdgeState } from './types';

function drawMapPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  type: 'bus' | 'school' | 'office' | 'mall' | 'store'
) {
  const pinRadius = 7.5;
  const pinHeight = 18;
  const headCenterY = y - pinHeight + pinRadius;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  // Pin teardrop body pointing down to (x, y)
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x + pinRadius * 1.05, y - pinRadius * 0.9, x + pinRadius, headCenterY + pinRadius * 0.5, x + pinRadius, headCenterY);
  ctx.arc(x, headCenterY, pinRadius, 0, Math.PI, true);
  ctx.bezierCurveTo(x - pinRadius, headCenterY + pinRadius * 0.5, x - pinRadius * 1.05, y - pinRadius * 0.9, x, y);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // White inner vector icon centered at (x, headCenterY)
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.0;

  if (type === 'bus') {
    ctx.beginPath();
    ctx.roundRect(x - 3.5, headCenterY - 4, 7, 8, 1);
    ctx.stroke();
    ctx.fillRect(x - 2.5, headCenterY - 3, 5, 2.2);
    ctx.beginPath();
    ctx.arc(x - 2, headCenterY + 2.5, 0.8, 0, Math.PI * 2);
    ctx.arc(x + 2, headCenterY + 2.5, 0.8, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'school') {
    ctx.beginPath();
    ctx.moveTo(x, headCenterY - 3.5);
    ctx.lineTo(x + 4, headCenterY - 1);
    ctx.lineTo(x, headCenterY + 1.5);
    ctx.lineTo(x - 4, headCenterY - 1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 2.5, headCenterY);
    ctx.lineTo(x - 2.5, headCenterY + 3);
    ctx.lineTo(x + 2.5, headCenterY + 3);
    ctx.lineTo(x + 2.5, headCenterY);
    ctx.stroke();
  } else if (type === 'office') {
    ctx.strokeRect(x - 3.5, headCenterY - 4, 7, 8);
    ctx.fillRect(x - 2.2, headCenterY - 2.8, 1.6, 1.6);
    ctx.fillRect(x + 0.6, headCenterY - 2.8, 1.6, 1.6);
    ctx.fillRect(x - 2.2, headCenterY + 0.2, 1.6, 1.6);
    ctx.fillRect(x + 0.6, headCenterY + 0.2, 1.6, 1.6);
  } else if (type === 'mall') {
    ctx.beginPath();
    ctx.roundRect(x - 3.5, headCenterY - 1.5, 7, 5.5, 1);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, headCenterY - 1.5, 2.0, Math.PI, 0, false);
    ctx.stroke();
  } else if (type === 'store') {
    ctx.beginPath();
    ctx.moveTo(x - 4, headCenterY - 1);
    ctx.lineTo(x + 4, headCenterY - 1);
    ctx.lineTo(x + 3.2, headCenterY + 3.5);
    ctx.lineTo(x - 3.2, headCenterY + 3.5);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 4.5, headCenterY - 1);
    ctx.lineTo(x - 3.5, headCenterY - 3.5);
    ctx.lineTo(x + 3.5, headCenterY - 3.5);
    ctx.lineTo(x + 4.5, headCenterY - 1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

type Props = {
  topology: Topology | null;
  snapshot: Snapshot | null;
  osm: boolean;
  running: boolean;
  virtualDaySeconds?: number;
  tickRate?: number;
  selectedEdge?: TopologyEdge | null;
  reduceMotion?: boolean;
  focusTarget?: { lon: number; lat: number; zoom?: number; token: number } | null;
  onSelect: (n: TopologyNode | null) => void;
  onSelectEdge?: (e: TopologyEdge | null) => void;
};

interface VehicleParticle {
  id: number;
  edgeId: number;
  progress: number;
  speedFactor: number;
  isHalted: boolean;
}

interface RoadHierarchyStyle {
  casingWidth: number;
  coreWidth: number;
  casingColor: string;
  defaultColor: string;
  label: string;
}

const ROAD_HIERARCHY: Record<string, RoadHierarchyStyle> = {
  motorway: { casingWidth: 9.0, coreWidth: 5.5, casingColor: '#0b0f19', defaultColor: '#f97316', label: 'Motorway / Highway' },
  primary: { casingWidth: 6.8, coreWidth: 4.2, casingColor: '#0f172a', defaultColor: '#f59e0b', label: 'Primary Arterial' },
  secondary: { casingWidth: 5.2, coreWidth: 3.2, casingColor: '#1e293b', defaultColor: '#94a3b8', label: 'Secondary Avenue' },
  tertiary: { casingWidth: 4.0, coreWidth: 2.4, casingColor: '#334155', defaultColor: '#cbd5e1', label: 'Tertiary Street' },
  residential: { casingWidth: 3.0, coreWidth: 1.8, casingColor: '#475569', defaultColor: '#e2e8f0', label: 'Residential Street' },
  service: { casingWidth: 2.0, coreWidth: 1.2, casingColor: '#64748b', defaultColor: '#f8fafc', label: 'Access / Service' }
};

function getRoadStyle(roadClass: string): RoadHierarchyStyle {
  const key = roadClass.toLowerCase();
  return ROAD_HIERARCHY[key] || ROAD_HIERARCHY['residential'];
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function NetworkMap({
  topology,
  snapshot,
  running,
  virtualDaySeconds = 0,
  tickRate = 1.0,
  selectedEdge,
  reduceMotion = false,
  focusTarget = null,
  onSelect,
  onSelectEdge
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [hoveredEdge, setHoveredEdge] = useState<TopologyEdge | null>(null);
  const [hoveredNode, setHoveredNode] = useState<TopologyNode | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  // Pan & Zoom state
  const [transform, setTransform] = useState({ scale: 1, panX: 0, panY: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  // Store vehicle particles matching exact internal count
  const vehiclesRef = useRef<VehicleParticle[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(performance.now());
  const pulsePhaseRef = useRef<number>(0);

  // Compute map bounding box
  const bounds = useMemo(() => {
    if (!topology || !topology.nodes || topology.nodes.length === 0) return null;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const n of topology.nodes) {
      if (n.position.lon < minLon) minLon = n.position.lon;
      if (n.position.lon > maxLon) maxLon = n.position.lon;
      if (n.position.lat < minLat) minLat = n.position.lat;
      if (n.position.lat > maxLat) maxLat = n.position.lat;
    }
    for (const e of topology.edges) {
      for (const p of e.geometry) {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
      }
    }
    const dLon = maxLon - minLon || 0.01;
    const dLat = maxLat - minLat || 0.01;
    return {
      minLon: minLon - dLon * 0.05,
      maxLon: maxLon + dLon * 0.05,
      minLat: minLat - dLat * 0.05,
      maxLat: maxLat + dLat * 0.05,
      spanLon: dLon * 1.1,
      spanLat: dLat * 1.1
    };
  }, [topology]);

  // Transform coordinates (lon, lat) to screen (sx, sy)
  const project = useCallback((lon: number, lat: number, width: number, height: number) => {
    if (!bounds) return { x: width / 2, y: height / 2 };
    const padding = 50;
    const availW = width - padding * 2;
    const availH = height - padding * 2;
    const scaleFactor = Math.min(availW / bounds.spanLon, availH / bounds.spanLat);

    const baseCenterX = width / 2;
    const baseCenterY = height / 2;
    const centerLon = (bounds.minLon + bounds.maxLon) / 2;
    const centerLat = (bounds.minLat + bounds.maxLat) / 2;

    const rawX = baseCenterX + (lon - centerLon) * scaleFactor;
    const rawY = baseCenterY - (lat - centerLat) * scaleFactor;

    return {
      x: (rawX - width / 2) * transform.scale + width / 2 + transform.panX,
      y: (rawY - height / 2) * transform.scale + height / 2 + transform.panY
    };
  }, [bounds, transform]);

  // Sync vehicles pool to match EXACT internal simulation engine count 1-to-1
  useEffect(() => {
    if (!topology || !topology.edges || topology.edges.length === 0 || !snapshot || !snapshot.edges) {
      return;
    }

    const currentVehicles = vehiclesRef.current;
    const vehiclesByEdge = new Map<number, VehicleParticle[]>();
    for (const v of currentVehicles) {
      const list = vehiclesByEdge.get(v.edgeId) || [];
      list.push(v);
      vehiclesByEdge.set(v.edgeId, list);
    }

    const nextVehicles: VehicleParticle[] = [];
    let particleIdSeq = currentVehicles.length > 0 ? Math.max(...currentVehicles.map(v => v.id)) + 1 : 1;

    for (const es of snapshot.edges) {
      const targetCount = es.vehicle_count;
      const existing = vehiclesByEdge.get(es.id) || [];

      if (existing.length <= targetCount) {
        nextVehicles.push(...existing);
        const toAdd = targetCount - existing.length;
        for (let i = 0; i < toAdd; i++) {
          nextVehicles.push({
            id: particleIdSeq++,
            edgeId: es.id,
            progress: (i + Math.random() * 0.7) / Math.max(1, targetCount),
            speedFactor: 0.82 + Math.random() * 0.36,
            isHalted: false
          });
        }
      } else {
        // Excess vehicles: keep the ones with earliest progress
        existing.sort((a, b) => a.progress - b.progress);
        nextVehicles.push(...existing.slice(0, targetCount));
      }
    }

    vehiclesRef.current = nextVehicles;
  }, [topology, snapshot]);

  // Reset viewport zoom/pan
  const handleResetView = () => {
    setTransform({ scale: 1, panX: 0, panY: 0 });
  };

  // Center & zoom on focus target event
  useEffect(() => {
    if (!focusTarget || !bounds || !containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    const padding = 50;
    const availW = width - padding * 2;
    const availH = height - padding * 2;
    const scaleFactor = Math.min(availW / bounds.spanLon, availH / bounds.spanLat);
    const baseCenterX = width / 2;
    const baseCenterY = height / 2;
    const centerLon = (bounds.minLon + bounds.maxLon) / 2;
    const centerLat = (bounds.minLat + bounds.maxLat) / 2;

    const rawX = baseCenterX + (focusTarget.lon - centerLon) * scaleFactor;
    const rawY = baseCenterY - (focusTarget.lat - centerLat) * scaleFactor;
    const targetScale = focusTarget.zoom ?? 2.8;

    setTransform({
      scale: targetScale,
      panX: -(rawX - width / 2) * targetScale,
      panY: -(rawY - height / 2) * targetScale
    });
  }, [focusTarget, bounds]);

  // Main canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let active = true;

    const render = (now: number) => {
      if (!active) return;
      const dt = Math.min((now - lastTickRef.current) / 1000, 0.1);
      lastTickRef.current = now;
      pulsePhaseRef.current = (pulsePhaseRef.current + dt * 1.8) % (Math.PI * 2);

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // 1. Crisp Professional Background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      // Subtle modern engineering grid
      ctx.strokeStyle = '#f1f5f9';
      ctx.lineWidth = 1;
      const gridSize = 40 * transform.scale;
      const startX = (transform.panX % gridSize + gridSize) % gridSize;
      const startY = (transform.panY % gridSize + gridSize) % gridSize;
      ctx.beginPath();
      for (let x = startX; x < width; x += gridSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = startY; y < height; y += gridSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();

      if (!topology || !topology.nodes.length) {
        ctx.restore();
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      const edgeStateMap = new Map<number, EdgeState>();
      if (snapshot && snapshot.edges) {
        for (const e of snapshot.edges) edgeStateMap.set(e.id, e);
      }

      const edgeLookup = new Map<number, TopologyEdge>();
      for (const e of topology.edges) edgeLookup.set(e.id, e);

      const nodeLookup = new Map<number, TopologyNode>();
      for (const n of topology.nodes) nodeLookup.set(n.id, n);

      // Build outgoing edge map for vehicle branching
      const outgoingMap = new Map<number, number[]>();
      for (const e of topology.edges) {
        const list = outgoingMap.get(e.from) || [];
        list.push(e.id);
        outgoingMap.set(e.from, list);
      }

      // 2. Active Rain Storms (Prolonged, Dynamic Radius, Translucent Oceanic Blue, Drifting Epicenter)
      const weatherEvents = snapshot?.active_weather ?? [];
      const pulse = (Math.sin(pulsePhaseRef.current) + 1) / 2; // 0..1

      for (const w of weatherEvents) {
        const center = project(w.lon, w.lat, width, height);
        const rEdge = project(w.lon + (w.radius_m / 111320), w.lat, width, height);
        const radiusPx = Math.max(30, Math.abs(rEdge.x - center.x));

        // Translucent gradient storm body
        const grad = ctx.createRadialGradient(center.x, center.y, radiusPx * 0.15, center.x, center.y, radiusPx);
        grad.addColorStop(0, `rgba(2, 132, 199, ${Math.min(0.42, 0.15 + w.intensity * 0.28)})`);
        grad.addColorStop(0.7, `rgba(14, 165, 233, ${Math.min(0.25, 0.08 + w.intensity * 0.18)})`);
        grad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');

        ctx.beginPath();
        ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Dashed storm boundary
        ctx.beginPath();
        ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Animated propagating rain pulse wave
        const pulseR = radiusPx * (0.2 + pulse * 0.85);
        ctx.beginPath();
        ctx.arc(center.x, center.y, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(56, 189, 248, ${0.45 * (1 - pulse)})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Drifting epicenter marker with wind drift vector
        ctx.beginPath();
        ctx.arc(center.x, center.y, 5.0, 0, Math.PI * 2);
        ctx.fillStyle = '#0369a1';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.0;
        ctx.stroke();
      }

      // 3. Roads: SUMO-GUI Road Hierarchy
      // Pass 3a: Selected Road Glow Halo
      if (selectedEdge && selectedEdge.geometry && selectedEdge.geometry.length >= 2) {
        ctx.beginPath();
        const p0 = project(selectedEdge.geometry[0].lon, selectedEdge.geometry[0].lat, width, height);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < selectedEdge.geometry.length; i++) {
          const pi = project(selectedEdge.geometry[i].lon, selectedEdge.geometry[i].lat, width, height);
          ctx.lineTo(pi.x, pi.y);
        }
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 14;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // Pass 3b: Solid Black / Slate Casings with Class-Specific Widths
      for (const edge of topology.edges) {
        if (!edge.geometry || edge.geometry.length < 2) continue;
        const style = getRoadStyle(edge.road_class);

        ctx.beginPath();
        const p0 = project(edge.geometry[0].lon, edge.geometry[0].lat, width, height);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < edge.geometry.length; i++) {
          const pi = project(edge.geometry[i].lon, edge.geometry[i].lat, width, height);
          ctx.lineTo(pi.x, pi.y);
        }
        ctx.strokeStyle = style.casingColor;
        ctx.lineWidth = style.casingWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // Pass 3c: Dynamic Inner Cores (Highway / Arterial / Congestion Colors)
      for (const edge of topology.edges) {
        if (!edge.geometry || edge.geometry.length < 2) continue;
        const style = getRoadStyle(edge.road_class);
        const es = edgeStateMap.get(edge.id);

        let coreColor = style.defaultColor;
        if (es?.closed) {
          coreColor = '#dc2626'; // Impassable / Closed
        } else if ((es?.flood ?? 0) > 0.35) {
          coreColor = '#2563eb'; // Flooded
        } else {
          const cong = es?.congestion ?? 0;
          if (cong >= 0.75) coreColor = '#ef4444'; // Severe Congestion
          else if (cong >= 0.40) coreColor = '#f59e0b'; // Moderate Traffic
          else if (cong >= 0.15) coreColor = '#06b6d4'; // Active Flow
          else coreColor = '#10b981'; // Free Flow
        }

        ctx.beginPath();
        const p0 = project(edge.geometry[0].lon, edge.geometry[0].lat, width, height);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < edge.geometry.length; i++) {
          const pi = project(edge.geometry[i].lon, edge.geometry[i].lat, width, height);
          ctx.lineTo(pi.x, pi.y);
        }
        ctx.strokeStyle = coreColor;
        ctx.lineWidth = style.coreWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // Pass 3d: Hovered Road Highlight
      if (hoveredEdge && hoveredEdge.id !== selectedEdge?.id && hoveredEdge.geometry.length >= 2) {
        ctx.beginPath();
        const p0 = project(hoveredEdge.geometry[0].lon, hoveredEdge.geometry[0].lat, width, height);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < hoveredEdge.geometry.length; i++) {
          const pi = project(hoveredEdge.geometry[i].lon, hoveredEdge.geometry[i].lat, width, height);
          ctx.lineTo(pi.x, pi.y);
        }
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // 4. Traffic Signals and Vehicles Micro-Simulation
      const effectiveTick = running ? tickRate : 0;

      // Determine signal state per signalized node
      const signalStateMap = new Map<number, { isEWGreen: boolean; isNSGreen: boolean }>();
      for (const node of topology.nodes) {
        if (!node.signal) continue;
        const cycle = 60;
        const cycleSec = (virtualDaySeconds + node.id * 7) % cycle;
        const isEWGreen = cycleSec < 27;
        const isNSGreen = cycleSec >= 30 && cycleSec < 57;
        signalStateMap.set(node.id, { isEWGreen, isNSGreen });
      }

      // Advance and Render Every Single Simulated Vehicle (1-to-1 matching internal counter)
      for (const v of vehiclesRef.current) {
        const edge = edgeLookup.get(v.edgeId);
        if (!edge || !edge.geometry || edge.geometry.length < 2) continue;

        const es = edgeStateMap.get(edge.id);
        const lenM = Math.max(10, edge.length_m);
        const baseSpeed = es ? es.effective_speed_mps : edge.free_speed_mps;

        // Micro-simulation: Check traffic signal at edge terminus
        let mustHalt = false;
        const termNode = nodeLookup.get(edge.to);
        if (termNode && termNode.signal) {
          const sig = signalStateMap.get(termNode.id);
          if (sig) {
            // Check edge heading
            const geom = edge.geometry;
            const lastP = geom[geom.length - 1];
            const prevP = geom[geom.length - 2];
            const dx = Math.abs(lastP.lon - prevP.lon);
            const dy = Math.abs(lastP.lat - prevP.lat);
            const isEW = dx >= dy;
            const signalRed = isEW ? !sig.isEWGreen : !sig.isNSGreen;

            // Decelerate and stop at red light near intersection
            if (signalRed && v.progress >= 0.82) {
              mustHalt = true;
            }
          }
        }

        // Check congestion queue halting
        if (!mustHalt && es && (es.halting_count ?? 0) > 0) {
          const queueRatio = Math.min(0.85, (es.halting_count ?? 0) / Math.max(1, es.vehicle_count));
          const queueThreshold = 1.0 - queueRatio * 0.75;
          if (v.progress >= queueThreshold) {
            mustHalt = true;
          }
        }

        v.isHalted = mustHalt;

        // Vehicle advances according to speed variation and simulation tick rate
        if (!mustHalt && effectiveTick > 0) {
          const vehicleSpeed = baseSpeed * v.speedFactor * effectiveTick;
          v.progress += (vehicleSpeed * dt) / lenM;
        }

        // When vehicle reaches end of edge, choose next connected downstream road
        if (v.progress >= 1.0) {
          v.progress = 0;
          const nextCandidates = outgoingMap.get(edge.to);
          if (nextCandidates && nextCandidates.length > 0) {
            v.edgeId = nextCandidates[Math.floor(Math.random() * nextCandidates.length)];
          } else {
            v.edgeId = topology.edges[Math.floor(Math.random() * topology.edges.length)].id;
          }
        }

        // In Reduce Motion mode, only render 25% of vehicles on the GUI
        if (reduceMotion && v.id % 4 !== 0) {
          continue;
        }

        // Interpolate along multi-segment curved polyline
        const geom = edge.geometry;
        const totalSegments = geom.length - 1;
        const segIdx = Math.min(Math.floor(v.progress * totalSegments), totalSegments - 1);
        const segT = (v.progress * totalSegments) - segIdx;

        const p1 = project(geom[segIdx].lon, geom[segIdx].lat, width, height);
        const p2 = project(geom[segIdx + 1].lon, geom[segIdx + 1].lat, width, height);

        const vx = p1.x + (p2.x - p1.x) * segT;
        const vy = p1.y + (p2.y - p1.y) * segT;

        // Render Vehicle Dot: Modern indigo particle with white core (or glowing brake amber when halting)
        ctx.beginPath();
        ctx.arc(vx, vy, 4.0, 0, Math.PI * 2);
        ctx.fillStyle = v.isHalted ? '#f59e0b' : '#6366f1';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // 5. Intersections, Signals & POI Badges
      for (const node of topology.nodes) {
        const pt = project(node.position.lon, node.position.lat, width, height);

        // 5a. Traffic Signal Heads
        if (node.signal) {
          const sig = signalStateMap.get(node.id);
          const isGreen = sig ? (sig.isEWGreen || sig.isNSGreen) : true;

          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = '#0f172a';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3.4, 0, Math.PI * 2);
          ctx.fillStyle = isGreen ? '#10b981' : '#ef4444';
          ctx.fill();
          continue;
        }

        // 5b. Bus Stop Teardrop Pin with White Bus Icon
        if (node.bus_stop) {
          drawMapPin(ctx, pt.x, pt.y, '#0891b2', 'bus');
          continue;
        }

        // 5c. Building POI Teardrop Pins (School, Office, Mall, Store) with White Vector Icons
        if (node.building) {
          const btype = node.building.toLowerCase();
          let bColor = '#4f46e5';
          let pinType: 'school' | 'office' | 'mall' | 'store' = 'store';

          if (btype === 'school') {
            bColor = '#d97706'; // Amber School
            pinType = 'school';
          } else if (btype === 'office') {
            bColor = '#475569'; // Slate Office
            pinType = 'office';
          } else if (btype === 'mall') {
            bColor = '#9333ea'; // Purple Mall
            pinType = 'mall';
          } else if (btype === 'store' || btype === 'shop') {
            bColor = '#059669'; // Emerald Shop
            pinType = 'store';
          }

          drawMapPin(ctx, pt.x, pt.y, bColor, pinType);
          continue;
        }

        // 5d. Minor intersection junction dot
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.0, 0, Math.PI * 2);
        ctx.fillStyle = '#334155';
        ctx.fill();
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      active = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [topology, snapshot, bounds, transform, project, selectedEdge, hoveredEdge, running, virtualDaySeconds, tickRate, reduceMotion]);

  // Road & Node mouse hit-testing
  const findEntityAt = useCallback((clientX: number, clientY: number): { edge: TopologyEdge | null; node: TopologyNode | null } => {
    const canvas = canvasRef.current;
    if (!canvas || !topology) return { edge: null, node: null };
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const width = rect.width;
    const height = rect.height;

    // 1. Check POI Nodes first
    for (const node of topology.nodes) {
      if (node.bus_stop || node.building || node.signal) {
        const pt = project(node.position.lon, node.position.lat, width, height);
        const headY = pt.y - 10.5;
        if (Math.hypot(px - pt.x, py - headY) <= 12 || Math.hypot(px - pt.x, py - pt.y) <= 12) {
          return { edge: null, node };
        }
      }
    }

    // 2. Check Roads
    let closestEdge: TopologyEdge | null = null;
    let minDistance = 16;
    for (const edge of topology.edges) {
      if (!edge.geometry || edge.geometry.length < 2) continue;
      for (let i = 0; i < edge.geometry.length - 1; i++) {
        const p1 = project(edge.geometry[i].lon, edge.geometry[i].lat, width, height);
        const p2 = project(edge.geometry[i + 1].lon, edge.geometry[i + 1].lat, width, height);
        const d = distToSegment(px, py, p1.x, p1.y, p2.x, p2.y);
        if (d < minDistance) {
          minDistance = d;
          closestEdge = edge;
        }
      }
    }
    return { edge: closestEdge, node: null };
  }, [topology, project]);

  // Mouse Move: Hover detection & Tooltip
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      setTransform(prev => ({ ...prev, panX: prev.panX + dx, panY: prev.panY + dy }));
      return;
    }

    const { edge, node } = findEntityAt(e.clientX, e.clientY);
    setHoveredEdge(edge);
    setHoveredNode(node);

    const rect = canvasRef.current?.getBoundingClientRect();
    const tipX = e.clientX - (rect?.left ?? 0) + 14;
    const tipY = e.clientY - (rect?.top ?? 0) - 10;

    if (node) {
      const lines: string[] = [];
      let title = `Node #${node.id}`;
      if (node.bus_stop) {
        title = `Bus Stop · Node #${node.id}`;
        lines.push('Commute Rush: 07:30–09:30 & 16:30–19:00');
        lines.push('Status: Active Transit Station');
      } else if (node.building) {
        const b = node.building.toUpperCase();
        title = `${b} · Node #${node.id}`;
        if (b === 'SCHOOL') lines.push('Peak Hours: 07:45–09:15 & 14:30–16:00 (+45% congestion)');
        else if (b === 'OFFICE') lines.push('Peak Hours: 08:15–10:00 & 17:00–19:30 (+55% congestion)');
        else if (b === 'MALL') lines.push('Peak Hours: 12:00–14:00 & 18:00–21:30 (+40% congestion)');
        else if (b === 'STORE') lines.push('Peak Hours: 11:00–20:00 (+35% congestion)');
      } else if (node.signal) {
        title = `Traffic Signal · Node #${node.id}`;
        lines.push('Deterministic 60s Cycle (Coordinated)');
      }
      setTooltip({ x: tipX, y: tipY, title, lines });
    } else if (edge) {
      const es = snapshot?.edges.find(ed => ed.id === edge.id);
      const speedKmH = Math.round((es?.effective_speed_mps ?? edge.free_speed_mps) * 3.6);
      const freeKmH = Math.round(edge.free_speed_mps * 3.6);
      const vehicles = es?.vehicle_count ?? 0;
      const congPct = Math.round((es?.congestion ?? 0) * 100);
      const style = getRoadStyle(edge.road_class);

      setTooltip({
        x: tipX,
        y: tipY,
        title: `Road #${edge.id} (${style.label})`,
        lines: [
          `Speed: ${speedKmH} km/h (Limit: ${freeKmH} km/h)`,
          `Vehicles on segment: ${vehicles}`,
          `Congestion Level: ${congPct}%`,
          es?.closed ? 'Status: IMPASSABLE / CLOSED' : ((es?.flood ?? 0) > 0.35 ? 'Status: FLOOD HAZARD' : 'Status: OPEN')
        ]
      });
    } else {
      setTooltip(null);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 0) {
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      const moved = Math.hypot(e.clientX - dragStartRef.current.x, e.clientY - dragStartRef.current.y);
      isDraggingRef.current = false;
      if (moved < 5) {
        const { edge, node } = findEntityAt(e.clientX, e.clientY);
        if (edge) {
          if (onSelectEdge) onSelectEdge(edge);
          if (onSelect && topology) {
            const fromNode = topology.nodes.find(n => n.id === edge.from) ?? null;
            onSelect(fromNode);
          }
        } else if (node) {
          onSelect(node);
        }
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const width = rect.width;
    const height = rect.height;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.88;
    setTransform(prev => {
      const newScale = Math.max(0.4, Math.min(prev.scale * zoomFactor, 8.0));
      const ratio = newScale / prev.scale;
      const newPanX = mx - width / 2 - (mx - width / 2 - prev.panX) * ratio;
      const newPanY = my - height / 2 - (my - height / 2 - prev.panY) * ratio;
      return {
        scale: newScale,
        panX: newPanX,
        panY: newPanY
      };
    });
  };

  return (
    <div ref={containerRef} className="map-container" style={{ position: 'relative', width: '100%', height: '100%', background: '#ffffff', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: (hoveredEdge || hoveredNode) ? 'pointer' : isDraggingRef.current ? 'grabbing' : 'grab'
        }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* Floating Rich Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            pointerEvents: 'none',
            background: 'rgba(15, 23, 42, 0.95)',
            color: '#f8fafc',
            padding: '7px 12px',
            borderRadius: '7px',
            fontSize: '11px',
            fontFamily: 'Manrope, sans-serif',
            boxShadow: '0 6px 18px rgba(0,0,0,0.28)',
            border: '1px solid rgba(56, 189, 248, 0.45)',
            zIndex: 10,
            whiteSpace: 'nowrap'
          }}
        >
          <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: 2 }}>{tooltip.title}</div>
          {tooltip.lines.map((line, idx) => (
            <div key={idx} style={{ color: '#cbd5e1', fontSize: '10.5px' }}>{line}</div>
          ))}
        </div>
      )}

      {/* Modern Floating Map Navigation Controls */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          right: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          zIndex: 8
        }}
      >
        <button
          type="button"
          onClick={() => setTransform(prev => ({ ...prev, scale: Math.min(prev.scale * 1.25, 6) }))}
          title="Zoom In"
          style={{
            width: 32,
            height: 32,
            padding: 0,
            background: '#ffffff',
            color: '#0f172a',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
            fontSize: 16,
            fontWeight: 700
          }}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setTransform(prev => ({ ...prev, scale: Math.max(prev.scale * 0.8, 0.4) }))}
          title="Zoom Out"
          style={{
            width: 32,
            height: 32,
            padding: 0,
            background: '#ffffff',
            color: '#0f172a',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
            fontSize: 16,
            fontWeight: 700
          }}
        >
          −
        </button>
        <button
          type="button"
          onClick={handleResetView}
          title="Reset View to Full Network"
          style={{
            width: 32,
            height: 32,
            padding: 0,
            background: '#ffffff',
            color: '#0f172a',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
            fontSize: 13
          }}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
