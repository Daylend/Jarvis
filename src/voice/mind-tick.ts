/**
 * Periodic 1Hz `state:tick` for the dashboard gauges.
 * Mirrors `FakeMind._tickLoop`: tokPerSec decays (*0.6) toward 0 when idle.
 */
import { mindBus } from './mind-bus';
import { mindState } from './mind-state';

let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  // Decay tok/s toward 0 when idle (no active generation).
  const decayed = Math.max(0, mindState.stats.tokPerSec * 0.6);
  mindState.updateStats({ tokPerSec: Math.round(decayed * 10) / 10 });
  mindBus.emit('state:tick', {
    stats: { ...mindState.stats },
    context: { ...mindState.context },
    session: { ...mindState.session },
  });
}

export function startMindTick(): void {
  if (timer) return;
  timer = setInterval(tick, 1000);
  timer.unref?.();
  console.log('[mind-tick] 1Hz state:tick started');
}

export function stopMindTick(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
