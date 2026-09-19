import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon, categoryIcon } from "./Icons";
import type { IconName } from "./Icons";
import { Tooltip } from "./Tooltip";
import { api } from "./api";
import { describeNews, stripPrefix } from "./notificationModel";
import { useTimeFormat } from "./preferences";
import type { RuntimeStatus } from "./telemetryRecorder";
import type { Backpressure, Congestion, EventPage, News, Snapshot, Status, Topology, WeatherState } from "./types";

type Props = {
  status: Status | undefined;
  snapshot: Snapshot | null;
  topology: Topology | null;
  congestion: Congestion | undefined;
  news: News[];
  runtime: RuntimeStatus;
  virtualTime: number;
  runId: string;
  asb: Backpressure | null;
};

/** Events shown as incidents rather than routine news. */
const incidentCategories = new Set(["safety", "incident", "flooding"]);
const incidentPattern = /crash|collision|breakdown|puncture|spill|diversion|closed|flood/i;
export function isIncident(item: News) {
  return incidentCategories.has(item.category) || incidentPattern.test(item.message);
}

function rainfallSummary(weather: WeatherState[]) {
  if (!weather.length) return { label: "Clear", detail: "No active cells" };
  const peak = weather.reduce((a, b) => (b.intensity > a.intensity ? b : a));
  // Intensity is a normalized 0 to 1 field; shown as an indicative rate.
  return { label: peak.intensity > 0.6 ? "Heavy rain" : "Rain", detail: `${(peak.intensity * 8).toFixed(1)} mm/h` };
}

const STATUS_TEXT: Record<RuntimeStatus, string> = { online: "Online", degraded: "Degraded", offline: "Offline" };

/**
 * A scroll region whose lower edge fades out while more content lies below,
 * and stops fading once the real end is reached.
 */
function FadeScroll({ children, resetKey }: { children: ReactNode; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [resetKey]);
  return (
    <div ref={ref} className={`stream${atEnd ? " at-end" : ""}`} role="tabpanel" onScroll={measure}>
      {children}
    </div>
  );
}

function StreamRow({
  icon,
  tone = "",
  title,
  tag,
  tagTone = "grey",
  meta,
  metaRight,
  meter,
  alert,
}: {
  icon: IconName;
  tone?: string;
  title: ReactNode;
  tag?: string;
  tagTone?: string;
  meta?: ReactNode;
  metaRight?: ReactNode;
  meter?: number;
  alert?: boolean;
}) {
  return (
    <div className={`stream-card${alert ? " alert" : ""}`}>
      <span className={`row-icon ${tone}`} aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <div className="row-main">
        <div className="stream-head">
          <strong className="stream-title">{title}</strong>
          {tag && <span className={`tag ${tagTone}`}>{tag}</span>}
        </div>
        {(meta || metaRight) && (
          <div className="stream-meta">
            <span>{meta}</span>
            {metaRight && <span className="mono">{metaRight}</span>}
          </div>
        )}
        {meter !== undefined && (
          <div className="meter thin" aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(0, meter * 100))}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="stream-empty">
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </div>
  );
}

export function TelemetryDeck({ status, snapshot, topology, congestion, news, runtime, virtualTime, runId, asb }: Props) {
  const time = useTimeFormat();
  const [tab, setTab] = useState<"stack" | "events" | "queue" | "incidents">("stack");
  const [queueView, setQueueView] = useState<"future" | "history">("future");
  const [queueCategory, setQueueCategory] = useState("all");
  const [queue, setQueue] = useState<EventPage | null>(null);
  const [queueError, setQueueError] = useState("");
  useEffect(() => setQueue(null), [runId, queueView, queueCategory]);
  // The scheduled-event queue is paged by the core; only the open tab polls.
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
        if (!cancel) setQueueError(e instanceof Error ? e.message : "Scheduled events are unavailable.");
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

  const vehicles = useMemo(() => snapshot?.edges.reduce((sum, e) => sum + e.vehicle_count, 0) ?? 0, [snapshot]);
  const halting = useMemo(() => snapshot?.edges.reduce((sum, e) => sum + e.halting_count, 0) ?? 0, [snapshot]);
  const activeEdges = useMemo(() => snapshot?.edges.filter((e) => e.vehicle_count > 0).length ?? 0, [snapshot]);
  const incidents = useMemo(() => news.filter(isIncident), [news]);
  const openIncidents = snapshot?.active_incidents ?? [];
  const weather = useMemo(() => rainfallSummary(snapshot?.active_weather ?? []), [snapshot]);

  const tabs = [
    ["stack", "Stack", 0],
    ["events", "News", news.length],
    ["queue", "Queue", queue?.pending_count ?? 0],
    ["incidents", "Incidents", openIncidents.length],
  ] as const;

  return (
    <aside data-tutorial="telemetry" className="telemetry-deck" aria-label="Live telemetry">
      <div className="deck-header">
        <h2>Live telemetry</h2>
        <span className={`runtime runtime-${runtime} small`}>
          <i aria-hidden="true" />
          {STATUS_TEXT[runtime]}
        </span>
      </div>

      <div className="metric-grid">
        <div className="metric">
          <span className="metric-label">Road edges</span>
          <span className="metric-value">{topology ? topology.edges.length.toLocaleString() : "0"}</span>
          <span className="tag mint">{activeEdges.toLocaleString()} carrying flow</span>
        </div>
        <div className="metric">
          <span className="metric-label">Vehicles</span>
          <span className="metric-value accent">{snapshot ? vehicles.toLocaleString() : "0"}</span>
          <span className="tag cyan">{halting.toLocaleString()} halting</span>
        </div>
        <div className="metric">
          <span className="metric-label">Incidents</span>
          <span className="metric-value error">{openIncidents.length}</span>
          <span className="tag red">{openIncidents.filter((i) => i.closed).length} closed</span>
        </div>
        <div className="metric" data-tutorial="weather">
          <span className="metric-label">Weather</span>
          <span className="metric-value small">{weather.label}</span>
          <span className="tag mint">{weather.detail}</span>
        </div>
        <div className="metric wide" data-tutorial="congestion">
          <div className="metric-row">
            <span className="metric-label">Congestion index</span>
            <span className="metric-figure mono">{congestion ? `${congestion.current.toFixed(0)}%` : "0%"}</span>
          </div>
          <Tooltip
            label="Congestion index"
            detail="Speed loss 60%, queue ratio 25% and occupancy 15%, weighted by road length and lanes. Shows the state computed for the current instant."
          >
            <div className="meter" role="img" aria-label={`Congestion index ${congestion ? congestion.current.toFixed(0) : 0} percent`}>
              <i style={{ width: `${Math.min(100, congestion?.current ?? 0)}%` }} />
            </div>
          </Tooltip>
        </div>
      </div>

      <div data-tutorial="events" className="tab-row" role="tablist" aria-label="Telemetry detail">
        {tabs.map(([key, label, count]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
            {count > 0 && key !== "stack" && <span className="count">{count > 99 ? "99+" : count}</span>}
          </button>
        ))}
      </div>

      <FadeScroll resetKey={tab}>
        {tab === "stack" && (
          <>
            <StreamRow
              icon="network"
              tone="cyan"
              title="Road network"
              tag={topology ? "Loaded" : "Waiting"}
              tagTone={topology ? "mint" : "grey"}
              meta={topology ? `${topology.nodes.length.toLocaleString()} junctions · ${topology.edges.length.toLocaleString()} edges` : "Awaiting topology"}
              metaRight={topology?.graph_hash ? topology.graph_hash.replace(/^sha256:/, "").slice(0, 8) : undefined}
            />
            <StreamRow
              icon="traffic"
              tone="mint"
              title="Traffic and routing"
              tag={status?.modules?.traffic ? "Active" : "Off"}
              tagTone={status?.modules?.traffic ? "mint" : "grey"}
              meta={`${activeEdges.toLocaleString()} edges carrying flow`}
              metaRight={`${vehicles.toLocaleString()} veh`}
              meter={snapshot?.edges.length ? activeEdges / snapshot.edges.length : undefined}
            />
            <StreamRow
              icon="rain"
              tone="blue"
              title="Weather"
              tag={status?.modules?.dws ? "Active" : "Off"}
              tagTone={status?.modules?.dws ? "mint" : "grey"}
              meta={`${snapshot?.active_weather.length ?? 0} rain cell${snapshot?.active_weather.length === 1 ? "" : "s"}`}
              metaRight={weather.detail}
            />
            <StreamRow
              icon="gauge"
              tone={asb && asb.state !== "NORMAL" ? "amber" : "mint"}
              title="Adaptive backpressure"
              tag={asb ? asb.state.charAt(0) + asb.state.slice(1).toLowerCase() : "Idle"}
              tagTone={asb && asb.state !== "NORMAL" ? "amber" : "mint"}
              meta={asb ? `${(asb.score * 100).toFixed(0)}% pressure · ${(asb.throughput?.snapshots_per_s ?? 0).toFixed(1)} snapshots/s` : "Not reporting"}
              metaRight={asb ? (asb.rate_capped ? `${asb.applied_tick_rate}× of ${asb.requested_tick_rate}×` : `${asb.applied_tick_rate}×`) : undefined}
              meter={asb ? asb.score : undefined}
            />
            <StreamRow
              icon="signal"
              tone="violet"
              title="Signal controllers"
              tag={status?.modules?.signals ? "Active" : "Off"}
              tagTone={status?.modules?.signals ? "mint" : "grey"}
              meta={`${snapshot?.signals.length ?? 0} junctions scheduled`}
              metaRight={time.time(virtualTime)}
            />
          </>
        )}

        {tab === "events" &&
          (news.length ? (
            news.slice(0, 120).map((item) => (
              <StreamRow
                key={item.news_id}
                icon={categoryIcon(item.category)}
                tone={item.severity === "alert" ? "red" : item.severity === "warning" ? "amber" : ""}
                title={time.text(stripPrefix(item.message))}
                meta={<span className="mono">{time.event(item)}</span>}
                metaRight={item.category}
              />
            ))
          ) : (
            <Empty icon="info">No events recorded yet for this run.</Empty>
          ))}

        {tab === "queue" && (
          <>
            <div className="queue-filters" role="group" aria-label="Scheduled event view">
              {(
                [
                  ["future", "Upcoming"],
                  ["history", "Executed"],
                ] as const
              ).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={queueView === key} onClick={() => setQueueView(key)}>
                  {label}
                </button>
              ))}
              <select aria-label="Event category" value={queueCategory} onChange={(e) => setQueueCategory(e.target.value)}>
                {["all", "signals", "demand", "incidents", "weather", "flooding", "system"].map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            {queueError && <Empty icon="incident">{queueError}</Empty>}
            {!queueError && !queue && <Empty icon="clock">Loading scheduled events.</Empty>}
            {queue?.items.length === 0 && (
              <Empty icon="clock">No {queueView === "future" ? "pending" : "executed"} events in this category.</Empty>
            )}
            {queue?.items.map((item) => (
              <StreamRow
                key={`${item.id}-${item.virtual_s}`}
                icon={categoryIcon(item.category === "incidents" ? "incident" : item.category)}
                title={time.text(item.description)}
                tag={item.category}
                meta={<span className="mono">{time.time(item.virtual_s)}</span>}
                metaRight={`${queueView === "future" ? "scheduled" : "executed"} · entity ${item.entity}`}
              />
            ))}
            {queue && (
              <p className="stream-foot">
                {queue.pending_count.toLocaleString()} pending · {queue.executed_count.toLocaleString()} executed
              </p>
            )}
          </>
        )}

        {tab === "incidents" &&
          (incidents.length ? (
            incidents.slice(0, 120).map((item) => {
              const d = describeNews(item, topology);
              return (
                <StreamRow
                  key={item.news_id}
                  icon={categoryIcon(item.category)}
                  tone={item.severity === "alert" ? "red" : "amber"}
                  alert={item.severity === "alert"}
                  title={d.title}
                  tag={item.severity === "alert" ? "High" : item.severity === "warning" ? "Moderate" : "Low"}
                  tagTone={item.severity === "alert" ? "red" : item.severity === "warning" ? "amber" : "grey"}
                  meta={time.text(d.summary)}
                  metaRight={time.event(item)}
                />
              );
            })
          ) : (
            <Empty icon="check">No incidents on the network.</Empty>
          ))}
      </FadeScroll>
    </aside>
  );
}
