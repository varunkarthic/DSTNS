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
  const started = await call("/api/v1/playback/start", { seed: "0x2a17", playback_duration_seconds: 600, map: { osm_file: "data/fixtures/real_network.osm.xml" } }, token);
  assert.equal(started.code, 202, JSON.stringify(started.body));

  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "Pause simulation" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);

  const box = (locator) => locator.boundingBox();
  const layout = async (label) => {
    const vw = page.viewportSize();
    const rail = await box(page.locator(".rail"));
    const cluster = page.locator(".lower-cluster > *:visible");
    const pieces = [];
    for (let i = 0; i < (await cluster.count()); i++) pieces.push(await cluster.nth(i).boundingBox());
    const deck = await page.locator(".telemetry-deck").isVisible() ? await box(page.locator(".telemetry-deck")) : null;
    const dock = await box(page.locator(".map-dock"));
    assert.ok(rail, `${label}: rail visible`);
    assert.ok(rail.x >= 0 && rail.x + rail.width <= vw.width + 0.5, `${label}: rail inside viewport`);
    assert.ok(rail.height <= 66 || vw.width <= 900, `${label}: rail compact (${rail.height}px)`);
    for (const p of pieces) assert.ok(!overlap(p, rail), `${label}: lower cluster clear of rail`);
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
  check("layout at 1100", async () => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(400);
    await layout("1100");
    await page.screenshot({ path: path.join(out, "hud-1100.png") });
  });
  check("layout at 760", async () => {
    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForTimeout(400);
    await layout("760");
    await page.screenshot({ path: path.join(out, "hud-760.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
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
    assert.equal(copied, (await call("/api/v1/playback/status")).body.global_seed);
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
    const card = page.getByRole("dialog", { name: /The network/ });
    await card.waitFor();
    await page.waitForTimeout(400);
    assert.equal((await call("/api/v1/playback/status")).body.data.lifecycle, "PAUSED", "tutorial pauses the run");
    const targets = [];
    for (let i = 0; i < 20; i++) {
      targets.push(await page.locator("[data-tutorial-step]").getAttribute("data-tutorial-step"));
      const start = page.getByRole("button", { name: "Start Simulation" });
      if (await start.count()) break;
      await page.getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(450);
      // The card stays inside the viewport and off its target.
      const c = await page.locator(".tour-card").boundingBox();
      const vw = page.viewportSize();
      assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= vw.width && c.y + c.height <= vw.height, "tour card inside viewport");
      if (i === 6) await page.screenshot({ path: path.join(out, "tutorial.png") });
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
    await page.getByRole("alertdialog").waitFor();
    await page.screenshot({ path: path.join(out, "world-generating.png") });
    await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 30000 });
    const after = (await call("/api/v1/playback/status")).body;
    assert.notEqual(after.run_id, before.run_id, "new run");
    assert.notEqual(after.global_seed, before.global_seed, "new seed");
    await page.getByRole("button", { name: new RegExp(`Copy seed ${after.global_seed}`) }).waitFor();
    await page.getByRole("button", { name: "Resume simulation" }).waitFor();
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
