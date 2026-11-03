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

const tiles = SHORTCUTS.map(
  ([name, url, domain]) => `
    <a class="tile" href="${url}">
      <span class="icon"><img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" alt=""></span>
      <span class="name">${name}</span>
    </a>`
).join("");

export const HOME_HTML = `<!doctype html>
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
</style>
</head>
<body>
<div class="clouds"></div>
<main>
  <form action="https://www.google.com/search" method="get">
    <input type="hidden" name="hl" value="en">
    <label class="search">
      <img src="https://www.google.com/s2/favicons?domain=google.com&sz=64" alt="">
      <input name="q" placeholder="Search the web" autocomplete="off" autofocus>
    </label>
  </form>
  <nav class="tiles">${tiles}</nav>
</main>
</body>
</html>`;
