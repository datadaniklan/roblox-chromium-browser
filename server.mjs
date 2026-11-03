// Chromium render server for the Roblox browser game.
// Each Roblox player gets an isolated browser context. The Roblox game server
// polls /tick with queued input and receives only the screen tiles that changed,
// as RGBA, zstd-compressed and base64-encoded (decoded with EncodingService).
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 2);
const IDLE_MS = Number(process.env.IDLE_MS || 60_000);
const TILE = 32;
const HOME = "https://www.google.com";

let browser;
const sessions = new Map();

async function getBrowser() {
  if (browser?.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--mute-audio",
      "--disable-extensions",
      "--disable-background-networking",
      // Keep Chromium inside Render's 512 MB free tier: one shared renderer, no site isolation
      "--renderer-process-limit=1",
      "--disable-site-isolation-trials",
      "--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter",
      "--disable-software-rasterizer",
      "--autoplay-policy=user-gesture-required",
      "--js-flags=--max-old-space-size=128",
    ],
  });
  browser.on("disconnected", () => sessions.clear());
  return browser;
}

async function createSession(w, h) {
  if (sessions.size >= MAX_SESSIONS) closeOldest();
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  // Popups open in the same tab so the player never loses the view
  page.on("popup", async (p) => {
    const url = p.url();
    await p.close().catch(() => {});
    if (url && url !== "about:blank") page.goto(url).catch(() => {});
  });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  const id = crypto.randomUUID();
  const s = { id, ctx, page, w, h, prev: null, lastUsed: Date.now(), busy: Promise.resolve() };
  sessions.set(id, s);
  page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  return s;
}

function closeOldest() {
  let oldest;
  for (const s of sessions.values()) if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s;
  if (oldest) closeSession(oldest.id);
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.ctx.close().catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastUsed > IDLE_MS) closeSession(s.id);
}, 15_000);

function normalizeUrl(raw) {
  const t = String(raw || "").trim();
  if (!t) return HOME;
  if (/^[a-z]+:\/\//i.test(t)) return t;
  if (/^[^\s]+\.[^\s]{2,}$/.test(t)) return "https://" + t;
  return "https://www.google.com/search?q=" + encodeURIComponent(t);
}

const KEYS = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Space",
]);

async function applyEvents(s, events) {
  const { page } = s;
  for (const e of events || []) {
    try {
      switch (e.t) {
        case "nav":
          page.goto(normalizeUrl(e.url), { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
          break;
        case "back": page.goBack({ timeout: 10_000 }).catch(() => {}); break;
        case "fwd": page.goForward({ timeout: 10_000 }).catch(() => {}); break;
        case "reload": page.reload({ timeout: 20_000 }).catch(() => {}); break;
        case "move": await page.mouse.move(e.x, e.y); break;
        case "down": await page.mouse.move(e.x, e.y); await page.mouse.down(); break;
        case "up": await page.mouse.move(e.x, e.y); await page.mouse.up(); break;
        case "scroll": await page.mouse.wheel({ deltaY: Math.max(-2000, Math.min(2000, e.dy)) }); break;
        case "type": await page.keyboard.type(String(e.text).slice(0, 500)); break;
        case "key": if (KEYS.has(e.key)) await page.keyboard.press(e.key === "Space" ? " " : e.key); break;
      }
    } catch {
      // A navigation mid-input can detach the frame; ignore and keep going
    }
  }
}

// Returns a buffer of changed tiles: u16 w, u16 h, u16 count, then per tile
// u16 x, u16 y, u16 tw, u16 th followed by tw*th*4 RGBA bytes.
function diffTiles(s, rgba, full) {
  const { w, h } = s;
  const prev = full ? null : s.prev;
  const parts = [];
  let count = 0;
  for (let ty = 0; ty < h; ty += TILE) {
    for (let tx = 0; tx < w; tx += TILE) {
      const tw = Math.min(TILE, w - tx), th = Math.min(TILE, h - ty);
      let changed = !prev;
      if (!changed) {
        for (let y = ty; y < ty + th && !changed; y++) {
          const o = (y * w + tx) * 4;
          if (rgba.compare(prev, o, o + tw * 4, o, o + tw * 4) !== 0) changed = true;
        }
      }
      if (!changed) continue;
      const head = Buffer.alloc(8);
      head.writeUInt16LE(tx, 0); head.writeUInt16LE(ty, 2);
      head.writeUInt16LE(tw, 4); head.writeUInt16LE(th, 6);
      parts.push(head);
      for (let y = ty; y < ty + th; y++) {
        const o = (y * w + tx) * 4;
        parts.push(rgba.subarray(o, o + tw * 4));
      }
      count++;
    }
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(w, 0); header.writeUInt16LE(h, 2); header.writeUInt16LE(count, 4);
  s.prev = Buffer.from(rgba);
  return { count, data: Buffer.concat([header, ...parts]) };
}

async function tick(s, body) {
  s.lastUsed = Date.now();
  await applyEvents(s, body.events);
  if (body.events?.length) await new Promise((r) => setTimeout(r, 40));
  let png;
  try {
    png = await s.page.screenshot({ type: "png", optimizeForSpeed: true });
  } catch {
    // Page is mid-navigation; report no changes and try again next tick
    return { url: s.page.url(), title: "", tiles: 0, loading: true };
  }
  const img = PNG.sync.read(Buffer.from(png));
  const { count, data } = diffTiles(s, img.data, !!body.full);
  const out = { url: s.page.url(), title: "", tiles: count };
  out.title = await s.page.title().catch(() => "");
  if (count > 0) {
    out.data = zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }).toString("base64");
  }
  return out;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/health") {
      return send(res, 200, { ok: true, sessions: sessions.size });
    }
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readJson(req);
      const w = Math.max(160, Math.min(1024, body.w | 0 || 640));
      const h = Math.max(120, Math.min(1024, body.h | 0 || 360));
      const s = await createSession(w, h);
      return send(res, 200, { id: s.id, w, h });
    }

    const m = url.pathname.match(/^\/session\/([\w-]+)(\/tick)?$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { error: "no session" });
      if (req.method === "DELETE" && !m[2]) {
        await closeSession(s.id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && m[2]) {
        const body = await readJson(req);
        // Serialize ticks per session so screenshots never overlap
        const run = s.busy.then(() => tick(s, body));
        s.busy = run.catch(() => {});
        return send(res, 200, await run);
      }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => console.log(`browser render server on :${PORT}`));
