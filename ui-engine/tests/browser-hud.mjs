// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Real-browser verification of the observer HUD against a live core.
//
// Starts dstns_server on a private port, starts a run on the bundled fixture
// map (no network), then checks layout geometry at three window sizes, the
// command rail, tooltips, settings, notifications, world regeneration and the
// report download. Screenshots land in artifacts/hud/.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "artifacts/hud");
const port = 18193;
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
// Refuse to run against a server left over on this port: its operator token
// would not match the one this run reads.
try {
  await fetch(`${base}/health`);
  console.error(`Port ${port} is already in use. Stop the process listening there and retry.`);
  process.exit(2);
} catch {
  /* Free, as expected. */
}
const server = spawn(path.join(root, "build/dstns_server"), ["--host", "127.0.0.1", "--port", String(port), "--logs", out, "--map-cache", "keep"], { cwd: root, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, fn) => results.push([name, fn]);

async function call(route, data, token) {
  const res = await fetch(base + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-DSTNS-Operator": token } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { code: res.status, body: await res.json() };
}

const overlap = (a, b) => a && b && Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

let browser;
let failures = 0;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call("/health")).code === 200) break;
    } catch {}
    await wait(100);
  }
  const token = readFileSync(path.join(out, "operator.token"), "utf8").trim();

  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // The interface opens before the run exists, as the CLI now launches it, and
  // reports the stages the core reaches. This is the first thing an operator
  // sees, so it is the first thing checked.
  await page.goto(base);
  const startup = page.getByRole("status", { name: /Waiting for a simulation|Starting interface/ });
  await startup.waitFor({ timeout: 20000 });
  assert.match(await startup.innerText(), /Waiting for a simulation/);
  assert.equal(await page.getByRole("progressbar").count(), 0, "no progress is claimed before a run exists");
  assert.equal(await page.locator(".loading-steps").count(), 0, "no stages are listed before a run exists");
  // The shell's chrome arrives with the interface, not before it.
  const headerOpacity = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".app-header")).opacity));
  assert.ok(headerOpacity < 0.2, `the header waits for the interface (opacity ${headerOpacity})`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, "startup-waiting.png") });

  const started = await call("/api/v1/playback/start", { seed: "10775", playback_duration_seconds: 600, map: { osm_file: "data/fixtures/real_network.osm.xml" } }, token);
  assert.equal(started.code, 202, JSON.stringify(started.body));
  await page.getByRole("button", { name: "Pause simulation" }).waitFor({ timeout: 30000 });
  await page.locator(".loading-surface").waitFor({state: "detached", timeout: 10000});
  assert.equal(await page.locator(".loading-surface").count(), 0, "the start-up screen leaves once the map is up");

  check("the browser icon is the mark", async () => {
    const icon = await page.evaluate(() => document.querySelector("link[rel='icon']")?.getAttribute("href"));
    assert.equal(icon, "/favicon.svg", "the page references the icon");
    const res = await fetch(base + "/favicon.svg");
    assert.equal(res.status, 200, "the server serves it");
    const body = await res.text();
    assert.match(res.headers.get("content-type") || "", /svg/);
    assert.match(body, /<path/, "it carries the mark's geometry");
    assert.ok(body.length < 8000, "it is a small vector, not an embedded bitmap");
  });


  const box = (locator) => locator.boundingBox();
  const layout = async (label) => {
    const vw = page.viewportSize();
    const rail = await box(page.locator(".rail"));
    const cluster = page.locator(".lower-hud .hud-zone > *:visible");
    const aligned = page.locator(".lower-hud .hud-pill:visible, .lower-hud .capsule:visible");
    const baseline = [];
    for (const el of await aligned.all()) baseline.push(await el.boundingBox());
    assert.ok(baseline.every(b => Math.abs(b.height - 42) < 1), "all lower HUD surfaces share 42px height");
    assert.ok(Math.max(...baseline.map(b => b.y)) - Math.min(...baseline.map(b => b.y)) < 1, "all lower HUD surfaces share the baseline");
    const pieces = [];
    for (let i = 0; i < (await cluster.count()); i++) pieces.push(await cluster.nth(i).boundingBox());
    // The painted surface, not the panel's full box: collapsed, only the
    // strip is drawn and the rest of that box lets pointers through.
    const deck = await page.locator(".deck-surface").isVisible() ? await box(page.locator(".deck-surface")) : null;
    const dock = await box(page.locator(".map-dock"));
    assert.ok(rail, `${label}: rail visible`);
    assert.ok(rail.x >= 0 && rail.x + rail.width <= vw.width + 0.5, `${label}: rail inside viewport`);
    assert.ok(rail.height <= 66 || vw.width <= 900, `${label}: rail compact (${rail.height}px)`);
    for (const p of pieces) assert.ok(!overlap(p, rail), `${label}: lower HUD clear of rail`);
    // The zones of the lower HUD never run into each other either.
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++)
        assert.ok(!overlap(pieces[i], pieces[j]), `${label}: lower HUD elements do not overlap`);
    if (deck) for (const p of pieces) assert.ok(!overlap(p, deck), `${label}: lower HUD clear of telemetry`);
    if (deck) assert.ok(!overlap(deck, rail), `${label}: rail clear of deck`);
    assert.ok(!overlap(dock, rail), `${label}: rail clear of dock`);
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollW <= vw.width + 1, `${label}: no horizontal scroll`);
    // Icons stay within the size scale.
    const big = await page.$$eval("svg.icon", (els) => els.filter((e) => e.getBoundingClientRect().width > 24).length);
    assert.equal(big, 0, `${label}: no oversized icons`);
  };

  check("layout at 1440", async () => {
    await layout("1440");
    await page.screenshot({ path: path.join(out, "hud-1440.png") });
  });
  check("layout at 2560", async () => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.waitForTimeout(400);
    await layout("2560");
    await page.screenshot({ path: path.join(out, "hud-2560.png") });
  });
  check("layout at 1920", async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(400);
    await layout("1920");
  });
  check("layout at 1280", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await layout("1280");
    await page.screenshot({ path: path.join(out, "hud-1280.png") });
  });
  check("layout at the minimum supported size", async () => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await page.waitForTimeout(500);
    await layout("1024x640");
    // Everything the rail carries has to fit on one row at the smallest
    // supported size: this is what that minimum was chosen against.
    const rail = await box(page.locator(".rail"));
    assert.ok(rail.height <= 66, `rail stays one row at 1024 (${rail.height}px)`);
    for (const name of [/Copy seed/, "Terminate"])
      assert.ok(await page.getByRole("button", { name }).first().isVisible(), `${name} visible at 1024x640`);
    for (const rate of ["0.25 times speed", "5 times speed"])
      assert.ok(await page.getByRole("radio", { name: rate, exact: true }).isVisible(), `${rate} visible at 1024x640`);
    await page.screenshot({ path: path.join(out, "hud-1024.png") });
  });
  check("below the minimum, the interface says so instead of squeezing", async () => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(400);
    const notice = page.getByRole("alert");
    await notice.waitFor({ timeout: 5000 });
    assert.match(await notice.innerText(), /not optimized for this screen size/i);
    assert.match(await notice.innerText(), /1024/);
    assert.equal(await page.locator(".rail").count(), 0, "the interface is not rendered at all");
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollW <= 901, "the notice itself does not scroll sideways");
    await page.screenshot({ path: path.join(out, "hud-too-small.png") });
    // And it leaves again on its own.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Pause simulation" }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
  });

  check("tooltips avoid the control and its neighbours", async () => {
    for (const name of ["Step 1 min", "Generate new world", "Terminate", "Zoom in"]) {
      const target = page.getByRole("button", { name, exact: true });
      await target.hover();
      const tip = page.locator(".tip.shown");
      await tip.waitFor({ timeout: 2000 });
      const t = await tip.boundingBox();
      const a = await target.boundingBox();
      const vw = page.viewportSize();
      assert.ok(!overlap(t, a), `${name}: tooltip does not cover its control`);
      assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.width <= vw.width && t.y + t.height <= vw.height, `${name}: tooltip inside viewport`);
      const neighbours = await page.$$eval(".rail button, .map-dock > .tooltip-anchor > button", (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
      const covered = neighbours.filter((n) => overlap(t, n) && !overlap(n, a));
      assert.equal(covered.length, 0, `${name}: tooltip covers no neighbouring control; tip ${JSON.stringify(t)} covers ${JSON.stringify(covered)}`);
      await page.mouse.move(700, 300);
      await page.waitForTimeout(200);
    }
    await page.getByRole("button", { name: "Step 1 min", exact: true }).hover();
    await page.locator(".tip.shown").waitFor();
    await page.screenshot({ path: path.join(out, "tooltip.png"), clip: { x: 300, y: 700, width: 900, height: 200 } });
    await page.mouse.move(700, 300);
  });

  check("time control, speed and step drive the engine", async () => {
    const time = page.getByRole("button", { name: /Simulation time/ });
    await time.hover();
    await page.locator(".time-hint").filter({ hasText: /% complete/ }).waitFor();
    await page.getByRole("radio", { name: "2 times speed" }).click();
    await page.waitForTimeout(1500);
    assert.equal((await call("/api/v1/playback/status")).body.clock.tick_rate, 2, "speed reached the engine");
    const before = (await call("/api/v1/playback/status")).body.clock.virtual_day_seconds;
    await page.getByRole("button", { name: "Step 1 min", exact: true }).click();
    await page.waitForTimeout(600);
    const after = (await call("/api/v1/playback/status")).body;
    assert.equal(after.data.lifecycle, "PAUSED", "step holds the run");
    assert.ok(after.clock.virtual_day_seconds >= before + 60, "step advanced the model");
    await page.getByRole("button", { name: "Resume simulation" }).waitFor();
    await page.waitForTimeout(800);
    assert.match(await time.getAttribute("class"), /paused/, "paused time control breathes");
    await time.click();
    await page.getByRole("button", { name: /Simulation time \d{1,2}:\d{2}:\d{2} (AM|PM)/ }).waitFor();
    await time.click();
    await page.screenshot({ path: path.join(out, "rail-paused.png"), clip: { x: 200, y: 780, width: 1040, height: 120 } });
  });

  check("seed copies to the clipboard", async () => {
    const seed = page.getByRole("button", { name: /Copy seed/ });
    await seed.click();
    await page.locator(".seed-feedback.copied").waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const status = (await call("/api/v1/playback/status")).body;
    // The seed is copied as the number that starts the run, not as its hash.
    assert.equal(copied, status.seed);
    assert.match(copied, /^\d+$/);
    assert.notEqual(copied, status.global_seed);
  });

  check("settings drawer and layers panel", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.locator(".settings-drawer.open").waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, "settings.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Layers/ }).click();
    await page.getByRole("dialog", { name: "Layers" }).waitFor();
    await page.waitForTimeout(350);
    const panel = await box(page.getByRole("dialog", { name: "Layers" }));
    const rail = await box(page.locator(".rail"));
    assert.ok(!overlap(panel, rail), "layers panel clear of rail");
    await page.screenshot({ path: path.join(out, "layers.png") });
    await page.keyboard.press("Escape");
  });

  check("tutorial pauses time, walks the controls and starts the simulation", async () => {
    await call("/api/v1/playback/play", {});
    await page.getByRole("button", { name: "Pause simulation" }).waitFor();
    await page.getByRole("button", { name: "Start tutorial" }).click();
    const card = page.getByRole("dialog", { name: /The live network/ });
    await card.waitFor();
    await page.waitForTimeout(400);
    assert.equal((await call("/api/v1/playback/status")).body.data.lifecycle, "PAUSED", "tutorial pauses the run");
    const targets = [];
    for (let i = 0; i < 40; i++) {
      targets.push(await page.locator("[data-tutorial-step]").getAttribute("data-tutorial-step"));
      const start = page.getByRole("button", { name: "Start Simulation" });
      if (await start.count()) break;
      await page.getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(450);
      // The card stays inside the viewport and off its target.
      const c = await page.locator(".tour-card").boundingBox();
      const vw = page.viewportSize();
      assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= vw.width && c.y + c.height <= vw.height, "tour card inside viewport");
      assert.equal(await page.locator(".tour-missing").count(), 0, "every tutorial target is visible");
      const target = await page.locator("[data-tutorial-step]").getAttribute("data-tutorial-step");
      if (["focus", "notifications", "telemetry-congestion", "telemetry-notifications"].includes(target))
        await page.screenshot({ path: path.join(out, `tutorial-${target}.png`) });
      if (target === "focus") {
        const shape = await page.locator(".tour-spotlight").evaluate(el => ({ r: parseFloat(getComputedStyle(el).borderRadius), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));
        assert.ok(Math.abs(shape.w - shape.h) < 1 && shape.r >= shape.w / 2 - 1, "circular control has circular spotlight");
        const spot = await box(page.locator(".tour-spotlight"));
        assert.ok(!overlap(spot, await box(page.locator('.map-dock [data-tutorial="dnd"]'))), "focus spotlight clears next sidebar button");
      }
    }
    assert.equal(targets[targets.length - 1], "transport", "tour ends at playback");
    assert.ok(!targets.includes("asb"), "tour has no conditional backpressure step");
    await page.getByRole("button", { name: "Start Simulation" }).click();
    await page.waitForTimeout(800);
    assert.equal((await call("/api/v1/playback/status")).body.data.lifecycle, "RUNNING", "final action starts the run");
  });

  check("notifications appear as a capsule once events occur", async () => {
    await call("/api/v1/playback/play", {});
    // Jump to mid-morning, where the fixture day has scheduled events.
    await call("/api/v1/playback/seek", { target_time: "09:00:00", play: true });
    const capsule = page.getByRole("article", { name: "Notifications" });
    await capsule.waitFor({ timeout: 20000 });
    const head = capsule.locator(".capsule-head");
    const collapsed = await head.boundingBox();
    assert.ok(collapsed.height <= 48, "collapsed capsule is compact");
    await head.click();
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(out, "capsule-open.png") });
    const opened = await box(capsule);
    const rail = await box(page.locator(".rail"));
    assert.ok(!overlap(opened, rail), "expanded capsule clear of rail");
    await page.keyboard.press("Escape");
  });

  check("world regeneration replaces the world", async () => {
    const before = (await call("/api/v1/playback/status")).body;
    await page.getByRole("button", { name: "Generate new world" }).click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const overlay = page.getByRole("alertdialog");
    await overlay.waitFor();
    // The current world is paused for the swap and its controls rest.
    assert.match((await call("/api/v1/playback/status")).body.data.lifecycle, /PAUSED|PREPARING/);
    assert.ok(await page.locator(".app-shell.world-busy").count(), "the controls show they are busy");
    assert.match(await overlay.innerText(), /Generating new world/);
    // Nothing of the confirmation is left behind it.
    assert.equal(await page.locator(".scrim:not(.loading-surface) .dialog").count(), 0, "the confirmation has left");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, "world-generating.png") });
    await overlay.waitFor({ state: "detached", timeout: 30000 });
    const after = (await call("/api/v1/playback/status")).body;
    assert.notEqual(after.run_id, before.run_id, "new run");
    assert.notEqual(after.seed, before.seed, "new seed");
    assert.match(after.seed, /^\d{1,20}$/, "a generated seed is a plain number");
    await page.getByRole("button", { name: new RegExp(`Copy seed ${after.seed}`) }).waitFor();
    await page.getByRole("button", { name: "Resume simulation" }).waitFor();
  });

  check("telemetry collapses to a strip with a temporary side panel", async () => {
    const deck = page.locator(".telemetry-deck");
    const surfaceBefore = await box(page.locator(".deck-surface"));
    await page.getByRole("button", { name: "Collapse live telemetry" }).click();
    await page.waitForTimeout(500);
    const surfaceAfter = await box(page.locator(".deck-surface"));
    assert.ok(surfaceAfter.width < surfaceBefore.width / 3, "the panel really became a strip");
    assert.ok(await deck.locator(".deck-strip").isVisible(), "the strip is shown");

    const strip = page.getByRole("navigation", { name: "Telemetry summary" });
    // Compact figures use the shared abbreviation.
    const roads = await strip.getByLabel(/^Road edges/).innerText();
    assert.match(roads, /^\d+(\.\d+)?K?$/, `compact road count reads ${roads}`);

    await strip.getByRole("button", { name: "Stack" }).click();
    const panel = page.getByRole("dialog", { name: "Stack" });
    await panel.waitFor();
    await page.waitForTimeout(400);
    const panelBox = await box(panel);
    const railBox = await box(page.locator(".rail"));
    const dockBox = await box(page.locator(".map-dock"));
    assert.ok(!overlap(panelBox, railBox), "the side panel clears the command bar");
    assert.ok(!overlap(panelBox, dockBox), "the side panel clears the map tools");
    await page.screenshot({ path: path.join(out, "telemetry-compact.png") });

    await strip.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("dialog", { name: "Notifications" }).waitFor();
    await page.waitForTimeout(400);
    assert.ok(await deck.locator(".deck-strip").isVisible(), "the full panel stayed collapsed");
    await page.screenshot({ path: path.join(out, "notification-history.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Notifications" }).waitFor({ state: "detached" });

    await strip.getByRole("button", { name: "Expand live telemetry" }).click();
    await page.waitForTimeout(500);
    assert.ok((await box(page.locator(".deck-surface"))).width > surfaceBefore.width / 2, "the panel came back");
  });

  check("the place legend explains every marker on the map", async () => {
    await page.getByRole("button", { name: "Place legend" }).click();
    const legend = page.getByRole("dialog", { name: "Place legend" });
    await legend.waitFor();
    await page.waitForTimeout(350);
    const rows = await legend.getByRole("listitem").allInnerTexts();
    assert.ok(rows.length >= 3, `the legend lists the kinds on the map (${rows.length})`);
    // Every glyph the legend shows is one the map actually draws.
    const glyphs = await legend.locator(".place-glyph").allInnerTexts();
    assert.ok(glyphs.every((g) => g.trim().length === 0), "place glyphs contain no letter abbreviations");
    assert.equal(await legend.locator(".place-glyph svg").count(), glyphs.length, "every kind uses a vector glyph");
    assert.ok(rows.some((r) => /Not modelled|At rest|Peak \d/.test(r)), "demand is reported per kind");
    await page.screenshot({ path: path.join(out, "place-legend.png") });
    const toggle = legend.getByRole("switch", { name: "Show unclassified places" });
    if (await toggle.count()) {
      assert.equal(await toggle.getAttribute("aria-checked"), "false", "unclassified places start hidden");
    }
    await page.keyboard.press("Escape");
    await legend.waitFor({ state: "detached" });
  });

  check("runtime errors preempt notifications and DND without shifting status", async () => {
    await page.getByRole("button", { name: "Do Not Disturb", exact: true }).click();
    const before = await box(page.locator(".rail .runtime"));
    await page.route("**/api/v1/view/snapshot", route => route.abort());
    const error = page.getByRole("alert").filter({ hasText: "Simulator unavailable" });
    await error.waitFor({ timeout: 10000 });
    assert.ok(await error.evaluate(el => !!el.closest(".hud-left")), "errors use the simulation notification area");
    const after = await box(page.locator(".rail .runtime"));
    assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.x - after.x) < 1, "status geometry is reserved across state changes");
    await page.screenshot({ path: path.join(out, "system-error-dnd.png") });
    await page.unroute("**/api/v1/view/snapshot");
    await error.waitFor({ state: "detached", timeout: 10000 });
    await page.getByRole("button", { name: "Do Not Disturb", exact: true }).click();
  });

  check("report downloads as a multi-page PDF", async () => {
    await call("/api/v1/playback/play", {});
    await page.waitForTimeout(3000);
    const download = page.waitForEvent("download", { timeout: 60000 });
    await page.getByRole("button", { name: "Export Report" }).click();
    const file = await download;
    const target = path.join(out, "report.pdf");
    await file.saveAs(target);
    const bytes = readFileSync(target);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const pages = (bytes.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
    assert.ok(pages >= 8, `report has ${pages} pages`);
    assert.ok(statSync(target).size > 50000);
  });

  check("no page errors", async () => {
    assert.deepEqual(errors, []);
  });

  for (const [name, fn] of results) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures += 1;
      console.log(`FAIL  ${name}: ${e.message}`);
      await page.screenshot({ path: path.join(out, `fail-${name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
    }
  }
} finally {
  // Stop the server first so a browser shutdown error cannot orphan it.
  server.kill();
  await browser?.close().catch(() => {});
}
console.log(failures ? `${failures} HUD browser check(s) failed` : "HUD browser checks passed");
process.exit(failures ? 1 : 0);
