import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { NetworkMap } from './NetworkMap';
import type { Envelope, News, Snapshot, Status, Topology, TopologyNode, TopologyEdge } from './types';
import './style.css';

const fmt = (x: number) => `${Math.round(x * 100)}%`;

export function sanitizeNumericSeed(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    const hex = trimmed.slice(2).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (hex.length >= 128) return `0x${hex.slice(0, 128)}`;
    return `0x${hex.padEnd(32, '0')}`;
  }
  const digits = input.replace(/\D/g, '');
  if (digits.length >= 128) return digits.slice(0, 128);
  if (digits.length >= 16) return digits;
  return digits.padEnd(16, '0');
}

export function generateRandomSeed128(differentFrom = ''): string {
  let result = '';
  do {
    const arr = new Uint8Array(64); // 64 bytes = 128 hex chars
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    result = '0x' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  } while (result === differentFrom);
  return result;
}

export function formatSeedForDisplay(seed: string): string {
  if (seed.length > 24) {
    return `${seed.slice(0, 14)}...${seed.slice(-6)}`;
  }
  return seed;
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.min(3600, Math.max(60, Math.round(value)));
}

function peakHoursFor(node: TopologyNode, dayMode: 0 | 1 = 0): string {
  if (node.bus_stop) {
    return dayMode === 1 ? '11:00–14:00 & 17:00–20:00 (Weekend Leisure)' : '07:30–09:30 & 16:30–19:00 (Weekday Commute)';
  }
  switch (node.building?.toLowerCase()) {
    case 'school':
      return dayMode === 1 ? 'Weekend Recess (-70% traffic)' : '07:45–09:15 & 14:30–16:00 (+45% congestion)';
    case 'office':
      return dayMode === 1 ? 'Weekend Minimal (-60% demand)' : '08:15–10:00 & 17:00–19:30 (+55% congestion)';
    case 'mall':
      return dayMode === 1 ? '12:00–16:00 & 18:00–22:30 (Weekend Peak +80%)' : '12:00–14:00 & 18:00–21:30 (+40% congestion)';
    case 'store':
    case 'shop':
      return dayMode === 1 ? '11:00–21:30 (Weekend Shopping +50%)' : '11:00–20:00 (+35% congestion)';
    default:
      return 'Standard flow profile';
  }
}

interface DwsEventItem {
  id: number;
  epicenter_node: number;
  startTime: string;
  start_sec: number;
  end_sec: number;
  start_ppm: number;
  end_ppm: number;
  intensity: number;
  radius_m: number;
  active: boolean;
}

function extractLocation(n: News): { type: 'node' | 'edge'; id: number } | null {
  if (n.data?.epicenter !== undefined && n.data.epicenter !== null) return { type: 'node', id: Number(n.data.epicenter) };
  if (n.data?.node_id !== undefined && n.data.node_id !== null) return { type: 'node', id: Number(n.data.node_id) };
  if (n.data?.edge_id !== undefined && n.data.edge_id !== null) return { type: 'edge', id: Number(n.data.edge_id) };
  const nodeMatch = n.message.match(/Node\s+#?(\d+)/i);
  if (nodeMatch) return { type: 'node', id: parseInt(nodeMatch[1], 10) };
  const edgeMatch = n.message.match(/Edge\s+#?(\d+)/i);
  if (edgeMatch) return { type: 'edge', id: parseInt(edgeMatch[1], 10) };
  return null;
}

// Modern SVG Icons
function NetworkBrandIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="7" height="7" rx="1.5" fill="rgba(69, 202, 212, 0.15)" stroke="#45cad4" />
      <rect x="15" y="2" width="7" height="7" rx="1.5" fill="rgba(69, 202, 212, 0.15)" stroke="#45cad4" />
      <rect x="15" y="15" width="7" height="7" rx="1.5" fill="rgba(69, 202, 212, 0.15)" stroke="#45cad4" />
      <rect x="2" y="15" width="7" height="7" rx="1.5" fill="rgba(69, 202, 212, 0.15)" stroke="#45cad4" />
      <path d="M5.5 9v6M18.5 9v6M9 5.5h6M9 18.5h6" stroke="#45cad4" strokeWidth="1.5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
    </svg>
  );
}

function TerminateIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function DiceIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="3" />
      <path d="M12 12h.01" strokeWidth="3" />
      <path d="M16 16h.01" strokeWidth="3" />
      <path d="M8 8h.01" strokeWidth="3" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  );
}

function MotionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h5l3-7 4 14 3-7h5" />
    </svg>
  );
}

function VehiclesIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 15h12M4 9l3-5h10l3 5v6H4V9z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ReportIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function EventIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function AlertTriangleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case 'weather':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
          <path d="M16 14v6" />
          <path d="M8 14v6" />
          <path d="M12 16v6" />
        </svg>
      );
    case 'traffic':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 2.8C2.1 11 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </svg>
      );
    case 'transit':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="16" height="16" x="4" y="3" rx="2" />
          <path d="M4 11h16" />
          <path d="M8 19v2" />
          <path d="M16 19v2" />
          <circle cx="8" cy="15" r="1" />
          <circle cx="16" cy="15" r="1" />
        </svg>
      );
    case 'safety':
    case 'incident':
    case 'incidents':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case 'signals':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="8" height="18" x="8" y="3" rx="2" />
          <circle cx="12" cy="7" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="17" r="1.5" />
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
}

function ModuleIcon({ name }: { name: string }) {
  switch (name.toLowerCase()) {
    case 'traffic':
      return <CategoryIcon category="traffic" />;
    case 'signals':
      return <CategoryIcon category="signals" />;
    case 'buildings':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01" />
        </svg>
      );
    case 'dws':
      return <CategoryIcon category="weather" />;
    case 'flooding':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
        </svg>
      );
    case 'news':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
          <path d="M18 14h-8M15 18h-5M10 6h8v4h-8V6Z" />
        </svg>
      );
    default:
      return <CategoryIcon category="default" />;
  }
}

export default function App() {
  const [status, setStatus] = useState<Envelope<Status> | null>(null);
  const [topology, setTopology] = useState<Topology | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [news, setNews] = useState<News[]>([]);
  const [dwsEvents, setDwsEvents] = useState<DwsEventItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<TopologyEdge | null>(null);

  // 128-Character Scenario Seed (Full hex in footer/reports, formatted in input)
  const [seed, setSeed] = useState<string>(() => '0x5089050192221083c848bf3e12e22a4f90112233445566778899aabbccddeeff');
  const [seedInput, setSeedInput] = useState<string>(() => '0x5089050192221083c848bf3e12e22a4f90112233445566778899aabbccddeeff');

  const [duration, setDuration] = useState(120);
  const [dayMode, setDayMode] = useState<0 | 1>(0);
  const [seek, setSeek] = useState('12:00:00');
  const [terminated, setTerminated] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [stackTab, setStackTab] = useState<'dws' | 'events' | 'incidents'>('dws');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceVehicles, setReduceVehicles] = useState(false);
  const [facilitiesExpanded, setFacilitiesExpanded] = useState(false);
  const [focusTarget, setFocusTarget] = useState<{ lon: number; lat: number; zoom?: number; token: number } | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportMapScreenshot, setReportMapScreenshot] = useState<string | null>(null);
  const [showTransitModal, setShowTransitModal] = useState(false);
  const [dispatchedBuses, setDispatchedBuses] = useState<Array<{
    busId: string;
    label: string;
    nodeRoute: number[];
    edgeRoute: number[];
    currentEdgeIndex: number;
    progress: number;
    totalDistanceM: number;
    isHalted: boolean;
  }>>([]);

  const lastNewsIdRef = useRef<number>(0);
  const currentRunIdRef = useRef<string>('');

  const refresh = useCallback(async () => {
    if (terminated) return;
    try {
      const s = await api.status();
      setStatus(s);
      setError('');

      if (!['IDLE', 'STOPPED', 'COMPLETED'].includes(s.data.lifecycle) && (s.data.day === 0 || s.data.day === 1)) {
        setDayMode(s.data.day);
      }

      const incomingRunId = s.run_id || (s.data as Status)?.run_id || '';
      if (incomingRunId && incomingRunId !== currentRunIdRef.current) {
        currentRunIdRef.current = incomingRunId;
        lastNewsIdRef.current = 0;
        setNews([]);
        setFocusTarget(null);
        setSelectedNode(null);
        setSelectedEdge(null);
        setTopology(null);
      }

      // Fetch live snapshot and latest news continuously
      const [snap, n] = await Promise.all([
        api.snapshot(),
        api.news(lastNewsIdRef.current)
      ]);
      setSnapshot(snap.data);

      const incomingItems: News[] = [];
      if (n.data.items && n.data.items.length > 0) {
        for (const item of n.data.items) {
          incomingItems.push(item);
          if (item.news_id > lastNewsIdRef.current) {
            lastNewsIdRef.current = item.news_id;
          }
        }
      }

      // Merge events from snapshot event_stack if present
      if (snap.data && (snap.data as any).event_stack) {
        for (const item of (snap.data as any).event_stack) {
          incomingItems.push(item);
          if (item.news_id > lastNewsIdRef.current) {
            lastNewsIdRef.current = item.news_id;
          }
        }
      }

      if (incomingItems.length > 0) {
        setNews(prev => {
          const map = new Map<number, News>();
          for (const item of prev) map.set(item.news_id, item);
          for (const item of incomingItems) map.set(item.news_id, item);
          return Array.from(map.values())
            .sort((a, b) => {
              if (b.virtual_day_s !== a.virtual_day_s) return b.virtual_day_s - a.virtual_day_s;
              return b.news_id - a.news_id;
            })
            .slice(0, 200);
        });
      }

      // Fetch DWS scheduled weather events catalog
      try {
        const w = await api.catalogWeather();
        if (w && w.data && Array.isArray(w.data.items)) {
          const mapped: DwsEventItem[] = w.data.items.map(item => {
            const startSec = Math.round((item.start_ppm * 86400) / 1000000);
            const endSec = Math.round((item.end_ppm * 86400) / 1000000);
            const hh = String(Math.floor(startSec / 3600)).padStart(2, '0');
            const mm = String(Math.floor((startSec % 3600) / 60)).padStart(2, '0');
            const ss = String(startSec % 60).padStart(2, '0');
            return {
              id: item.event_id,
              epicenter_node: item.epicenter_node,
              startTime: `${hh}:${mm}:${ss}`,
              start_sec: startSec,
              end_sec: endSec,
              start_ppm: item.start_ppm,
              end_ppm: item.end_ppm,
              intensity: item.intensity,
              radius_m: item.radius_m,
              active: item.active
            };
          });
          setDwsEvents(mapped);
        }
      } catch {
        // catalogWeather endpoint might not be populated yet
      }

      if (!topology) {
        const t = await api.topology();
        if (t.data && t.data.nodes && t.data.nodes.length > 0) {
          setTopology(t.data);
        }
      }
    } catch (e) {
      if (!terminated) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [topology, terminated]);

  const running = status?.data.lifecycle === 'RUNNING';
  const idle = !status || status.data.lifecycle === 'IDLE' || status.data.lifecycle === 'READY' || status.data.lifecycle === 'STOPPED' || status.data.lifecycle === 'COMPLETED';

  // Continuous live auto-updating: 500ms when simulation is running, 1000ms otherwise
  useEffect(() => {
    refresh();
    const intervalMs = running ? 500 : 1000;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, running]);

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Re-Roll / Seed Preparation: Compiles scenario & loads map in standby without auto-starting
  const prepareWithSeed = async (newSeedVal: string) => {
    const s = sanitizeNumericSeed(newSeedVal);
    const safeDuration = clampDuration(duration);
    setSeed(s);
    setSeedInput(s);
    setDuration(safeDuration);
    lastNewsIdRef.current = 0;
    setNews([]);
    setTopology(null);
    setFocusTarget(null);
    setSelectedNode(null);
    setSelectedEdge(null);
    await action(async () => {
      try {
        await api.stop();
      } catch {
        // Ignore if already idle
      }
      await api.prepare({
        seed: s,
        playback_duration_seconds: safeDuration,
        day: dayMode,
        tick_rate: 1.0,
        modules: {
          traffic: true,
          signals: true,
          buildings: true,
          dws: true,
          flooding: true,
          news: true
        },
        dws: { frequency: 3 }
      });
      const [t, snap, st] = await Promise.all([api.topology(), api.snapshot(), api.status()]);
      if (t.data?.nodes?.length) setTopology(t.data);
      if (snap.data) setSnapshot(snap.data);
      if (st) setStatus(st);
    });
  };

  // Explicit Start Simulation Run (1x)
  const handleStartRun = async () => {
    const s = sanitizeNumericSeed(seed);
    const safeDuration = clampDuration(duration);
    await action(async () => {
      await api.start({
        seed: s,
        playback_duration_seconds: safeDuration,
        day: dayMode,
        tick_rate: 1.0,
        modules: {
          traffic: true,
          signals: true,
          buildings: true,
          dws: true,
          flooding: true,
          news: true
        },
        dws: { frequency: 3 }
      });
      const [t, snap, st] = await Promise.all([api.topology(), api.snapshot(), api.status()]);
      if (t.data?.nodes?.length) setTopology(t.data);
      if (snap.data) setSnapshot(snap.data);
      if (st) setStatus(st);
    });
  };

  const rerollSeed = () => {
    prepareWithSeed(generateRandomSeed128(seed));
  };

  const handleTerminate = async () => {
    if (!confirm('Are you sure you want to terminate the Deterministic Simulated Environment server?')) return;
    setBusy(true);
    try {
      await api.terminate();
      setTerminated(true);
      setError('Deterministic Simulated Environment server gracefully shut down.');
    } catch {
      setTerminated(true);
      setError('Server process terminated.');
    } finally {
      setBusy(false);
    }
  };

  const focusOnNode = useCallback((nodeId: number) => {
    if (!topology) return;
    const n = topology.nodes.find(node => node.id === nodeId);
    if (n) {
      setSelectedNode(n);
      setSelectedEdge(null);
      setFocusTarget({
        lon: n.position.lon,
        lat: n.position.lat,
        zoom: 2.8,
        token: Date.now()
      });
    }
  }, [topology]);

  const focusOnEdge = useCallback((edgeId: number) => {
    if (!topology) return;
    const e = topology.edges.find(edge => edge.id === edgeId);
    if (e && e.geometry.length > 0) {
      setSelectedEdge(e);
      setSelectedNode(null);
      const mid = e.geometry[Math.floor(e.geometry.length / 2)];
      setFocusTarget({
        lon: mid.lon,
        lat: mid.lat,
        zoom: 2.8,
        token: Date.now()
      });
    }
  }, [topology]);

  const edgeMean = useMemo(
    () => (snapshot?.edges.length ? snapshot.edges.reduce((a, e) => a + e.congestion, 0) / snapshot.edges.length : 0),
    [snapshot]
  );

  const virtualSec = status?.clock.virtual_day_seconds ?? 0;

  // DWS Partition into Active vs Completed/Archived
  const { activeDws, completedDws } = useMemo(() => {
    const active: DwsEventItem[] = [];
    const completed: DwsEventItem[] = [];
    for (const ev of dwsEvents) {
      const isNowActive = ev.active || (snapshot?.active_weather ?? []).some(w => w.id === ev.id) || (virtualSec >= ev.start_sec && virtualSec <= ev.end_sec);
      const isFinished = virtualSec > ev.end_sec && !isNowActive;
      if (isFinished) {
        completed.push(ev);
      } else {
        active.push(ev);
      }
    }
    return { activeDws: active, completedDws: completed };
  }, [dwsEvents, snapshot?.active_weather, virtualSec]);

  // Filtered News Partition into Active vs Completed/Archived
  const filteredNews = useMemo(() => {
    if (filterCategory === 'all') return news;
    return news.filter(n => n.category === filterCategory);
  }, [news, filterCategory]);

  const { activeEvents, completedEvents } = useMemo(() => {
    const active: News[] = [];
    const completed: News[] = [];
    for (const n of news) {
      const ageSec = virtualSec - n.virtual_day_s;
      if (ageSec > 900) {
        completed.push(n);
      } else {
        active.push(n);
      }
    }
    return { activeEvents: active, completedEvents: completed };
  }, [news, virtualSec]);

  // Incident Desk Incidents Partition into Active vs Completed/Archived
  const incidentNews = useMemo(() => {
    return news.filter(n => n.category === 'safety' || n.category === 'incident' || /crash|collision|breakdown|puncture|spill|diversion/i.test(n.message));
  }, [news]);

  const { activeIncidents, completedIncidents } = useMemo(() => {
    const active: News[] = [];
    const completed: News[] = [];
    for (const n of incidentNews) {
      const ageSec = virtualSec - n.virtual_day_s;
      if (ageSec > 1200) {
        completed.push(n);
      } else {
        active.push(n);
      }
    }
    return { activeIncidents: active, completedIncidents: completed };
  }, [incidentNews, virtualSec]);

  const selectedEdgeState = useMemo(() => {
    if (!selectedEdge || !snapshot) return null;
    return snapshot.edges.find(e => e.id === selectedEdge.id) ?? null;
  }, [selectedEdge, snapshot]);

  // Network statistics summary
  const networkStats = useMemo(() => {
    if (!topology) return null;
    const busStops = topology.nodes.filter(n => n.bus_stop).length;
    const signals = topology.nodes.filter(n => n.signal).length;
    const schools = topology.nodes.filter(n => n.building?.toLowerCase() === 'school').length;
    const offices = topology.nodes.filter(n => n.building?.toLowerCase() === 'office').length;
    const malls = topology.nodes.filter(n => n.building?.toLowerCase() === 'mall').length;
    const stores = topology.nodes.filter(n => n.building?.toLowerCase() === 'store' || n.building?.toLowerCase() === 'shop').length;
    return { busStops, signals, schools, offices, malls, stores };
  }, [topology]);

  // Selected Node Signal Calculation
  const selectedNodeSignal = useMemo(() => {
    if (!selectedNode || !selectedNode.signal) return null;
    const cycle = selectedNode.signal_cycle_s || 60;
    const offset = selectedNode.signal_offset_s || 0;
    const green = selectedNode.signal_green_s || Math.floor(cycle * 0.55);
    const phasePos = (virtualSec + offset) % cycle;
    const isGreen = phasePos < green;
    const remSeconds = isGreen ? Math.ceil(green - phasePos) : Math.ceil(cycle - phasePos);
    return { isGreen, remSeconds, cycle, green };
  }, [selectedNode, virtualSec]);

  // Trigger Red Visual Traffic Surge around POI / Node
  const handleTriggerTrafficSurge = async (node: TopologyNode) => {
    await action(async () => {
      await api.triggerSurge(
        node.id,
        0.75,
        300,
        360,
        `Commercial Demand Surge at Node #${node.id} (${node.building ? node.building.toUpperCase() : 'District Junction'})`
      );
    });
  };

  // Toggle Manual Signal Phase Persistently
  const handleToggleSignalPhase = async (node: TopologyNode) => {
    await action(async () => {
      await api.toggleSignal(node.id);
    });
  };

  // Open Export Report Modal & Capture High-Res Screenshot
  const handleOpenReport = () => {
    const screenshot = (window as unknown as { __dstnsGetMapScreenshot?: () => string | null }).__dstnsGetMapScreenshot?.() || null;
    setReportMapScreenshot(screenshot);
    setShowReportModal(true);
  };

  return (
    <main>
      <header>
        <div className="brand">
          <div className="mark-icon" title="Deterministic Transport Simulator">
            <NetworkBrandIcon />
          </div>
          <div>
            <b>Deterministic Simulated Environment</b>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="export-report-btn"
            onClick={handleOpenReport}
            title="Generate and export comprehensive DSTNS simulation telemetry audit report"
          >
            <ReportIcon /> Export Report
          </button>
          <div className={`health ${error || terminated ? 'bad' : ''}`} title="Core Simulation Engine Connectivity Health">
            <i />
            {terminated ? 'SERVER SHUT DOWN' : error ? 'ENGINE OFFLINE' : status?.data.lifecycle ?? 'CONNECTING'}
          </div>
          {!terminated && (
            <button className="terminate-btn" onClick={handleTerminate} disabled={busy} title="Shutdown Simulation Daemon Process (/terminate)">
              <TerminateIcon /> Terminate
            </button>
          )}
        </div>
      </header>

      <section className="workspace">
        {/* LEFT PANEL: Simulation Control & 3-Tab Stack (DWS / Events / Incident Desk) */}
        <aside className="left panel">
          <div className="eyebrow" title="Microscopic Traffic & Weather Engine Controls">Simulation Control</div>
          <div className="clock-row">
            <div className="clock" title="Current Simulated Virtual Time (24h Day Profile)">{status?.clock.simulated_current_time ?? '00:00:00'}</div>
            <div className="clock-rate-badge" title="Target Virtual Acceleration">{(status?.clock.target_virtual_rate ?? 0).toFixed(0)}×</div>
          </div>
          <div className="progress" title={`Simulation Day Progress: ${fmt(status?.clock.simulation_percentage ?? 0)}`}>
            <span style={{ width: fmt(status?.clock.simulation_percentage ?? 0) }} />
          </div>

          <div className="metric-grid compact-grid">
            <button
              type="button"
              className="metric metric-button"
              onClick={() => setDayMode(current => current === 0 ? 1 : 0)}
              disabled={!idle || busy || terminated}
              aria-pressed={dayMode === 1}
              title={idle ? 'Switch the demand profile before starting the simulation' : 'Day mode is locked after the simulation starts'}
            >
              <small>Day Mode</small>
              <b>{dayMode === 1 ? 'Weekend' : 'Weekday'}</b>
            </button>
            <Metric label="Revision" value={String(status?.state_revision ?? 0)} title="Deterministic state transition increment counter" />
            <Metric label="Sim Rate" value={`${(status?.clock.target_virtual_rate ?? 0).toFixed(0)}×`} title="Current virtual clock acceleration factor" />
            <Metric label="Congestion" value={fmt(edgeMean)} title="Network-wide average congestion index across all monitored road segments" />
          </div>

          {/* Dual Visual Modes: Reduce Vehicles and Reduce Motion */}
          <div className="motion-controls-row">
            <button
              type="button"
              className={`motion-btn ${reduceVehicles ? 'active' : ''}`}
              onClick={() => setReduceVehicles(current => !current)}
              aria-pressed={reduceVehicles}
              title="Smoothly render 1/20th of vehicles for clean viewing (actual count shown in tooltips)"
            >
              <VehiclesIcon />
              <span>Reduced Vehicles</span>
              <strong className="badge">{reduceVehicles ? 'ON' : 'OFF'}</strong>
            </button>

            <button
              type="button"
              className={`motion-btn ${reduceMotion ? 'active' : ''}`}
              onClick={() => setReduceMotion(current => !current)}
              aria-pressed={reduceMotion}
              title="Stepped stop-motion rendering with 1/15th vehicle density"
            >
              <MotionIcon />
              <span>Reduced Motion</span>
              <strong className="badge">{reduceMotion ? 'ON' : 'OFF'}</strong>
            </button>
          </div>

          {idle && (
            <div className="start-card compact-start-card">
              <label title="128-character cryptographic scenario seed (automatically padded or folded)">
                Deterministic Seed (128-Bit Scenario Key)
                <div className="seed-row">
                  <input
                    value={seedInput}
                    onChange={e => setSeedInput(e.target.value)}
                    onBlur={() => {
                      const cleaned = sanitizeNumericSeed(seedInput);
                      if (cleaned !== seed) {
                        prepareWithSeed(cleaned);
                      } else {
                        setSeedInput(cleaned);
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const cleaned = sanitizeNumericSeed(seedInput);
                        prepareWithSeed(cleaned);
                      }
                    }}
                    placeholder="e.g. 0x5089050192221083..."
                    title="Enter full seed; re-rolls or edits immediately recompile and load map in standby without auto-starting."
                  />
                  <button
                    type="button"
                    onClick={rerollSeed}
                    title="Generate new 128-char random seed and load new district in standby"
                    className="icon-btn-text"
                  >
                    <DiceIcon /> Re-roll
                  </button>
                </div>
              </label>

              <label title="Virtual playback duration in real-world seconds (60 to 3600 seconds)">
                Playback Duration (seconds)
                <input
                  type="number"
                  min="60"
                  max="3600"
                  value={duration}
                  onChange={e => setDuration(Number(e.target.value))}
                  onBlur={() => setDuration(current => clampDuration(current))}
                  title="Duration of full 24h day simulation run in real seconds"
                />
              </label>

              <button
                className="primary compact-primary"
                disabled={busy || terminated}
                onClick={handleStartRun}
                title="Start deterministic traffic simulation at 1x"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <PlayIcon /> Start Simulation Run (1×)
              </button>
            </div>
          )}

          {!idle && (
            <div className="active-controls-wrap">
              <div className="control-row">
                <button
                  disabled={busy || terminated}
                  onClick={() => action(running ? api.pause : api.play)}
                  title={running ? 'Temporarily freeze simulation progression' : 'Resume simulation progression'}
                >
                  {running ? <><PauseIcon /> Pause</> : <><PlayIcon /> Resume</>}
                </button>
                <button
                  disabled={busy || terminated}
                  onClick={() => action(api.stop)}
                  title="Halt simulation and return to ready state"
                >
                  <StopIcon /> Stop
                </button>
                <button
                  disabled={busy || terminated}
                  onClick={() => action(api.undo)}
                  title="Undo last applied control command"
                >
                  <UndoIcon /> Undo
                </button>
                <button
                  disabled={busy || terminated}
                  onClick={() => action(api.redo)}
                  title="Redo previously reverted control command"
                >
                  <RedoIcon /> Redo
                </button>
              </div>

              {/* Tick Rate Slider up to 100x & Quick Presets */}
              <div className="tick-row-compact">
                <div className="tick-header">
                  <span>Tick Rate</span>
                  <strong>{(status?.clock.tick_rate ?? 1).toFixed(1)}×</strong>
                </div>
                <div className="tick-presets">
                  {[1, 5, 10, 25, 50, 100].map(val => (
                    <button
                      key={val}
                      type="button"
                      className={`preset-btn ${Math.round(status?.clock.tick_rate ?? 1) === val ? 'active' : ''}`}
                      onClick={() => action(() => api.tick(val))}
                      title={`Set simulation acceleration to ${val}×`}
                    >
                      {val}×
                    </button>
                  ))}
                </div>
              </div>

              {/* Seed Switcher During Run (Auto-reloads new scenario) */}
              <div className="compact-seed-bar" title="Change seed to prepare a new map topology">
                <input
                  value={seedInput}
                  onChange={e => setSeedInput(e.target.value)}
                  onBlur={() => {
                    const cleaned = sanitizeNumericSeed(seedInput);
                    if (cleaned !== seed) prepareWithSeed(cleaned);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const cleaned = sanitizeNumericSeed(seedInput);
                      prepareWithSeed(cleaned);
                    }
                  }}
                  placeholder="Seed key"
                  title="Press Enter or click away to prepare new map with this seed"
                />
                <button
                  type="button"
                  onClick={rerollSeed}
                  title="Generate new random seed and load distinct OSM district in standby"
                >
                  <DiceIcon />
                </button>
              </div>

              <div className="seek compact-seek" title="Seek to specific time of day">
                <input value={seek} onChange={e => setSeek(e.target.value)} placeholder="HH:MM:SS" title="Target virtual time (HH:MM:SS)" />
                <button onClick={() => action(() => api.seek(seek))} title="Jump simulation virtual clock to target time">Seek</button>
              </div>

              {/* Compact Module Mini-Pills with custom icons and tooltips */}
              <div className="module-pills-row" title="Toggle individual simulation sub-systems">
                {Object.entries(status?.data.modules ?? {}).map(([m, on]) => (
                  <button
                    key={m}
                    type="button"
                    className={`module-pill ${on ? 'active' : ''}`}
                    onClick={() => action(() => api.module(m, !on))}
                    title={`Click to ${on ? 'disable' : 'enable'} ${m} subsystem`}
                  >
                    <ModuleIcon name={m} />
                    <span>{m}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Expanded 3-Tab Stack Panel consuming maximum vertical space */}
          <div className="stack-panel expanded-stack">
            <div className="stack-tabs">
              <button
                type="button"
                className={`stack-tab ${stackTab === 'dws' ? 'active' : ''}`}
                onClick={() => setStackTab('dws')}
                title="Deterministic Weather Simulation (DWS) scheduled storm cells"
              >
                <CategoryIcon category="weather" /> DWS ({activeDws.length})
              </button>
              <button
                type="button"
                className={`stack-tab ${stackTab === 'events' ? 'active' : ''}`}
                onClick={() => setStackTab('events')}
                title="Real-time transport event stack"
              >
                <EventIcon /> Events ({activeEvents.length})
              </button>
              <button
                type="button"
                className={`stack-tab ${stackTab === 'incidents' ? 'active' : ''}`}
                onClick={() => setStackTab('incidents')}
                title="Incident Desk: Stochastic breakdowns, stalls, punctures, and road disruptions"
              >
                <AlertTriangleIcon /> Incidents ({activeIncidents.length})
              </button>
            </div>

            <div className="stack-body">
              {stackTab === 'dws' && (
                <div className="dws-list">
                  {activeDws.length > 0 || completedDws.length > 0 ? (
                    <>
                      {activeDws.map(ev => {
                        const isNowActive = ev.active || (snapshot?.active_weather ?? []).some(w => w.id === ev.id);
                        return (
                          <div key={ev.id} className={`dws-card ${isNowActive ? 'active-storm' : ''}`}>
                            <div className="dws-header">
                              <span className="dws-time" title="Scheduled rain cell start time"><ClockIcon /> {ev.startTime}</span>
                              <span className={`dws-badge ${isNowActive ? 'badge-active' : 'badge-sched'}`} title={isNowActive ? 'Rain storm is currently active on the network' : 'Scheduled upcoming rain storm'}>
                                {isNowActive ? 'ACTIVE' : 'SCHEDULED'}
                              </span>
                            </div>
                            <div className="dws-info">
                              <span><strong>Epicenter:</strong> Node #{ev.epicenter_node}</span>
                              <span><strong>Radius:</strong> {Math.round(ev.radius_m)}m · <strong>Intensity:</strong> {Math.round(ev.intensity * 100)}%</span>
                            </div>
                            <button
                              type="button"
                              className="focus-btn"
                              onClick={() => focusOnNode(ev.epicenter_node)}
                              title={`Center and zoom map camera directly onto Node #${ev.epicenter_node}`}
                            >
                              <TargetIcon /> Focus
                            </button>
                          </div>
                        );
                      })}

                      {completedDws.length > 0 && (
                        <>
                          <div className="stack-archive-divider">
                            <span>Completed & Cleared Weather ({completedDws.length})</span>
                          </div>
                          {completedDws.map(ev => (
                            <div key={ev.id} className="dws-card archived-card">
                              <div className="dws-header">
                                <span className="dws-time"><ClockIcon /> {ev.startTime}</span>
                                <span className="dws-badge badge-cleared">CLEARED</span>
                              </div>
                              <div className="dws-info">
                                <span><strong>Epicenter:</strong> Node #{ev.epicenter_node}</span>
                                <span><strong>Radius:</strong> {Math.round(ev.radius_m)}m</span>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  ) : (
                    <p className="hint">No weather events scheduled. Dynamic storm cells populate as the scenario compiles.</p>
                  )}
                </div>
              )}

              {stackTab === 'events' && (
                <div className="event-list">
                  {activeEvents.length > 0 || completedEvents.length > 0 ? (
                    <>
                      {activeEvents.map(n => {
                        const loc = extractLocation(n);
                        return (
                          <div key={n.news_id} className={`event-stack-card ${n.category}`}>
                            <div className="event-article-header">
                              <time>
                                <CategoryIcon category={n.category} />
                                {n.simulated_current_time} · {n.category.toUpperCase()}
                              </time>
                              {loc && (
                                <button
                                  type="button"
                                  className="micro-focus-btn"
                                  onClick={() => (loc.type === 'node' ? focusOnNode(loc.id) : focusOnEdge(loc.id))}
                                  title={`Focus ${loc.type} #${loc.id} on the map`}
                                >
                                  <TargetIcon /> Focus
                                </button>
                              )}
                            </div>
                            <p>{n.message}</p>
                          </div>
                        );
                      })}

                      {completedEvents.length > 0 && (
                        <>
                          <div className="stack-archive-divider">
                            <span>Completed & Archived Events ({completedEvents.length})</span>
                          </div>
                          {completedEvents.map(n => (
                            <div key={n.news_id} className="event-stack-card archived-card">
                              <div className="event-article-header">
                                <time>
                                  <CategoryIcon category={n.category} />
                                  {n.simulated_current_time} · {n.category.toUpperCase()}
                                </time>
                                <span className="dws-badge badge-cleared">RESOLVED</span>
                              </div>
                              <p>{n.message}</p>
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  ) : (
                    <p className="hint">Simulation events will appear here as virtual time advances.</p>
                  )}
                </div>
              )}

              {stackTab === 'incidents' && (
                <div className="ueh-list">
                  {activeIncidents.length > 0 || completedIncidents.length > 0 ? (
                    <>
                      {activeIncidents.map(n => {
                        const loc = extractLocation(n);
                        const isHigh = /severe|major|multi-vehicle|tanker/i.test(n.message);
                        const isMid = /moderate|tempo|puncture|diversion/i.test(n.message);
                        const sevClass = isHigh ? 'sev-high' : isMid ? 'sev-mid' : 'sev-low';
                        const sevLabel = isHigh ? 'HIGH' : isMid ? 'MID' : 'LOW';
                        return (
                          <div key={n.news_id} className={`ueh-card ${sevClass}`}>
                            <div className="ueh-header">
                              <span className="ueh-time"><ClockIcon /> {n.simulated_current_time}</span>
                              <span className={`ueh-badge ${sevClass}`}>{sevLabel} SEVERITY</span>
                            </div>
                            <p className="ueh-msg">{n.message}</p>
                            {loc && (
                              <button
                                type="button"
                                className="focus-btn"
                                onClick={() => (loc.type === 'node' ? focusOnNode(loc.id) : focusOnEdge(loc.id))}
                                title={`Focus incident location on the map`}
                              >
                                <TargetIcon /> Inspect Spot
                              </button>
                            )}
                          </div>
                        );
                      })}

                      {completedIncidents.length > 0 && (
                        <>
                          <div className="stack-archive-divider">
                            <span>Resolved Incidents ({completedIncidents.length})</span>
                          </div>
                          {completedIncidents.map(n => (
                            <div key={n.news_id} className="ueh-card archived-card">
                              <div className="ueh-header">
                                <span className="ueh-time"><ClockIcon /> {n.simulated_current_time}</span>
                                <span className="dws-badge badge-cleared">RESOLVED</span>
                              </div>
                              <p className="ueh-msg">{n.message}</p>
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  ) : (
                    <p className="hint">No unexpected incidents reported. Incident Desk monitors for stochastic breakdowns, stalls, punctures, and hazards.</p>
                  )}
                </div>
              )}

              <div className="feed-fade-mask" />
            </div>
          </div>
        </aside>

        {/* CENTER PANEL: Microscopic Network Map */}
        <section className="map-wrap">
          <NetworkMap
            topology={topology}
            snapshot={snapshot}
            osm={false}
            running={running}
            virtualDaySeconds={status?.clock.virtual_day_seconds ?? 0}
            tickRate={status?.clock.tick_rate ?? 1.0}
            selectedEdge={selectedEdge}
            reduceMotion={reduceMotion}
            reduceVehicles={reduceVehicles}
            focusTarget={focusTarget}
            dispatchedBuses={dispatchedBuses}
            onSelect={node => {
              setSelectedNode(node);
              if (node) setSelectedEdge(null);
            }}
            onSelectEdge={edge => {
              setSelectedEdge(edge);
              if (edge) setSelectedNode(null);
            }}
          />

          {!topology && (
            <div className="empty-map">
              <b>Deterministic Simulated Environment</b>
              <span>Click "Start Simulation Run" on the left or enter a seed to compile and view the network.</span>
            </div>
          )}
        </section>

        {/* RIGHT PANEL: Map Legend, Collapsible Facilities, Inspector & Notifications */}
        <aside className="right panel">
          <div className="eyebrow" title="Real-Time Network Operations Telemetry">Live Operations & Telemetry</div>
          <div className="summary">
            <Metric label="Road Edges" value={String(topology?.edges.length ?? 0)} title="Total compiled directed road segments in this network topology" />
            <Metric
              label="Vehicles"
              value={String(snapshot?.edges.reduce((a, e) => a + e.vehicle_count, 0) ?? 0)}
              title="Active microscopic vehicles traversing the road network"
            />
            <Metric
              label="Rain Storms"
              value={String(snapshot?.active_weather?.length ?? snapshot?.active_weather_events ?? 0)}
              title="Active dynamic rainstorm cells currently propagating across network nodes"
            />
          </div>

          {/* Top Map Legend with matched badges & vector glyphs */}
          <MapLegend />

          {/* Collapsible Network Facilities & Signals (Collapsed by default) */}
          <div className="collapsible-card">
            <button
              type="button"
              className="collapsible-header"
              onClick={() => setFacilitiesExpanded(curr => !curr)}
              title="Click to expand or collapse network facilities summary"
            >
              <span>Network Facilities & Signals</span>
              <strong>{facilitiesExpanded ? '▲ Collapse' : '▼ Expand'}</strong>
            </button>
            {facilitiesExpanded && networkStats && (
              <div className="collapsible-body">
                <div className="stat-row"><span>Traffic Light Controllers:</span><strong>{networkStats.signals}</strong></div>
                <div className="stat-row"><span>Bus Stop Transit Anchors:</span><strong>{networkStats.busStops}</strong></div>
                <div className="stat-row"><span>Schools & Academies:</span><strong>{networkStats.schools}</strong></div>
                <div className="stat-row"><span>Office & Corporate Parks:</span><strong>{networkStats.offices}</strong></div>
                <div className="stat-row"><span>Shopping Malls:</span><strong>{networkStats.malls}</strong></div>
                <div className="stat-row"><span>Retail Commercial Shops:</span><strong>{networkStats.stores}</strong></div>
              </div>
            )}
          </div>

          <div className="telemetry-container">
            <div className="telemetry-content">
              {selectedEdge ? (
                <div className="inspector">
                  <div className="section-title">
                    Road Edge #{selectedEdge.id}
                    <span style={{ background: selectedEdgeState?.closed ? '#dc2626' : undefined }}>
                      {selectedEdgeState?.closed ? 'CLOSED' : selectedEdge.road_class.toUpperCase()}
                    </span>
                  </div>
                  <p>
                    <strong>Length:</strong> {Math.round(selectedEdge.length_m)} m<br />
                    <strong>Speed Limit:</strong> {Math.round(selectedEdge.free_speed_mps * 3.6)} km/h<br />
                    <strong>Current Speed:</strong> {Math.round((selectedEdgeState?.effective_speed_mps ?? selectedEdge.free_speed_mps) * 3.6)} km/h<br />
                    <strong>Vehicles Active:</strong> {selectedEdgeState?.vehicle_count ?? 0}<br />
                    <strong>Queued / Halting:</strong> {selectedEdgeState?.halting_count ?? 0}<br />
                    <strong>Congestion:</strong> {fmt(selectedEdgeState?.congestion ?? 0)}
                    {selectedEdgeState && selectedEdgeState.flood > 0.05 && (
                      <>
                        <br />
                        <strong>Flood Level:</strong> {fmt(selectedEdgeState.flood)}
                      </>
                    )}
                  </p>
                  <div className="inspector-actions">
                    <button
                      className={`compact-action ${selectedEdgeState?.closed ? 'success' : 'danger'}`}
                      onClick={() =>
                        action(() =>
                          api.overrideEdge(selectedEdge.id, {
                            closed: !selectedEdgeState?.closed,
                            speed_multiplier: selectedEdgeState?.closed ? 1.0 : 0.0
                          })
                        )
                      }
                      title={selectedEdgeState?.closed ? 'Reopen this road (vehicles accelerate back to speed gradually)' : 'Close this road to all traffic and trigger route detours'}
                    >
                      {selectedEdgeState?.closed ? 'Reopen Traffic' : 'Close for Traffic'}
                    </button>
                    <button className="compact-action ghost" onClick={() => { setSelectedEdge(null); setSelectedNode(null); }} title="Dismiss inspection pane">
                      Close
                    </button>
                  </div>
                </div>
              ) : selectedNode ? (
                <div className="inspector">
                  <div className="section-title">
                    Intersection Node #{selectedNode.id}
                    <span>{selectedNode.signal ? 'SIGNALIZED' : 'PRIORITY JUNCTION'}</span>
                  </div>
                  <p>
                    <strong>Coordinates:</strong> {selectedNode.position.lon.toFixed(5)}, {selectedNode.position.lat.toFixed(5)}<br />
                    {selectedNode.signal && selectedNodeSignal && (
                      <>
                        <strong>Signal Status:</strong>{' '}
                        <span style={{ color: selectedNodeSignal.isGreen ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                          {selectedNodeSignal.isGreen ? 'GREEN PHASE' : 'RED PHASE'}
                        </span>{' '}
                        ({selectedNodeSignal.remSeconds}s remaining)<br />
                        <strong>Signal Cycle:</strong> {selectedNodeSignal.cycle}s (Green: {selectedNodeSignal.green}s)<br />
                      </>
                    )}
                    {selectedNode.bus_stop && (
                      <>
                        <strong>Transit:</strong> Bus Stop Terminal<br />
                        <strong>Peak Hours:</strong> {peakHoursFor(selectedNode, dayMode)}<br />
                        <strong>Service Radius:</strong> {Math.round(selectedNode.bus_stop_radius_m ?? 800)} m<br />
                      </>
                    )}
                    {selectedNode.building && (
                      <>
                        <strong>Facility:</strong> {selectedNode.building.toUpperCase()}<br />
                        <strong>Peak Profile:</strong> {peakHoursFor(selectedNode, dayMode)}<br />
                        <strong>Impact Factor:</strong> {((selectedNode.building_impact ?? 0.5) * 100).toFixed(0)}%<br />
                        <strong>Influence Radius:</strong> {Math.round(selectedNode.building_radius_m ?? 250)} m<br />
                      </>
                    )}
                  </p>
                  <div className="inspector-actions">
                    <button className="compact-action primary-action" onClick={() => action(() => api.weather(selectedNode.id))} title="Simulate a localized rainfall storm cell at this node">
                      <CategoryIcon category="weather" /> Simulate Rain
                    </button>
                    <button className="compact-action surge-action" onClick={() => handleTriggerTrafficSurge(selectedNode)} title="Simulate a high commercial demand surge with red glowing zone on map">
                      <CategoryIcon category="traffic" /> Traffic Surge
                    </button>
                    {selectedNode.signal && (
                      <button
                        className="compact-action signal-action"
                        onClick={() => handleToggleSignalPhase(selectedNode)}
                        title="Toggle conflict-free coordinated signal phase"
                      >
                        <CategoryIcon category="signals" /> Toggle Signal
                      </button>
                    )}
                    <button className="compact-action ghost" onClick={() => setSelectedNode(null)} title="Dismiss inspection pane">
                      Close
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="feed-fade-mask" />
          </div>

          {/* Live Notification Feed */}
          <section className="notifications-panel" aria-label="Simulation notifications">
            <div className="stack-heading">
              <span><EventIcon /> Live Bulletins</span>
              <strong>{filteredNews.length}</strong>
            </div>
            <div className="event-filters" aria-label="Notification filters">
              {['all', 'weather', 'traffic', 'transit', 'safety'].map(cat => (
                <button
                  key={cat}
                  type="button"
                  className={`filter-chip ${filterCategory === cat ? 'active' : ''}`}
                  onClick={() => setFilterCategory(cat)}
                  title={`Show ${cat} notifications`}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="feed notification-feed">
              {filteredNews.length ? (
                filteredNews.map(n => {
                  const loc = extractLocation(n);
                  return (
                    <article key={n.news_id} className={n.category}>
                      <div className="event-article-header">
                        <time>
                          <CategoryIcon category={n.category} />
                          {n.simulated_current_time} · {n.category.toUpperCase()}
                        </time>
                        {loc && (
                          <button
                            type="button"
                            className="micro-focus-btn"
                            onClick={() => (loc.type === 'node' ? focusOnNode(loc.id) : focusOnEdge(loc.id))}
                            title={`Focus ${loc.type} #${loc.id} on the map`}
                          >
                            <TargetIcon /> Focus
                          </button>
                        )}
                      </div>
                      <p>{n.message}</p>
                    </article>
                  );
                })
              ) : (
                <p className="hint">Notifications will appear here as simulated time advances.</p>
              )}
            </div>
          </section>
        </aside>
      </section>

      <footer>
        <span title="Cryptographic SHA-256 hash of canonical network topology graph">Graph Hash: {topology?.graph_hash?.slice(0, 18) ?? '—'}</span>
        <span title="Active deterministic scenario generation seed">Active Seed: {status?.global_seed || seed || '—'}</span>
        <span title="Current backend daemon connection state">
          {terminated ? 'Server Offline' : error ? error : running ? '● Live Simulation Active (500ms sync)' : '○ Standby'}
        </span>
      </footer>

      {/* DSTNS Comprehensive Simulation Report Export Modal */}
      {showReportModal && (
        <SimulationReportModal
          status={status}
          topology={topology}
          snapshot={snapshot}
          news={news}
          dwsEvents={dwsEvents}
          seed={status?.global_seed || seed}
          dayMode={dayMode}
          screenshotUrl={reportMapScreenshot}
          onClose={() => setShowReportModal(false)}
        />
      )}
    </main>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="metric" title={title}>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

function MapLegend() {
  return (
    <section className="legend-panel" aria-label="Map legend">
      <div className="legend-panel-title">Map Legend</div>
      <div className="legend-clean-group">
        <span className="legend-group-label">Roads</span>
        <span className="legend-item" title="Motorway or high-speed arterial"><i style={{ background: '#f97316' }} /> Highway</span>
        <span className="legend-item" title="Primary arterial avenue"><i style={{ background: '#f59e0b' }} /> Primary</span>
        <span className="legend-item" title="Residential and access streets"><i style={{ background: '#94a3b8' }} /> Street</span>
      </div>
      <div className="legend-clean-group">
        <span className="legend-group-label">State</span>
        <span className="legend-item" title="Free-flow traffic"><i className="legend-status free" /> Free</span>
        <span className="legend-item" title="Congested traffic"><i className="legend-status heavy" /> Heavy</span>
        <span className="legend-item" title="Closed road with hazard striping"><i className="legend-status closed-hazard" /> Closed</span>
        <span className="legend-item" title="Flooded roadway"><i className="legend-status flood" /> Flooded</span>
        <span className="legend-item" title="Active rain storm"><i className="legend-status rain-circle" /> Rain</span>
        <span className="legend-item" title="Commercial traffic surge zone"><i className="legend-status surge-circle" /> Surge</span>
      </div>
      <div className="legend-clean-group">
        <span className="legend-group-label">Nodes</span>
        <span className="legend-item" title="Bus stop"><i className="legend-pin" style={{ background: '#0891b2' }} /> Bus</span>
        <span className="legend-item" title="School"><i className="legend-pin" style={{ background: '#d97706' }} /> School</span>
        <span className="legend-item" title="Office"><i className="legend-pin" style={{ background: '#475569' }} /> Office</span>
        <span className="legend-item" title="Shopping mall"><i className="legend-pin" style={{ background: '#9333ea' }} /> Mall</span>
        <span className="legend-item" title="Shop"><i className="legend-pin" style={{ background: '#059669' }} /> Shop</span>
        <span className="legend-item" title="Traffic signal"><i className="legend-status signal-dot" /> Signal</span>
        <span className="legend-item" title="Simulated vehicle"><i className="legend-status dot" style={{ background: '#6366f1' }} /> Vehicle</span>
      </div>
    </section>
  );
}

// Comprehensive DSTNS Telemetry Audit Report Modal
function SimulationReportModal({
  status,
  topology,
  snapshot,
  news,
  dwsEvents,
  seed,
  dayMode,
  screenshotUrl,
  onClose
}: {
  status: Envelope<Status> | null;
  topology: Topology | null;
  snapshot: Snapshot | null;
  news: News[];
  dwsEvents: DwsEventItem[];
  seed: string;
  dayMode: 0 | 1;
  screenshotUrl: string | null;
  onClose: () => void;
}) {
  const avgCongestion = snapshot?.edges.length
    ? (snapshot.edges.reduce((sum, e) => sum + e.congestion, 0) / snapshot.edges.length)
    : 0;

  const totalVehicles = snapshot?.edges.reduce((sum, e) => sum + e.vehicle_count, 0) ?? 0;
  const closedRoads = snapshot?.edges.filter(e => e.closed).length ?? 0;

  // Compute Lat/Lon center & bounding box
  const { centerLon, centerLat, minLon, maxLon, minLat, maxLat } = useMemo(() => {
    if (!topology || !topology.nodes.length) return { centerLon: 0, centerLat: 0, minLon: 0, maxLon: 0, minLat: 0, maxLat: 0 };
    let minLo = Infinity, maxLo = -Infinity, minLa = Infinity, maxLa = -Infinity;
    for (const n of topology.nodes) {
      if (n.position.lon < minLo) minLo = n.position.lon;
      if (n.position.lon > maxLo) maxLo = n.position.lon;
      if (n.position.lat < minLa) minLa = n.position.lat;
      if (n.position.lat > maxLa) maxLa = n.position.lat;
    }
    return {
      centerLon: (minLo + maxLo) / 2,
      centerLat: (minLa + maxLa) / 2,
      minLon: minLo,
      maxLon: maxLo,
      minLat: minLa,
      maxLat: maxLa
    };
  }, [topology]);

  return (
    <div className="report-modal-backdrop" onClick={onClose}>
      <div className="report-modal-content" onClick={e => e.stopPropagation()}>
        <div className="report-toolbar no-print">
          <button type="button" className="print-btn" onClick={() => window.print()}>
            🖨️ Print / Save PDF
          </button>
          <button type="button" className="close-btn" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        <div className="report-paper">
          {/* Header with DSTNS Branding */}
          <div className="report-header">
            <div className="report-brand">
              <div className="brand-logo-badge">
                <NetworkBrandIcon />
              </div>
              <div>
                <h1 className="report-title">DSTNS TELEMETRY AUDIT REPORT</h1>
                <p className="report-subtitle">Deterministic Transport & Urban Network Simulation Framework</p>
              </div>
            </div>
            <div className="report-meta-tag">
              <div><strong>Generated:</strong> {new Date().toLocaleString()}</div>
              <div><strong>Status:</strong> {status?.data.lifecycle ?? 'COMPLETED'}</div>
              <div><strong>Sim Time:</strong> {status?.clock.simulated_current_time ?? '24:00:00'}</div>
            </div>
          </div>

          <hr className="report-divider" />

          {/* Section 1: Network Canvas Snapshot */}
          <div className="report-section">
            <h2 className="report-section-title">1. High-Resolution OSM Network Capture</h2>
            {screenshotUrl ? (
              <div className="report-map-frame">
                <img src={screenshotUrl} alt="OSM Network Telemetry Screenshot" className="report-screenshot-img" />
              </div>
            ) : (
              <div className="report-no-img">Map canvas snapshot unavailable</div>
            )}
            <div className="report-caption">
              Geographic Center: {centerLat.toFixed(5)}° N, {centerLon.toFixed(5)}° E · Bounding Box: [{minLat.toFixed(4)}°, {minLon.toFixed(4)}°] to [{maxLat.toFixed(4)}°, {maxLon.toFixed(4)}°]
            </div>
          </div>

          {/* Section 2: Scenario Configuration Data */}
          <div className="report-section">
            <h2 className="report-section-title">2. Scenario Configuration & Deterministic Parameters</h2>
            <table className="report-table">
              <tbody>
                <tr>
                  <th>Deterministic Scenario Seed (128-Bit)</th>
                  <td className="seed-code-cell">{seed}</td>
                </tr>
                <tr>
                  <th>Graph Topology SHA-256 Hash</th>
                  <td><code>{topology?.graph_hash ?? '—'}</code></td>
                </tr>
                <tr>
                  <th>Day Demand Profile</th>
                  <td>{dayMode === 1 ? 'Weekend (Leisure & Shopping Peak Profile)' : 'Weekday (Commuter & School Rush Profile)'}</td>
                </tr>
                <tr>
                  <th>Virtual Clock Acceleration</th>
                  <td>{(status?.clock.target_virtual_rate ?? 0).toFixed(0)}× (Tick Rate: {(status?.clock.tick_rate ?? 1).toFixed(1)}×)</td>
                </tr>
                <tr>
                  <th>Network Dimensions</th>
                  <td>{topology?.nodes.length ?? 0} Nodes · {topology?.edges.length ?? 0} Directed Road Edges</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Section 3: Network Facilities & Operational Telemetry */}
          <div className="report-section">
            <h2 className="report-section-title">3. Operational Telemetry & Congestion Performance</h2>
            <div className="report-stats-grid">
              <div className="report-stat-card">
                <div className="stat-num">{fmt(avgCongestion)}</div>
                <div className="stat-lbl">Mean Congestion Index</div>
              </div>
              <div className="report-stat-card">
                <div className="stat-num">{totalVehicles}</div>
                <div className="stat-lbl">Peak Vehicles Active</div>
              </div>
              <div className="report-stat-card">
                <div className="stat-num">{closedRoads}</div>
                <div className="stat-lbl">Road Closure Detours</div>
              </div>
              <div className="report-stat-card">
                <div className="stat-num">{dwsEvents.length}</div>
                <div className="stat-lbl">Rain Storm Cells (DWS)</div>
              </div>
            </div>
          </div>

          {/* Section 4: Chronological Incident & Event Ledger */}
          <div className="report-section">
            <h2 className="report-section-title">4. Historical Event & Incident Ledger</h2>
            <table className="report-table report-ledger-table">
              <thead>
                <tr>
                  <th>Virtual Time</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {news.length > 0 ? (
                  news.map(n => (
                    <tr key={n.news_id}>
                      <td><strong>{n.simulated_current_time}</strong></td>
                      <td><span className={`ledger-cat-badge ${n.category}`}>{n.category.toUpperCase()}</span></td>
                      <td>{n.message}</td>
                      <td><span className="ledger-status-badge">LOGGED</span></td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: '#64748b' }}>No events logged during this run.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer Branding */}
          <div className="report-footer">
            <span>DSTNS Deterministic Transport Simulator · Core Version 2.4.0</span>
            <span>Document ID: DSTNS-AUDIT-{Date.now().toString(36).toUpperCase()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
