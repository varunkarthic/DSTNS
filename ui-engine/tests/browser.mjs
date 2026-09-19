// Repeatable full UI -> CLI -> core -> API -> report verification.
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "../.."),
  dir = path.join(root, "artifacts/modernization/browser"),
  port = 18191,
  base = `http://127.0.0.1:${port}`;
mkdirSync(dir, { recursive: true });
const server = spawn(
  path.join(root, "build/dstns_server"),
  ["--host", "127.0.0.1", "--port", String(port), "--logs", dir],
  { cwd: root, stdio: "ignore" },
);
let browser;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (route, data) => {
  const res = await fetch(base + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { code: res.status, body: await res.json() };
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call("/health")).code === 200) break;
    } catch {}
    await wait(100);
  }
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("heading", { name: "Awaiting CLI startup" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Toggle reduced motion" })
      .getAttribute("aria-pressed"),
    "true",
    "OS motion preference",
  );
  assert.equal(
    (await call("/api/v1/playback/start", { seed: "0x42" })).code,
    403,
    "browser cannot start",
  );
  assert.equal(
    await page.locator("[title]").count(),
    0,
    "custom tooltips only",
  );
  const token = readFileSync(path.join(dir, "operator.token"), "utf8").trim();
  const seedDb = path.join(dir, `seeds-${Date.now()}.db`);
  const run = spawnSync(
    "node",
    [
      "dstns-operator-cli/dstns.mjs",
      "start",
      "--seed",
      "382923",
      "--day-type",
      "weekend",
      "--osm-file",
      "data/fixtures/real_network.osm.xml",
      "--save-seed",
      "browser-weekend",
      "--no-splash", "--no-open",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DSTNS_API_PORT: String(port),
        DSTNS_OPERATOR_TOKEN: token,
        DSTNS_SEED_DB: seedDb,
      },
    },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  await page.getByRole("button", { name: "Pause simulation" }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Pause simulation"]').disabled,
  );
  await page.getByRole("button", { name: "Pause simulation" }).click();
  await page.getByRole("button", { name: "Resume simulation" }).waitFor();
  assert.equal((await call("/api/v1/playback/status")).body.data.day, 1);
  const first = (await call("/api/v1/playback/status")).body.clock
    .virtual_day_seconds;
  await wait(1200);
  assert.equal(
    (await call("/api/v1/playback/status")).body.clock.virtual_day_seconds,
    first,
    "pause freezes virtual time",
  );
  await page.getByRole("button", { name: "Resume simulation" }).click();
  await page.getByRole("button", { name: "Pause simulation" }).waitFor();
  await wait(1200);
  assert.ok(
    (await call("/api/v1/playback/status")).body.clock.virtual_day_seconds >
      first,
  );
  await page.getByRole("button", { name: "Pause simulation" }).click();
  await page.getByRole("button", { name: "Resume simulation" }).waitFor();
  const rate = page.getByRole("slider", {
    name: "Simulation rate multiplier",
  });
  await rate.focus();
  await rate.press("ArrowRight");
  await wait(1200);
  assert.equal(
    (await call("/api/v1/playback/status")).body.clock.tick_rate,
    2,
    "rate slider drives the core",
  );
  const motionToggle = page.getByRole("button", {
    name: "Toggle reduced motion",
  });
  await motionToggle.hover();
  await page.getByRole("tooltip").waitFor();
  assert.match(
    await page.getByRole("tooltip").innerText(),
    /visual motion sensitivity/,
  );
  await motionToggle.click();
  assert.equal(await motionToggle.getAttribute("aria-pressed"), "false");
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Toggle reduced motion"]')
        ?.getAttribute("aria-pressed") === "false",
    undefined,
    { timeout: 10000 },
  );
  await page.getByRole("tab", { name: /Queue/ }).click();
  await page.getByRole("button", { name: "Upcoming" }).click();
  await page
    .getByRole("combobox", { name: "Event category" })
    .selectOption("signals");
  await page.waitForFunction(
    () => document.querySelectorAll(".event-row").length > 0,
  );
  assert.ok((await page.locator(".event-row").count()) <= 30);
  assert.match(await page.locator(".stream").innerText(), /scheduled/);
  await page.getByRole("button", { name: "Executed" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".event-row small")
      ?.textContent.includes("executed"),
  );
  await page.getByRole("tab", { name: "Stack" }).click();
  const topo = (await call("/api/v1/view/topology")).body.data;
  // Real pointer inspection against the projected map, with no DOM entity mocks.
  const bounds = await page.locator(".map-layer").boundingBox();
  const xs = topo.nodes.map((n) => n.position.x_m),
    ys = topo.nodes.map((n) => -n.position.y_m);
  // Mirrors mapFitLayout() in src/mapProjection.ts, which is unit tested there.
  // Kept in sync so these suites can aim real pointer events at real entities.
  const deckPx = bounds.width <= 1024 ? 0 : bounds.width <= 1280 ? 340 : 420;
  const available = Math.max(280, bounds.width - deckPx - (deckPx ? 110 : 100));
  const centerX = (bounds.width - deckPx) / 2;
  const scale = Math.min(
    available / (Math.max(...xs) - Math.min(...xs)),
    (bounds.height - 150) / (Math.max(...ys) - Math.min(...ys)),
  );
  const project = (p) => ({
    x:
      bounds.x +
      centerX +
      (p.x_m - (Math.max(...xs) + Math.min(...xs)) / 2) * scale,
    y:
      bounds.y +
      (bounds.height - 60) / 2 +
      (-p.y_m - (Math.max(...ys) + Math.min(...ys)) / 2) * scale,
  });
  const signals = (await call("/api/v1/view/snapshot")).body.data.signals;
  // The part of the canvas no floating panel covers: right of the map dock,
  // left of the telemetry deck, below the header and search, above the bottom
  // stack. A pointer aimed outside this lands on a panel, not the map.
  const exposed = (p) => p.x > 120 && p.x < 900 && p.y > 200 && p.y < 620;
  const signal = signals.find((s) =>
    exposed(project(topo.nodes[s.junction_id].position)),
  );
  assert.ok(signal, "visible actual signal");
  const signalPoint = project(topo.nodes[signal.junction_id].position);
  await page.mouse.move(signalPoint.x, signalPoint.y);
  await page
    .getByRole("tooltip")
    .filter({ hasText: `Signal J-${signal.junction_id}` })
    .waitFor();
  assert.match(await page.getByRole("tooltip").innerText(), /Next transition/);
  await page.screenshot({ path: path.join(dir, "signal-hover.png") });
  await page.mouse.move(720, 950);
  // Cross a real scheduled demand change and observe the actual UI notification.
  const future = (
    await call("/api/v1/view/event-queue?view=future&category=demand&limit=30")
  ).body.data.items;
  const demand = future.find((e) => e.virtual_s > first + 3);
  assert.ok(demand, "upcoming real POI demand");
  await call("/api/v1/playback/seek", { target_time: demand.virtual_s - 3 });
  await wait(1800);
  await page.getByRole("button", { name: "Resume simulation" }).click();
  await page
    .locator(".toast")
    .filter({ hasText: /demand|commute|Retail/i })
    .first()
    .waitFor();
  assert.match(
    await page
      .locator(".toast")
      .filter({ hasText: /demand|commute|Retail/i })
      .first()
      .innerText(),
    /demand|commute|Retail/i,
  );
  await page.getByRole("button", { name: "Pause simulation" }).click();
  await page.getByRole("button", { name: "Resume simulation" }).waitFor();
  const demandState = (await call("/api/v1/view/snapshot")).body.data;
  assert.ok(demandState.demand.some((d) => d.active));
  assert.ok(demandState.edges.some((e) => e.demand_causes.length > 0));
  await page.screenshot({ path: path.join(dir, "demand-toast.png") });
  const place = topo.features.find((f) => f.name && f.name.length > 3);
  assert.ok(place);
  await page.getByRole("textbox", { name: "Search places" }).fill(place.name);
  await page.locator(".place-search li button").first().click();
  await page.getByRole("tooltip").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit network to viewport" }).click();
  await page.screenshot({ path: path.join(dir, "desktop.png") });
  for (const [width, height] of [
    [1280, 633],
    [800, 700],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await wait(300);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "no horizontal overflow",
    );
    const box = await page.locator(".playback-dock").boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height,
    );
    await page.screenshot({ path: path.join(dir, `viewport-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export Report/ }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(dir, "report.pdf"));
  assert.equal(await download.failure(), null);
  await page.route("**/api/v1/view/snapshot", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page
    .getByRole("alert")
    .filter({ hasText: /Incomplete/ })
    .waitFor();
  assert.ok(
    await page.getByRole("button", { name: "Resume simulation" }).isDisabled(),
  );
  await page.unroute("**/api/v1/view/snapshot");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Resume simulation"]').disabled,
  );
  // Run to the end of the virtual day and confirm the UI reflects completion.
  await call("/api/v1/playback/seek", { target_time: 86400 });
  await call("/api/v1/playback/play", {});
  for (let i = 0; i < 100; i++) {
    if (
      (await call("/api/v1/playback/status")).body.data.lifecycle ===
      "COMPLETED"
    )
      break;
    await wait(100);
  }
  assert.equal(
    (await call("/api/v1/playback/status")).body.data.lifecycle,
    "COMPLETED",
    "seeking to the end completes the run",
  );
  // The scrubber reports the full day, and transport controls are inert.
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector('[aria-label="Virtual day position"]')
          ?.getAttribute("aria-valuenow") ?? 0,
      ) >= 86399,
    undefined,
    { timeout: 10000 },
  );
  assert.ok(
    await page.getByRole("button", { name: "Pause simulation" }).isDisabled(),
    "completed run offers no pause",
  );
  assert.ok(
    await page.getByRole("button", { name: "Pause simulation" }).isDisabled(),
  );
  await call("/api/v1/playback/reset", {});
  await page.getByRole("heading", { name: "Awaiting CLI startup" }).waitFor();
  const reused = spawnSync(
    "node",
    [
      "dstns-operator-cli/dstns.mjs",
      "start",
      "--saved-seed",
      "browser-weekend",
      "--no-splash", "--no-open",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DSTNS_API_PORT: String(port),
        DSTNS_OPERATOR_TOKEN: token,
        DSTNS_SEED_DB: seedDb,
      },
    },
  );
  assert.equal(reused.status, 0, reused.stdout + reused.stderr);
  await page.getByRole("button", { name: "Pause simulation" }).waitFor();
  assert.equal((await call("/api/v1/playback/status")).body.data.day, 1);
  assert.equal(
    (await call("/api/v1/view/topology")).body.data.graph_hash,
    topo.graph_hash,
  );
  await call("/terminate", {});
  await page
    .getByRole("alert")
    .filter({ hasText: /unavailable/ })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Browser verification passed: CLI-only start, weekend, pause/resume/speed, OS and persisted motion, tooltips, event pages, place inspection, responsive layouts, PDF download, malformed data, completion and backend termination.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
