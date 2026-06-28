// Gateway: serves the SvelteKit dashboard and reverse-proxies the bot's
// in-process /api (HTTP) and WS upgrade to the paxfax container, so the
// browser only needs a single same-origin URL through the reverse proxy.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { handler } from './build/handler.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BOT_HOST = process.env.BOT_HOST || 'paxfax';
const BOT_HTTP_PORT = Number(process.env.BOT_HTTP_PORT) || 7781;
const BOT_WS_PORT = Number(process.env.BOT_WS_PORT) || 7780;

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api/')) {
    return proxyHttp(req, res);
  }
  return handler(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/' || req.url === '/ws') {
    return proxyWs(req, socket, head);
  }
  socket.destroy();
});

function proxyHttp(req, res) {
  const opts = {
    hostname: BOT_HOST,
    port: BOT_HTTP_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${BOT_HOST}:${BOT_HTTP_PORT}` },
  };
  const upstream = http.request(opts, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream: ${err.message}` }));
  });
  req.pipe(upstream);
}

function proxyWs(req, socket, head) {
  const upstream = new WebSocket(`ws://${BOT_HOST}:${BOT_WS_PORT}`);
  // Buffer messages the upstream (bot) emits before the browser socket has
  // finished upgrading, then flush them once handleUpgrade runs. Without this,
  // an eager `hello` sent on connect can land before `pipeWs` wires its
  // `message` handler and be silently dropped — leaving the dashboard blank on
  // refresh until the next live event.
  const early = [];
  let clientWs = null;
  const onEarlyMessage = (d, isBinary) => {
    if (!clientWs) {
      early.push(isBinary ? d : d.toString());
    }
    // Once upgraded, pipeWs owns the upstream->client path; this handler is
    // removed below.
  };
  upstream.on('message', onEarlyMessage);
  upstream.on('open', () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      clientWs = ws;
      for (const m of early) ws.send(m);
      early.length = 0;
      upstream.removeListener('message', onEarlyMessage);
      pipeWs(ws, upstream);
    });
  });
  upstream.on('error', () => {
    socket.destroy();
  });
}

function pipeWs(a, b) {
  a.on('message', (d, isBinary) => b.send(isBinary ? d : d.toString()));
  b.on('message', (d, isBinary) => a.send(isBinary ? d : d.toString()));
  const close = () => { try { a.close(); } catch {} try { b.close(); } catch {} };
  a.on('close', close);
  b.on('close', close);
  a.on('error', close);
  b.on('error', close);
}

server.listen(PORT, HOST, () => {
  console.log(`[gateway] UI on http://${HOST}:${PORT}, proxying /api -> ${BOT_HOST}:${BOT_HTTP_PORT}, WS -> ${BOT_HOST}:${BOT_WS_PORT}`);
});
