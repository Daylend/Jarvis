/**
 * In-process WebSocket server pushing mind-bus events to dashboard clients.
 * No app-level auth — protected by the reverse proxy (NPM) / internal network.
 * Boooted from src/index.ts when config.dashboardEnabled.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import { mindBus } from '../voice/mind-bus';
import { mindState } from '../voice/mind-state';
import type { MindEvent } from '../voice/mind-types';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

function send(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(event: MindEvent): void {
  for (const ws of clients) send(ws, event);
}

function handleClientMessage(ws: WebSocket, raw: string): void {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === 'mind:hello') {
      // Client-driven rehydrate: reply with the current mind state so a
      // refresh/reconnect repopulates immediately. Replaces the eager hello
      // that was sent on connect (which could race the gateway proxy and be
      // dropped before the browser socket was upgraded).
      send(ws, { type: 'hello', payload: mindState.rehydrate(), t: Date.now() });
      return;
    }
    if (msg.type === 'mind:select' && msg.payload && typeof msg.payload.id !== 'undefined') {
      mindState.selectSlice(msg.payload.id === null ? null : Number(msg.payload.id));
    }
  } catch (err) {
    console.warn('[dashboard-ws] bad client message:', (err as Error).message);
  }
}

export function startWsServer(): void {
  if (wss) return;
  wss = new WebSocketServer({ port: config.dashboardWsPort, host: '0.0.0.0' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    // Rehydrate is now client-driven: the browser sends `mind:hello` on open,
    // and we reply in handleClientMessage. This avoids the race where an eager
    // hello here could be dropped by the gateway proxy before the browser
    // socket finished upgrading.
    ws.on('message', (data) => handleClientMessage(ws, data.toString()));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // Forward every mind-bus event to all connected clients.
  mindBus.on((event) => broadcast(event));

  console.log(`[dashboard-ws] listening on ws://0.0.0.0:${config.dashboardWsPort}`);
}

export function stopWsServer(): void {
  if (wss) {
    wss.close();
    wss = null;
    clients.clear();
  }
}
