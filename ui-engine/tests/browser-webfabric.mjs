// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// WebFabric in a real browser against a live core, with representative mock
// applications calling the real API concurrently. Checks what jsdom cannot: the
// sandbox boundary, the Content Security Policy, painting and rendering under load.
// Screenshots land in artifacts/webfabric/.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
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

const server = spawn(path.join(root, "build/dstns_server"), ["--host", "127.0.0.1", "--port", String(port), "--logs", out, "--map-cache", "keep"], { cwd: root, stdio: "ignore" });
const call = async (method, route, data, token, extra = {}) => {
  const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { code: res.status, body: await res.json().catch(() => null) };
};
const settings = (extra = []) => ({ version: 1, groups: [{ id: "general", label: "General", fields: [{ id: "on", label: "Enabled", type: "toggle", default: true }, { id: "rate", label: "Rate", type: "slider", min: 0, max: 100, default: 25 }, ...extra] }] });
const register = async (id, name, capabilities, ui = [], extra = {}) => {
  const res = await call("POST", "/api/v1/fabric/apps", { id, name, version: "1.0.0", capabilities, settings: settings(), ui, ...extra });
  assert.equal(res.code, 201, JSON.stringify(res.body));
  return res.body.data.token;
};

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
    { id: "lab", slot: "panel", title: "Traffic Lab", widgets: [{ type: "text", text: "Declared by the application." }, { type: "stat", label: "Vehicles", value: 12, tone: "ok" }, { type: "progress", label: "Sweep", value: 0.4 }, { type: "button", id: "run", label: "Run sweep" }, { type: "toggle", id: "auto", label: "Auto", value: true }] },
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

  await test("a panel opens from the dock, and reports use to its own application", async () => {
    await page.getByRole("button", { name: "Lab tools, Traffic Lab" }).click();
    const panel = page.getByRole("dialog", { name: "Traffic Lab, Traffic Lab" });
    await panel.waitFor();
    await wait(600);
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
      return items.some((e) => e.data.action === "report") && items.some((e) => e.data.value?.id === 8) ? items : null;
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
    await page.getByText("Traffic Lab: Sweep finished").waitFor({ timeout: 6000 });
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
    const size = await about.getByRole("img", { name: "WebFabric" }).evaluate((img) => [img.naturalWidth / img.naturalHeight, img.clientWidth / img.clientHeight]);
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
