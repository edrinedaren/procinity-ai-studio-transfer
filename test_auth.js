import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import express from "express";
import workerMod from "./src/index.js";
const worker = workerMod.default;
import { chromium } from "/usr/local/share/bun-global/node_modules/playwright/index.mjs";

execSync('openssl req -x509 -newkey rsa:2048 -keyout /tmp/px_test_key.pem -out /tmp/px_test_cert.pem -days 1 -nodes -subj "/CN=localhost" 2>/dev/null');
const tlsOpts = {
  key: fs.readFileSync("/tmp/px_test_key.pem"),
  cert: fs.readFileSync("/tmp/px_test_cert.pem"),
};

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(fs.readFileSync("schema.sql", "utf8"));
for (const f of fs.readdirSync("migrations").sort()) {
  if (f.endsWith(".sql")) {
    try { sqlite.exec(fs.readFileSync(path.join("migrations", f), "utf8")); } catch {}
  }
}

function createD1(db) {
  const prep = (sql) => {
    const stmt = db.prepare(sql);
    const bind = (args) => ({
      first: async (col) => { const r = stmt.get(...args); if (!r) return null; return col ? r[col] : r; },
      all: async () => ({ results: stmt.all(...args), success: true, meta: {} }),
      run: async () => { const info = stmt.run(...args); return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid || 0) } }; },
    });
    return { bind: (...args) => bind(args), first: (c) => bind([]).first(c), all: () => bind([]).all(), run: () => bind([]).run() };
  };
  return { prepare: prep, batch: async (s) => Promise.all(s.map(x => x.run())), exec: async (q) => db.exec(q) };
}

const app = express();
app.use("/api", express.raw({ type: "*/*", limit: "20mb" }), async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const baseUrl = req.headers.origin || `${proto}://${host}`;
  const fullUrl = new URL(req.originalUrl, baseUrl).toString();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody && Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
  const wRes = await worker.fetch(new Request(fullUrl, { method: req.method, headers, body }), { DB: createD1(sqlite) }, {});
  const setCookies = typeof wRes.headers.getSetCookie === "function" ? wRes.headers.getSetCookie() : [];
  res.status(wRes.status);
  wRes.headers.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") res.setHeader(k, v); });
  if (setCookies.length) res.setHeader("set-cookie", setCookies);
  res.send(Buffer.from(await wRes.arrayBuffer()));
});
app.use(express.static(path.resolve("public")));

const appServer = https.createServer(tlsOpts, app);
await new Promise(r => appServer.listen(0, "127.0.0.1", r));
const appPort = appServer.address().port;

const parentApp = express();
parentApp.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><body style="margin:0"><iframe id="f" src="https://localhost:${appPort}/" style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
});
const parentServer = https.createServer(tlsOpts, parentApp);
await new Promise(r => parentServer.listen(0, "127.0.0.1", r));
const parentPort = parentServer.address().port;

const browser = await chromium.launch();

async function runTest(mode) {
  console.log(`\n============================`);
  console.log(`TEST SUITE: ${mode.toUpperCase()} ENVIRONMENT`);
  console.log(`============================`);
  
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 900 } });
  const page = await ctx.newPage();
  const getTarget = () => mode === "iframe" ? page.frameLocator("#f") : page;
  const evalTarget = async (fn) => {
    if (mode === "iframe") {
      const fr = page.frames().find(f => f.url().includes("localhost"));
      return fr ? fr.evaluate(fn) : null;
    }
    return page.evaluate(fn);
  };

  if (mode === "iframe") await page.goto(`https://127.0.0.1:${parentPort}/`);
  else await page.goto(`https://localhost:${appPort}/`);

  await page.waitForTimeout(900);
  const t = getTarget();

  // 1. Create a test account
  await t.locator('nav button[data-t="profile"]').click();
  await t.locator('#view button:has-text("Sign in")').click();
  await t.locator('#pxTu').click();
  await t.locator('#pxN').fill("Final Test User");
  await t.locator('#pxE').fill(`final_${mode}@example.com`);
  await t.locator('#pxP').fill("StrongPass123!");
  await t.locator('#pxGo').click();
  await page.waitForTimeout(900);

  const r1 = await evalTarget(() => ({ u: PX.u && PX.u.email, guest: PX.guest }));
  console.log("1. Create test account & Sign in:", r1.u ? "PASS" : "FAIL", r1);

  // 2. Sign in successfully
  const r2 = await evalTarget(() => ({ u: PX.u && PX.u.email }));
  console.log("2. Sign in successfully:", r2.u ? "PASS" : "FAIL");

  // 3. Refresh page and confirm user remains signed in
  await page.reload();
  await page.waitForTimeout(900);
  const r3 = await evalTarget(() => ({ u: PX.u && PX.u.email, guest: PX.guest }));
  console.log("3. Refresh page & remain signed in:", r3.u ? "PASS" : "FAIL", r3);

  // 4. Open Wishlist without returning to sign-in screen
  await t.locator('nav button[data-t="market"]').click();
  await page.waitForTimeout(300);
  await t.locator('#shopMenuBtn').click();
  await page.waitForTimeout(200);
  await t.locator('[data-sm="Wishlist"]').click();
  await page.waitForTimeout(500);

  const r4 = await evalTarget(() => ({
    gateVisible: !!document.getElementById("pxGate"),
    shopPageVisible: !!document.getElementById("shopPage")
  }));
  console.log("4. Open Wishlist without sign-in prompt:", !r4.gateVisible && r4.shopPageVisible ? "PASS" : "FAIL", r4);

  // Close shop page
  await t.locator('#spgBack').click().catch(() => {});
  await page.waitForTimeout(300);

  // 5. Add an item to Wishlist and refresh; confirm it persists
  await t.locator('#view [data-d]').first().click();
  await page.waitForTimeout(300);
  await t.locator('#ipHeart').click();
  await page.waitForTimeout(2200);

  const wishCountBefore = await evalTarget(() => (S.wish || []).length);
  await page.reload();
  await page.waitForTimeout(900);
  const wishCountAfter = await evalTarget(() => (S.wish || []).length);
  console.log("5. Add item to Wishlist and persist on refresh:", wishCountBefore > 0 && wishCountBefore === wishCountAfter ? "PASS" : "FAIL", { before: wishCountBefore, after: wishCountAfter });

  // 6. Sign out and confirm protected actions require authentication
  await t.locator('nav button[data-t="profile"]').click();
  await page.waitForTimeout(400);
  await t.locator('[data-a="so"]').click();
  await page.waitForTimeout(800);

  const r6SignOut = await evalTarget(() => ({ u: PX.u, guest: PX.guest }));
  await t.locator('nav button[data-t="market"]').click();
  await page.waitForTimeout(300);
  await t.locator('#view [data-d]').first().click();
  await page.waitForTimeout(300);
  await t.locator('#ipHeart').click();
  await page.waitForTimeout(400);

  const r6Gate = await evalTarget(() => ({ gateVisible: !!document.getElementById("pxGate") }));
  console.log("6. Sign out & protected actions require auth:", !r6SignOut.u && r6Gate.gateVisible ? "PASS" : "FAIL", { signOut: r6SignOut, gate: r6Gate });

  await page.reload();
  await page.waitForTimeout(500);

  // 7. Sign in again and confirm session works
  await t.locator('nav button[data-t="profile"]').click();
  await page.waitForTimeout(300);
  await t.locator('#view button:has-text("Sign in")').click();
  await t.locator('#pxE').fill(`final_${mode}@example.com`);
  await t.locator('#pxP').fill("StrongPass123!");
  await t.locator('#pxGo').click();
  await page.waitForTimeout(900);

  const r7 = await evalTarget(() => ({ u: PX.u && PX.u.email, gateVisible: !!document.getElementById("pxGate") }));
  console.log("7. Sign in again & session works:", r7.u && !r7.gateVisible ? "PASS" : "FAIL", r7);

  await ctx.close();
}

await runTest("direct");
await runTest("iframe");

await browser.close();
appServer.close();
parentServer.close();
fs.rmSync("/tmp/px_test_key.pem", { force: true });
fs.rmSync("/tmp/px_test_cert.pem", { force: true });
