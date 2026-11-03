// Minimal SOCKS5 server that Chromium uses as its only proxy. chrome-headless-shell ignores PAC
// files, so per-host routing happens here instead: hosts matching `routed` go through the
// upstream SOCKS5 proxy (a reverse SSH tunnel to a home connection), with a direct connection as
// fallback when the tunnel is down; everything else connects directly.
import net from "node:net";

// Reads exact byte counts from a socket during the handshake. One data listener owns the socket
// until detach(), so bytes that arrive together with the handshake are never dropped.
function reader(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  const check = () => {
    if (!waiting || buf.length < waiting.n) return;
    const out = buf.subarray(0, waiting.n);
    buf = buf.subarray(waiting.n);
    const w = waiting;
    waiting = null;
    w.resolve(out);
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    check();
  };
  const onEnd = () => waiting?.reject(new Error("closed"));
  socket.on("data", onData);
  socket.on("close", onEnd);
  socket.on("error", onEnd);
  return {
    read: (n) =>
      new Promise((resolve, reject) => {
        waiting = { n, resolve, reject };
        check();
      }),
    // Stop reading and hand back anything that arrived past the handshake
    detach: () => {
      socket.off("data", onData);
      socket.off("close", onEnd);
      socket.off("error", onEnd);
      socket.pause();
      return buf;
    },
  };
}

async function readConnectRequest(socket, r) {
  const [ver, nMethods] = await r.read(2);
  if (ver !== 5) throw new Error("not socks5");
  await r.read(nMethods);
  socket.write(Buffer.from([5, 0])); // no auth
  const [, cmd, , atyp] = await r.read(4);
  if (cmd !== 1) throw new Error("only CONNECT");
  let host;
  if (atyp === 1) host = [...(await r.read(4))].join(".");
  else if (atyp === 3) host = (await r.read((await r.read(1))[0])).toString();
  else if (atyp === 4) host = (await r.read(16)).toString("hex").match(/.{4}/g).join(":");
  else throw new Error("bad address type");
  const port = (await r.read(2)).readUInt16BE(0);
  return { host, port };
}

function connectDirect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, family: 4 });
    s.setTimeout(15_000, () => s.destroy(new Error("timeout")));
    s.once("connect", () => {
      s.setTimeout(0);
      resolve({ socket: s, extra: Buffer.alloc(0) });
    });
    s.once("error", reject);
  });
}

async function connectViaUpstream(upstream, host, port) {
  const [uHost, uPort] = upstream.split(":");
  const { socket: s } = await connectDirect(uHost, Number(uPort));
  const r = reader(s);
  try {
    s.write(Buffer.from([5, 1, 0]));
    const [, method] = await r.read(2);
    if (method !== 0) throw new Error("upstream wants auth");
    const name = Buffer.from(host);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    const head = await r.read(4);
    if (head[1] !== 0) throw new Error(`upstream refused (${head[1]})`);
    const addrLen = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await r.read(1))[0];
    await r.read(addrLen + 2);
    return { socket: s, extra: r.detach() };
  } catch (err) {
    s.destroy();
    throw err;
  }
}

export function startSocksRouter({ port, upstream, routed }) {
  const matches = (host) => routed.some((d) => host === d || host.endsWith("." + d));
  const server = net.createServer(async (client) => {
    client.on("error", () => {});
    const r = reader(client);
    let remote;
    try {
      const { host, port: targetPort } = await readConnectRequest(client, r);
      remote = upstream && matches(host)
        ? await connectViaUpstream(upstream, host, targetPort).catch(() => connectDirect(host, targetPort))
        : await connectDirect(host, targetPort);
    } catch {
      if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const { socket, extra } = remote;
    const early = r.detach();
    socket.on("error", () => client.destroy());
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    if (extra.length) client.write(extra);
    if (early.length) socket.write(early);
    client.pipe(socket);
    socket.pipe(client);
    client.resume();
    socket.resume();
    client.on("close", () => socket.destroy());
    socket.on("close", () => client.destroy());
  });
  server.listen(port, "127.0.0.1");
  return server;
}
