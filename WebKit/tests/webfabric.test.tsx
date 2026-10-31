// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFrame } from "../src/webfabric/AppFrame";
import { paintOverlay } from "../src/webfabric/Overlay";
import { WebFabricSettings } from "../src/webfabric/Settings";
import { AppBoundary, FabricDialog, FabricDockItems, FabricPanel, FabricStatus } from "../src/webfabric/Slots";
import { fabric, mergeApps, selectSlot, SLOT_LIMITS, toUiNotification } from "../src/webfabric/store";
import type { FabricApp, FabricElement } from "../src/webfabric/store";

// Representative applications: exercised here, never shipped.
function mockApp(id: string, order: number, overrides: Partial<FabricApp> = {}): FabricApp {
  return {
    id, name: id.split(".").pop()!, version: "1.0.0", description: "", author: "", state: "active", detail: "", user_suspended: false, order,
    capabilities: { requested: ["ui.status", "settings", "sim.read"], granted: ["ui.status", "settings", "sim.read"], pending: [] },
    settings: { version: 1, groups: [{ id: "general", label: "General", fields: [
      { id: "on", label: "Enabled", type: "toggle", default: true },
      { id: "level", label: "Level", type: "slider", min: 0, max: 10, default: 5 },
      { id: "mode", label: "Mode", type: "select", default: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { id: "many", label: "Many", type: "select", default: "1", options: ["1", "2", "3", "4"].map((v) => ({ value: v, label: v })) },
      { id: "count", label: "Count", type: "number", default: 2 },
      { id: "name", label: "Name", type: "text", default: "x" },
    ] }] },
    ui: [], blocked_ui: [], ...overrides,
  };
}
const status = (id: string, extra: Partial<FabricElement> = {}): FabricElement => ({ id, slot: "status", label: id, ...extra });
const load = (apps: FabricApp[]) => act(() => fabric.apply({ revision: Math.random(), notification_sequence: 0, notifications: [], unchanged: false, apps }));

let requests: { url: string; method: string; body: unknown; host: string | null }[];
let replies: (url: string, method: string, body: unknown) => unknown;

beforeEach(() => {
  requests = [];
  replies = () => ({ version: 1, values: { on: true, level: 5, mode: "a", many: "1", count: 2, name: "x" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ url, method: init?.method ?? "GET", body, host: new Headers(init?.headers).get("X-DSTNS-Host") });
    const data = replies(url, init?.method ?? "GET", body);
    if (data instanceof Error) return new Response(JSON.stringify({ error: { message: data.message } }), { status: 400 });
    return new Response(JSON.stringify({ data }), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  load([]);
  act(() => fabric.setOpenPanel(null));
  vi.unstubAllGlobals();
});

describe("state updates", () => {
  it("keeps the identity of whatever did not change, so nothing else re-renders", () => {
    const a = mockApp("org.x.a", 0, { ui: [status("one"), status("two")] });
    const b = mockApp("org.x.b", 1);
    const first = mergeApps([], [a, b]);
    expect(mergeApps(first, JSON.parse(JSON.stringify(first)))).toBe(first);
    const changed = JSON.parse(JSON.stringify(first));
    changed[0].ui[1].value = "new";
    const next = mergeApps(first, changed);
    expect(next).not.toBe(first);
    expect(next[1]).toBe(first[1]);
    expect(next[0].ui[0]).toBe(first[0].ui[0]);
    expect(next[0].ui[1]).not.toBe(first[0].ui[1]);
  });

  it("renders thousands of updates as one latest value", () => {
    render(<FabricStatus />);
    const updates = Array.from({ length: 5000 }, (_, n) => mockApp("org.x.a", 0, { ui: [status("s", { value: n })] }));
    act(() => { for (const apps of updates) fabric.apply({ revision: 1, notification_sequence: 0, notifications: [], unchanged: false, apps: [apps] }); });
    expect(screen.getByText("4999")).toBeInTheDocument();
  });

  it("delivers every notification, in order, attributed to its application", () => {
    const seen: number[] = [];
    const stop = fabric.onNotifications((notes) => seen.push(...notes.map((n) => n.sequence)));
    const note = (sequence: number) => ({ sequence, app_id: "org.x.a", app_name: "A", severity: "info" as const, title: "t", body: "" });
    fabric.apply({ revision: 1, notification_sequence: 2, notifications: [note(1), note(2)], unchanged: true });
    fabric.apply({ revision: 1, notification_sequence: 3, notifications: [note(3)], unchanged: true });
    stop();
    expect(seen).toEqual([1, 2, 3]);
    expect(toUiNotification(note(9), 60).title).toBe("A: t");
  });
});

describe("slots", () => {
  it("shares a slot between applications in registration order, and reports what did not fit", () => {
    const apps = Array.from({ length: 6 }, (_, i) => mockApp(`org.x.a${i}`, i, { ui: [status("s")] }));
    const { items, overflow } = selectSlot(apps, "status");
    expect(items).toHaveLength(SLOT_LIMITS.status);
    expect(items[0].app.id).toBe("org.x.a0");
    expect(overflow).toHaveLength(2);
    render(<FabricStatus />);
    load(apps);
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("renders only as text: markup and unknown fields never reach the page", () => {
    render(<FabricStatus />);
    load([mockApp("org.x.evil", 0, { ui: [status("s", { label: "<img src=x onerror=alert(1)>", value: { toString: "x" } as never, style: "position:fixed" } as never)] })]);
    expect(document.querySelector(".fabric-status img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("[style*=fixed]")).toBeNull();
  });

  it("offers tones, not colours: an unknown tone gets no class", () => {
    render(<FabricStatus />);
    load([mockApp("org.x.a", 0, { ui: [status("s", { tone: "#ff0000" as never }), status("t", { tone: "danger" })] })]);
    const [first, second] = document.querySelectorAll(".fabric-status-item");
    expect(first.className).toBe("fabric-status-item");
    expect(second).toHaveClass("tone-danger");
  });

  it("one application's failure stays with that application", async () => {
    const Bomb = (): never => { throw new Error("boom"); };
    const silence = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<div><AppBoundary app={mockApp("org.x.bad", 0)}><Bomb /></AppBoundary><span>the rest of the interface</span></div>);
    expect(screen.getByText("the rest of the interface")).toBeInTheDocument();
    await waitFor(() => expect(requests.some((r) => r.url.includes("/apps/org.x.bad/failure"))).toBe(true));
    silence.mockRestore();
  });

  it("tells the application when a control is used, and opens a declared panel", async () => {
    render(<><FabricDockItems /><FabricPanel /></>);
    load([mockApp("org.x.a", 0, { ui: [
      { id: "go", slot: "map_control", label: "Go", icon: "pin" },
      { id: "open", slot: "map_control", label: "Open", opens: "p" },
      { id: "p", slot: "panel", title: "Report", widgets: [{ type: "text", text: "Hello" }, { type: "stat", label: "Load", value: 3 }, { type: "progress", label: "Done", value: 0.5 }, { type: "button", id: "b", label: "Run" }, { type: "nonsense" } as never] },
    ] })]);
    fireEvent.click(screen.getByRole("button", { name: "Go, a" }));
    await waitFor(() => expect(requests.at(-1)).toMatchObject({ url: "/api/v1/fabric/apps/org.x.a/actions", body: { element: "go", action: "activate" } }));
    fireEvent.click(screen.getByRole("button", { name: "Open, a" }));
    expect(await screen.findByRole("dialog", { name: "Report, a" })).toHaveTextContent("Hello");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(requests.at(-1)?.body).toMatchObject({ element: "b" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes a panel whose application has gone", async () => {
    render(<FabricPanel />);
    load([mockApp("org.x.a", 0, { ui: [{ id: "p", slot: "panel", title: "Report", widgets: [] }] })]);
    act(() => fabric.setOpenPanel("org.x.a/p"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    load([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fabric.getOpenPanel()).toBeNull();
  });

  it("holds a dialog while the observer is busy, shows one at a time, and does not reopen an answered one", async () => {
    const dialog = (id: string): FabricElement => ({ id, slot: "dialog", title: `Title ${id}`, body: "Body", actions: [{ id: "yes", label: "Yes" }] });
    const { rerender } = render(<FabricDialog blocked />);
    load([mockApp("org.x.a", 0, { ui: [dialog("d")] })]);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<FabricDialog blocked={false} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("From a");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(requests.at(-1)?.body).toMatchObject({ element: "d", action: "yes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("overlays", () => {
  it("places map metres through the camera and takes colour only from the palette", () => {
    const calls: unknown[][] = [];
    const ctx = new Proxy({}, { get: (_, key) => (key === "fillText" || key === "arc" || key === "moveTo" || key === "lineTo" ? (...args: unknown[]) => calls.push([key, ...args]) : () => undefined), set: () => true }) as unknown as CanvasRenderingContext2D;
    const tones: string[] = [];
    paintOverlay(ctx, [{ type: "circle", x_m: 100, y_m: 50, radius_m: 20, tone: "danger", label: "Here" }, { type: "line", points: [[0, 0], [10, 10]] }], { x: 10, y: 20, scale: 2 }, (tone) => { tones.push(tone); return "#000"; });
    expect(calls[0]).toEqual(["arc", 210, -80, 40, 0, Math.PI * 2]);
    expect(calls).toContainEqual(["moveTo", 10, 20]);
    expect(calls).toContainEqual(["lineTo", 30, 0]);
    expect(tones).toEqual(["danger", "accent"]);
  });
});

describe("settings", () => {
  const open = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));

  it("lists applications, searches when there are many, and shows one at a time", async () => {
    render(<WebFabricSettings onBack={() => undefined} />);
    expect(screen.getByText(/No applications have registered/)).toBeInTheDocument();
    load(Array.from({ length: 30 }, (_, i) => mockApp(`org.x.app${i}`, i)));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "app17" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    open("app17");
    expect(await screen.findByLabelText("Enabled")).toBeInTheDocument();
    expect(requests.at(-1)?.url).toBe("/api/v1/fabric/apps/org.x.app17/settings");
    expect(requests.at(-1)?.host).toBe("observer");
  });

  it("draws every field type from the schema with the shared controls, and saves to that application alone", async () => {
    render(<WebFabricSettings onBack={() => undefined} />);
    load([mockApp("org.x.a", 0), mockApp("org.x.b", 1)]);
    open("a");
    expect(await screen.findByRole("switch", { name: "Enabled" })).toBeChecked();
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByLabelText("Many").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Level")).toHaveAttribute("type", "range");
    expect(screen.getByLabelText("Count")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("Name")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    await waitFor(() => expect(requests.at(-1)).toMatchObject({ url: "/api/v1/fabric/apps/org.x.a/settings", method: "PUT", body: { on: false } }));
    expect(requests.some((r) => r.url.includes("org.x.b"))).toBe(false);
  });

  it("shows a refused value, and returns to what is stored", async () => {
    render(<WebFabricSettings onBack={() => undefined} />);
    load([mockApp("org.x.a", 0)]);
    open("a");
    const toggle = await screen.findByRole("switch", { name: "Enabled" });
    replies = (_url, method) => (method === "PUT" ? new Error("invalid value for on") : { version: 1, values: { on: true } });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid value for on");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enabled" })).toBeChecked());
  });

  it("grants and revokes permissions, and marks those waiting", async () => {
    render(<WebFabricSettings onBack={() => undefined} />);
    replies = (url) => (url.includes("/state") ? { revision: 2, notification_sequence: 0, notifications: [], unchanged: true } : { version: 1, values: {} });
    load([mockApp("org.x.a", 0, { capabilities: { requested: ["ui.status", "control.events"], granted: ["ui.status"], pending: ["control.events"] } })]);
    fireEvent.click(screen.getByRole("radio", { name: "Permissions (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /Change the simulation/ }));
    const control = await screen.findByRole("switch", { name: "Change the simulation" });
    expect(control).not.toBeChecked();
    fireEvent.click(control);
    await waitFor(() => expect(requests.find((r) => r.url.endsWith("/grants"))?.body).toEqual({ capabilities: ["ui.status", "control.events"] }));
  });

  it("removes an application's settings when it is forgotten, and handles it failing", async () => {
    const back = vi.fn();
    render(<WebFabricSettings onBack={back} />);
    replies = (url) => (url.includes("/audit") ? { items: [] } : url.includes("/state") ? { revision: 3, notification_sequence: 0, notifications: [], unchanged: false, apps: [] } : {});
    load([mockApp("org.x.a", 0, { state: "failed", detail: "Its frame did not respond." })]);
    open("a");
    fireEvent.click(screen.getByRole("radio", { name: "Details" }));
    expect(await screen.findByText(/Its frame did not respond/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forget application" }));
    await waitFor(() => expect(requests.some((r) => r.method === "DELETE" && r.url === "/api/v1/fabric/apps/org.x.a")).toBe(true));
    await waitFor(() => expect(screen.getByText(/No applications have registered/)).toBeInTheDocument());
  });
});

describe("sandboxed frames", () => {
  const app = (granted: string[]) => mockApp("org.x.a", 0, { capabilities: { requested: granted, granted, pending: [] } });
  const element: FabricElement = { id: "p", slot: "panel", frame: "https://app.example/", title: "Panel" };
  const send = (frame: HTMLIFrameElement, data: unknown, source: unknown = frame.contentWindow) =>
    act(() => { window.dispatchEvent(new MessageEvent("message", { data, source: source as Window })); });

  it("has an opaque origin: scripts, and nothing else", () => {
    const { container } = render(<AppFrame app={app([])} element={element} />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("answers only its own frame, and checks each request against what was granted", async () => {
    const replies: { type?: string; code?: string; id?: unknown }[] = [];
    const { container, rerender } = render(<AppFrame app={app([])} element={element} onReply={(m) => replies.push(m as never)} />);
    const frame = container.querySelector("iframe")!;
    send(frame, { fabric: 1, type: "ready" }, window);
    expect(replies).toHaveLength(0);
    send(frame, { fabric: 1, type: "ready" });
    expect(replies.at(-1)?.type).toBe("init");
    send(frame, { fabric: 1, id: 1, type: "settings.get" });
    expect(replies.at(-1)).toMatchObject({ id: 1, type: "error", code: "CAPABILITY_NOT_GRANTED" });
    send(frame, { fabric: 1, id: 2, type: "sim.subscribe" });
    expect(replies.at(-1)).toMatchObject({ id: 2, code: "CAPABILITY_NOT_GRANTED" });
    send(frame, { fabric: 1, id: 3, type: "dom.write" });
    expect(replies.at(-1)).toMatchObject({ id: 3, code: "UNKNOWN_MESSAGE" });
    expect(requests).toHaveLength(0);
    rerender(<AppFrame app={app(["settings", "sim.read"])} element={element} onReply={(m) => replies.push(m as never)} />);
    send(frame, { fabric: 1, id: 4, type: "settings.get" });
    await waitFor(() => expect(replies.at(-1)).toMatchObject({ id: 4, type: "settings" }));
    expect(requests.at(-1)?.url).toBe("/api/v1/fabric/apps/org.x.a/settings");
    send(frame, { fabric: 1, id: 5, type: "sim.subscribe" });
    act(() => fabric.publishSim({ lifecycle: "RUNNING", virtual_s: 5, tick_rate: 1, congestion: 0.2, run_id: "r" }));
    expect(replies.at(-1)).toMatchObject({ type: "sim", virtual_s: 5 });
  });

  it("refuses a flood out loud rather than dropping it unannounced", () => {
    const replies: { code?: string }[] = [];
    const { container } = render(<AppFrame app={app([])} element={element} onReply={(m) => replies.push(m as never)} />);
    const frame = container.querySelector("iframe")!;
    for (let i = 0; i < 130; i++) send(frame, { fabric: 1, id: i, type: "nothing" });
    expect(replies.filter((r) => r.code === "RATE_LIMITED").length).toBe(10);
  });

  it("reports a frame that never answers, and offers another try without touching the rest", () => {
    vi.useFakeTimers();
    render(<AppFrame app={app([])} element={element} />);
    act(() => { vi.advanceTimersByTime(10001); });
    expect(screen.getByRole("alert")).toHaveTextContent(/other applications are unaffected/);
    expect(requests.at(-1)?.url).toBe("/api/v1/fabric/apps/org.x.a/failure");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });
});
