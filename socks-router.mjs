// Minimal SOCKS5 server that Chromium uses as its only proxy. chrome-headless-shell ignores PAC
// files, so per-host routing happens here instead: hosts matching `routed` go through the
// upstream SOCKS5 proxy (a reverse SSH tunnel to a home connection), with a direct connection as
// fallback when the tunnel is down; everything else connects directly.
import net from "node:net";

function readExactly(socket, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < n) return;
      socket.off("data", onData);
      socket.off("error", reject);
      socket.off("close", onClose);
      // Anything past what we asked for belongs to the next read
      if (buf.length > n) socket.unshift(buf.subarray(n));
      resolve(buf.subarray(0, n));
    };
    const onClose = () => reject(new Error("closed"));
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", onClose);
  });
}

async function readConnectRequest(socket) {
  const [ver, nMethods] = await readExactly(socket, 2);
  if (ver !== 5) throw new Error("not socks5");
  await readExactly(socket, nMethods);
  socket.write(Buffer.from([5, 0])); // no auth
  const [, cmd, , atyp] = await readExactly(socket, 4);
  if (cmd !== 1) throw new Error("only CONNECT");
  let host;
  if (atyp === 1) host = [...(await readExactly(socket, 4))].join(".");
  else if (atyp === 3) host = (await readExactly(socket, (await readExactly(socket, 1))[0])).toString();
  else if (atyp === 4) host = (await readExactly(socket, 16)).toString("hex").match(/.{4}/g).join(":");
  else throw new Error("bad address type");
  const port = (await readExactly(socket, 2)).readUInt16BE(0);
  return { host, port };
}

function connectDirect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, family: 4 });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function connectViaUpstream(upstream, host, port) {
  const [uHost, uPort] = upstream.split(":");
  const s = await connectDirect(uHost, Number(uPort));
  try {
    s.write(Buffer.from([5, 1, 0]));
    const [, method] = await readExactly(s, 2);
    if (method !== 0) throw new Error("upstream wants auth");
    const name = Buffer.from(host);
    const req = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]);
    s.write(req);
    const head = await readExactly(s, 4);
    if (head[1] !== 0) throw new Error(`upstream refused (${head[1]})`);
    const addrLen = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readExactly(s, 1))[0];
    await readExactly(s, addrLen + 2);
    return s;
  } catch (err) {
    s.destroy();
    throw err;
  }
}

export function startSocksRouter({ port, upstream, routed }) {
  const matches = (host) => routed.some((d) => host === d || host.endsWith("." + d));
  const server = net.createServer(async (client) => {
    client.on("error", () => {});
    let remote;
    try {
      const { host, port: targetPort } = await readConnectRequest(client);
      if (upstream && matches(host)) {
        remote = await connectViaUpstream(upstream, host, targetPort).catch(() => connectDirect(host, targetPort));
      } else {
        remote = await connectDirect(host, targetPort);
      }
    } catch {
      if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
    }
    remote.on("error", () => client.destroy());
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    client.pipe(remote);
    remote.pipe(client);
    client.on("close", () => remote.destroy());
    remote.on("close", () => client.destroy());
  });
  server.listen(port, "127.0.0.1");
  return server;
}
