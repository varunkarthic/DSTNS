import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Envelope, News, Snapshot, Status, Topology } from "./types";
export function useSimulation(dwellMs = 7000) {
  const [status, setStatus] = useState<Envelope<Status> | null>(null),
    [snapshot, setSnapshot] = useState<Envelope<Snapshot> | null>(null),
    [topology, setTopology] = useState<Topology | null>(null);
  const [error, setError] = useState(""),
    [stage, setStage] = useState("Connecting to simulation…"),
    [lastUpdated, setLastUpdated] = useState(0),
    // performance.now() alongside it: a monotonic clock, so a system time
    // change cannot make freshly arrived data look ancient.
    [lastDataAt, setLastDataAt] = useState(() => performance.now()),
    [now, setNow] = useState(Date.now());
  const [news, setNews] = useState<News[]>([]),
    [toasts, setToasts] = useState<News[]>([]);
  const receivedAt = useRef(new Map<number, number>());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>,
      run = "",
      since = 0,
      initial = true,
      lastVirtual = -1;
    async function refresh() {
      try {
        const [st, snap] = await Promise.all([api.status(), api.snapshot()]);
        if (cancelled) return;
        if (st.run_id !== snap.run_id)
          throw new Error("Synchronizing a new simulation…");
        if (st.data.lifecycle === "IDLE" || !st.run_id) {
          setTopology(null);
          setSnapshot(null);
          setStatus(st);
          setError("");
          setStage("Awaiting CLI startup");
          run = "";
          since = 0;
          initial = true;
          setNews([]);
          setToasts([]);
          receivedAt.current.clear();
          setLastUpdated(Date.now());
          setLastDataAt(performance.now());
        } else {
          if (
            !Array.isArray(snap.data.edges) ||
            !Array.isArray(snap.data.signals) ||
            !snap.data.congestion ||
            !Number.isFinite(snap.data.congestion.current)
          )
            throw new Error("Invalid simulation state received. Reconnecting…");
          if (run !== st.run_id) {
            setStage("Loading network and buildings…");
            setTopology(null);
            setSnapshot(null);
            const topo = await api.topology();
            if (cancelled) return;
            if (topo.run_id !== st.run_id)
              throw new Error("Synchronizing a new simulation…");
            if (
              !topo.data.nodes?.length ||
              !topo.data.edges?.length ||
              !Array.isArray(topo.data.features)
            )
              throw new Error("Map data is missing or incomplete.");
            setTopology(topo.data);
            run = st.run_id;
            since = 0;
            initial = true;
            setNews([]);
            setToasts([]);
            receivedAt.current.clear();
          }
          // Publish fresh simulation data independently of the auxiliary news feed.
          setStatus(st);
          setSnapshot(snap);
          setLastUpdated(Date.now());
          setLastDataAt(performance.now());
          setStage("");
          setError("");
          if (snap.clock.virtual_day_seconds < lastVirtual) {
            since = 0;
            initial = true;
            setNews([]);
            setToasts([]);
            receivedAt.current.clear();
          }
          lastVirtual = snap.clock.virtual_day_seconds;
          const messages = await api.news(since);
          if (cancelled) return;
          if (messages.run_id === run) {
            const items = messages.data.items;
            if (!initial) {
              const important = items.filter((n) =>
                [
                  "DEMAND_CHANGED",
                  "DWS_RAIN_STARTED",
                  "INCIDENT_ACTIVATED",
                  "INCIDENT_RESOLVED",
                  "FLOOD_STARTED",
                ].includes(n.template_id),
              );
              // Keep the burst intact: grouping collapses it for display, so
              // truncating here would throw away the count before it is shown.
              if (important.length) {
                for (const n of important)
                  if (!receivedAt.current.has(n.news_id)) receivedAt.current.set(n.news_id, performance.now());
                setToasts((old) => mergeNews(important, old, 200));
              }
            }
            setNews((old) => mergeNews(items, old, 200));
            since = Math.max(since, ...items.map((n) => n.news_id));
            initial = false;
          }
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Connection failed.");
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!toasts.length) return;
    const nextExpiry = Math.min(...toasts.map(n => (receivedAt.current.get(n.news_id) ?? 0) + dwellMs));
    const timer = setTimeout(() => {
      const now = performance.now();
      setToasts(old => old.filter(n => now < (receivedAt.current.get(n.news_id) ?? 0) + dwellMs));
      for (const [id, at] of receivedAt.current) if (now >= at + dwellMs) receivedAt.current.delete(id);
    }, Math.max(0, nextExpiry - performance.now()));
    return () => clearTimeout(timer);
  }, [toasts, dwellMs]);
  return {
    status,
    snapshot,
    topology,
    error,
    stage,
    lastUpdated,
    lastDataAt,
    stale: !!lastUpdated && now - lastUpdated > 5000,
    news,
    toasts,
    dismissToast: (id: number) =>
      setToasts((old) => old.filter((n) => n.news_id !== id)),
    /** Dismiss a whole group at once. */
    dismissToasts: (ids: number[]) => {
      const drop = new Set(ids);
      setToasts((old) => old.filter((n) => !drop.has(n.news_id)));
    },
  };
}

/** Stable identity and bounded history even if a poll repeats messages. */
export function mergeNews(incoming: News[], previous: News[], limit: number): News[] {
  return [...new Map([...previous, ...incoming].map(n => [n.news_id, n])).values()]
    .sort((a, b) => b.news_id - a.news_id).slice(0, limit);
}
