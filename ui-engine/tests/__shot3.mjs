import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
const root = "/Users/varun/Library/CloudStorage/OneDrive-Personal/SUMO_Sandbox/dstns";
const out = process.argv[2], port = 18295, base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root, "build/dstns_server"), ["--host","127.0.0.1","--port",String(port),"--logs",out],
  { cwd: root, stdio: "ignore", env: { ...process.env, DSTNS_OPERATOR_TOKEN: "tok" } });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await wait(100); }
  await fetch(base + "/api/v1/playback/start", { method: "POST",
    headers: { "Content-Type": "application/json", "X-DSTNS-Operator": "tok" },
    body: JSON.stringify({ seed: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }) });
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".loading-surface", { state: "detached", timeout: 180000 }).catch(()=>{});
  await wait(2500);
  // Zoom in so the markers are at readable size.
  const zoom = await page.$('[aria-label="Zoom in"]');
  for (let i = 0; i < 4 && zoom; i++) { await zoom.click(); await wait(350); }
  await wait(900);
  await page.screenshot({ path: `${out}/20-glyphs.png` });
  await page.click('button[aria-label="Place legend"]').catch(()=>{});
  await wait(700);
  await page.screenshot({ path: `${out}/21-legend.png` });
  console.log("ok");
} finally { await browser?.close(); server.kill("SIGKILL"); }
