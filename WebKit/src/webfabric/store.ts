// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UiNotification } from "../notificationModel";

/**
 * The observer's side of WebFabric: one poll for everything applications have
 * declared, however many there are and however often they update.
 *
 * Declared UI is state, so it coalesces: a thousand updates between polls are one
 * render of the latest value, and whatever did not change keeps its identity, so
 * memoised components skip it. Notifications are events, so they arrive through a
 * cursor and none is skipped.
 */

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";
export type Slot = "header" | "status" | "panel" | "overlay" | "map_control" | "indicator" | "dialog";

export interface FabricWidget {
  type: "text" | "stat" | "progress" | "button" | "toggle" | "select" | "slider";
  id?: string;
  label?: string;
  text?: string;
  value?: unknown;
  tone?: Tone;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string }[];
}

export interface OverlayFeature {
  type: "point" | "circle" | "line" | "polygon";
  x_m?: number;
  y_m?: number;
  radius_m?: number;
  points?: [number, number][];
  tone?: Tone;
  label?: string;
}

export interface FabricElement {
  id: string;
  slot: Slot;
  label?: string;
  value?: string | number;
  tone?: Tone;
  icon?: string;
  title?: string;
  body?: string;
  /** Panel to open when activated, rather than telling the application. */
  opens?: string;
  edge?: "top" | "right" | "bottom" | "left";
  position?: number;
  active?: boolean;
  frame?: string;
  widgets?: FabricWidget[];
  features?: OverlayFeature[];
  actions?: { id: string; label: string; tone?: Tone }[];
}

export type SettingsFieldType = "toggle" | "slider" | "number" | "select" | "text";
export interface SettingsField {
  id: string;
  label: string;
  hint?: string;
  type: SettingsFieldType;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
  options?: { value: string | number; label: string }[];
}
export interface SettingsSchema {
  version?: number;
  groups: { id: string; label: string; fields: SettingsField[] }[];
}

export type AppState = "registered" | "initialized" | "active" | "suspended" | "failed" | "unloaded";

export interface FabricApp {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  state: AppState;
  detail: string;
  user_suspended: boolean;
  order: number;
  capabilities: { requested: string[]; granted: string[]; pending: string[] };
  settings: SettingsSchema | null;
  ui: FabricElement[];
  blocked_ui: string[];
}

export interface FabricNotification {
  sequence: number;
  app_id: string;
  app_name: string;
  severity: "info" | "warning" | "alert";
  title: string;
  body: string;
}

interface StatePayload {
  revision: number;
  notification_sequence: number;
  notifications: FabricNotification[];
  unchanged: boolean;
  apps?: FabricApp[];
}

/** How many of each kind fit on screen, in registration order, shared by all applications. */
export const SLOT_LIMITS: Record<Slot, number> = { header: 3, status: 4, map_control: 4, indicator: 8, panel: 32, overlay: 16, dialog: 1 };

const NO_APPS: FabricApp[] = [];

/** Reuse whatever has not changed, so components memoised on it do not re-render. */
export function mergeApps(previous: FabricApp[], incoming: FabricApp[]): FabricApp[] {
  const before = new Map(previous.map((app) => [app.id, app]));
  let changed = previous.length !== incoming.length;
  const next = incoming.map((app, index) => {
    const old = before.get(app.id);
    if (!old) {
      changed = true;
      return app;
    }
    const oldElements = new Map(old.ui.map((element) => [element.id, element]));
    const ui = app.ui.map((element) => {
      const same = oldElements.get(element.id);
      return same && JSON.stringify(same) === JSON.stringify(element) ? same : element;
    });
    const merged = { ...app, ui };
    if (JSON.stringify(old) === JSON.stringify(merged)) {
      if (previous[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return merged;
  });
  return changed ? next : previous;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/fabric${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    // Marks this as the person's own interface; see is_host in Fabric/src/routes_apps.cpp.
    headers: { "Content-Type": "application/json", "X-DSTNS-Host": "observer", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body?.data as T;
}

export interface SimSummary {
  lifecycle: string;
  virtual_s: number;
  tick_rate: number;
  congestion: number;
  run_id: string;
}

class FabricStore {
  private apps: FabricApp[] = NO_APPS;
  private listeners = new Set<() => void>();
  private revision = 0;
  private cursor = 0;
  private started = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private notes: FabricNotification[] = [];
  private noteListeners = new Set<(notes: FabricNotification[]) => void>();
  private sim: SimSummary | null = null;
  private simListeners = new Set<(sim: SimSummary) => void>();
  private openPanel: string | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getApps = () => this.apps;
  getOpenPanel = () => this.openPanel;

  private emit() {
    for (const listener of this.listeners) listener();
  }

  start() {
    if (this.started++) return;
    void this.poll();
  }

  stop() {
    if (--this.started > 0) return;
    this.started = 0;
    clearTimeout(this.timer);
  }

  /** Apply one state response. Separate from polling so it can be tested alone. */
  apply(state: StatePayload) {
    this.revision = state.revision;
    if (state.notifications?.length) {
      this.cursor = state.notifications[state.notifications.length - 1].sequence;
      for (const listener of this.noteListeners) listener(state.notifications);
    } else if (typeof state.notification_sequence === "number" && state.notification_sequence < this.cursor) {
      this.cursor = state.notification_sequence; // The server restarted.
    }
    if (!state.unchanged && state.apps) {
      const next = mergeApps(this.apps, state.apps);
      if (next !== this.apps) {
        this.apps = next;
        if (this.openPanel && !this.findPanel(this.openPanel)) this.openPanel = null;
        this.emit();
      }
    }
  }

  private async poll() {
    let delay = 1000;
    try {
      const state = await call<StatePayload>(`/state?since=${this.revision}&notifications_since=${this.cursor}`);
      if (!this.started) return;
      this.apply(state);
    } catch {
      delay = 5000; // An older core, or a lost connection: nothing to show either way.
    }
    if (!this.started) return;
    // A hidden tab has nothing to render, and a burst waits safely on the cursor.
    if (typeof document !== "undefined" && document.hidden) delay = Math.max(delay, 5000);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private findPanel(key: string) {
    const [appId, element] = key.split("/");
    return this.apps.find((app) => app.id === appId)?.ui.find((item) => item.id === element && item.slot === "panel");
  }

  setOpenPanel(key: string | null) {
    this.openPanel = key;
    this.emit();
  }

  onNotifications(listener: (notes: FabricNotification[]) => void) {
    this.noteListeners.add(listener);
    return () => {
      this.noteListeners.delete(listener);
    };
  }

  /** Latest only: frames follow the simulation at the rate the observer does. */
  publishSim(sim: SimSummary) {
    this.sim = sim;
    for (const listener of this.simListeners) listener(sim);
  }
  onSim(listener: (sim: SimSummary) => void) {
    this.simListeners.add(listener);
    if (this.sim) listener(this.sim);
    return () => {
      this.simListeners.delete(listener);
    };
  }

  /** Tell an application what a person did. Lossless: each is its own request. */
  action(appId: string, element: string, action = "activate", value?: unknown) {
    return call(`/apps/${appId}/actions`, { method: "POST", body: JSON.stringify({ element, action, value: value ?? null }) });
  }
  settings(appId: string) {
    return call<{ version: number; values: Record<string, unknown> }>(`/apps/${appId}/settings`);
  }
  updateSettings(appId: string, changes: Record<string, unknown>) {
    return call<{ version: number; values: Record<string, unknown> }>(`/apps/${appId}/settings`, { method: "PUT", body: JSON.stringify(changes) });
  }
  resetSettings(appId: string) {
    return call<{ version: number; values: Record<string, unknown> }>(`/apps/${appId}/settings`, { method: "DELETE" });
  }
  async grants(appId: string, capabilities: string[]) {
    await call(`/apps/${appId}/grants`, { method: "PUT", body: JSON.stringify({ capabilities }) });
    await this.refresh();
  }
  async suspend(appId: string, suspended: boolean) {
    await call(`/apps/${appId}/${suspended ? "suspend" : "resume"}`, { method: "POST", body: "{}" });
    await this.refresh();
  }
  async forget(appId: string) {
    await call(`/apps/${appId}`, { method: "DELETE" });
    await this.refresh();
  }
  failure(appId: string, detail: string) {
    return call(`/apps/${appId}/failure`, { method: "POST", body: JSON.stringify({ detail }) }).catch(() => undefined);
  }
  audit() {
    return call<{ items: { app_id: string; action: string; outcome: string; virtual_s: number; sequence: number }[] }>("/audit?limit=200");
  }
  private async refresh() {
    const state = await call<StatePayload>(`/state?since=0&notifications_since=${this.cursor}`);
    this.apply(state);
  }
}

export const fabric = new FabricStore();

export function useFabricApps(): FabricApp[] {
  return useSyncExternalStore(fabric.subscribe, fabric.getApps);
}

export function useOpenPanel(): string | null {
  return useSyncExternalStore(fabric.subscribe, fabric.getOpenPanel);
}

export interface SlotItem {
  app: FabricApp;
  element: FabricElement;
}

/** A slot's contents in registration order, and how many did not fit. */
export function selectSlot(apps: FabricApp[], slot: Slot): { items: SlotItem[]; overflow: SlotItem[] } {
  const all: SlotItem[] = [];
  for (const app of apps) for (const element of app.ui) if (element.slot === slot) all.push({ app, element });
  const limit = SLOT_LIMITS[slot];
  return { items: all.slice(0, limit), overflow: all.slice(limit) };
}

export function useSlot(slot: Slot) {
  const apps = useFabricApps();
  return useMemo(() => selectSlot(apps, slot), [apps, slot]);
}

/** An application's notifications as the capsule's records, attributed so none can pose as DSTNS. */
export function toUiNotification(note: FabricNotification, virtual: number): UiNotification {
  return {
    id: `app:${note.sequence}`,
    newsIds: [],
    type: "APPLICATION",
    category: "system",
    severity: note.severity,
    timestamp: virtual,
    startedAt: virtual,
    title: `${note.app_name}: ${note.title}`,
    summary: note.body,
    details: [],
    technical: [{ label: "Application", value: note.app_id }],
    count: 1,
  };
}

/** Notifications on screen for their dwell, then gone. */
export function useFabricNotifications(dwellMs: number, virtual: number) {
  const [items, setItems] = useState<{ note: UiNotification; until: number }[]>([]);
  const clock = useRef(virtual);
  clock.current = virtual;
  useEffect(
    () =>
      fabric.onNotifications((notes) => {
        const until = performance.now() + dwellMs;
        setItems((old) => [...old, ...notes.map((note) => ({ note: toUiNotification(note, clock.current), until }))].slice(-200));
      }),
    [dwellMs],
  );
  useEffect(() => {
    if (!items.length) return;
    const next = Math.min(...items.map((item) => item.until));
    const timer = setTimeout(() => setItems((old) => old.filter((item) => item.until > performance.now())), Math.max(0, next - performance.now()) + 10);
    return () => clearTimeout(timer);
  }, [items]);
  return {
    notes: useMemo(() => items.map((item) => item.note), [items]),
    dismiss: (id: string) => setItems((old) => old.filter((item) => item.note.id !== id)),
  };
}
