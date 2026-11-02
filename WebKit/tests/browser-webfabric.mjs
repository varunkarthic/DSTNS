// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// WebFabric in a real browser against a live core, with representative mock
// applications calling the real API concurrently. Checks what jsdom cannot: the
// sandbox boundary, the Content Security Policy, painting and rendering under load.
// Screenshots land in artifacts/webfabric/.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "artifacts/webfabric");
const port = 18194;
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A hostile page, standing in for any application's own page. It reports exactly
// what it managed to do, and the host relays that to the application's events.
const framePage = `<!doctype html><title>frame</title><body style="color:#fff;font:13px sans-serif">frame page<script>
const results = {};
const attempt = async (name, fn) => { try { results[name] = String(await fn()); } catch (e) { results[name] = "blocked"; } };
(async () => {
  await attempt("parentDom", () => parent.document.title);
  await attempt("parentLocation", () => parent.location.href);
  await attempt("cookie", () => document.cookie);
  await attempt("storage", () => localStorage.getItem("x"));
  await attempt("terminate", async () => (await fetch("${base}/api/v1/system/terminate", { method: "POST" })).status);
  await attempt("readStatus", async () => (await (await fetch("${base}/api/v1/system/status")).text()).length);
  await attempt("grant", async () => (await fetch("${base}/api/v1/fabric/apps/org.mock.hostile/grants", { method: "PUT", headers: {"Content-Type":"application/json"}, body: '{"capabilities":["control.world"]}' })).status);
  parent.postMessage({ fabric: 1, type: "ready" }, "*");
  parent.postMessage({ fabric: 1, type: "action", element: "probe", action: "report", value: results }, "*");
  parent.postMessage({ fabric: 1, id: 7, type: "settings.get" }, "*");
  parent.postMessage({ fabric: 1, id: 8, type: "sim.subscribe" }, "*");
})();
addEventListener("message", (e) => { if (e.data && e.data.fabric === 1 && (e.data.id === 7 || e.data.id === 8 || e.data.type === "sim")) parent.postMessage({ fabric: 1, type: "action", element: "probe", action: "reply", value: e.data }, "*"); });
</script>`;
const pages = createServer((_, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(framePage);
});
await new Promise((r) => pages.listen(18195, "127.0.0.1", r));

// Registrations persist beside the logs; a fresh server must not inherit the last run's.
rmSync(path.join(out, "fabric-apps.json"), { force: true });
const server = spawn(path.join(root, "build/dstns_server"), ["--host", "127.0.0.1", "--port", String(port), "--logs", out, "--map-cache", "keep"], { cwd: root, stdio: "ignore" });
const call = async (method, route, data, token, extra = {}) => {
  const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { code: res.status, body: await res.json().catch(() => null) };
};
const settings = (extra = []) => ({ version: 1, groups: [{ id: "general", label: "General", fields: [{ id: "on", label: "Enabled", type: "toggle", default: true }, { id: "rate", label: "Rate", type: "slider", min: 0, max: 100, default: 25 }, ...extra] }] });
const register = async (id, name, capabilities, ui = [], extra = {}) => {
  const res = await call("POST", "/api/v1/fabric/apps", { id, name, version: "1.0.0", capabilities, settings: settings(), ui, ...extra });
  assert.equal(res.code, 201, JSON.stringify(res.body));
  checkingIn.set(id, res.body.data.token);
  return res.body.data.token;
};
// As a real application does: the film outlasts a lease, and an application that goes silent is hidden.
const checkingIn = new Map();
const keepAlive = setInterval(() => {
  for (const [id, token] of checkingIn) void call("POST", `/api/v1/fabric/apps/${id}/heartbeat`, {}, token).catch(() => undefined);
}, 15000);
keepAlive.unref();

let browser;
let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n     ${error.message.split("\n").slice(0, 4).join("\n     ")}`);
  }
};
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await wait(50);
  }
};

try {
  await until(async () => (await call("GET", "/health").catch(() => ({}))).code === 200, "server");
  const operator = readFileSync(path.join(out, "operator.token"), "utf8").trim();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fabric\/apps|Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });
  await page.goto(base);
  const started = await call("POST", "/api/v1/playback/start", { seed: "10775", playback_duration_seconds: 3600, map: { osm_file: "data/fixtures/real_network.osm.xml" } }, null, { "X-DSTNS-Operator": operator });
  assert.equal(started.code, 202);
  await page.getByRole("button", { name: "Pause simulation" }).waitFor({ timeout: 30000 });

  // Representative applications, independent of one another.
  const traffic = await register("org.mock.traffic", "Traffic Lab", ["ui.status", "ui.overlays", "ui.notifications", "ui.map-controls", "ui.panels", "ui.indicators", "ui.header", "settings", "sim.read"], [
    { id: "load", slot: "status", label: "Load", value: "0", tone: "ok" },
    { id: "zone", slot: "overlay", features: [{ type: "circle", x_m: 0, y_m: 0, radius_m: 400, tone: "warn", label: "Study area" }] },
    { id: "tools", slot: "map_control", label: "Lab tools", icon: "gauge", opens: "lab" },
    { id: "lab", slot: "panel", title: "Traffic Lab", widgets: [{ type: "keyvalues", items: [{ label: "Fleet", value: 12 }, { label: "Late", value: 3, tone: "warn" }] }, { type: "table", columns: [{ label: "Route" }, { label: "Buses", align: "right" }], cells: [["R1", 4], ["R2", 8]] }, { type: "gauge", label: "Load", value: 0.62, tone: "ok" }, { type: "bars", items: [{ label: "North", value: 8 }, { label: "South", value: 4, tone: "warn" }] }, { type: "text", text: "Declared by the application." }, { type: "stat", label: "Vehicles", value: 12, tone: "ok" }, { type: "progress", label: "Sweep", value: 0.4 }, { type: "button", id: "run", label: "Run sweep" }, { type: "toggle", id: "auto", label: "Auto", value: true }] },
    { id: "edge", slot: "indicator", edge: "right", position: 0.3, tone: "danger", label: "Hot spot" },
    { id: "export", slot: "header", label: "Lab export", icon: "download" },
  ]);
  const hostile = await register("org.mock.hostile", "Hostile", ["ui.frames", "ui.panels", "ui.map-controls", "settings", "sim.read"], [
    { id: "open", slot: "map_control", label: "Hostile", icon: "system", opens: "frame" },
    { id: "frame", slot: "panel", title: "Hostile frame", frame: "http://127.0.0.1:18195/" },
  ]);
  const crowd = [];
  for (let i = 0; i < 10; i++) crowd.push([`org.mock.crowd${i}`, await register(`org.mock.crowd${i}`, `Crowd ${i}`, ["ui.status", "settings"], [{ id: "tick", slot: "status", label: `Crowd ${i}`, value: "0" }])]);
  const dialogs = await register("org.mock.prompt", "Prompter", ["ui.dialogs"], [{ id: "ask", slot: "dialog", title: "A question", body: "Proceed?", actions: [{ id: "yes", label: "Yes" }] }]);
  const controller = await register("org.mock.control", "Controller", ["control.playback"]);

  // Modelled on a real planner: its work sits beside the map.
  const net = await until(async () => {
    const body = (await call("GET", "/api/v1/view/topology")).body;
    const data = body?.data ?? body;
    return Array.isArray(data?.edges) && data.edges.length ? data : null;
  }, "the network", 30000);
  const edge = (i) => net.edges[i % net.edges.length].geometry.map((p) => [p.x_m, p.y_m]);
  const lines = Array.from({ length: 6 }, (_, i) => ({ type: "line", series: i, width: 2.5, points: edge(i * 37).concat(edge(i * 37 + 1), edge(i * 37 + 2)) }));
  const bus = (t) => ({ id: "buses", slot: "overlay", features: Array.from({ length: 6 }, (_, i) => { const pts = edge(i * 37); const p = pts[t % pts.length]; return { id: `bus-${i}`, type: "point", size: 5, series: i, x_m: p[0], y_m: p[1] }; }) });
  const planner = await register("org.mock.planner", "Route planner", ["ui.sidebar", "ui.overlays", "settings"], [
    { id: "routes", slot: "overlay", features: lines },
    bus(0),
    { id: "main", slot: "sidebar", title: "Route planner", label: "Bus network and journeys", widgets: [
      { type: "chips", items: [{ label: "City", value: "Berlin" }, { label: "Time", value: "18:00:00" }, { label: "Seed", value: "0x2026" }, { label: "Demand", value: "catchment" }] },
      { type: "input", id: "at", label: "Plan for", input_type: "time", value: "18:00:00", submit: "Re-plan" },
      { type: "tabs", id: "algo", tabs: [
        { id: "net", caption: "Algorithm 1", label: "The network", widgets: [
          { type: "heading", text: "What Algorithm 1 built" },
          { type: "text", text: "Greedy demand covering: start each line at the busiest stop not yet served, and keep extending it to whichever stop adds the most demand per extra minute of driving." },
          { type: "stats", items: [{ label: "Demand covered", value: "91.3", caption: "%", tone: "accent" }, { label: "Lines", value: "6", caption: "/6" }, { label: "Stops", value: "72" }] },
          { type: "progress", label: "Coverage", value: 0.913, tone: "accent" },
          { type: "heading", text: "Lines" },
          { type: "list", id: "lines", rows: [47.6, 25.2, 8.7, 4.2, 4.0, 3.1].map((share, i) => ({ id: `r${i}`, badge: `R${i}`, subtitle: `${11 + i} stops · ${(7.3 + i / 10).toFixed(1)} min out`, share: share / 47.6, value: `${share}%`, series: i })) },
        ] },
        { id: "trip", caption: "Algorithm 2", label: "A journey", widgets: [{ type: "button", id: "from", label: "Choose where to start", pick: true }] },
      ] },
      { type: "legend", legend: [{ label: "Bus line", series: 0, mark: "line" }, { label: "Your ride", tone: "accent", mark: "line" }, { label: "Stop", tone: "warn", mark: "dot" }, { label: "Walk", tone: "ok", mark: "dash" }, { id: "moving", label: "Moving buses", value: true }, { id: "live", label: "Live traffic", value: false }] },
    ] },
  ]);

  await test("a planner gets room beside the map, and the map refits around it", async () => {
    const sidebar = page.getByRole("complementary", { name: /Route planner/ });
    await sidebar.waitFor({ timeout: 8000 });
    await page.locator(".loading-surface").waitFor({ state: "detached", timeout: 90000 });
    await wait(900);
    const box = await sidebar.boundingBox();
    assert.ok(box.width > 340 && box.x >= 70 && box.x < 100, JSON.stringify(box));
    assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".fabric-sidebar"), { x: box.x + 30, y: box.y + 30 }), true, "nothing covers it");
    await sidebar.getByRole("button", { name: /R1/ }).click();
    await until(async () => (await call("GET", "/api/v1/fabric/apps/org.mock.planner/events", undefined, planner)).body.data.items.some((e) => e.data.element === "lines" && e.data.value === "r1"), "a row selection");
    await sidebar.getByRole("tab", { name: /A journey/ }).click();
    await sidebar.getByRole("button", { name: "Choose where to start" }).click();
    await page.getByText(/Click a place on the map/).waitFor();
    await page.mouse.click(900, 400);
    const picked = await until(async () => (await call("GET", "/api/v1/fabric/apps/org.mock.planner/events", undefined, planner)).body.data.items.find((e) => e.data.action === "pick"), "the picked place");
    assert.ok(Number.isFinite(picked.data.value.x_m) && Number.isFinite(picked.data.value.lat), JSON.stringify(picked.data.value));
    await sidebar.getByRole("tab", { name: /The network/ }).click();
    await wait(400);
    // Buses move by updating one element; the rest of the network is not resent.
    const mark = (await call("GET", "/api/v1/fabric/state")).body.data.revision;
    assert.equal((await call("PUT", "/api/v1/fabric/apps/org.mock.planner/ui/buses", bus(1), planner)).code, 200);
    const delta = (await call("GET", `/api/v1/fabric/state?since=${mark}`)).body.data.apps[0];
    assert.deepEqual(delta.ui_patch.map((e) => e.id), ["buses"]);
    await wait(700);
    await page.screenshot({ path: path.join(out, "planner.png") });
    await sidebar.getByRole("button", { name: "Put the sidebar away" }).click();
    await page.getByRole("button", { name: "Open Route planner" }).waitFor();
    await wait(500);
    assert.ok((await sidebar.boundingBox().catch(() => null))?.x < 0 || !(await sidebar.isVisible()), "it has gone");
    await page.getByRole("button", { name: "Open Route planner" }).click();
    await until(async () => (await sidebar.boundingBox())?.x > 70, "it comes back");
    await call("DELETE", "/api/v1/fabric/apps/org.mock.planner", undefined, planner);
    await sidebar.waitFor({ state: "detached", timeout: 6000 });
  });

  await test("declared UI appears in every slot, within limits", async () => {
    await page.getByRole("status", { name: "Application status" }).waitFor({ timeout: 8000 });
    assert.equal(await page.locator(".fabric-status-item:not(.more)").count(), 4, "four status lines fit");
    assert.match(await page.locator(".fabric-status-item.more").innerText(), /^\+\d+ more$/);
    await page.getByRole("button", { name: "Lab tools, Traffic Lab" }).waitFor();
    await page.getByRole("button", { name: "Lab export" }).waitFor();
    assert.equal(await page.locator(".fabric-indicator.edge-right").count(), 1);
    await page.screenshot({ path: path.join(out, "slots.png") });
  });

  await test("an overlay paints above the map and follows the camera", async () => {
    const painted = () => page.evaluate(() => {
      const c = document.querySelector(".fabric-overlay");
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
      return n;
    });
    const before = await until(painted, "overlay pixels");
    await page.locator(".map-dock").getByRole("button", { name: "Zoom in" }).click();
    await until(async () => (await painted()) !== before, "overlay redrawn for the new camera");
  });

  await test("a road draws itself along adjacent junctions, and vehicles drive it", async () => {
    // A real chain of roads from the loaded network.
    const from = new Map();
    for (const e of net.edges) if (!e.synthetic_reverse && !from.has(e.from)) from.set(e.from, e);
    let at = net.edges.find((e) => !e.synthetic_reverse).from;
    const chain = [at];
    while (chain.length < 8 && from.has(at) && !chain.includes(from.get(at).to)) chain.push((at = from.get(at).to));
    assert.ok(chain.length >= 3, "there is a chain to draw");
    const stranger = net.nodes.find((n) => !net.edges.some((e) => e.from === chain[0] && e.to === n.id))?.id;
    const refused = await call("PUT", "/api/v1/fabric/apps/org.mock.planner/ui/drawn", { slot: "overlay", features: [{ type: "route", nodes: [chain[0], stranger], draw_s: 2 }] }, planner);
    assert.ok(refused.code >= 400 && refused.code < 500, "junctions that are not adjacent are refused");
    const placed = await call("PUT", "/api/v1/fabric/apps/org.mock.planner/ui/drawn", { slot: "overlay", features: [
      { type: "route", nodes: chain, draw_s: 1.2, width: 5, tone: "warn" },
      { type: "path", id: "convoy", nodes: chain, drive: true, count: 3, shape: "vehicle", speed_mps: 25, loop: true, reveal: false, trail: false, tone: "danger", size: 6 },
    ] }, planner);
    assert.equal(placed.code, 200, JSON.stringify(placed.body));
    const frame = () => page.evaluate(() => {
      const c = document.querySelector(".fabric-overlay");
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let hash = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { n++; hash = (hash * 31 + i) | 0; }
      return { n, hash };
    });
    const first = await until(frame, "the overlay");
    // A convoy may be waiting at a red signal, so it gets long enough for the lights to change.
    await until(async () => (await frame()).hash !== first.hash, "it moves by itself, with nothing more sent", 60000);
    assert.equal((await call("DELETE", "/api/v1/fabric/apps/org.mock.planner/ui/drawn", undefined, planner)).code, 200);
  });

  await test("a panel opens from the dock, and reports use to its own application", async () => {
    await page.getByRole("button", { name: "Lab tools, Traffic Lab" }).click();
    const panel = page.getByRole("dialog", { name: "Traffic Lab, Traffic Lab" });
    await panel.waitFor();
    await wait(600);
    // The richer components render as data, in the interface's own shapes.
    assert.deepEqual(await panel.locator(".fabric-keyvalues dt").allInnerTexts(), ["Fleet", "Late"]);
    assert.equal(await panel.locator(".fabric-table tbody tr").count(), 2);
    assert.equal(await panel.locator(".fabric-table td.right").first().innerText(), "4");
    assert.equal(await panel.locator(".fabric-gauge[role=meter]").getAttribute("aria-valuenow"), "62");
    assert.equal(await panel.locator(".fabric-bars li").count(), 2);
    const box = await panel.boundingBox();
    assert.ok(box && box.width > 200 && box.height > 200, `the panel has its size: ${JSON.stringify(box)}`);
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).opacity), "1");
    assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".fabric-panel"), { x: box.x + 40, y: box.y + 40 }), true, "nothing covers the panel");
    await page.screenshot({ path: path.join(out, "panel.png") });
    await panel.getByRole("button", { name: "Run sweep" }).click();
    await until(async () => (await call("GET", "/api/v1/fabric/apps/org.mock.traffic/events", undefined, traffic)).body.data.items.some((e) => e.type === "ui.action" && e.data.element === "run"), "the action event");
    const others = await call("GET", "/api/v1/fabric/apps/org.mock.crowd0/events", undefined, crowd[0][1]);
    assert.equal(others.body.data.items.filter((e) => e.type === "ui.action").length, 0);
    assert.equal(await panel.count(), 1, "the panel stays open after use");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  await test("an ungranted frame is not offered; a granted one is sandboxed and cannot escape", async () => {
    await page.getByRole("button", { name: "Hostile, Hostile" }).click();
    await wait(1200);
    assert.equal(await page.locator(".fabric-frame iframe").count(), 0, "no grant, no frame");
    const granted = await call("PUT", "/api/v1/fabric/apps/org.mock.hostile/grants", { capabilities: ["ui.panels", "ui.map-controls", "ui.frames", "settings"] }, null, { "X-DSTNS-Operator": operator });
    assert.equal(granted.code, 200);
    await page.locator(".fabric-frame iframe").waitFor({ timeout: 6000 });
    await page.getByRole("button", { name: "Hostile, Hostile" }).click();
    assert.equal(await page.locator(".fabric-frame iframe").getAttribute("sandbox"), "allow-scripts");
    const events = await until(async () => {
      const items = (await call("GET", "/api/v1/fabric/apps/org.mock.hostile/events", undefined, hostile)).body.data.items.filter((e) => e.type === "ui.action");
      // Request 8 is refused at once and 7 needs a request of its own, so either may come first.
      return items.some((e) => e.data.action === "report") && items.some((e) => e.data.value?.id === 7) && items.some((e) => e.data.value?.id === 8) ? items : null;
    }, "the frame's report");
    const report = events.find((e) => e.data.action === "report").data.value;
    for (const attempt of ["parentDom", "parentLocation", "cookie", "storage", "terminate", "readStatus", "grant"]) {
      if (attempt === "terminate" || attempt === "grant") assert.ok(report[attempt] === "blocked" || report[attempt] === "403", `${attempt}: ${report[attempt]}`);
      else assert.equal(report[attempt], "blocked", `${attempt}: ${report[attempt]}`);
    }
    assert.equal((await call("GET", "/health")).code, 200, "the server is still up");
    const view = (await call("GET", "/api/v1/fabric/apps/org.mock.hostile")).body.data;
    assert.ok(!view.capabilities.granted.includes("control.world"), "it could not grant itself anything");
    const replies = events.filter((e) => e.data.action === "reply").map((e) => e.data.value);
    assert.equal(replies.find((m) => m.id === 7)?.type, "settings", "a granted request is answered");
    assert.equal(replies.find((m) => m.id === 8)?.code, "CAPABILITY_NOT_GRANTED", "an ungranted one is refused");
    await page.screenshot({ path: path.join(out, "frame.png") });
    await page.keyboard.press("Escape");
  });

  await test("a dialog waits for its grant, and is attributed", async () => {
    assert.equal(await page.locator(".dialog").count(), 0);
    await call("PUT", "/api/v1/fabric/apps/org.mock.prompt/grants", { capabilities: ["ui.dialogs"] }, null, { "X-DSTNS-Operator": operator });
    const dialog = page.getByRole("dialog").filter({ hasText: "A question" });
    await dialog.waitFor({ timeout: 6000 });
    assert.match(await dialog.innerText(), /From Prompter/);
    await dialog.getByRole("button", { name: "Yes" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(dialogs);
  });

  await test("notifications are attributed in the capsule", async () => {
    assert.equal((await call("POST", "/api/v1/fabric/apps/org.mock.traffic/notifications", { title: "Sweep finished", severity: "warning" }, traffic)).code, 202);
    await page.locator(".capsule.from-webfabric .capsule-from", { hasText: "WebFabric · Traffic Lab" }).waitFor({ timeout: 6000 });
    await page.locator(".capsule-head", { hasText: "Sweep finished" }).waitFor();
  });

  await test("a granted app controls the simulation, and it is recorded", async () => {
    assert.equal((await call("POST", "/api/v1/fabric/apps/org.mock.control/control", { action: "pause" }, controller)).body.error.code, "CAPABILITY_NOT_GRANTED");
    await call("PUT", "/api/v1/fabric/apps/org.mock.control/grants", { capabilities: ["control.playback"] }, null, { "X-DSTNS-Operator": operator });
    assert.equal((await call("POST", "/api/v1/fabric/apps/org.mock.control/control", { action: "pause" }, controller)).code, 200);
    await page.getByRole("button", { name: "Resume simulation" }).waitFor({ timeout: 6000 });
    assert.equal((await call("POST", "/api/v1/fabric/apps/org.mock.control/control", { action: "play" }, controller)).code, 200);
    const audit = (await call("GET", "/api/v1/fabric/audit")).body.data.items;
    assert.deepEqual(audit.map((e) => [e.app_id, e.action, e.outcome]), [["org.mock.control", "pause", "ok"], ["org.mock.control", "play", "ok"]]);
    await page.getByRole("button", { name: "Pause simulation" }).waitFor({ timeout: 6000 });
  });

  await test("settings: dynamic pages, isolation, keyboard access and persistence", async () => {
    await page.locator("[data-settings-trigger]").click();
    await page.locator(".settings-drawer.open").waitFor();
    await page.locator(".settings-nav").click();
    await page.getByRole("searchbox", { name: "Search applications" }).fill("crowd 7");
    assert.equal(await page.locator(".fabric-apps li").count(), 1);
    await wait(500);
    assert.equal(await page.locator(".settings-page").evaluate((el) => getComputedStyle(el).opacity), "1", "the page has settled, and is readable");
    await page.screenshot({ path: path.join(out, "settings-list.png") });
    await page.locator(".fabric-apps button").click();
    const toggle = page.getByRole("switch", { name: "Enabled" });
    await toggle.waitFor();
    await toggle.focus();
    await page.keyboard.press("Space");
    const token = crowd[7][1];
    await until(async () => (await call("GET", "/api/v1/fabric/apps/org.mock.crowd7/settings", undefined, token)).body.data.values.on === false, "the change");
    assert.equal((await call("GET", "/api/v1/fabric/apps/org.mock.crowd6/settings", undefined, crowd[6][1])).body.data.values.on, true, "another application is untouched");
    const events = (await call("GET", "/api/v1/fabric/apps/org.mock.crowd7/events", undefined, token)).body.data.items;
    assert.ok(events.some((e) => e.type === "settings.changed"), "told without a restart");
    await page.screenshot({ path: path.join(out, "settings-app.png") });
    await page.keyboard.press("Escape");
  });

  await test("one application going away leaves the others and the interface alone", async () => {
    await call("POST", "/api/v1/fabric/apps/org.mock.traffic/failure", { detail: "simulated crash" }, null, { "X-DSTNS-Operator": operator });
    await page.getByRole("button", { name: "Lab tools, Traffic Lab" }).waitFor({ state: "detached", timeout: 6000 });
    await page.getByRole("button", { name: "Hostile, Hostile" }).waitFor();
    await page.locator(".fabric-status-item", { hasText: "Crowd 0" }).waitFor();
    assert.equal((await call("PUT", "/api/v1/fabric/apps/org.mock.traffic/state", { state: "active" }, traffic)).code, 200);
    await page.getByRole("button", { name: "Lab tools, Traffic Lab" }).waitFor({ timeout: 6000 });
  });

  await test("twelve applications updating flat out leave the interface fluid", async () => {
    let running = true;
    let updates = 0;
    const flood = crowd.map(async ([id, token]) => {
      for (let n = 0; running; n++) {
        await call("PUT", `/api/v1/fabric/apps/${id}/ui/tick`, { slot: "status", label: id, value: String(n) }, token);
        updates++;
      }
    });
    const metrics = await page.evaluate(() => new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      let long = 0;
      const observer = new PerformanceObserver((list) => { long += list.getEntries().length; });
      observer.observe({ entryTypes: ["longtask"] });
      const started = last;
      const frame = (now) => {
        gaps.push(now - last);
        last = now;
        if (now - started < 6000) requestAnimationFrame(frame);
        else {
          observer.disconnect();
          gaps.sort((a, b) => a - b);
          resolve({ fps: gaps.length / 6, p95: gaps[Math.floor(gaps.length * 0.95)], long });
        }
      };
      requestAnimationFrame(frame);
    }));
    running = false;
    await Promise.all(flood);
    const rendered = await page.locator(".fabric-status-item").first().innerText();
    console.log(`     ${updates} updates in 6 s: ${metrics.fps.toFixed(1)} fps, p95 frame ${metrics.p95.toFixed(1)} ms, ${metrics.long} long tasks`);
    assert.ok(updates > 500, "the flood was a real one");
    assert.ok(metrics.fps > 50, `${metrics.fps.toFixed(1)} fps`);
    assert.ok(metrics.p95 < 25, `p95 ${metrics.p95.toFixed(1)} ms`);
    assert.ok(rendered, "still rendering");
  });

  await test("an application directs the view, and nothing of a person's changes", async () => {
    const host = { "X-DSTNS-Operator": operator };
    const capabilities = ["ui.camera", "ui.layers", "ui.overlays"];
    const token = (await call("POST", "/api/v1/fabric/apps", { id: "org.mock.director", name: "Director", version: "1.0.0", capabilities })).body.data.token;
    checkingIn.set("org.mock.director", token);
    const app = "/api/v1/fabric/apps/org.mock.director";
    assert.equal((await call("POST", `${app}/view`, { action: "fit" }, token)).code, 403, "not without a person's grant");
    assert.equal((await call("PUT", `${app}/presentation`, { layers: { weather: false } }, token)).code, 403, "not without a person's grant");
    assert.equal((await call("PUT", `${app}/grants`, { capabilities }, null, host)).code, 200);
    const saved = () => page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])));
    const before = await saved();

    const scale = () => page.locator(".map-scale-mark").evaluate((el) => `${el.textContent}/${el.querySelector("i, span, b")?.getAttribute("style") ?? el.getAttribute("style") ?? ""}`);
    const outcome = async (request) =>
      until(async () => (await call("GET", `${app}/events`, undefined, token)).body.data.items.find((e) => e.type.startsWith("view.") && e.data.request === request), `an outcome for request ${request}`);
    const ask = async (view) => outcome((await call("POST", `${app}/view`, view, token)).body.data.request);
    // Earlier checks may have moved the map themselves.
    const askUntilApplied = async (view) => {
      for (let n = 0; n < 12; n++) {
        const told = await ask(view);
        if (told.type === "view.applied") return told;
        assert.equal(told.data.reason, "person_moved_the_map");
        await wait(1000);
      }
      throw new Error("never applied");
    };

    await page.locator(".map-scale-mark").waitFor();
    const topology = (await call("GET", "/api/v1/view/topology")).body;
    const node = (topology.data ?? topology).nodes[20].id;
    const start = await scale();
    await askUntilApplied({ action: "node", node, span_m: 300 });
    const close = await until(async () => {
      const now = await scale();
      return now !== start && now;
    }, "the map moving as asked");
    await wait(1200);
    const settled = await scale();
    await askUntilApplied({ action: "zoom", factor: 0.5 });
    await until(async () => (await scale()) !== settled, "zooming as asked");
    assert.ok(close, "it moved");
    await wait(1200);

    // A person's move comes first, and the application is told.
    const map = page.locator(".map-canvas-wrap, .network-map, canvas").first();
    const box = await map.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    await wait(900);
    const theirs = await scale();
    const told = await ask({ action: "fit" });
    assert.equal(told.type, "view.declined");
    assert.equal(told.data.reason, "person_moved_the_map");
    await wait(600);
    assert.equal(await scale(), theirs, "and the map stays where the person put it");
    await page.mouse.move(box.x + 4, box.y + box.height - 4);

    // Holding layers: shown, named, and taken back. None of it is the person's setting.
    await page.locator("[data-layers-trigger]").click();
    const weather = page.getByRole("switch", { name: "Weather" });
    const signals = page.getByRole("switch", { name: "Signals" });
    await weather.waitFor();
    assert.equal(await weather.getAttribute("aria-checked"), "true");
    assert.equal((await call("PUT", `${app}/presentation`, { layers: { weather: false, signals: false } }, token)).code, 200);
    await until(async () => (await weather.getAttribute("aria-checked")) === "false", "the layer held off");
    await page.getByText("Held by Director").first().waitFor();
    await page.screenshot({ path: path.join(out, "layers-held.png") });
    assert.equal(await saved(), before, "holding a layer writes nothing");
    await page.getByRole("button", { name: "Use my choice for Weather" }).click();
    await until(async () => (await weather.getAttribute("aria-checked")) === "true", "the person's own choice back");
    assert.equal(await signals.getAttribute("aria-checked"), "false", "only that one was taken back");
    assert.equal(await saved(), before, "taking one back writes nothing either");

    // Changing something while an application holds another saves only what the person changed.
    await call("PUT", `${app}/presentation`, { layers: { weather: false, signals: false } }, token);
    await until(async () => (await weather.getAttribute("aria-checked")) === "false", "held again, having asked again");
    const vehicles = page.getByRole("switch", { name: "Flow markers" });
    const flipped = (await vehicles.getAttribute("aria-checked")) !== "true";
    await vehicles.click();
    await until(async () => (await saved()) !== before, "the person's own change saved");
    const config = JSON.parse(await page.evaluate(() => localStorage.getItem("dstns.ui-config.v1")));
    assert.equal(config.layers.vehicles, flipped, "what they changed");
    // Only what differs from the defaults is kept, so these are absent, or still the person's own.
    assert.notEqual(config.layers.weather, false, "not what an application was holding");
    assert.notEqual(config.layers.signals, false, "not what an application was holding");
    await vehicles.click();

    // Gone with the application.
    await call("POST", `${app}/suspend`, {}, null, host);
    await until(async () => (await weather.getAttribute("aria-checked")) === "true" && (await signals.getAttribute("aria-checked")) === "true", "released on suspending");
    await call("POST", `${app}/resume`, {}, null, host);
    assert.equal((await call("PUT", `${app}/presentation`, { layers: { signals: false } }, token)).code, 200);
    await until(async () => (await signals.getAttribute("aria-checked")) === "false", "held again");
    await call("PUT", `${app}/grants`, { capabilities: ["ui.camera", "ui.overlays"] }, null, host);
    await until(async () => (await signals.getAttribute("aria-checked")) === "true", "released on revoking");
    await page.keyboard.press("Escape");

    // Its own marks are drawn, and a flowing line moves. How a colour is made legible is in direction.test.ts.
    const road = (topology.data ?? topology).edges.find((e) => e.geometry.length > 1);
    assert.equal((await call("PUT", `${app}/ui/line`, { id: "line", slot: "overlay", features: [
      { type: "route", id: "a", nodes: [road.from, road.to], color: "#07131e", style: "flow", glow: true, width: 8 },
      { type: "route", id: "b", nodes: [road.from, road.to], color: "auto", style: "dotted", width: 4 },
    ] }, token)).code, 200);
    await askUntilApplied({ action: "edge", edge: road.id, span_m: 200 }).catch(() => undefined);
    const pixels = () => page.locator(".fabric-overlay").evaluate((c) => {
      const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      let [drawn, sum] = [0, 0];
      for (let i = 0; i < data.length; i += 16) {
        if (data[i + 3] < 200) continue;
        drawn++;
        sum = (sum + data[i] * (i % 251)) % 1000003;
      }
      return { drawn, sum };
    });
    const first = await until(async () => {
      const now = await pixels();
      return now.drawn > 20 && now;
    }, "the line drawn");
    await until(async () => (await pixels()).sum !== first.sum, "the line flowing");
    await page.screenshot({ path: path.join(out, "direction.png") });
    await call("DELETE", app, {}, token);
    checkingIn.delete("org.mock.director");
  });

  await test("several applications share the canvas: chosen from a list, placed on a grid, and leaving gracefully", async () => {
    const host = { "X-DSTNS-Operator": operator };
    const register = async (id, name, extra = {}) => {
      const made = await call("POST", "/api/v1/fabric/apps", { id, name, version: "1.0.0", capabilities: ["ui.deck", "ui.panels", "ui.map-controls"], ...extra });
      checkingIn.set(id, made.body.data.token);
      return made.body.data.token;
    };
    const first = await register("org.mock.canvas-a", "Canvas A", { web: { url: "https://example.org/a", label: "Open Canvas A" } });
    const second = await register("org.mock.canvas-b", "Canvas B");
    await call("PUT", "/api/v1/fabric/apps/org.mock.canvas-a/ui", [
      { id: "board", slot: "deck", title: "Board", layout: { columns: 6 }, widgets: [
        { type: "metric", label: "Buses", value: "12", delta: "+2", area: { column: 1, width: 3 } },
        { type: "metric", label: "Late", value: "1", delta: "-1", area: { column: 4, width: 3 } },
        { type: "chart", label: "Load", kind: "area", lines: [{ label: "Today", points: [1, 3, 2, 5, 4] }] },
        { type: "timeline", events: [{ time: "08:00", label: "First bus" }, { time: "08:20", label: "Second" }] },
        { type: "link", label: "Read more", url: "https://example.org/docs" },
        { type: "status", label: "Planner running", state: "ok" },
      ] },
      { id: "open", slot: "map_control", label: "Canvas A", icon: "gauge", opens: "panel" },
      { id: "panel", slot: "panel", title: "Canvas A panel", widgets: [{ type: "card", label: "A card", text: "Inside it" }] },
    ], first);
    await call("PUT", "/api/v1/fabric/apps/org.mock.canvas-b/ui", [{ id: "board", slot: "deck", title: "Other", widgets: [{ type: "text", text: "Canvas B here" }] }], second);
    await page.getByRole("tab", { name: /^Apps/ }).click();
    const deck = page.locator(".fabric-deck");
    await deck.waitFor();
    // Chosen from a list, since there are several.
    const chooser = deck.getByRole("button", { name: /Application/ }).first();
    await chooser.waitFor({ timeout: 8000 });
    await chooser.click();
    await page.getByRole("option", { name: /Canvas A/ }).click();
    await deck.getByText("Buses").waitFor();
    // Placed on its grid, side by side.
    const [left, right] = await deck.locator(".fabric-metric").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
    assert.ok(right > left + 40, `two metrics side by side: ${left} ${right}`);
    assert.equal(await deck.locator(".fabric-grid").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), 6);
    assert.equal(await deck.locator(".fabric-link").getAttribute("target"), "_blank");
    assert.equal(await deck.locator(".fabric-link").getAttribute("rel"), "noopener noreferrer");
    // Its own web interface, offered, and opened in a tab of its own.
    const [tab] = await Promise.all([page.context().waitForEvent("page"), deck.getByRole("button", { name: "Open Canvas A, Canvas A" }).click()]);
    assert.match(tab.url(), /example\.org\/a/);
    await tab.close();
    await page.screenshot({ path: path.join(out, "canvas.png") });

    // Its panel open, and the application turned off: the panel leaves rather than vanishing.
    await page.getByRole("button", { name: "Canvas A, Canvas A", exact: true }).click();
    const panel = page.locator(".fabric-panel");
    await panel.waitFor();
    await panel.getByRole("button", { name: "Turn off, Canvas A" }).click();
    await until(async () => (await page.locator(".fabric-panel.fabric-leaving").count()) > 0, "the panel leaving");
    await panel.waitFor({ state: "detached", timeout: 3000 });
    // And the deck hands over to the one that is left.
    await deck.getByText("Canvas B here").waitFor({ timeout: 6000 });
    assert.equal((await call("GET", "/api/v1/fabric/apps/org.mock.canvas-a")).body.data.user_suspended, true);

    // Several at once, from Settings.
    await call("POST", "/api/v1/fabric/apps/org.mock.canvas-a/resume", {}, null, host);
    await page.locator("[data-settings-trigger]").click();
    await page.locator(".settings-drawer.open").waitFor();
    // Settings opens where it was left, so go back to the list of applications.
    const pick = page.getByRole("checkbox", { name: "Select Canvas A" });
    for (let n = 0; n < 4 && !(await pick.isVisible()); n++) {
      if (await page.locator(".settings-nav").isVisible()) await page.locator(".settings-nav").click();
      else if (await page.locator(".settings-back").first().isVisible()) await page.locator(".settings-back").first().click();
      await wait(400);
    }
    await pick.check();
    await page.getByRole("checkbox", { name: "Select Canvas B" }).check();
    await page.getByRole("button", { name: "Turn off selected" }).click();
    await until(async () => {
      const [a, b] = await Promise.all(["a", "b"].map(async (x) => (await call("GET", `/api/v1/fabric/apps/org.mock.canvas-${x}`)).body.data.user_suspended));
      return a && b;
    }, "both turned off");
    await page.getByRole("button", { name: "Turn on all" }).click();
    await until(async () => (await call("GET", "/api/v1/fabric/apps/org.mock.canvas-b")).body.data.user_suspended === false, "turned on again");
    await page.keyboard.press("Escape");
    // Reloading ends its link at once.
    await page.getByRole("tab", { name: /^Apps/ }).click();
    await call("POST", "/api/v1/fabric/apps/org.mock.canvas-a/reload", {}, null, host);
    assert.equal((await call("POST", "/api/v1/fabric/apps/org.mock.canvas-a/heartbeat", {}, first)).code, 401);
    for (const id of ["org.mock.canvas-a", "org.mock.canvas-b"]) checkingIn.delete(id);
    await call("DELETE", "/api/v1/fabric/apps/org.mock.canvas-b", {}, second);
  });

  await test("a report still exports under the Content Security Policy", async () => {
    const download = page.waitForEvent("download", { timeout: 40000 });
    await page.getByRole("button", { name: "Export Report" }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /\.pdf$/);
  });

  await test("the About card shows the subsystems beside the protected legal text", async () => {
    await page.getByRole("button", { name: /About DSTNS/ }).click();
    const about = page.locator(".about-dialog");
    await about.getByRole("img", { name: "WebFabric" }).waitFor();
    const size = await about.getByRole("img", { name: "WebFabric" }).locator("img:visible").evaluate((img) => [img.naturalWidth / img.naturalHeight, img.clientWidth / img.clientHeight]);
    assert.ok(Math.abs(size[0] - size[1]) < 0.05, `the logo keeps its proportions: ${size}`);
    assert.match(await about.innerText(), /AGPL-3.0-or-later/);
    await page.screenshot({ path: path.join(out, "about.png") });
    await page.keyboard.press("Escape");
  });

  await test("nothing failed in the page", async () => {
    // The hostile frame's own fetches being refused is the boundary working.
    const seen = [...new Set(pageErrors)].filter((e) => !/from origin 'null' has been blocked by CORS/.test(e));
    for (const error of seen) console.error(`     page error: ${error.slice(0, 300)}`);
    assert.equal(seen.length, 0);
  });
} finally {
  await browser?.close().catch(() => undefined);
  server.kill("SIGTERM");
  pages.close();
}
console.log(failures ? `${failures} failed` : "webfabric browser ok");
process.exit(failures ? 1 : 0);
