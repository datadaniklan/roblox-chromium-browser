// Chromium render server for the Roblox browser game.
// Each Roblox player gets an isolated browser context. Chromium pushes frames via the
// DevTools screencast as soon as the page changes; the Roblox game server long-polls /tick
// and receives only the 32x32 tiles that changed, as RGB565, zstd-compressed and
// base64-encoded (decoded in Roblox with EncodingService). Input goes through /input so
// clicks and keys are applied without waiting for the next frame.
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { HOME_HTML } from "./home.mjs";
import { AUDIO_TAP_JS, TONE_HTML, toneWav } from "./audio-tap.mjs";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";
const LOW_MEMORY = process.env.LOW_MEMORY === "1";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || (LOW_MEMORY ? 2 : 5));
const IDLE_MS = Number(process.env.IDLE_MS || 90_000);
const COOKIE_FILE = process.env.COOKIE_FILE || "";
const TILE = 32;
const HOME = `http://127.0.0.1:${PORT}/home`;
const LONG_POLL_MS = 350;
const AFTER_INPUT_MS = 120;
const AUDIO_BATCH = 3; // ~100 ms of audio frames wakes a waiting /tick
const TONE_WAV = toneWav();

sharp.concurrency(1);
sharp.cache(false);

let browser;
const sessions = new Map();

async function getBrowser() {
  if (browser?.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    // chrome-headless-shell (lighter than full Chromium) needs the "shell" mode
    headless: process.env.HEADLESS === "shell" ? "shell" : true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--mute-audio",
      "--disable-extensions",
      "--disable-background-networking",
      "--lang=en-US",
      "--disable-site-isolation-trials",
      "--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter",
      "--disable-software-rasterizer",
      "--autoplay-policy=user-gesture-required",
      // LOW_MEMORY=1 squeezes Chromium into a 512 MB instance with one shared renderer
      ...(LOW_MEMORY
        ? ["--renderer-process-limit=1", "--js-flags=--max-old-space-size=128"]
        : ["--renderer-process-limit=4", "--js-flags=--max-old-space-size=384"]),
    ],
  });
  browser.on("disconnected", () => sessions.clear());
  return browser;
}

function frameWaiters(s) {
  const waiters = s.waiters;
  s.waiters = [];
  for (const w of waiters) w();
}

function waitForFrame(s, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    s.waiters.push(done);
  });
}

async function createSession(w, h) {
  if (sessions.size >= MAX_SESSIONS) await closeOldest();
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  // Sites block "HeadlessChrome"; present as regular desktop Chrome
  const ua = (await b.userAgent()).replace("HeadlessChrome", "Chrome");
  await page.setUserAgent(ua);
  // The host is in Germany; ask sites for English instead of geo-localized German
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  const id = crypto.randomUUID();
  const s = {
    id, ctx, page, w, h,
    png: null, seq: 0, // latest screencast frame
    cur: null, curSeq: -1, // latest frame decoded to RGB565
    sent: null, sentSeq: -1, // what the Roblox client already has
    waiters: [], lastUsed: Date.now(), busy: Promise.resolve(),
    audio: [], // pending audio frames (band levels + pitches) from the page tap
  };
  await page.exposeFunction("__rbxAudio", (b64) => {
    s.audio.push(Buffer.from(String(b64), "base64"));
    if (s.audio.length > 30) s.audio.shift(); // nobody is polling; keep only the last second
    if (s.audio.length >= AUDIO_BATCH) frameWaiters(s);
  });
  await page.evaluateOnNewDocument(AUDIO_TAP_JS);
  // Popups open in the same tab so the player never loses the view
  page.on("popup", async (p) => {
    const url = p.url();
    await p.close().catch(() => {});
    if (url && url !== "about:blank") page.goto(url).catch(() => {});
  });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  const cdp = await page.createCDPSession();
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    s.png = data;
    s.seq++;
    frameWaiters(s);
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: w, maxHeight: h, everyNthFrame: 1 });
  s.cdp = cdp;

  sessions.set(id, s);
  await restoreSharedCookies(s);
  page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  return s;
}

// Non-identifying cookies (bot-check pass, consent choice) are shared across sessions so a
// solved Google captcha or cookie banner stays solved. Login cookies are never shared.
const SHARED_COOKIES = new Set(["GOOGLE_ABUSE_EXEMPTION", "SOCS", "CONSENT", "NID", "AEC", "PREF", "VISITOR_INFO1_LIVE", "YSC"]);
const SHARED_DOMAINS = /(^|\.)(google\.[a-z.]+|youtube\.com)$/;
let sharedCookies = [];
try {
  if (COOKIE_FILE) sharedCookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
} catch {}

async function browserCdp() {
  const b = await getBrowser();
  if (!b.__cdp) b.__cdp = await b.target().createCDPSession();
  return b.__cdp;
}

async function restoreSharedCookies(s) {
  const now = Date.now() / 1000;
  const cookies = sharedCookies.filter((c) => !c.expires || c.expires < 0 || c.expires > now);
  if (cookies.length === 0) return;
  const cdp = await browserCdp();
  await cdp.send("Storage.setCookies", { cookies, browserContextId: s.ctx.id }).catch(() => {});
}

async function saveSharedCookies(s) {
  if (!COOKIE_FILE) return;
  const cdp = await browserCdp();
  const { cookies } = await cdp.send("Storage.getCookies", { browserContextId: s.ctx.id }).catch(() => ({ cookies: [] }));
  let changed = false;
  for (const c of cookies) {
    if (!SHARED_COOKIES.has(c.name) || !SHARED_DOMAINS.test(c.domain.replace(/^\./, ""))) continue;
    const keep = { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite };
    const i = sharedCookies.findIndex((o) => o.name === c.name && o.domain === c.domain);
    if (i >= 0 && sharedCookies[i].value === c.value) continue;
    if (i >= 0) sharedCookies[i] = keep;
    else sharedCookies.push(keep);
    changed = true;
  }
  if (changed) fs.writeFile(COOKIE_FILE, JSON.stringify(sharedCookies), () => {});
}

setInterval(() => {
  for (const s of sessions.values()) saveSharedCookies(s).catch(() => {});
}, 30_000);

async function closeOldest() {
  let oldest;
  for (const s of sessions.values()) if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s;
  if (oldest) await closeSession(oldest.id);
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  frameWaiters(s);
  await saveSharedCookies(s).catch(() => {});
  await s.ctx.close().catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastUsed > IDLE_MS) closeSession(s.id);
}, 10_000);

function normalizeUrl(raw) {
  const t = String(raw || "").trim();
  if (!t || t.toLowerCase() === "home") return HOME;
  if (t.toLowerCase() === "sound test") return HOME.replace("/home", "/tone");
  if (/^[a-z]+:\/\//i.test(t)) return t;
  if (/^[^\s]+\.[^\s]{2,}$/.test(t)) return "https://" + t;
  // Google captchas every search from datacenter IPs; DuckDuckGo doesn't
  return "https://duckduckgo.com/?kl=us-en&q=" + encodeURIComponent(t);
}

function publicUrl(url) {
  if (url.startsWith(HOME)) return "";
  return url.startsWith(HOME.replace("/home", "/tone")) ? "sound test" : url;
}

const KEYS = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);
const MODIFIERS = new Set(["Control", "Shift", "Alt"]);

async function pressKey(page, key, mods) {
  const valid = KEYS.has(key) || /^[a-z0-9]$/i.test(key);
  if (!valid) return;
  const held = (Array.isArray(mods) ? mods : []).filter((m) => MODIFIERS.has(m));
  for (const m of held) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of held.reverse()) await page.keyboard.up(m);
}

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
        case "down":
          await page.mouse.move(e.x, e.y);
          await page.mouse.down({ button: e.button === "right" ? "right" : "left", clickCount: e.clicks || 1 });
          break;
        case "up":
          await page.mouse.move(e.x, e.y);
          await page.mouse.up({ button: e.button === "right" ? "right" : "left", clickCount: e.clicks || 1 });
          break;
        case "scroll":
          if (e.x != null) await page.mouse.move(e.x, e.y);
          await page.mouse.wheel({ deltaY: Math.max(-3000, Math.min(3000, e.dy)) });
          break;
        case "type": await page.keyboard.type(String(e.text).slice(0, 500)); break;
        case "key": await pressKey(page, String(e.key), e.mods); break;
      }
    } catch {
      // A navigation mid-input can detach the frame; ignore and keep going
    }
  }
}

// RGB565 halves the bytes per pixel versus RGBA and zstd compresses it well
async function decodeFrame(s) {
  if (s.curSeq === s.seq || !s.png) return;
  const seq = s.seq;
  let img = sharp(Buffer.from(s.png, "base64"));
  const meta = await img.metadata();
  if (meta.width !== s.w || meta.height !== s.h) img = img.resize(s.w, s.h, { fit: "fill" });
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = s.w * s.h;
  const out = Buffer.allocUnsafe(px * 2);
  for (let i = 0, o = 0, p = 0; p < px; p++, i += info.channels, o += 2) {
    out.writeUInt16LE(((data[i] >> 3) << 11) | ((data[i + 1] >> 2) << 5) | (data[i + 2] >> 3), o);
  }
  s.cur = out;
  s.curSeq = seq;
}

// Changed tiles: u16 w, u16 h, u16 count, then per tile u16 x, u16 y, u16 tw, u16 th
// followed by tw*th RGB565 pixels (u16 little endian)
function diffTiles(s, full) {
  const { w, h, cur } = s;
  const prev = full ? null : s.sent;
  const parts = [];
  let count = 0;
  for (let ty = 0; ty < h; ty += TILE) {
    for (let tx = 0; tx < w; tx += TILE) {
      const tw = Math.min(TILE, w - tx), th = Math.min(TILE, h - ty);
      let changed = !prev;
      for (let y = ty; y < ty + th && !changed; y++) {
        const o = (y * w + tx) * 2;
        if (cur.compare(prev, o, o + tw * 2, o, o + tw * 2) !== 0) changed = true;
      }
      if (!changed) continue;
      const head = Buffer.allocUnsafe(8);
      head.writeUInt16LE(tx, 0); head.writeUInt16LE(ty, 2);
      head.writeUInt16LE(tw, 4); head.writeUInt16LE(th, 6);
      parts.push(head);
      for (let y = ty; y < ty + th; y++) {
        const o = (y * w + tx) * 2;
        parts.push(cur.subarray(o, o + tw * 2));
      }
      count++;
    }
  }
  const header = Buffer.allocUnsafe(6);
  header.writeUInt16LE(w, 0); header.writeUInt16LE(h, 2); header.writeUInt16LE(count, 4);
  s.sent = cur;
  return { count, data: Buffer.concat([header, ...parts]) };
}

async function tick(s, { full, hadInput }) {
  s.lastUsed = Date.now();
  // Long-poll: answer as soon as Chromium paints something new or audio has queued up
  if (!full && s.seq === s.sentSeq && s.audio.length < AUDIO_BATCH) {
    await waitForFrame(s, hadInput ? AFTER_INPUT_MS : LONG_POLL_MS);
  }
  const out = { url: publicUrl(s.page.url()), title: "", tiles: 0 };
  out.title = await s.page.title().catch(() => "");
  if (s.audio.length > 0) {
    out.audioFrames = s.audio.length;
    out.audio = Buffer.concat(s.audio.splice(0)).toString("base64");
  }
  if (!s.png || (!full && s.seq === s.sentSeq)) return out;
  await decodeFrame(s);
  s.sentSeq = s.curSeq;
  const { count, data } = diffTiles(s, full);
  out.tiles = count;
  if (count > 0) {
    out.data = zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 } }).toString("base64");
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
    if (url.pathname === "/home") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(HOME_HTML);
    }
    if (url.pathname === "/tone") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(TONE_HTML);
    }
    if (url.pathname === "/tone.wav") {
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(TONE_WAV);
    }
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readJson(req);
      const w = Math.max(320, Math.min(1024, body.w | 0 || 1024));
      const h = Math.max(240, Math.min(1024, body.h | 0 || 576));
      const s = await createSession(w, h);
      return send(res, 200, { id: s.id, w, h });
    }

    const m = url.pathname.match(/^\/session\/([\w-]+)(\/tick|\/input)?$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { error: "no session" });
      if (req.method === "DELETE" && !m[2]) {
        await closeSession(s.id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && m[2] === "/input") {
        const body = await readJson(req);
        s.lastUsed = Date.now();
        const run = s.busy.then(() => applyEvents(s, body.events));
        s.busy = run.catch(() => {});
        await run;
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && m[2] === "/tick") {
        const body = await readJson(req);
        // Apply this tick's input in order with /input calls, but don't hold the queue while long-polling
        const run = s.busy.then(() => applyEvents(s, body.events));
        s.busy = run.catch(() => {});
        await run;
        return send(res, 200, await tick(s, { full: !!body.full, hadInput: body.events?.length > 0 }));
      }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => console.log(`browser render server on :${PORT}`));



