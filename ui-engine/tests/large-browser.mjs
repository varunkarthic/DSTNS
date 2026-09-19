// Optional performance/visual probe: attach to an existing paused large-map run.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const base = process.env.DSTNS_LARGE_URL || "http://127.0.0.1:18194";
const dir = new URL("../../artifacts/modernization/large/", import.meta.url)
  .pathname;
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_BIN ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const start = Date.now();
  await page.goto(base);
  await page.getByRole("button", { name: "Resume simulation" }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Resume simulation"]').disabled,
  );
  const metrics = { interactive_load_ms: Date.now() - start };
  metrics.frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frames = [];
        let previous = performance.now(),
          start = previous;
        function frame(now) {
          frames.push(now - previous);
          previous = now;
          if (now - start < 3000) requestAnimationFrame(frame);
          else {
            frames.sort((a, b) => a - b);
            resolve({
              count: frames.length,
              median_ms: frames[Math.floor(frames.length / 2)],
              p95_ms: frames[Math.floor(frames.length * 0.95)],
            });
          }
        }
        requestAnimationFrame(frame);
      }),
  );
  await page.screenshot({ path: dir + "large-map.png" });
  const t = Date.now();
  const motionToggle = page.getByRole("button", {
    name: "Toggle reduced motion",
  });
  await motionToggle.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Toggle reduced motion"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  metrics.motion_toggle_ms = Date.now() - t;
  await page.screenshot({ path: dir + "large-map-reduced-motion.png" });
  const topo = (await (await fetch(base + "/api/v1/view/topology")).json())
    .data;
  const box = await page.locator(".map-layer").boundingBox(),
    xs = topo.nodes.map((n) => n.position.x_m),
    ys = topo.nodes.map((n) => -n.position.y_m);
  // Mirrors the network fit in NetworkMap (mapInsets() and viewportFor(),
  // both unit tested). The fit pads the network by 3% on each side.
  const focusButton = page.getByRole("button", { name: "Auto Focus on live events" });
  if ((await focusButton.getAttribute("aria-pressed")) === "true") await focusButton.click();
  await page.getByRole("button", { name: "Fit network to viewport" }).click();
  await page.waitForTimeout(1600);
  const deckPx = box.width <= 1024 ? 0 : box.width <= 1280 ? 340 : 420;
  const insets = { top: 24, left: box.width <= 720 ? 16 : 76, right: deckPx + 24, bottom: box.width <= 720 ? 196 : 150 };
  const usableW = box.width - insets.left - insets.right;
  const usableH = box.height - insets.top - insets.bottom;
  const scale = Math.min(
    usableW / ((Math.max(...xs) - Math.min(...xs)) * 1.06),
    usableH / ((Math.max(...ys) - Math.min(...ys)) * 1.06),
  );
  const centerX = insets.left + usableW / 2;
  const centerY = insets.top + usableH / 2;
  let roadInspected = false;
  for (const edge of topo.edges.filter(
    (e) => !e.synthetic_reverse && e.length_m > 50,
  )) {
    const a = edge.geometry[0],
      b = edge.geometry.at(-1),
      x =
        box.x +
        centerX +
        ((a.x_m + b.x_m) / 2 - (Math.max(...xs) + Math.min(...xs)) / 2) * scale,
      y =
        box.y +
        centerY +
        (-(a.y_m + b.y_m) / 2 - (Math.max(...ys) + Math.min(...ys)) / 2) *
          scale;
    // Only aim at canvas no floating panel covers (see browser.mjs).
    if (x < 120 || x > 900 || y < 200 || y > 620) continue;
    await page.mouse.move(x, y);
    await page.waitForTimeout(330);
    if (
      await page
        .getByRole("tooltip")
        .filter({ hasText: /Road · E-/ })
        .count()
    ) {
      roadInspected = true;
      await page.screenshot({ path: dir + "road-hover.png" });
      break;
    }
  }
  assert.ok(roadInspected, "real road hover");
  metrics.road_hover = true;
  await page.mouse.move(720, 950);
  // Park the clock just before a real scheduled demand change so the
  // notification is observed deterministically rather than by luck of timing.
  const clock = (await (await fetch(base + "/api/v1/playback/status")).json())
    .clock;
  const upcoming = (
    await (
      await fetch(
        base + "/api/v1/view/event-queue?view=future&category=demand&limit=30",
      )
    ).json()
  ).data.items;
  const demand = upcoming.find(
    (e) => e.virtual_s > clock.virtual_day_seconds + 3,
  );
  assert.ok(demand, "upcoming real POI demand");
  await fetch(base + "/api/v1/playback/seek", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_time: demand.virtual_s - 3 }),
  });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Resume simulation" }).click();
  await page
    .locator(".capsule")
    .filter({ hasText: /School|demand|commute|Retail/i })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Pause simulation" }).click();
  await page.getByRole("button", { name: "Resume simulation" }).waitFor();
  await page.screenshot({ path: dir + "large-demand.png" });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export Report/ }).click();
  await (await downloadPromise).saveAs(dir + "large-report.pdf");
  assert.deepEqual(errors, []);
  metrics.errors = errors;
  writeFileSync(dir + "browser-metrics.json", JSON.stringify(metrics, null, 2));
  console.log(metrics);
} finally {
  await browser.close();
}
