// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { Component, memo, useCallback, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Figure } from "../CoreMotion/Figure";
import { Icon } from "../components/Icons";
import { BrandLogo } from "../components/BrandLogo";
import { Tooltip } from "../components/Tooltip";
import { Scrim } from "../panels/Dialogs";
import { Switch } from "../components/settingsControls";
import { Select } from "../components/Popover";
import { settleTime, Spring, springEasing, SPRINGS } from "../CoreMotion/motion";
import { AppFrame } from "./AppFrame";
import { fabric, useFabricApps, useLaunchPlan, useOpenPanel, usePicking, useSlot, webOf } from "./store";
import type { FabricApp, FabricElement, FabricRow, FabricWidget, SlotItem, Tone } from "./store";

/**
 * Where applications' declared UI appears. Each slot belongs to the observer: it
 * decides placement, limits and appearance, and renders only the fields it knows,
 * as text. An application can say what to show, never how to draw it.
 */

/** An element's chosen motion, as attributes for webfabric.css. A custom spring becomes an easing. */
export function motionProps(element: FabricElement): { "data-motion"?: string; style?: Record<string, string> } {
  const motion = element.motion;
  if (!motion) return {};
  if (typeof motion === "string") return { "data-motion": motion };
  if (typeof motion.stiffness !== "number" || typeof motion.damping !== "number") return {};
  const preset = { k: motion.stiffness, c: motion.damping };
  return { "data-motion": "custom", style: { "--fabric-ease": springEasing(preset), "--fabric-ms": `${Math.round(settleTime(preset) * 1000)}ms` } };
}

const toneClass = (tone?: Tone) => (tone && ["accent", "ok", "warn", "danger"].includes(tone) ? ` tone-${tone}` : "");

/** One application's fault stops at that application: it is hidden and reported. */
export class AppBoundary extends Component<{ app: FabricApp; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    void fabric.failure(this.props.app.id, `Its interface could not be drawn: ${error.message}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function activate(app: FabricApp, element: FabricElement) {
  if (element.opens) fabric.setOpenPanel(`${app.id}/${element.opens}`);
  else void fabric.action(app.id, element.id).catch(() => undefined);
}

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

const HeaderItem = memo(function HeaderItem({ app, element }: { app: FabricApp; element: FabricElement }) {
  return (
    <Tooltip label={app.name} side={["bottom"]}>
      <button type="button" className={`btn fabric-action${toneClass(element.tone)}`} onClick={() => activate(app, element)}>
        {element.icon && <Icon name={element.icon} size={16} />}
        <span>{text(element.label) || element.id}</span>
      </button>
    </Tooltip>
  );
});

export function FabricHeader() {
  const items = useLeavingList(useSlot("header").items);
  return (
    <>
      {items.map(({ app, element, leaving }) => (
        <AppBoundary key={`${app.id}/${element.id}`} app={app}>
          <span className={leaving ? "fabric-leaving" : "fabric-lives"}><HeaderItem app={app} element={element} /></span>
        </AppBoundary>
      ))}
    </>
  );
}

const DockItem = memo(function DockItem({ app, element }: { app: FabricApp; element: FabricElement }) {
  const label = text(element.label) || element.id;
  return (
    <Tooltip label={label} detail={app.name} side={["right"]}>
      <button type="button" aria-label={`${label}, ${app.name}`} aria-pressed={element.active === true} className={`fabric-action${element.active ? " active" : ""}`} onClick={() => activate(app, element)}>
        <Icon name={element.icon ?? "info"} size={18} />
      </button>
    </Tooltip>
  );
});

export function FabricDockItems() {
  const items = useLeavingList(useSlot("map_control").items);
  if (!items.length) return null;
  return (
    <>
      <div className="divider" aria-hidden="true" />
      {items.map(({ app, element, leaving }) => (
        <AppBoundary key={`${app.id}/${element.id}`} app={app}>
          <span className={leaving ? "fabric-leaving" : "fabric-lives"}><DockItem app={app} element={element} /></span>
        </AppBoundary>
      ))}
    </>
  );
}

const StatusItem = memo(function StatusItem({ app, element }: { app: FabricApp; element: FabricElement }) {
  return (
    <div className={`fabric-status-item${toneClass(element.tone)}`} title={app.name} {...motionProps(element)}>
      <i aria-hidden="true" />
      <span>{text(element.label) || element.id}</span>
      {text(element.value) && <strong className="mono">{text(element.value)}</strong>}
    </div>
  );
});

export function FabricStatus() {
  const slot = useSlot("status");
  const { overflow } = slot;
  const items = useLeavingList(slot.items);
  if (!items.length) return null;
  return (
    <div className="fabric-status" role="status" aria-label="Application status">
      {items.map(({ app, element, leaving }) => (
        <AppBoundary key={`${app.id}/${element.id}`} app={app}>
          <div className={leaving ? "fabric-leaving" : "fabric-lives"}><StatusItem app={app} element={element} /></div>
        </AppBoundary>
      ))}
      {overflow.length > 0 && <div className="fabric-status-item more">+{overflow.length} more</div>}
    </div>
  );
}

export function FabricIndicators() {
  const { items } = useSlot("indicator");
  return (
    <>
      {items.map(({ app, element }) => {
        const edge = ["top", "right", "bottom", "left"].includes(element.edge ?? "") ? element.edge! : "right";
        const place = typeof element.position === "number" ? Math.min(1, Math.max(0, element.position)) : 0.5;
        return (
          <div
            key={`${app.id}/${element.id}`}
            className={`fabric-indicator edge-${edge}${toneClass(element.tone)}`}
            style={{ ["--place" as string]: `${place * 100}%` }}
            role="img"
            aria-label={`${app.name}: ${text(element.label) || element.id}`}
            title={`${app.name}: ${text(element.label) || element.id}`}
          />
        );
      })}
    </>
  );
}

const seriesStyle = (series?: number) => (typeof series === "number" ? { ["--tone" as string]: `var(--series-${Math.abs(Math.trunc(series)) % 8})` } : undefined);

const FabricRowItem = memo(function FabricRowItem({ row, onSelect }: { row: FabricRow; onSelect?: () => void }) {
  const share = typeof row.share === "number" ? Math.min(1, Math.max(0, row.share)) : null;
  const inner = (
    <>
      {row.badge && <span className="fabric-row-badge mono">{text(row.badge).slice(0, 6)}</span>}
      <span className="fabric-row-text">
        <span>{text(row.subtitle) || text(row.title)}</span>
        {share !== null && <span className="fabric-row-bar"><i style={{ transform: `translateX(${share * 100 - 100}%)` }} /></span>}
      </span>
      {row.value !== undefined && <span className="fabric-row-value mono">{text(row.value)}</span>}
    </>
  );
  return (
    <li style={seriesStyle(row.series)} className={row.selected ? "selected" : undefined}>
      {onSelect ? <button type="button" aria-pressed={row.selected === true} onClick={onSelect}>{inner}</button> : <div>{inner}</div>}
    </li>
  );
});

function FabricTabs({ app, element, widget }: { app: FabricApp; element: FabricElement; widget: FabricWidget }) {
  const tabs = Array.isArray(widget.tabs) ? widget.tabs.slice(0, 6) : [];
  const [active, setActive] = useState(tabs[0]?.id);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!current) return null;
  const index = tabs.indexOf(current);
  return (
    <>
      <div className="fabric-tabs" role="tablist" style={{ ["--count" as string]: tabs.length, ["--pos" as string]: index }}>
        <span className="fabric-tabs-pill" aria-hidden="true" />
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab === current}
            onClick={() => {
              setActive(tab.id);
              void fabric.action(app.id, widget.id ?? element.id, "tab", tab.id).catch(() => undefined);
            }}
          >
            {tab.caption && <small className="mono">{text(tab.caption)}</small>}
            <strong>{text(tab.label)}</strong>
          </button>
        ))}
      </div>
      <div className="fabric-tab-body" key={current.id} role="tabpanel">
        {(Array.isArray(current.widgets) ? current.widgets : []).map((child, i) => (
          <Widget key={child.id ?? i} app={app} element={element} widget={child} />
        ))}
      </div>
    </>
  );
}

function FabricInput({ widget, onSubmit }: { widget: FabricWidget; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState(text(widget.value));
  const kind = widget.input_type === "time" || widget.input_type === "number" ? widget.input_type : "text";
  return (
    <form className="fabric-input-row" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
      {widget.label && <label>{text(widget.label)}</label>}
      <input className="fabric-input mono" type={kind} step={kind === "time" ? 1 : undefined} value={value} aria-label={text(widget.label) || "Value"} placeholder={widget.placeholder} onChange={(e) => setValue(e.target.value)} />
      {widget.submit && <button type="submit" className="btn fabric-action">{text(widget.submit)}</button>}
    </form>
  );
}

/** A figure with its recent history. Drawn to the panel's width, in the application's series or tone. */
function FabricSparkline({ widget }: { widget: FabricWidget }) {
  const values = (Array.isArray(widget.values) ? widget.values : []).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(-120);
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const line = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100} ${28 - ((v - low) / span) * 26}`).join(" L");
  return (
    <div className={`fabric-spark${toneClass(widget.tone)}`} style={seriesStyle(widget.series)}>
      <span>{text(widget.label)}</span>
      <strong className="mono">{text(widget.value)}</strong>
      {values.length > 1 && (
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`${text(widget.label) || "Figure"}: recent history`}>
          <path className="area" d={`M0 30 L${line} L100 30 Z`} />
          <path className="line" d={`M${line}`} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------------------------------------------
// Coming and going. Whatever an application puts on screen arrives with its motion, and leaves the same way:
// suspended, turned off or gone, it fades and settles out over LEAVE_MS rather than vanishing, and what replaces
// it comes in after.
// ---------------------------------------------------------------------------------------------------------------
export const LEAVE_MS = 320;
const keyOf = ({ app, element }: SlotItem) => `${app.id}/${element.id}`;

/** One of several, chosen by a person, which leaves gracefully when it goes and hands over to the next. */
function useChoice(items: SlotItem[]) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<SlotItem | null>(null);
  const last = useRef<SlotItem | null>(null);
  const current = items.find((item) => keyOf(item) === chosen) ?? (chosen === null ? items[0] : undefined);
  const currentKey = current ? keyOf(current) : null;
  useEffect(() => {
    if (current) {
      last.current = current;
      // Pinned, so that its going can be noticed, rather than the next one quietly taking its place.
      if (chosen === null) setChosen(keyOf(current));
      return;
    }
    const gone = last.current;
    if (!gone) {
      if (chosen !== null) setChosen(null);
      return;
    }
    setLeaving(gone);
    const timer = setTimeout(() => {
      last.current = null;
      setLeaving(null);
      setChosen(null);
    }, LEAVE_MS);
    return () => clearTimeout(timer);
    // On what is chosen, not on every update of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, chosen]);
  return { current: current ?? leaving ?? undefined, leaving: !current && !!leaving, choose: setChosen };
}

/** A list in which what goes, goes gracefully. */
function useLeavingList(items: SlotItem[]): (SlotItem & { leaving?: boolean })[] {
  const [gone, setGone] = useState<SlotItem[]>([]);
  const previous = useRef<SlotItem[]>(items);
  const now = items.map(keyOf).join(",");
  useEffect(() => {
    const present = new Set(items.map(keyOf));
    const left = previous.current.filter((item) => !present.has(keyOf(item)));
    previous.current = items;
    if (!left.length) return;
    setGone((old) => [...old.filter((item) => !present.has(keyOf(item))), ...left]);
    const timer = setTimeout(() => setGone((old) => old.filter((item) => !left.includes(item))), LEAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  return [...items, ...gone.map((item) => ({ ...item, leaving: true }))];
}

/** Which application, when there is more than one, and what can be done with it. */
function AppBar({ items, current, onChoose }: { items: SlotItem[]; current: SlotItem; onChoose: (key: string) => void }) {
  const { app } = current;
  const perApp = new Map<string, number>();
  for (const item of items) perApp.set(item.app.id, (perApp.get(item.app.id) ?? 0) + 1);
  const options = items.map((item) => ({
    value: keyOf(item),
    label: (perApp.get(item.app.id) ?? 0) > 1 ? `${item.app.name} · ${text(item.element.title) || item.element.id}` : item.app.name,
  }));
  return (
    <div className="fabric-appbar">
      {items.length > 1 ? (
        <Select label="Application" className="fabric-app-select" value={keyOf(current)} options={options} onChange={onChoose} />
      ) : (
        <strong className="fabric-app-name">{app.name}</strong>
      )}
      <AppActions app={app} />
    </div>
  );
}

/** Open its own web interface, start it again, or turn it off. */
export function AppActions({ app, labelled = false }: { app: FabricApp; labelled?: boolean }) {
  const plan = useLaunchPlan();
  const web = webOf(app, plan);
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch {
      /* The state poll shows what happened. */
    } finally {
      setBusy(false);
    }
  }, []);
  const button = (icon: string, label: string, detail: string, onClick: () => void) => (
    <Tooltip label={label} detail={detail} side={["bottom"]}>
      <button type="button" className={labelled ? "btn" : "icon-btn"} aria-label={`${label}, ${app.name}`} disabled={busy} onClick={onClick}>
        <Icon name={icon} size={labelled ? 14 : 15} />
        {labelled && <span>{label}</span>}
      </button>
    </Tooltip>
  );
  return (
    <div className="fabric-app-actions">
      {web && button("external", web.label, "In a new tab", () => void window.open(web.url, "_blank", "noopener,noreferrer"))}
      {button("reset", "Reload", "Its connection ends, and it connects again anew", () => void act(() => fabric.reload(app.id)))}
      {button("power", "Turn off", "It leaves the interface until you turn it on in Settings", () => void act(() => fabric.suspend(app.id, true)))}
    </div>
  );
}

/** Widgets as a canvas: a grid a panel chooses the width of, on which each widget can take its own place. */
function WidgetGrid({ app, element, widgets }: { app: FabricApp; element: FabricElement; widgets: readonly FabricWidget[] }) {
  const placed = widgets.some((widget) => widget.area);
  const columns = Math.max(1, Math.min(12, Math.trunc(element.layout?.columns ?? (placed ? 6 : 1))));
  return (
    <div className="fabric-grid" style={{ ["--columns" as string]: String(columns) }}>
      {widgets.map((widget, index) => (
        <div key={widget.id ?? index} className="fabric-cell" style={cellStyle(widget.area, columns)}>
          <Widget app={app} element={element} widget={widget} />
        </div>
      ))}
    </div>
  );
}

function cellStyle(area: FabricWidget["area"], columns: number): Record<string, string> {
  const span = (value: number | undefined, fallback: number) => Math.max(1, Math.min(columns, Math.trunc(value ?? fallback)));
  const style: Record<string, string> = {};
  const width = span(area?.width, columns);
  style.gridColumn = area?.column ? `${Math.min(columns, Math.max(1, Math.trunc(area.column)))} / span ${width}` : `span ${width}`;
  const height = Math.max(1, Math.min(12, Math.trunc(area?.height ?? 1)));
  if (area?.row) style.gridRow = `${Math.max(1, Math.trunc(area.row))} / span ${height}`;
  else if (height > 1) style.gridRow = `span ${height}`;
  return style;
}

/** Only http and https, and only ever in a tab of its own: an application's link never navigates the observer. */
const safeUrl = (url: unknown) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : null);

function FabricChart({ widget }: { widget: FabricWidget }) {
  const lines = (Array.isArray(widget.lines) ? widget.lines : []).slice(0, 6).map((line) => ({
    ...line,
    points: (Array.isArray(line.points) ? line.points : []).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(-240),
  }));
  const all = lines.flatMap((line) => line.points);
  if (!all.length) return null;
  const low = Math.min(0, ...all);
  const span = Math.max(...all) - low || 1;
  const y = (v: number) => 38 - ((v - low) / span) * 36;
  return (
    <figure className="fabric-chart">
      {text(widget.label) && <figcaption>{text(widget.label)}</figcaption>}
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={text(widget.label) || "Chart"}>
        {lines.map((line, index) => {
          const style = seriesStyle(line.series ?? index);
          if (widget.kind === "bars") {
            const width = 100 / Math.max(1, line.points.length) / Math.max(1, lines.length);
            return (
              <g key={index} style={style}>
                {line.points.map((v, i) => <rect key={i} className="bar" x={i * width * lines.length + index * width} y={y(v)} width={width * 0.8} height={38 - y(v)} />)}
              </g>
            );
          }
          const path = line.points.map((v, i) => `${(i / Math.max(1, line.points.length - 1)) * 100} ${y(v)}`).join(" L");
          return (
            <g key={index} style={style}>
              {widget.kind === "area" && <path className="area" d={`M0 38 L${path} L100 38 Z`} />}
              <path className="line" d={`M${path}`} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {lines.some((line) => line.label) && (
        <ul className="fabric-chart-key">
          {lines.map((line, index) => line.label && <li key={index} style={seriesStyle(line.series ?? index)}>{text(line.label)}</li>)}
        </ul>
      )}
    </figure>
  );
}

function Widget({ app, element, widget }: { app: FabricApp; element: FabricElement; widget: FabricWidget }) {
  const name = widget.id ?? element.id;
  const send = (action: string, value?: unknown) => void fabric.action(app.id, name, action, value).catch(() => undefined);
  const label = text(widget.label);
  switch (widget.type) {
    case "metric": {
      const delta = text(widget.delta);
      const falling = delta.startsWith("-") || delta.startsWith("−");
      return (
        <div className={`fabric-metric${toneClass(widget.tone)}`}>
          <span>{label}</span>
          <strong className="mono">{text(widget.value)}{widget.unit && <small>{text(widget.unit)}</small>}</strong>
          {delta && <em className={falling ? "down" : "up"}>{delta}</em>}
          {widget.caption && <small>{text(widget.caption)}</small>}
        </div>
      );
    }
    case "card":
      return (
        <section className={`fabric-card${toneClass(widget.tone)}`}>
          {label && <h4>{label}</h4>}
          {widget.text && <p>{text(widget.text)}</p>}
          {Array.isArray(widget.widgets) && widget.widgets.length > 0 && <WidgetGrid app={app} element={{ ...element, layout: { columns: 1 } }} widgets={widget.widgets} />}
        </section>
      );
    case "chart":
      return <FabricChart widget={widget} />;
    case "link": {
      const url = safeUrl(widget.url);
      return url ? (
        <a className={`btn fabric-link${toneClass(widget.tone)}`} href={url} target="_blank" rel="noopener noreferrer">
          <span>{label || url}</span>
          <Icon name="external" size={14} />
        </a>
      ) : null;
    }
    case "divider":
      return <hr className="fabric-divider" />;
    case "status":
      return (
        <div className={`fabric-status-line state-${["ok", "warn", "danger", "busy"].includes(String(widget.state)) ? widget.state : "neutral"}`}>
          <i aria-hidden="true" />
          <span>{label}</span>
          {widget.caption && <small>{text(widget.caption)}</small>}
        </div>
      );
    case "timeline":
      return (
        <ol className="fabric-timeline" aria-label={label || undefined}>
          {(Array.isArray(widget.events) ? widget.events : []).slice(0, 50).map((event, index) => (
            <li key={index} className={toneClass(event.tone).trim()}>
              {event.time && <time className="mono">{text(event.time)}</time>}
              <span>{text(event.label)}</span>
              {event.caption && <small>{text(event.caption)}</small>}
            </li>
          ))}
        </ol>
      );
    case "text":
      return <p className="fabric-text">{text(widget.text) || text(widget.value)}</p>;
    case "heading":
      return <h3 className="fabric-heading">{text(widget.text) || label}</h3>;
    case "note":
      return <p className="fabric-note">{text(widget.text) || label}</p>;
    case "stats":
      return (
        <dl className="fabric-stats">
          {(Array.isArray(widget.items) ? widget.items : []).slice(0, 4).map((item, index) => (
            <div key={index} className={toneClass(item.tone).trim()}>
              <dt>{text(item.label)}</dt>
              <dd className="mono">{text(item.value)}{item.caption && <small>{text(item.caption)}</small>}</dd>
            </div>
          ))}
        </dl>
      );
    case "chips":
      return (
        <dl className="fabric-chips">
          {(Array.isArray(widget.items) ? widget.items : []).slice(0, 8).map((item, index) => (
            <div key={index}><dt>{text(item.label)}</dt><dd className="mono">{text(item.value)}</dd></div>
          ))}
        </dl>
      );
    case "list":
      return (
        <ul className="fabric-rows" aria-label={label || undefined}>
          {(Array.isArray(widget.rows) ? widget.rows : []).slice(0, 200).map((row, index) => (
            <FabricRowItem key={row.id ?? index} row={row} onSelect={row.id ? () => send("select", row.id) : undefined} />
          ))}
        </ul>
      );
    case "legend":
      return (
        <ul className="fabric-legend">
          {(Array.isArray(widget.legend) ? widget.legend : []).slice(0, 24).map((item, index) => (
            <li key={item.id ?? index} style={seriesStyle(item.series)} className={toneClass(item.tone).trim()}>
              {typeof item.value === "boolean" ? (
                <label>
                  <input type="checkbox" checked={item.value} onChange={(e) => void fabric.action(app.id, item.id ?? name, "change", e.target.checked).catch(() => undefined)} />
                  <span>{text(item.label)}</span>
                </label>
              ) : (
                <>
                  <i className={`mark-${item.mark ?? "line"}`} aria-hidden="true" />
                  <span>{text(item.label)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      );
    case "route":
      return (
        <ol className="fabric-route" aria-label={label || undefined} style={seriesStyle(widget.series)}>
          {(Array.isArray(widget.stops) ? widget.stops : []).slice(0, 64).map((stop, index) => (
            <li key={stop.id ?? index} className={stop.state ? `is-${stop.state}` : undefined} aria-current={stop.state === "current" ? "step" : undefined}>
              <i aria-hidden="true" />
              <span>{text(stop.label)}</span>
              {stop.caption && <small className="mono">{text(stop.caption)}</small>}
            </li>
          ))}
        </ol>
      );
    case "sparkline":
      return <FabricSparkline widget={widget} />;
    case "keyvalues":
      return (
        <dl className="fabric-keyvalues">
          {(Array.isArray(widget.items) ? widget.items : []).slice(0, 40).map((item, index) => (
            <div key={index} className={toneClass(item.tone).trim()}>
              <dt>{text(item.label)}</dt>
              <dd className="mono">{text(item.value)}</dd>
            </div>
          ))}
        </dl>
      );
    case "table":
      return (
        <div className="fabric-table-frame">
          <table className="fabric-table">
            <thead>
              <tr>{(widget.columns ?? []).slice(0, 8).map((column, index) => <th key={index} className={column.align === "right" ? "right" : undefined}>{text(column.label)}</th>)}</tr>
            </thead>
            <tbody>
              {(widget.cells ?? []).slice(0, 200).map((row, r) => (
                <tr key={r}>{row.slice(0, 8).map((cell, c) => <td key={c} className={widget.columns?.[c]?.align === "right" ? "right mono" : undefined}>{text(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "gauge": {
      // A half circle, drawn by how much of its length shows, so that a new value travels there.
      const share = Math.min(1, Math.max(0, (Number(widget.value) - (widget.min ?? 0)) / ((widget.max ?? 1) - (widget.min ?? 0)) || 0));
      return (
        <div className={`fabric-gauge${toneClass(widget.tone)}`} role="meter" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label || name}>
          <svg viewBox="0 0 100 56" aria-hidden="true">
            <path className="track" d="M8 50a42 42 0 0 1 84 0" pathLength={100} />
            <path className="fill" d="M8 50a42 42 0 0 1 84 0" pathLength={100} style={{ strokeDasharray: `${share * 100} 100` }} />
          </svg>
          <strong className="mono">{text(widget.caption) || `${Math.round(share * 100)}%`}</strong>
          <span>{label}</span>
        </div>
      );
    }
    case "bars": {
      const items = (Array.isArray(widget.items) ? widget.items : []).slice(0, 24);
      const most = Math.max(1e-9, ...items.map((item) => Number(item.value) || 0));
      return (
        <ul className="fabric-bars">
          {items.map((item, index) => (
            <li key={index} className={toneClass(item.tone).trim()}>
              <span>{text(item.label)}</span>
              <i aria-hidden="true"><b style={{ transform: `translateX(${((Number(item.value) || 0) / most) * 100 - 100}%)` }} /></i>
              <strong className="mono">{text(item.caption) || text(item.value)}</strong>
            </li>
          ))}
        </ul>
      );
    }
    case "tabs":
      return <FabricTabs app={app} element={element} widget={widget} />;
    case "input":
      return <FabricInput widget={widget} onSubmit={(value) => send("submit", value)} />;
    case "stat":
      return (
        <div className={`fabric-stat${toneClass(widget.tone)}`}>
          <span>{label}</span>
          <strong className="mono">{text(widget.value)}</strong>
        </div>
      );
    case "progress": {
      const share = Math.min(1, Math.max(0, Number(widget.value) || 0));
      return (
        <div className={`fabric-progress${toneClass(widget.tone)}`}>
          <span>{label}</span>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={label || "Progress"}>
            <i style={{ transform: `translateX(${share * 100 - 100}%)` }} />
          </div>
        </div>
      );
    }
    case "button":
      return (
        <button type="button" className={`btn fabric-action${toneClass(widget.tone)}`} onClick={() => (widget.pick ? fabric.armPick(app.id, name) : send("activate"))}>
          {label || name}
        </button>
      );
    case "toggle":
      return (
        <div className="settings-row">
          <span className="settings-row-text"><strong>{label}</strong></span>
          <Switch label={label || name} checked={widget.value === true} onChange={(value) => send("change", value)} />
        </div>
      );
    case "select":
      return (
        <label className="fabric-field">
          <span>{label}</span>
          <Select label={label || name} value={text(widget.value)} onChange={(value) => send("change", value)} options={(Array.isArray(widget.options) ? widget.options : []).map((option) => ({ value: String(option.value), label: text(option.label) }))} />
        </label>
      );
    case "slider":
      return (
        <label className="fabric-field">
          <span>{label}</span>
          <input type="range" min={widget.min ?? 0} max={widget.max ?? 100} step={widget.step ?? 1} defaultValue={Number(widget.value) || 0} onPointerUp={(e) => send("change", Number(e.currentTarget.value))} onKeyUp={(e) => send("change", Number(e.currentTarget.value))} />
        </label>
      );
    default:
      return null;
  }
}

/** The one open application panel. Opening another replaces it. */
export function FabricPanel() {
  const open = useOpenPanel();
  const apps = useFabricApps();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [appId, elementId] = open?.split("/") ?? [];
  const app = apps.find((item) => item.id === appId);
  const element = app?.ui.find((item) => item.id === elementId && item.slot === "panel");
  // What was open, kept while it leaves: an application turned off while a person is looking at it goes gracefully.
  const last = useRef<{ key: string; app: FabricApp; element: FabricElement } | null>(null);
  const [leaving, setLeaving] = useState(false);
  if (open && app && element) last.current = { key: open, app, element };
  useEffect(() => {
    // Only what was this panel, shown: a panel asked for that has not appeared yet is not leaving.
    if (!open || (app && element) || last.current?.key !== open) return;
    setLeaving(true);
    const timer = setTimeout(() => {
      setLeaving(false);
      last.current = null;
      fabric.setOpenPanel(null);
    }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [open, app, element]);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fabric.setOpenPanel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const shown = app && element ? { app, element } : open && leaving && last.current?.key === open ? last.current : null;
  if (!shown) return null;
  return (
    <AppBoundary key={open} app={shown.app}>
      <aside className={`fabric-panel${leaving ? " fabric-leaving" : ""}`} {...motionProps(shown.element)} role="dialog" aria-label={`${text(shown.element.title) || shown.element.id}, ${shown.app.name}`}>
        <header>
          <div>
            <h2>{text(shown.element.title) || shown.element.id}</h2>
            <small>{shown.app.name}</small>
          </div>
          <AppActions app={shown.app} />
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close panel" onClick={() => fabric.setOpenPanel(null)}>
            <Icon name="close" size={16} />
          </button>
        </header>
        {shown.element.frame ? (
          <AppFrame app={shown.app} element={shown.element} />
        ) : (
          <div className="fabric-panel-body scroll-region" tabIndex={0}>
            <WidgetGrid app={shown.app} element={shown.element} widgets={Array.isArray(shown.element.widgets) ? shown.element.widgets : []} />
          </div>
        )}
      </aside>
    </AppBoundary>
  );
}

/** An application's content on the right, as a tab of the telemetry deck. */
export function FabricDeck() {
  const { items } = useSlot("deck");
  const { current, leaving, choose } = useChoice(items);
  if (!current)
    return (
      <div className="fabric-empty">
        <Figure name="tiles" />
        <BrandLogo name="webfabric" height={18} />
        <strong>Nothing to show yet</strong>
        <p>Applications connected through the Fabric API show their panels, figures and controls here.</p>
      </div>
    );
  const { app, element } = current;
  return (
    <div className="fabric-deck" {...motionProps(element)}>
      <header className="fabric-deck-head">
        <BrandLogo name="webfabric" height={14} />
      </header>
      <AppBar items={items.length ? items : [current]} current={current} onChoose={choose} />
      <div key={keyOf(current)} className={leaving ? "fabric-leaving" : "fabric-arriving"}>
        <AppBoundary app={app}>
          {element.title && <h3 className="fabric-heading">{text(element.title)}</h3>}
          {element.frame ? <AppFrame app={app} element={element} /> : <WidgetGrid app={app} element={element} widgets={Array.isArray(element.widgets) ? element.widgets : []} />}
        </AppBoundary>
      </div>
    </div>
  );
}

const SIDEBAR_WIDTH = 372;

/**
 * Room on the map's left for an application to lay out its work, such as a planner
 * with its lines and journeys. The map refits beside it. Several applications share
 * it by tabs, and a person can put it away.
 */
export function FabricSidebar({ onInset, reduceMotion }: { onInset: (width: number) => void; reduceMotion: boolean }) {
  const { items } = useSlot("sidebar");
  const { current, leaving, choose } = useChoice(items);
  const [collapsed, setCollapsed] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const picking = usePicking();
  // Leaving with nothing to follow it, it slides away as when it is put away.
  const present = !!current && !(leaving && items.length === 0);
  // An attribute, because the shell's class belongs to React.
  useEffect(() => {
    const shell = document.querySelector(".app-shell");
    shell?.toggleAttribute("data-sidebar-open", present && !collapsed);
    return () => shell?.removeAttribute("data-sidebar-open");
  }, [present, collapsed]);
  const hidden = -(SIDEBAR_WIDTH + 96);
  const spring = useRef<Spring | null>(null);
  useEffect(() => {
    onInset(present && !collapsed ? 84 + SIDEBAR_WIDTH + 16 : 0);
    return () => onInset(0);
  }, [present, collapsed, onInset]);
  useEffect(() => {
    if (!panel.current) return;
    const element = panel.current;
    spring.current ??= new Spring(hidden, SPRINGS.expressiveDefault, (x) => element.style.setProperty("--sidebar-x", `${x.toFixed(2)}px`), 0.2);
    const away = collapsed || !present;
    if (reduceMotion) spring.current.jump(away ? hidden : 0);
    else spring.current.set(away ? hidden : 0);
  }, [collapsed, reduceMotion, present, hidden]);
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fabric.cancelPick();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking]);
  if (!current) {
    spring.current = null;
    return null;
  }
  const { app, element } = current;
  return (
    <>
      <aside ref={panel} className="fabric-sidebar" aria-label={`${text(element.title) || app.name}, ${app.name}`} inert={collapsed || undefined}>
        <header>
          <div>
            <h2>{text(element.title) || app.name}</h2>
            {element.label && <small>{text(element.label)}</small>}
          </div>
          <button type="button" className="icon-btn" aria-label="Put the sidebar away" onClick={() => setCollapsed(true)}>
            <Icon name="panelCollapse" size={16} className="flip" />
          </button>
        </header>
        <AppBar items={items.length ? items : [current]} current={current} onChoose={choose} />
        <div key={keyOf(current)} className={`fabric-sidebar-body ${leaving ? "fabric-leaving" : "fabric-arriving"}`}>
          <AppBoundary app={app}>
            {element.frame ? (
              <AppFrame app={app} element={element} />
            ) : (
              <div className="fabric-panel-body scroll-region" tabIndex={0}>
                <WidgetGrid app={app} element={element} widgets={Array.isArray(element.widgets) ? element.widgets : []} />
              </div>
            )}
          </AppBoundary>
        </div>
      </aside>
      {collapsed && (
        <button type="button" className="fabric-sidebar-tab" aria-label={`Open ${app.name}`} onClick={() => setCollapsed(false)}>
          <Icon name="panelExpand" size={16} className="flip" />
          <span>{app.name}</span>
        </button>
      )}
      {picking && (
        <div className="fabric-picking" role="status">
          <Icon name="pin" size={14} />
          Click a place on the map for {app.name}
          <button type="button" onClick={fabric.cancelPick}>Cancel</button>
        </div>
      )}
    </>
  );
}

/**
 * At most one application dialog, and only when the observer has nothing of its
 * own on screen. Answered once per content, so a repeated declaration does not
 * reopen what a person has already dismissed.
 */
export function FabricDialog({ blocked }: { blocked: boolean }) {
  const { items } = useSlot("dialog");
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const next = items.find(({ app, element }) => !answered.has(`${app.id}/${element.id}/${element.title}/${element.body}`));
  if (blocked || !next) return null;
  const { app, element } = next;
  const key = `${app.id}/${element.id}/${element.title}/${element.body}`;
  const answer = (action: string) => {
    setAnswered((old) => new Set(old).add(key));
    void fabric.action(app.id, element.id, action).catch(() => undefined);
  };
  return (
    <AppBoundary key={key} app={app}>
      <Scrim onClose={() => answer("dismiss")} labelledBy="fabric-dialog-title">
        <h2 id="fabric-dialog-title">{text(element.title) || app.name}</h2>
        <p className="fabric-dialog-from">From {app.name}</p>
        <p>{text(element.body)}</p>
        <div className="dialog-actions">
          {(Array.isArray(element.actions) && element.actions.length ? element.actions : [{ id: "ok", label: "OK" }]).slice(0, 3).map((action) => (
            <button key={action.id} type="button" className={`btn${toneClass("tone" in action ? action.tone : undefined)}`} onClick={() => answer(action.id)}>
              {text(action.label) || action.id}
            </button>
          ))}
        </div>
      </Scrim>
    </AppBoundary>
  );
}
