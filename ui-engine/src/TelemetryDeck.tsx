import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "./Tooltip";
import { api } from "./api";
import type {
  Backpressure,
  Congestion,
  EventPage,
  News,
  Snapshot,
  Status,
  Topology,
  WeatherState,
} from "./types";

type Props = {
  status: Status | undefined;
  snapshot: Snapshot | null;
  topology: Topology | null;
  congestion: Congestion | undefined;
  history: Congestion | null;
  news: News[];
  connected: boolean;
  virtualTime: number;
  runId: string;
  /** Live backpressure, shown as its own pipeline stage. */
  asb: Backpressure | null;
};

/** Events the operator should see as incidents rather than routine traffic news. */
const incidentCategories = new Set(["safety", "incident", "flooding"]);
const incidentPattern =
  /crash|collision|breakdown|puncture|spill|diversion|closed|flood/i;

function isIncident(item: News) {
  return (
    incidentCategories.has(item.category) || incidentPattern.test(item.message)
  );
}

function clockOf(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return [s / 3600, (s % 3600) / 60, s % 60]
    .map((v) => String(Math.floor(v)).padStart(2, "0"))
    .join(":");
}

function rainfallSummary(weather: WeatherState[]) {
  if (!weather.length) return { label: "Clear", detail: "no active cells" };
  const peak = weather.reduce((a, b) => (b.intensity > a.intensity ? b : a));
  // Intensity is a normalized 0-1 field; present it as an indicative rate.
  return {
    label: peak.intensity > 0.6 ? "Heavy rain" : "Rain",
    detail: `${(peak.intensity * 8).toFixed(1)} mm/h`,
  };
}

export function TelemetryDeck({
  status,
  snapshot,
  topology,
  congestion,
  history,
  news,
  connected,
  virtualTime,
  runId,
  asb,
}: Props) {
  const [tab, setTab] = useState<
    "stack" | "events" | "queue" | "incidents"
  >("stack");
  // The scheduled-event queue is paged server-side; only poll the open tab.
  const [queueView, setQueueView] = useState<"future" | "history">("future");
  const [queueCategory, setQueueCategory] = useState("all");
  const [queue, setQueue] = useState<EventPage | null>(null);
  const [queueError, setQueueError] = useState("");
  useEffect(() => {
    setQueue(null);
  }, [runId, queueView, queueCategory]);
  useEffect(() => {
    if (!runId || tab !== "queue") return;
    let cancel = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api.events(queueView, queueCategory, 0);
        if (!cancel && result.run_id === runId) {
          setQueue(result.data);
          setQueueError("");
        }
      } catch (e) {
        if (!cancel)
          setQueueError(e instanceof Error ? e.message : "Events unavailable");
      } finally {
        if (!cancel) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [runId, tab, queueView, queueCategory]);

  const vehicles = useMemo(
    () => snapshot?.edges.reduce((sum, e) => sum + e.vehicle_count, 0) ?? 0,
    [snapshot],
  );
  const activeEdges = useMemo(
    () => snapshot?.edges.filter((e) => e.vehicle_count > 0).length ?? 0,
    [snapshot],
  );
  const incidents = useMemo(() => news.filter(isIncident), [news]);
  const openIncidents = useMemo(
    () => snapshot?.active_incidents ?? [],
    [snapshot],
  );
  const weather = useMemo(
    () => rainfallSummary(snapshot?.active_weather ?? []),
    [snapshot],
  );
  const baseline = history?.average ?? congestion?.average ?? 0;

  // "Stack" mirrors the alpha's pipeline view: what the core is doing right now.
  const stack = useMemo(
    () => [
      {
        key: "network",
        badge: "",
        tone: "",
        title: "Spatiotemporal Graph Matrix",
        tag: topology ? "SYNCED" : "WAITING",
        left: topology
          ? `${topology.nodes.length.toLocaleString()} nodes · ${topology.edges.length.toLocaleString()} edges`
          : "Awaiting topology",
        right: topology?.graph_hash
          ? topology.graph_hash.replace(/^sha256:/, "").slice(0, 8)
          : "—",
      },
      {
        key: "traffic",
        badge: "",
        tone: "mint",
        title: "Traffic & Routing",
        tag: status?.modules?.traffic ? "ACTIVE" : "OFF",
        left: `${activeEdges.toLocaleString()} edges carrying flow`,
        right: `${vehicles.toLocaleString()} veh`,
        meter: snapshot?.edges.length
          ? activeEdges / snapshot.edges.length
          : undefined,
      },
      {
        key: "dws",
        badge: "",
        tone: "mint",
        title: "Deterministic Weather",
        tag: status?.modules?.dws ? "ACTIVE" : "OFF",
        left: `${snapshot?.active_weather.length ?? 0} storm cells`,
        right: weather.detail,
      },
      {
        key: "asb",
        badge: "",
        tone: asb && asb.state !== "NORMAL" ? "red" : "mint",
        title: "Adaptive Backpressure",
        tag: asb ? asb.state : "IDLE",
        left: asb
          ? `${(asb.score * 100).toFixed(0)}% backpressure · ${(asb.throughput?.snapshots_per_s ?? 0).toFixed(1)}/s`
          : "Not reporting",
        right: asb
          ? asb.rate_capped
            ? `${asb.applied_tick_rate}× of ${asb.requested_tick_rate}×`
            : `${asb.applied_tick_rate}×`
          : "—",
        meter: asb ? asb.score : undefined,
      },
      {
        key: "signals",
        badge: "",
        tone: "violet",
        title: "Signal Controllers",
        tag: status?.modules?.signals ? "ACTIVE" : "OFF",
        left: `${snapshot?.signals.length ?? 0} junctions scheduled`,
        right: clockOf(virtualTime),
      },
    ],
    [
      topology,
      status?.modules,
      activeEdges,
      vehicles,
      snapshot,
      weather.detail,
      virtualTime,
      asb,
    ],
  );

  return (
    <aside className="telemetry-deck glass" aria-label="Live telemetry">
      <div className="deck-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="live-dot" aria-hidden="true">
            <span />
            <span />
          </span>
          <h2>LIVE TELEMETRY</h2>
        </div>
        <span className="chip">{connected ? "1 Hz Synced" : "Offline"}</span>
      </div>

      <div className="metric-grid">
        <div className="metric">
          <div className="metric-top">
            <span>Road Edges</span>
          </div>
          <div className="metric-bottom">
            <span className="metric-value">
              {topology ? topology.edges.length.toLocaleString() : "—"}
            </span>
            <span className="tag mint">{activeEdges} active</span>
          </div>
        </div>

        <div className="metric">
          <div className="metric-top">
            <span>Vehicles</span>
          </div>
          <div className="metric-bottom">
            <span className="metric-value accent">
              {snapshot ? vehicles.toLocaleString() : "—"}
            </span>
            <span className="tag cyan">
              {snapshot
                ? `${snapshot.edges
                    .reduce((sum, e) => sum + e.halting_count, 0)
                    .toLocaleString()} halting`
                : "—"}
            </span>
          </div>
        </div>

        <div className="metric">
          <div className="metric-top">
            <span>Incidents</span>
          </div>
          <div className="metric-bottom">
            <span className="metric-value error">{openIncidents.length}</span>
            <span className="tag red">
              {openIncidents.filter((i) => i.closed).length} closed
            </span>
          </div>
        </div>

        <div className="metric">
          <div className="metric-top">
            <span>Weather Cell</span>
          </div>
          <div className="metric-bottom">
            <span className="metric-value small">{weather.label}</span>
            <span className="tag mint">{weather.detail}</span>
          </div>
        </div>

        <div className="metric wide">
          <div className="metric-top">
            <span>Congestion Index</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                className="mono"
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: "var(--secondary)",
                }}
              >
                {congestion ? `${congestion.current.toFixed(0)}%` : "—"}
              </span>
              {congestion && (
                <span className="tag mint">
                  {congestion.delta >= 0 ? "↑" : "↓"}{" "}
                  {Math.abs(congestion.delta).toFixed(1)} pp
                </span>
              )}
            </div>
          </div>
          <Tooltip
            info={{
              title: "Congestion model",
              category: "Analytics",
              description:
                "Speed loss (60%), queue ratio (25%) and occupancy (15%). Network weighted by road length × lanes. The marker is the 15-minute virtual-time moving average.",
            }}
          >
            <div className="meter" role="img" aria-label="Congestion index">
              <i style={{ width: `${Math.min(100, congestion?.current ?? 0)}%` }} />
              <b style={{ left: `${Math.min(100, baseline)}%` }} />
            </div>
          </Tooltip>
        </div>
      </div>

      <div className="tab-row" role="tablist" aria-label="Telemetry detail">
        {(
          [
            ["stack", "Stack", 0],
            ["events", "News", news.length],
            ["queue", "Queue", queue?.pending_count ?? 0],
            // Count what is live on the network, matching the metric tile above,
            // rather than every incident-shaped message ever received.
            ["incidents", "Incidents", openIncidents.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {key === "stack" && (
              <span
                className="live-dot sm"
                aria-hidden="true"
                style={{ height: 6, width: 6 }}
              >
                <span />
                <span style={{ height: 6, width: 6 }} />
              </span>
            )}
            {label}
            {count > 0 && key !== "stack" && (
              <span className="count">{count > 99 ? "99+" : count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="stream" role="tabpanel">
        {tab === "stack" &&
          stack.map((row) => (
            <div key={row.key} className="stream-card active">
              <div className="stream-head">
                <div className="stream-title">
                  <span className={`badge ${row.tone}`} aria-hidden="true">
                    ◆
                  </span>
                  <strong>{row.title}</strong>
                </div>
                <span
                  className={`tag ${row.tag === "ACTIVE" || row.tag === "SYNCED" ? "mint" : "grey"}`}
                >
                  {row.tag}
                </span>
              </div>
              <div className="stream-meta">
                <span>{row.left}</span>
                <span className="mono" style={{ color: "var(--primary)" }}>
                  {row.right}
                </span>
              </div>
              {row.meter !== undefined && (
                <div className="meter" style={{ height: 6 }}>
                  <i
                    style={{
                      width: `${Math.min(100, row.meter * 100)}%`,
                      background: "var(--primary-container)",
                    }}
                  />
                </div>
              )}
            </div>
          ))}

        {tab === "events" &&
          (news.length ? (
            news.slice(0, 80).map((item) => (
              <div key={item.news_id} className="stream-card">
                <div className="stream-head">
                  <div className="stream-title">
                    <strong>{item.message.replace(/^\[.*?\]\s*/, "")}</strong>
                  </div>
                </div>
                <div className="stream-meta">
                  <span className="mono">{item.simulated_current_time}</span>
                  <span className="tag grey">{item.category}</span>
                </div>
              </div>
            ))
          ) : (
            <p className="stream-empty">
              No events recorded yet for this run.
            </p>
          ))}

        {tab === "queue" && (
          <>
            <div
              className="tab-row"
              style={{ marginBottom: 4 }}
              role="group"
              aria-label="Scheduled event view"
            >
              {(
                [
                  ["future", "Upcoming"],
                  ["history", "Executed"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={queueView === key}
                  aria-selected={queueView === key}
                  onClick={() => setQueueView(key)}
                >
                  {label}
                </button>
              ))}
              <select
                aria-label="Event category"
                value={queueCategory}
                onChange={(e) => setQueueCategory(e.target.value)}
                className="mono"
                style={{
                  background: "var(--surface-container)",
                  color: "var(--on-surface)",
                  border: "1px solid rgb(60 73 77 / 40%)",
                  borderRadius: "var(--radius-lg)",
                  fontSize: 11,
                  padding: "3px 6px",
                }}
              >
                {[
                  "all",
                  "signals",
                  "demand",
                  "incidents",
                  "weather",
                  "flooding",
                  "system",
                ].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            {queueError && <p className="stream-empty">{queueError}</p>}
            {!queueError && !queue && (
              <p className="stream-empty">Loading scheduled events…</p>
            )}
            {queue?.items.length === 0 && (
              <p className="stream-empty">
                No {queueView === "future" ? "pending" : "executed"} events in
                this category.
              </p>
            )}
            {queue?.items.map((item) => (
              <div key={`${item.id}-${item.virtual_s}`} className="stream-card event-row">
                <div className="stream-head">
                  <div className="stream-title">
                    <strong>{item.description}</strong>
                  </div>
                  <span className="tag grey">{item.category}</span>
                </div>
                <div className="stream-meta">
                  <span className="mono">{clockOf(item.virtual_s)}</span>
                  <small>
                    {queueView === "future" ? "scheduled" : "executed"} · entity{" "}
                    {item.entity}
                  </small>
                </div>
              </div>
            ))}
            {queue && (
              <p className="stream-empty" style={{ paddingTop: 4 }}>
                {queue.pending_count.toLocaleString()} pending ·{" "}
                {queue.executed_count.toLocaleString()} executed
              </p>
            )}
          </>
        )}

        {tab === "incidents" &&
          (incidents.length ? (
            incidents.slice(0, 80).map((item) => (
              <div key={item.news_id} className="stream-card alert">
                <div className="stream-head">
                  <div className="stream-title">
                    <span className="badge red" aria-hidden="true">
                      !
                    </span>
                    <strong>{item.message.replace(/^\[.*?\]\s*/, "")}</strong>
                  </div>
                </div>
                <div className="stream-meta">
                  <span className="mono">{item.simulated_current_time}</span>
                  <span className="tag red">{item.severity || "incident"}</span>
                </div>
              </div>
            ))
          ) : (
            <p className="stream-empty">No incidents on the network.</p>
          ))}
      </div>
    </aside>
  );
}
