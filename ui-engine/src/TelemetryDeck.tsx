// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useScrollFade } from "./scrollFade";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon, categoryIcon } from "./Icons";
import type { IconName } from "./Icons";
import { Select } from "./Popover";
import { Tooltip } from "./Tooltip";
import { api } from "./api";
import { formatCompact } from "./format";
import { DELIVERY_LABEL, filterHistory } from "./notificationHistory";
import type { Delivery, HistoryEntry, HistoryFilter } from "./notificationHistory";
import { SEVERITY_LABEL, describeNews, stripPrefix } from "./notificationModel";
import { useTimeFormat } from "./preferences";
import { networkFigures, weatherSummary } from "./telemetryModel";
import type { WeatherSummary } from "./telemetryModel";
import type { RuntimeStatus } from "./telemetryRecorder";
import type { Backpressure, Congestion, EventPage, News, Snapshot, Status, Topology } from "./types";

/**
 * Live telemetry.
 *
 * Two presentations of the same data. The full panel shows the network
 * measures and the detail tabs. Collapsed, it becomes a narrow strip of
 * compact figures; each detail view then opens in a temporary side panel
 * beside the strip, so looking at one list never reopens the whole panel.
 */

export type TelemetryTab = "stack" | "events" | "queue" | "incidents" | "notifications";
export type PanelView = TelemetryTab | "overview";

export interface HistoryFeed {
  entries: readonly HistoryEntry[];
  counts: Record<Delivery | "all" | "autoFocused", number>;
  revision: number;
}

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
  history: HistoryFeed;
  compact: boolean;
  tutorialTarget?: string;
  onCollapse: () => void;
  onExpand: () => void;
};

/** Events shown as incidents rather than routine news. */
const incidentCategories = new Set(["safety", "incident", "flooding"]);
const incidentPattern = /crash|collision|breakdown|puncture|spill|diversion|closed|flood/i;
export function isIncident(item: News) {
  return incidentCategories.has(item.category) || incidentPattern.test(item.message);
}

const STATUS_TEXT: Record<RuntimeStatus, string> = { online: "Online", degraded: "Degraded", offline: "Offline" };

export const TABS: { id: TelemetryTab; label: string; icon: IconName }[] = [
  { id: "stack", label: "Stack", icon: "stack" },
  { id: "events", label: "News", icon: "news" },
  { id: "queue", label: "Queue", icon: "queue" },
  { id: "incidents", label: "Incidents", icon: "incident" },
  { id: "notifications", label: "Notifications", icon: "notificationHistory" },
];
const VIEW_TITLE: Record<PanelView, string> = {
  overview: "Network",
  stack: "Stack",
  events: "News",
  queue: "Queue",
  incidents: "Incidents",
  notifications: "Notifications",
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * A scroll region whose lower edge fades out while more content lies below,
 * and stops fading once the real end is reached.
 */
function FadeScroll({ children, resetKey, labelledBy }: { children: ReactNode; resetKey: string; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = useScrollFade<HTMLDivElement>();
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [resetKey]);
  return (
    <div {...scroll} ref={useCallback((el: HTMLDivElement | null) => { ref.current = el; scroll.ref(el); }, [scroll.ref])} className={`stream ${scroll.className}`} role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
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

/** Weather glyph whose colour and bar count both carry the severity. */
export function WeatherGlyph({ weather, size = 16 }: { weather: WeatherSummary; size?: 14 | 16 | 18 }) {
  return (
    <span className={`wx wx-${weather.level}`} aria-hidden="true">
      {/* The glyph says what the sky is doing: a waveform did not. */}
      <Icon
        name={weather.level === "clear" ? "sun" : weather.level === "heavy" ? "cloudHeavy" : "cloudRain"}
        size={size}
      />
      <span className="wx-bars">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= weather.bars ? "on" : ""} />
        ))}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function Overview({ snapshot, topology, congestion }: Pick<Props, "snapshot" | "topology" | "congestion">) {
  const f = useMemo(() => networkFigures(snapshot, topology), [snapshot, topology]);
  const weather = useMemo(() => weatherSummary(snapshot?.active_weather), [snapshot]);
  const value = congestion?.current ?? 0;
  return (
    <div className="metric-grid">
      <div className="metric" data-tutorial="telemetry-roads">
        <span className="metric-label">
          <Icon name="road" size={14} /> Road edges
        </span>
        <span className="metric-value">{f.edges.toLocaleString()}</span>
        <span className="metric-sub">{f.flowingEdges.toLocaleString()} carrying flow</span>
      </div>
      <div className="metric" data-tutorial="telemetry-vehicles">
        <span className="metric-label">
          <Icon name="vehicle" size={14} /> Vehicles
        </span>
        <span className="metric-value accent">{f.vehicles.toLocaleString()}</span>
        <span className="metric-sub">{f.halting.toLocaleString()} halting</span>
      </div>
      <div className="metric" data-tutorial="telemetry-incidents-metric">
        <span className="metric-label">
          <Icon name="incident" size={14} /> Incidents
        </span>
        <span className={`metric-value${f.incidents ? " error" : ""}`}>{f.incidents}</span>
        <span className="metric-sub">{f.closed} closed</span>
      </div>
      <div className="metric" data-tutorial="telemetry-weather">
        <span className="metric-label">
          <WeatherGlyph weather={weather} size={14} /> Weather
        </span>
        <span className="metric-value small">{weather.label}</span>
        <span className="metric-sub">{weather.cells ? `${weather.cells} cell${weather.cells === 1 ? "" : "s"} · ${weather.rate}` : weather.rate}</span>
      </div>
      <div className="metric wide" data-tutorial="telemetry-congestion">
        <div className="metric-row">
          <span className="metric-label">
            <Icon name="gauge" size={14} /> Congestion index
          </span>
          <span className="metric-figure mono">{value.toFixed(0)}%</span>
        </div>
        <Tooltip
          label="Congestion index"
          detail="Speed loss 60%, queue ratio 25% and occupancy 15%, weighted by road length and lanes. Shows the state computed for the current instant."
        >
          <div className="meter" role="img" aria-label={`Congestion index ${value.toFixed(0)} percent`}>
            <i style={{ transform: `scaleX(${Math.min(100, value) / 100})` }} />
          </div>
        </Tooltip>
      </div>
    </div>
  );
}

function StackView({ status, snapshot, topology, asb, virtualTime }: Pick<Props, "status" | "snapshot" | "topology" | "asb" | "virtualTime">) {
  const time = useTimeFormat();
  const f = useMemo(() => networkFigures(snapshot, topology), [snapshot, topology]);
  const weather = useMemo(() => weatherSummary(snapshot?.active_weather), [snapshot]);
  return (
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
        meta={`${f.flowingEdges.toLocaleString()} edges carrying flow`}
        metaRight={`${f.vehicles.toLocaleString()} veh`}
        meter={snapshot?.edges.length ? f.flowingEdges / snapshot.edges.length : undefined}
      />
      <StreamRow
        icon="rain"
        tone="blue"
        title="Weather"
        tag={status?.modules?.dws ? "Active" : "Off"}
        tagTone={status?.modules?.dws ? "mint" : "grey"}
        meta={`${weather.cells} rain cell${weather.cells === 1 ? "" : "s"}`}
        metaRight={weather.rate}
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
  );
}

function NewsView({ news }: { news: News[] }) {
  const time = useTimeFormat();
  if (!news.length) return <Empty icon="info">No events recorded yet for this run.</Empty>;
  return (
    <>
      {news.slice(0, 120).map((item) => (
        <StreamRow
          key={item.news_id}
          icon={categoryIcon(item.category)}
          tone={item.severity === "alert" ? "red" : item.severity === "warning" ? "amber" : ""}
          title={time.text(stripPrefix(item.message))}
          meta={<span className="mono">{time.event(item)}</span>}
          metaRight={item.category}
        />
      ))}
    </>
  );
}

function IncidentsView({ news, topology }: { news: News[]; topology: Topology | null }) {
  const time = useTimeFormat();
  const incidents = useMemo(() => news.filter(isIncident), [news]);
  if (!incidents.length) return <Empty icon="check">No incidents on the network.</Empty>;
  return (
    <>
      {incidents.slice(0, 120).map((item) => {
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
      })}
    </>
  );
}

const QUEUE_CATEGORIES = ["all", "signals", "demand", "incidents", "weather", "flooding", "system"] as const;
type QueueCategory = (typeof QUEUE_CATEGORIES)[number];
const QUEUE_OPTIONS = QUEUE_CATEGORIES.map((c) => ({ value: c, label: c === "all" ? "All categories" : c.charAt(0).toUpperCase() + c.slice(1) }));

interface QueueState {
  view: "future" | "history";
  category: QueueCategory;
}

/** The scheduled-event queue. It is paged by the core and only polled while visible. */
function QueueView({ runId, filter, onFilter }: { runId: string; filter: QueueState; onFilter: (f: QueueState) => void }) {
  const time = useTimeFormat();
  const [queue, setQueue] = useState<EventPage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setQueue(null), [runId, filter.view, filter.category]);
  useEffect(() => {
    if (!runId) return;
    let cancel = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api.events(filter.view, filter.category, 0);
        if (!cancel && result.run_id === runId) {
          const page = result.data;
          setQueue({
            ...page,
            items: Array.isArray(page?.items) ? page.items : [],
            pending_count: Number(page?.pending_count) || 0,
            executed_count: Number(page?.executed_count) || 0,
          });
          setError("");
        }
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : "Scheduled events are unavailable.");
      } finally {
        if (!cancel) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [runId, filter.view, filter.category]);

  return (
    <>
      <div className="view-filters" role="group" aria-label="Scheduled event view">
        <div className="seg small" role="radiogroup" aria-label="Queue">
          {(
            [
              ["future", "Upcoming"],
              ["history", "Executed"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={filter.view === key} onClick={() => onFilter({ ...filter, view: key })}>
              {label}
            </button>
          ))}
        </div>
        <Select label="Event category" value={filter.category} options={QUEUE_OPTIONS} onChange={(category) => onFilter({ ...filter, category })} />
      </div>
      {error && <Empty icon="incident">{error}</Empty>}
      {!error && !queue && <Empty icon="clock">Loading scheduled events.</Empty>}
      {queue?.items.length === 0 && <Empty icon="clock">No {filter.view === "future" ? "pending" : "executed"} events in this category.</Empty>}
      {queue?.items.map((item) => (
        <StreamRow
          key={`${item.id}-${item.virtual_s}`}
          icon={categoryIcon(item.category === "incidents" ? "incident" : item.category)}
          title={time.text(item.description)}
          tag={item.category}
          meta={<span className="mono">{time.time(item.virtual_s)}</span>}
          metaRight={`${filter.view === "future" ? "scheduled" : "executed"} · entity ${item.entity}`}
        />
      ))}
      {queue && (
        <p className="stream-foot">
          {queue.pending_count.toLocaleString()} pending · {queue.executed_count.toLocaleString()} executed
        </p>
      )}
    </>
  );
}

const HISTORY_PAGE = 60;
const HISTORY_FILTERS: { id: HistoryFilter; label: string; count: (c: HistoryFeed["counts"]) => number }[] = [
  { id: "all", label: "All", count: (c) => c.all },
  { id: "shown", label: "Shown", count: (c) => c.shown },
  { id: "silenced", label: "Silenced", count: (c) => c.silenced },
  { id: "autoFocused", label: "Auto Focus", count: (c) => c.autoFocused },
];

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const time = useTimeFormat();
  const [open, setOpen] = useState(false);
  const [technical, setTechnical] = useState(false);
  const id = useId();
  const tone = entry.severity === "alert" ? "red" : entry.severity === "warning" ? "amber" : "";
  return (
    <div className={`history-row${open ? " open" : ""}${entry.delivery === "silenced" ? " silenced" : ""}`}>
      <button type="button" className="history-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className={`row-icon ${tone}`} aria-hidden="true">
          <Icon name={categoryIcon(entry.category)} size={14} />
        </span>
        <span className="history-main">
          <span className="history-title">
            <strong>{entry.title}</strong>
            <span className="mono">{time.time(entry.timestamp)}</span>
          </span>
          <span className="history-summary">{time.text(entry.summary)}</span>
          <span className="history-flags">
            <span className={`flag ${entry.delivery}`}>
              {entry.delivery === "silenced" && <Icon name="bellOff" size={14} />}
              {DELIVERY_LABEL[entry.delivery]}
            </span>
            {entry.autoFocused && (
              <span className="flag focus">
                <Icon name="focus" size={14} />
                {entry.override ? "Auto Focus override" : "Auto Focus"}
              </span>
            )}
            <span className={`flag sev-${entry.severity}`}>{SEVERITY_LABEL[entry.severity]}</span>
          </span>
        </span>
        <Icon name="chevronDown" size={14} className="history-chevron" />
      </button>
      {open && (
        <div className="history-detail" id={id}>
          <dl>
            <div>
              <dt>Type</dt>
              <dd>{entry.category.charAt(0).toUpperCase() + entry.category.slice(1)}</dd>
            </div>
            {entry.location && (
              <div>
                <dt>Location</dt>
                <dd>{entry.location}</dd>
              </div>
            )}
            {entry.details.map((d) => (
              <div key={d.label}>
                <dt>{d.label}</dt>
                <dd className={d.time !== undefined ? "mono" : undefined}>{d.time !== undefined ? time.time(d.time) : d.value}</dd>
              </div>
            ))}
          </dl>
          {entry.technical.length > 0 && (
            <>
              <button type="button" className="text-toggle" aria-expanded={technical} onClick={() => setTechnical((v) => !v)}>
                Technical details
                <Icon name="chevronDown" size={14} />
              </button>
              {technical && (
                <dl className="mono technical">
                  {entry.technical.map((t) => (
                    <div key={t.label}>
                      <dt>{t.label}</dt>
                      <dd>{t.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryView({ history, filter, onFilter }: { history: HistoryFeed; filter: HistoryFilter; onFilter: (f: HistoryFilter) => void }) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  useEffect(() => setLimit(HISTORY_PAGE), [filter]);
  const list = useMemo(() => filterHistory(history.entries, filter), [history.revision, history.entries, filter]);
  return (
    <>
      <div className="view-filters">
        <div className="chips" role="radiogroup" aria-label="Filter notifications">
          {HISTORY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id}
              aria-label={`${f.label}, ${f.count(history.counts)}`}
              className="chip-filter"
              onClick={() => onFilter(f.id)}
            >
              {f.label}
              <span className="mono">{formatCompact(f.count(history.counts))}</span>
            </button>
          ))}
        </div>
      </div>
      {!list.length && (
        <Empty icon="bell">{filter === "all" ? "No notifications yet for this run." : `No ${HISTORY_FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} notifications.`}</Empty>
      )}
      {list.slice(0, limit).map((entry) => (
        <HistoryRow key={entry.key} entry={entry} />
      ))}
      {list.length > limit && (
        <button type="button" className="stream-more" onClick={() => setLimit((l) => l + HISTORY_PAGE)}>
          Show earlier ({(list.length - limit).toLocaleString()})
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

function useViewState() {
  const [queue, setQueue] = useState<QueueState>({ view: "future", category: "all" });
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  return { queue, setQueue, historyFilter, setHistoryFilter };
}

function DetailView({ view, props, state }: { view: PanelView; props: Props; state: ReturnType<typeof useViewState> }) {
  switch (view) {
    case "overview":
      return <Overview snapshot={props.snapshot} topology={props.topology} congestion={props.congestion} />;
    case "stack":
      return <StackView status={props.status} snapshot={props.snapshot} topology={props.topology} asb={props.asb} virtualTime={props.virtualTime} />;
    case "events":
      return <NewsView news={props.news} />;
    case "incidents":
      return <IncidentsView news={props.news} topology={props.topology} />;
    case "queue":
      return <QueueView runId={props.runId} filter={state.queue} onFilter={state.setQueue} />;
    case "notifications":
      return <HistoryView history={props.history} filter={state.historyFilter} onFilter={state.setHistoryFilter} />;
  }
}

/** Tabs with a highlight that slides to the measured position of the selected tab. */
function Tabs({ tab, onTab, counts, idPrefix }: { tab: TelemetryTab; onTab: (t: TelemetryTab) => void; counts: Record<TelemetryTab, number>; idPrefix: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = row.current?.querySelector<HTMLElement>(`[aria-selected="true"]`);
      if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !row.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [tab, counts.events > 0, counts.queue > 0, counts.incidents > 0, counts.notifications > 0]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -2;
    if (next === -2) return;
    e.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length];
    onTab(t.id);
    row.current?.querySelector<HTMLElement>(`#${idPrefix}-${t.id}`)?.focus();
  };
  return (
    <div ref={row} data-tutorial="events" className="tab-row" role="tablist" aria-label="Telemetry detail" onKeyDown={onKey}>
      {pill && <span className="tab-pill" aria-hidden="true" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} />}
      {TABS.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-${t.id}`}
          role="tab"
          data-tutorial={`telemetry-${t.id}`}
          type="button"
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          aria-label={t.id === "notifications" && counts[t.id] ? `${t.label}, ${counts[t.id]} silenced` : undefined}
          onClick={() => onTab(t.id)}
        >
          {t.label}
          {counts[t.id] > 0 &&
            (t.id === "notifications" ? (
              <span className="count muted">
                <Icon name="bellOff" size={14} />
                {counts[t.id] > 99 ? "99+" : counts[t.id]}
              </span>
            ) : (
              <span className="count">{counts[t.id] > 99 ? "99+" : counts[t.id]}</span>
            ))}
        </button>
      ))}
    </div>
  );
}

function TelemetryDeckImpl(props: Props) {
  const { snapshot, topology, runtime, compact, history } = props;
  const [chosenTab, setTab] = useState<TelemetryTab>(() => {
    try {
      const saved = localStorage.getItem("dstns.telemetry-tab.v1") as TelemetryTab | null;
      return saved && TABS.some((t) => t.id === saved) ? saved : "stack";
    } catch {
      return "stack";
    }
  });
  const tourTab = TABS.find(t => props.tutorialTarget === `telemetry-${t.id}`)?.id;
  const tab = tourTab ?? chosenTab;
  const chooseTab = (t: TelemetryTab) => {
    setTab(t);
    try {
      localStorage.setItem("dstns.telemetry-tab.v1", t);
    } catch {
      /* A remembered tab is a convenience only. */
    }
  };
  const [panel, setPanel] = useState<PanelView | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const strip = useRef<HTMLElement>(null);
  const deck = useRef<HTMLElement>(null);
  const views = useViewState();
  const idPrefix = useId().replace(/:/g, "");

  const figures = useMemo(() => networkFigures(snapshot, topology), [snapshot, topology]);
  const weather = useMemo(() => weatherSummary(snapshot?.active_weather), [snapshot]);
  const counts: Record<TelemetryTab, number> = {
    stack: 0,
    events: props.news.length,
    queue: 0,
    incidents: figures.incidents,
    notifications: history.counts.silenced,
  };

  // The side panel belongs to the collapsed strip.
  useEffect(() => {
    if (!compact) setPanel(null);
  }, [compact]);

  const openPanel = (view: PanelView, from: HTMLButtonElement) => {
    opener.current = from;
    setPanel((current) => (current === view ? null : view));
  };
  const closePanel = useCallback(() => {
    setPanel(null);
    opener.current?.focus();
  }, []);
  useEffect(() => {
    if (!panel) return;
    panelHeading.current?.focus({ preventScroll: true });
  }, [panel]);
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closePanel();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || strip.current?.contains(t)) return;
      if (t instanceof Element && t.closest(".floating")) return;
      setPanel(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [panel, closePanel]);

  // The glass surface morphs between the panel and the strip; it needs the
  // strip's height to know where to stop.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const apply = () => deck.current?.style.setProperty("--strip-h", `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);


  return (
    <aside ref={deck} className={`telemetry-deck${compact ? " compact" : ""}`} aria-label="Live telemetry">
      <div className="deck-surface" aria-hidden="true" />

      <div className="deck-full" data-tutorial={compact ? undefined : "telemetry"} inert={compact || undefined} aria-hidden={compact || undefined}>
        <div className="deck-header">
          <h2>Live Telemetry</h2>
          <span className={`runtime runtime-${runtime} small`}>
            <i aria-hidden="true" />
            {STATUS_TEXT[runtime]}
          </span>
          <Tooltip label="Collapse telemetry" detail="Keeps the key figures in a narrow strip." side={["bottom", "left"]}>
            <button type="button" className="icon-btn" aria-label="Collapse live telemetry" onClick={props.onCollapse}>
              <Icon name="panelCollapse" size={16} />
            </button>
          </Tooltip>
        </div>
        <Overview snapshot={snapshot} topology={topology} congestion={props.congestion} />
        <Tabs tab={tab} onTab={chooseTab} counts={counts} idPrefix={idPrefix} />
        <FadeScroll resetKey={tab} labelledBy={`${idPrefix}-${tab}`}>
          <DetailView view={tab} props={props} state={views} />
        </FadeScroll>
      </div>

      <nav ref={strip} className="deck-strip" aria-label="Telemetry summary" data-tutorial={compact ? "telemetry" : undefined} inert={!compact || undefined} aria-hidden={!compact || undefined}>
        <Tooltip label="Expand telemetry" side={["left", "bottom"]}>
          <button type="button" className="strip-expand" aria-label="Expand live telemetry" onClick={props.onExpand}>
            <Icon name="panelExpand" size={16} />
          </button>
        </Tooltip>
        <span className={`strip-status runtime-${runtime}`} role="status" aria-label={`Runtime ${STATUS_TEXT[runtime]}`}>
          <i aria-hidden="true" />
        </span>
        <span className="strip-rule" aria-hidden="true" />
        <Tooltip label="Network overview" detail="Roads, vehicles, congestion and weather." side={["left", "bottom"]}>
          <button type="button" className={`strip-overview${panel === "overview" ? " active" : ""}`}
            aria-label="Network overview" aria-expanded={panel === "overview"} onClick={(e) => openPanel("overview", e.currentTarget)}>
            <span className="strip-metric" aria-label={`Road edges: ${figures.edges.toLocaleString()}, ${figures.flowingEdges.toLocaleString()} carrying flow`}><Icon name="road" size={16}/><span className="mono">{formatCompact(figures.edges)}</span></span>
            <span className="strip-metric" aria-label={`Vehicles: ${figures.vehicles.toLocaleString()}, ${figures.halting.toLocaleString()} halting`}><Icon name="vehicle" size={16}/><span className="mono">{formatCompact(figures.vehicles)}</span></span>
            <span className="strip-metric" aria-label={`Congestion index: ${figures.congestion.toFixed(0)} percent`}><Icon name="gauge" size={16}/><span className="mono">{figures.congestion.toFixed(0)}%</span></span>
            <span className={`strip-metric wx-metric wx-${weather.level}`} aria-label={`Weather: ${weather.label}${weather.cells ? `, ${weather.cells} active cell${weather.cells === 1 ? "" : "s"}, ${weather.rate}` : ""}`}><WeatherGlyph weather={weather}/><span className="mono">{weather.cells || 0}</span></span>
          </button>
        </Tooltip>
        <span className="strip-rule" aria-hidden="true" />
        {TABS.map((t) => (
          <Tooltip key={t.id} label={t.label} side={["left", "bottom", "top"]}>
            <button
              type="button"
              className={`strip-view${panel === t.id ? " active" : ""}`}
              aria-label={`${t.label}${counts[t.id] ? `, ${counts[t.id]}${t.id === "notifications" ? " silenced" : ""}` : ""}`}
              aria-expanded={panel === t.id}
              onClick={(e) => openPanel(t.id, e.currentTarget)}
            >
              <Icon name={t.icon} size={16} />
              {counts[t.id] > 0 && <span className={`strip-badge${t.id === "notifications" ? " muted" : ""}`}>{counts[t.id] > 99 ? "99+" : counts[t.id]}</span>}
            </button>
          </Tooltip>
        ))}
      </nav>

      {compact && panel && (
        <section ref={panelRef} className="deck-panel" role="dialog" aria-labelledby={`${idPrefix}-panel-title`} data-tip-avoid>
          <header>
            <Icon name={panel === "overview" ? "network" : TABS.find((t) => t.id === panel)!.icon} size={16} />
            <h3 id={`${idPrefix}-panel-title`} ref={panelHeading} tabIndex={-1}>
              {VIEW_TITLE[panel]}
            </h3>
            <button type="button" className="icon-btn" aria-label={`Close ${VIEW_TITLE[panel]}`} onClick={closePanel}>
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="deck-panel-body" key={panel}>
            {panel === "overview" ? (
              <Overview snapshot={snapshot} topology={topology} congestion={props.congestion} />
            ) : (
              <FadeScroll resetKey={panel} labelledBy={`${idPrefix}-panel-title`}>
                <DetailView view={panel} props={props} state={views} />
              </FadeScroll>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

export const TelemetryDeck = memo(TelemetryDeckImpl);
