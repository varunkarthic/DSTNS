import { useEffect, useState } from "react";
import { api } from "./api";
import type { Envelope, News, Snapshot, Status, Topology } from "./types";
export function useSimulation() {
  const [status, setStatus] = useState<Envelope<Status> | null>(null),
    [snapshot, setSnapshot] = useState<Envelope<Snapshot> | null>(null),
    [topology, setTopology] = useState<Topology | null>(null);
  const [error, setError] = useState(""),
    [stage, setStage] = useState("Connecting to simulation…"),
    [lastUpdated, setLastUpdated] = useState(0),
    [now, setNow] = useState(Date.now());
  const [news, setNews] = useState<News[]>([]),
    [toasts, setToasts] = useState<News[]>([]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>,
      run = "",
      since = 0,
      initial = true;
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
          setLastUpdated(Date.now());
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
          }
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
              if (important.length)
                setToasts((old) =>
                  [...important.slice(-3), ...old].slice(0, 3),
                );
            }
            setNews((old) => [...items.reverse(), ...old].slice(0, 200));
            since = Math.max(since, ...items.map((n) => n.news_id));
            initial = false;
          }
          setStatus(st);
          setSnapshot(snap);
          setLastUpdated(Date.now());
          setStage("");
          setError("");
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
    const timer = setTimeout(() => setToasts([]), 7000);
    return () => clearTimeout(timer);
  }, [toasts]);
  return {
    status,
    snapshot,
    topology,
    error,
    stage,
    lastUpdated,
    stale: !!lastUpdated && now - lastUpdated > 5000,
    news,
    toasts,
    dismissToast: (id: number) =>
      setToasts((old) => old.filter((n) => n.news_id !== id)),
  };
}
