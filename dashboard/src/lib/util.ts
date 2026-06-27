// Canvas ring gauge drawer — ported from glass.js drawRing.
export function drawRing(
  canvas: HTMLCanvasElement | null,
  pct: number,
  color: string,
  size = 72,
): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const s = size;
  canvas.width = s * dpr;
  canvas.height = s * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, s, s);
  const lw = 5;
  const r = (s - lw) / 2;
  const cx = s / 2;
  const cy = s / 2;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(120,160,220,.12)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, pct));
  ctx.stroke();
}

export function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
