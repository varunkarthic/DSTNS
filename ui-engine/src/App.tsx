import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { NetworkMap } from './NetworkMap';
import type { Envelope, News, Snapshot, Status, Topology, TopologyNode, TopologyEdge } from './types';
import './style.css';

const fmt = (x: number) => `${Math.round(x * 100)}%`;

export function sanitizeNumericSeed(input: string): string {
  // If negative or contains any non-digit character, ignore and force positive digits
  const digits = input.replace(/\D/g, '');
  if (digits.length >= 16) {
    return digits.slice(0, 16);
  }
  return digits.padEnd(16, '0');
}

export function generateRandomNumericSeed(): string {
  let res = '';
  for (let i = 0; i < 16; i++) {
    res += Math.floor(Math.random() * 10).toString();
  }
  return res;
}

interface DwsEventItem {
  id: number;
  epicenter_node: number;
  startTime: string;
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
  const nodeMatch = n.message.match(/Node\s+(\d+)/i);
  if (nodeMatch) return { type: 'node', id: parseInt(nodeMatch[1], 10) };
  const edgeMatch = n.message.match(/Edge\s+#?(\d+)/i);
  if (edgeMatch) return { type: 'edge', id: parseInt(edgeMatch[1], 10) };
  return null;
}

// Modern Interface SVG Icons
function NetworkBrandIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
    </svg>
  );
}

function TerminateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h5l3-7 4 14 3-7h5" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function EventIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="3" />
      <line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="3" />
      <line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="3" />
    </svg>
  );
}

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case 'weather':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
          <path d="M16 14v6" />
          <path d="M8 14v6" />
          <path d="M12 16v6" />
        </svg>
      );
    case 'traffic':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 2.8C2.1 11 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </svg>
      );
    case 'transit':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="16" height="16" x="4" y="3" rx="2" />
          <path d="M4 11h16" />
          <path d="M8 19v2" />
          <path d="M16 19v2" />
          <circle cx="8" cy="15" r="1" />
          <circle cx="16" cy="15" r="1" />
        </svg>
      );
    case 'safety':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case 'signals':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="8" height="18" x="8" y="3" rx="2" />
          <circle cx="12" cy="7" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="17" r="1.5" />
        </svg>
      );
    default:
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
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

  // 16-Digit Numeric Seed with Auto-Reload
  const [seed, setSeed] = useState<string>(() => sanitizeNumericSeed('5089050192221083'));
  const [seedInput, setSeedInput] = useState<string>(() => sanitizeNumericSeed('5089050192221083'));

  const [duration, setDuration] = useState(120);
  const [seek, setSeek] = useState('12:00:00');
  const [terminated, setTerminated] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [stackTab, setStackTab] = useState<'dws' | 'events'>('dws');
  const [focusTarget, setFocusTarget] = useState<{ lon: number; lat: number; zoom?: number; token: number } | null>(null);

  const lastNewsIdRef = useRef<number>(0);
  const currentRunIdRef = useRef<string>('');

  const refresh = useCallback(async () => {
    if (terminated) return;
    try {
      const s = await api.status();
      setStatus(s);
      setError('');

      const incomingRunId = s.run_id || (s.data as Status)?.run_id || '';
      if (incomingRunId && incomingRunId !== currentRunIdRef.current) {
        currentRunIdRef.current = incomingRunId;
        lastNewsIdRef.current = 0;
        setNews([]);
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
            .slice(0, 150);
        });
      }

      // Fetch DWS scheduled weather events catalog
      try {
        const w = await api.catalogWeather();
        if (w && w.data && Array.isArray(w.data.items)) {
          const mapped: DwsEventItem[] = w.data.items.map(item => {
            const startSec = Math.round((item.start_ppm * 86400) / 1000000);
            const hh = String(Math.floor(startSec / 3600)).padStart(2, '0');
            const mm = String(Math.floor((startSec % 3600) / 60)).padStart(2, '0');
            const ss = String(startSec % 60).padStart(2, '0');
            return {
              id: item.event_id,
              epicenter_node: item.epicenter_node,
              startTime: `${hh}:${mm}:${ss}`,
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
  const idle = !status || status.data.lifecycle === 'IDLE' || status.data.lifecycle === 'STOPPED' || status.data.lifecycle === 'COMPLETED';

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

  // Reload scenario automatically whenever seed changes
  const reloadWithSeed = async (newNumericSeed: string) => {
    const s = sanitizeNumericSeed(newNumericSeed);
    setSeed(s);
    setSeedInput(s);
    lastNewsIdRef.current = 0;
    setNews([]);
    setTopology(null);
    await action(async () => {
      await api.start({
        seed: s,
        playback_duration_seconds: duration,
        day: 'auto',
        tick_rate: status?.clock.tick_rate ?? 1,
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

  const handleStartRun = async () => {
    await reloadWithSeed(seed);
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

  const filteredNews = useMemo(() => {
    if (filterCategory === 'all') return news;
    return news.filter(n => n.category === filterCategory);
  }, [news, filterCategory]);

  const selectedEdgeState = useMemo(() => {
    if (!selectedEdge || !snapshot) return null;
    return snapshot.edges.find(e => e.id === selectedEdge.id) ?? null;
  }, [selectedEdge, snapshot]);

  // Network statistics summary for inspector idle state
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
        {/* LEFT PANEL: Simulation Control & Dual-Tab Stack */}
        <aside className="left panel">
          <div className="eyebrow" title="Microscopic Traffic & Weather Engine Controls">Simulation Control</div>
          <div className="clock" title="Current Simulated Virtual Time (24h Day Profile)">{status?.clock.simulated_current_time ?? '00:00:00'}</div>
          <div className="progress" title={`Simulation Day Progress: ${fmt(status?.clock.simulation_percentage ?? 0)}`}>
            <span style={{ width: fmt(status?.clock.simulation_percentage ?? 0) }} />
          </div>

          <div className="metric-grid">
            <Metric label="Day Mode" value={status?.data.day === 1 ? 'Weekend' : 'Weekday'} title="Weekly demand schedule: Weekdays feature morning/evening commute peaks; Weekends feature afternoon shopping peaks" />
            <Metric label="Revision" value={String(status?.state_revision ?? 0)} title="Deterministic state transition increment counter" />
            <Metric label="Sim Rate" value={`${(status?.clock.target_virtual_rate ?? 0).toFixed(0)}×`} title="Current virtual clock acceleration factor" />
            <Metric label="Congestion" value={fmt(edgeMean)} title="Network-wide average congestion index across all monitored road segments" />
          </div>

          {/* Reduce Motion GUI Toggle */}
          <label className="toggle-row" title="Reduce the number of vehicles moving in the GUI display for visual clarity without modifying backend simulation physics">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <MotionIcon /> Reduce Motion (GUI)
            </span>
            <input
              type="checkbox"
              checked={reduceMotion}
              onChange={e => setReduceMotion(e.target.checked)}
              title="Toggle thinned visual vehicle representation in the GUI"
            />
          </label>

          {idle && (
            <div className="start-card">
              <label title="16-digit numeric deterministic seed (automatically padded with zeros or trimmed to 16 digits; non-digits ignored)">
                Deterministic Seed (16-Digit Numeric)
                <div className="seed-row">
                  <input
                    value={seedInput}
                    onChange={e => setSeedInput(e.target.value)}
                    onBlur={() => {
                      const cleaned = sanitizeNumericSeed(seedInput);
                      if (cleaned !== seed) {
                        reloadWithSeed(cleaned);
                      } else {
                        setSeedInput(cleaned);
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const cleaned = sanitizeNumericSeed(seedInput);
                        reloadWithSeed(cleaned);
                      }
                    }}
                    placeholder="e.g. 5089050192221083"
                    title="Enter any numeric seed; non-digits ignored, forced positive, formatted to 16 digits. Automatically reloads map on change."
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const randomSeed = generateRandomNumericSeed();
                      reloadWithSeed(randomSeed);
                    }}
                    title="Generate new 16-digit random numeric seed and auto-reload map"
                    style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                  >
                    <DiceIcon /> Re-roll
                  </button>
                </div>
              </label>

              <label title="Virtual playback duration in real-world seconds (60 to 1200 seconds)">
                Playback Duration (seconds)
                <input
                  type="number"
                  min="60"
                  max="1200"
                  value={duration}
                  onChange={e => setDuration(Number(e.target.value))}
                  title="Duration of full 24h day simulation run in real seconds"
                />
              </label>

              <button
                className="primary"
                disabled={busy || terminated}
                onClick={handleStartRun}
                title="Compile network topology and start deterministic traffic simulation"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
              >
                <PlayIcon /> Start Simulation Run
              </button>
            </div>
          )}

          {!idle && (
            <>
              <div className="control-row">
                <button
                  disabled={busy || terminated}
                  onClick={() => action(running ? api.pause : api.play)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  title={running ? 'Temporarily freeze simulation progression' : 'Resume simulation progression'}
                >
                  {running ? <><PauseIcon /> Pause</> : <><PlayIcon /> Resume</>}
                </button>
                <button
                  disabled={busy || terminated}
                  onClick={() => action(api.stop)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  title="Halt simulation and return to ready state"
                >
                  <StopIcon /> Stop
                </button>
                <button
                  disabled={busy || terminated}
                  onClick={() => action(api.undo)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  title="Undo last applied control command"
                >
                  <UndoIcon /> Undo
                </button>
                <button
                  disabled={busy || terminated}
                  onClick={() => action(api.redo)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  title="Redo previously reverted control command"
                >
                  <RedoIcon /> Redo
                </button>
              </div>

              {/* Tick Rate Slider up to 100x & Quick Presets */}
              <label title="Set simulation tick rate multiplier (0.1x to 100x)">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Tick Rate</span>
                  <strong>{(status?.clock.tick_rate ?? 1).toFixed(1)}×</strong>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="100"
                  step="0.5"
                  value={status?.clock.tick_rate ?? 1}
                  onChange={e => action(() => api.tick(Number(e.target.value)))}
                  title="Drag to adjust tick rate multiplier up to 100x"
                />
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
              </label>

              {/* Seed Switcher During Run (Auto-reloads new scenario) */}
              <label style={{ marginTop: '10px' }} title="Change 16-digit numeric seed to reload a new map topology">
                Active Scenario Seed (16-Digit Numeric)
                <div className="seed-row">
                  <input
                    value={seedInput}
                    onChange={e => setSeedInput(e.target.value)}
                    onBlur={() => {
                      const cleaned = sanitizeNumericSeed(seedInput);
                      if (cleaned !== seed) reloadWithSeed(cleaned);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const cleaned = sanitizeNumericSeed(seedInput);
                        reloadWithSeed(cleaned);
                      }
                    }}
                    placeholder="16 numeric digits"
                    title="Press Enter or click away to auto-reload new map with this seed"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const randomSeed = generateRandomNumericSeed();
                      reloadWithSeed(randomSeed);
                    }}
                    title="Generate new random seed and auto-reload map"
                  >
                    <DiceIcon />
                  </button>
                </div>
              </label>

              <div className="seek" style={{ marginTop: '10px' }} title="Seek to specific time of day">
                <input value={seek} onChange={e => setSeek(e.target.value)} placeholder="HH:MM:SS" title="Target virtual time (HH:MM:SS)" />
                <button onClick={() => action(() => api.seek(seek))} title="Jump simulation virtual clock to target time">Seek</button>
              </div>

              <div className="modules" title="Toggle individual simulation sub-systems">
                {Object.entries(status?.data.modules ?? {}).map(([m, on]) => (
                  <label key={m} title={`Toggle ${m} subsystem`}>
                    <span>{m}</span>
                    <input type="checkbox" checked={on} onChange={() => action(() => api.module(m, !on))} />
                  </label>
                ))}
              </div>
            </>
          )}

          {/* DUAL-TAB STACK: DWS Stack and Event Stack */}
          <div className="stack-panel">
            <div className="stack-tabs">
              <button
                type="button"
                className={`stack-tab ${stackTab === 'dws' ? 'active' : ''}`}
                onClick={() => setStackTab('dws')}
                title="Dynamic Weather System (DWS) scheduled storm cells"
              >
                <CategoryIcon category="weather" /> DWS Stack ({dwsEvents.length})
              </button>
              <button
                type="button"
                className={`stack-tab ${stackTab === 'events' ? 'active' : ''}`}
                onClick={() => setStackTab('events')}
                title="Chronological microscopic transport event log"
              >
                <EventIcon /> Event Stack ({filteredNews.length})
              </button>
            </div>

            <div className="stack-body">
              {stackTab === 'dws' ? (
                <div className="dws-list">
                  {dwsEvents.length ? (
                    dwsEvents.map(ev => {
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
                            <TargetIcon /> Focus Storm
                          </button>
                        </div>
                      );
                    })
                  ) : (
                    <p className="hint">No weather events scheduled. Weather events populate as scenario compiles.</p>
                  )}
                </div>
              ) : (
                <div className="event-list">
                  <div className="event-filters">
                    {['all', 'weather', 'traffic', 'transit', 'safety'].map(cat => (
                      <button
                        key={cat}
                        type="button"
                        className={`filter-chip ${filterCategory === cat ? 'active' : ''}`}
                        onClick={() => setFilterCategory(cat)}
                        title={`Filter event stream to ${cat}`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                  <div className="feed">
                    {filteredNews.length ? (
                      filteredNews.map(n => {
                        const loc = extractLocation(n);
                        return (
                          <article key={n.news_id} className={n.category}>
                            <div className="event-article-header">
                              <time style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <CategoryIcon category={n.category} />
                                {n.simulated_current_time} · {n.category.toUpperCase()}
                              </time>
                              {loc && (
                                <button
                                  type="button"
                                  className="micro-focus-btn"
                                  onClick={() => (loc.type === 'node' ? focusOnNode(loc.id) : focusOnEdge(loc.id))}
                                  title={`Fly map camera directly to ${loc.type} #${loc.id}`}
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
                      <p className="hint">No events logged yet. Real-time events will populate as time advances.</p>
                    )}
                  </div>
                </div>
              )}
              {/* Fade mask so bottom does not feel cut off */}
              <div className="feed-fade-mask" />
            </div>
          </div>
        </aside>

        {/* CENTER PANEL: Microscopic Network Map & Categorized Legend */}
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
            focusTarget={focusTarget}
            onSelect={setSelectedNode}
            onSelectEdge={setSelectedEdge}
          />

          {/* Clean Categorized Legend Menu (No Overlaps, Teardrop Pins, Rich Tooltips) */}
          <div className="legend-clean">
            <div className="legend-clean-group">
              <span className="legend-group-label">Roads</span>
              <span className="legend-item" title="Motorway / High-Speed Arterial (Free speed 80–120 km/h)"><i style={{ background: '#f97316' }} /> Highway</span>
              <span className="legend-item" title="Primary Arterial Avenue (Free speed 50–70 km/h)"><i style={{ background: '#f59e0b' }} /> Primary</span>
              <span className="legend-item" title="Residential & Access Streets (Free speed 30–50 km/h)"><i style={{ background: '#94a3b8' }} /> Street</span>
            </div>

            <div className="legend-clean-divider" />

            <div className="legend-clean-group">
              <span className="legend-group-label">Traffic</span>
              <span className="legend-item" title="Free flow traffic conditions (Delay < 25%)"><i className="legend-status free" /> Free</span>
              <span className="legend-item" title="Congested / Queued bottleneck (Delay > 65%)"><i className="legend-status heavy" /> Congested</span>
              <span className="legend-item" title="Flooded / Impassable roadway"><i className="legend-status flood" /> Flooded</span>
              <span className="legend-item" title="Active Dynamic Weather Rain Storm"><i className="legend-status rain-circle" /> Rain Storm</span>
            </div>

            <div className="legend-clean-divider" />

            <div className="legend-clean-group">
              <span className="legend-group-label">POIs</span>
              <span className="legend-item" title="Public Transit Bus Stop Anchor"><i className="legend-pin" style={{ background: '#0891b2' }} /> Bus</span>
              <span className="legend-item" title="School Facility (Morning & Afternoon Rush)"><i className="legend-pin" style={{ background: '#d97706' }} /> School</span>
              <span className="legend-item" title="Office Complex (Commuter Peak)"><i className="legend-pin" style={{ background: '#475569' }} /> Office</span>
              <span className="legend-item" title="Shopping Mall (Midday & Evening Peaks)"><i className="legend-pin" style={{ background: '#9333ea' }} /> Mall</span>
              <span className="legend-item" title="Local Store / Commercial Shop"><i className="legend-pin" style={{ background: '#059669' }} /> Shop</span>
              <span className="legend-item" title="Adaptive Traffic Light Signal Controller"><i className="legend-status signal-dot" /> Signal</span>
            </div>

            <div className="legend-clean-divider" />

            <div className="legend-clean-group">
              <span className="legend-item" title="Microscopic Simulated Moving Vehicles (Amber = braking/halted, Indigo = moving)"><i className="legend-status dot" style={{ background: '#6366f1' }} /> Vehicles</span>
            </div>
          </div>

          {!topology && (
            <div className="empty-map">
              <b>Deterministic Simulated Environment</b>
              <span>Click "Start Simulation Run" on the left or enter a seed to compile and view the network.</span>
            </div>
          )}
        </section>

        {/* RIGHT PANEL: Live Operations & Telemetry */}
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                    {selectedNode && (
                      <button className="primary" onClick={() => action(() => api.weather(selectedNode.id))} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} title="Inject localized rainfall storm cell at this node">
                        <CategoryIcon category="weather" /> Inject Rain on Node {selectedNode.id}
                      </button>
                    )}
                    <button
                      style={{
                        padding: '8px 12px',
                        fontSize: '11px',
                        fontWeight: 600,
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: selectedEdgeState?.closed ? '#10b981' : '#ef4444',
                        color: '#ffffff',
                        border: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6
                      }}
                      onClick={() =>
                        action(() =>
                          api.overrideEdge(selectedEdge.id, {
                            closed: !selectedEdgeState?.closed,
                            speed_multiplier: selectedEdgeState?.closed ? 1.0 : 0.0
                          })
                        )
                      }
                      title={selectedEdgeState?.closed ? 'Reopen this road to normal vehicle traffic' : 'Close this road to all traffic and simulate route detours'}
                    >
                      {selectedEdgeState?.closed ? 'Reopen Road' : 'Close Road to Traffic'}
                    </button>
                    <button className="ghost" onClick={() => { setSelectedEdge(null); setSelectedNode(null); }} title="Dismiss inspection pane">
                      Close Inspector
                    </button>
                  </div>
                </div>
              ) : selectedNode ? (
                <div className="inspector">
                  <div className="section-title">
                    Intersection Node #{selectedNode.id}
                    <span>DEGREE {selectedNode.degree}</span>
                  </div>
                  <p>
                    <strong>Coordinates:</strong> {selectedNode.position.lon.toFixed(5)}, {selectedNode.position.lat.toFixed(5)}<br />
                    <strong>Connecting Approaches:</strong> {selectedNode.degree} legs<br />
                    {selectedNode.bus_stop && <><strong>Transit:</strong> Bus Stop Terminal<br /></>}
                    {selectedNode.signal && <><strong>Signals:</strong> Adaptive Traffic Controller Active<br /></>}
                    {selectedNode.building && (
                      <>
                        <strong>Facility:</strong> {selectedNode.building.toUpperCase()}<br />
                        <strong>Impact Factor:</strong> {((selectedNode.building_impact ?? 0.5) * 100).toFixed(0)}%<br />
                        <strong>Influence Radius:</strong> {Math.round(selectedNode.building_radius_m ?? 250)} m<br />
                      </>
                    )}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                    <button className="primary" onClick={() => action(() => api.weather(selectedNode.id))} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} title="Inject localized rainfall storm cell at this node">
                      <CategoryIcon category="weather" /> Inject Rain on Node {selectedNode.id}
                    </button>
                    <button className="ghost" onClick={() => setSelectedNode(null)} title="Dismiss inspection pane">
                      Close Inspector
                    </button>
                  </div>
                </div>
              ) : (
                <div className="stats-card">
                  <div className="section-title" style={{ border: 'none', padding: 0 }}>
                    Network Facilities & Signals
                  </div>
                  {networkStats && (
                    <>
                      <div className="stat-row"><span>Traffic Light Controllers:</span><strong>{networkStats.signals}</strong></div>
                      <div className="stat-row"><span>Bus Stop Transit Anchors:</span><strong>{networkStats.busStops}</strong></div>
                      <div className="stat-row"><span>Schools & Academies:</span><strong>{networkStats.schools}</strong></div>
                      <div className="stat-row"><span>Office & Corporate Parks:</span><strong>{networkStats.offices}</strong></div>
                      <div className="stat-row"><span>Shopping Malls:</span><strong>{networkStats.malls}</strong></div>
                      <div className="stat-row"><span>Retail Commercial Shops:</span><strong>{networkStats.stores}</strong></div>
                    </>
                  )}
                  <p className="hint" style={{ marginTop: 8 }}>
                    💡 Click any road segment or building pin on the map to inspect vehicle density, modify speed limits, or inject localized weather events.
                  </p>
                </div>
              )}
            </div>
            {/* Fade mask so panel occupies full height and fades gracefully */}
            <div className="feed-fade-mask" />
          </div>
        </aside>
      </section>

      <footer>
        <span title="Cryptographic SHA-256 hash of canonical network topology graph">Graph Hash: {topology?.graph_hash?.slice(0, 18) ?? '—'}</span>
        <span title="Active deterministic scenario generation seed">Active Seed: {status?.global_seed || seed || '—'}</span>
        <span title="Current backend daemon connection state">
          {terminated ? 'Server Offline' : error ? error : running ? '● Live Simulation Active (500ms sync)' : '○ Standby'}
        </span>
      </footer>
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
