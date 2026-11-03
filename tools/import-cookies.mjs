// Imports Google/YouTube login cookies (Netscape cookies.txt, e.g. from the "Get cookies.txt
// LOCALLY" extension) into the render server's shared cookie jar, so every in-game browser is
// signed in to that (throwaway) account. Cookie values are never printed.
//
// Usage: node tools/import-cookies.mjs <cookies.txt> [ssh-target] [ssh-port] [ssh-key]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [file, target = "root@eggsmp.gg", port = "65022", key = path.join(os.homedir(), ".ssh", "eggsmp_danil")] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/import-cookies.mjs <cookies.txt> [ssh-target] [ssh-port] [ssh-key]");
  process.exit(1);
}

const KEEP = /(^|\.)(google\.[a-z.]+|youtube\.com)$/;
const cookies = [];
for (let line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  let httpOnly = false;
  if (line.startsWith("#HttpOnly_")) {
    httpOnly = true;
    line = line.slice("#HttpOnly_".length);
  } else if (line.startsWith("#") || !line.trim()) {
    continue;
  }
  const parts = line.split("\t");
  if (parts.length < 7) continue;
  const [domain, , cookiePath, secure, expires, name, ...rest] = parts;
  if (!KEEP.test(domain.replace(/^\./, ""))) continue;
  const c = { name, value: rest.join("\t"), domain, path: cookiePath, secure: secure === "TRUE", httpOnly };
  if (Number(expires) > 0) c.expires = Number(expires);
  cookies.push(c);
}
if (cookies.length === 0) {
  console.error("No Google/YouTube cookies found in that file. Export them while on youtube.com.");
  process.exit(1);
}
const loginNames = ["SID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO", "SAPISID"];
const hasLogin = cookies.some((c) => loginNames.includes(c.name));
console.log(`Found ${cookies.length} Google/YouTube cookies (${hasLogin ? "includes a login" : "NO login cookies - were you signed in?"}).`);

// Merge on the server: imported cookies replace same-name/domain ones, then restart the service
const MERGE = `
const fs = require("fs");
const jarFile = "/opt/roblox-browser/data/shared-cookies.json";
let jar = [];
try { jar = JSON.parse(fs.readFileSync(jarFile, "utf8")); } catch {}
const incoming = JSON.parse(fs.readFileSync(0, "utf8"));
const key = (c) => c.name + "\\u0000" + c.domain;
const byKey = new Map(jar.map((c) => [key(c), c]));
for (const c of incoming) byKey.set(key(c), c);
fs.writeFileSync(jarFile, JSON.stringify([...byKey.values()]), { mode: 0o600 });
console.log("shared jar now holds " + byKey.size + " cookies");
`;
const remote = [
  "systemctl stop roblox-browser",
  `node -e '${MERGE.replace(/'/g, "'\\''")}'`,
  "chown rbxbrowser:rbxbrowser /opt/roblox-browser/data/shared-cookies.json",
  "systemctl start roblox-browser",
  "sleep 2",
  "systemctl is-active roblox-browser",
].join(" && ");

// Stop first so the running service can't overwrite the jar with its in-memory copy
const out = execFileSync("ssh", ["-p", port, "-i", key, "-o", "BatchMode=yes", target, remote], {
  input: JSON.stringify(cookies),
  encoding: "utf8",
});
console.log(out.trim());
console.log("Done. New browser sessions start signed in.");
