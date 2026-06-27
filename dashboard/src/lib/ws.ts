// WebSocket client: connects to the bot's in-process mind-bus WS server and
// dispatches events into the Svelte store. Reconnects with backoff.
import { env } from '$env/dynamic/public';
import { applyEvent } from './mindStore';

const WS_URL = env.PUBLIC_DASHBOARD_WS_URL || `ws://${window.location.hostname}:7780`;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let wantOpen = false;

export function sendSelectSlice(id: number | null): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'mind:select', payload: { id } }));
  }
}

function connect(): void {
  if (!wantOpen) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn('[ws] connect failed', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    console.log('[ws] connected to', WS_URL);
  };

  ws.onmessage = (ev) => {
    try {
      const evt = JSON.parse(ev.data);
      applyEvent(evt);
    } catch (err) {
      console.warn('[ws] bad message', err);
    }
  };

  ws.onclose = () => {
    console.log('[ws] closed; reconnecting in', reconnectDelay, 'ms');
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws?.close(); } catch { /* ignore */ }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    connect();
  }, reconnectDelay);
}

export function startWs(): void {
  wantOpen = true;
  connect();
}

export function stopWs(): void {
  wantOpen = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
}
