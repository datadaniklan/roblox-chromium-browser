// New-tab page shown when the browser opens or Home is pressed.
const SHORTCUTS = [
  ["Google", "https://www.google.com", "google.com"],
  ["YouTube", "https://www.youtube.com", "youtube.com"],
  ["Roblox", "https://www.roblox.com", "roblox.com"],
  ["Creator Hub", "https://create.roblox.com", "create.roblox.com"],
  ["Wikipedia", "https://www.wikipedia.org", "wikipedia.org"],
  ["GitHub", "https://github.com", "github.com"],
  ["Reddit", "https://www.reddit.com", "reddit.com"],
  ["Zoom", "https://zoom.us/join", "zoom.us"],
];

const favicon = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

// Search engines the home page can switch between; the server uses the same table for
// address-bar searches. Google captchas datacenter IPs, so DuckDuckGo is the default.
export const ENGINES = {
  google: { action: "https://www.google.com/search", param: ["hl", "en"], icon: favicon("google.com") },
  duckduckgo: { action: "https://duckduckgo.com/", param: ["kl", "us-en"], icon: favicon("duckduckgo.com") },
};

export function searchUrl(engine, query) {
  const e = ENGINES[engine] || ENGINES.duckduckgo;
  return `${e.action}?${e.param[0]}=${e.param[1]}&q=${encodeURIComponent(query)}`;
}

const tiles = SHORTCUTS.map(
  ([name, url, domain]) => `
    <a class="tile" href="${url}">
      <span class="icon"><img src="${favicon(domain)}" alt=""></span>
      <span class="name">${name}</span>
    </a>`
).join("");

export const homeHtml = (engine) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>New Tab</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif;
    color: #e8eaed;
    overflow: hidden;
    background:
      radial-gradient(ellipse 40% 30% at 78% 70%, rgba(190, 170, 255, .45), transparent 70%),
      radial-gradient(ellipse 60% 40% at 20% 25%, rgba(80, 90, 200, .55), transparent 70%),
      radial-gradient(ellipse 70% 50% at 60% 15%, rgba(60, 70, 160, .6), transparent 75%),
      radial-gradient(ellipse 80% 60% at 30% 85%, rgba(30, 30, 80, .9), transparent 80%),
      linear-gradient(160deg, #1b1f5c 0%, #2a2f7a 35%, #22265e 60%, #0d0f2b 100%);
  }
  .clouds {
    position: fixed; inset: 0; pointer-events: none; opacity: .35;
    background:
      radial-gradient(circle at 15% 60%, rgba(255,255,255,.18) 0 8%, transparent 18%),
      radial-gradient(circle at 45% 35%, rgba(255,255,255,.14) 0 10%, transparent 22%),
      radial-gradient(circle at 85% 40%, rgba(255,255,255,.12) 0 9%, transparent 20%),
      radial-gradient(circle at 65% 80%, rgba(255,255,255,.10) 0 12%, transparent 26%);
    filter: blur(18px);
  }
  main {
    position: relative; height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 34px; padding: 0 24px; margin-top: -6vh;
  }
  form { width: min(620px, 100%); }
  .search {
    display: flex; align-items: center; gap: 12px;
    height: 46px; padding: 0 18px;
    background: rgba(32, 33, 36, .92); border-radius: 23px;
    box-shadow: 0 4px 18px rgba(0,0,0,.35);
  }
  .search img { width: 20px; height: 20px; }
  .search input {
    flex: 1; border: 0; outline: 0; background: transparent;
    color: #e8eaed; font-size: 16px;
  }
  .search input::placeholder { color: #9aa0a6; }
  .tiles { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 760px; }
  .tile {
    width: 82px; display: flex; flex-direction: column; align-items: center; gap: 8px;
    text-decoration: none; color: #e8eaed; font-size: 12px; padding: 8px 0; border-radius: 10px;
  }
  .tile:hover { background: rgba(255,255,255,.08); }
  .icon {
    width: 48px; height: 48px; border-radius: 12px; background: rgba(32, 33, 36, .92);
    display: grid; place-items: center;
  }
  .icon img { width: 28px; height: 28px; }
  .name { max-width: 78px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 3px rgba(0,0,0,.6); }
  .engines { display: flex; justify-content: center; gap: 10px; margin-top: 14px; }
  .engine {
    display: flex; align-items: center; gap: 8px; padding: 7px 16px 7px 10px;
    border: 1px solid rgba(255,255,255,.18); border-radius: 18px; background: rgba(32, 33, 36, .7);
    color: #e8eaed; font: inherit; font-size: 13px; cursor: pointer;
  }
  .engine img { width: 18px; height: 18px; }
  .engine.on { background: #e8eaed; color: #202124; border-color: #e8eaed; }
</style>
</head>
<body>
<div class="clouds"></div>
<main>
  <form id="search">
    <input type="hidden" id="extra">
    <label class="search">
      <img id="engineIcon" alt="">
      <input name="q" placeholder="Search the web" autocomplete="off" autofocus>
    </label>
    <div class="engines">
      <button type="button" class="engine" data-engine="google"><img src="${favicon("google.com")}" alt="">Google</button>
      <button type="button" class="engine" data-engine="duckduckgo"><img src="${favicon("duckduckgo.com")}" alt="">DuckDuckGo</button>
    </div>
  </form>
  <nav class="tiles">${tiles}</nav>
</main>
<script>
  const ENGINES = ${JSON.stringify(ENGINES)};
  const form = document.getElementById("search");
  function setEngine(name) {
    const e = ENGINES[name] || ENGINES.duckduckgo;
    form.action = e.action;
    const extra = document.getElementById("extra");
    extra.name = e.param[0];
    extra.value = e.param[1];
    document.getElementById("engineIcon").src = e.icon;
    for (const b of document.querySelectorAll(".engine")) b.classList.toggle("on", b.dataset.engine === name);
    // Tell the render server so address-bar searches use the same engine
    if (window.__rbxSetEngine) window.__rbxSetEngine(name);
    try { localStorage.setItem("engine", name); } catch (err) {}
  }
  for (const b of document.querySelectorAll(".engine")) b.onclick = () => setEngine(b.dataset.engine);
  let saved = ${JSON.stringify(engine)};
  try { saved = localStorage.getItem("engine") || saved; } catch (err) {}
  setEngine(saved);
</script>
</body>
</html>`;
