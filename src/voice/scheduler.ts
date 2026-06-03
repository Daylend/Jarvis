import { triggerStore } from './trigger-store';

const MAX_DELAY = 2_147_483_000;

interface TimeTrigger {
  id: number;
  ownerId: string;
  guildId?: string | null;
  channelId?: string | null;
  skillId?: number | null;
  type: string;
  label?: string | null;
  instruction: string;
  fireAt: Date;
  repeatSeconds?: number | null;
  status: string;
}

class Scheduler {
  private timers = new Map<number, NodeJS.Timeout>();
  private fireHandler: ((trigger: TimeTrigger) => Promise<void>) | null = null;

  setFireHandler(fn: (trigger: TimeTrigger) => Promise<void>): void {
    this.fireHandler = fn;
  }

  schedule(row: TimeTrigger): void {
    this.cancelTimer(row.id);

    const fireMs = new Date(row.fireAt).getTime();
    const delay = fireMs - Date.now();

    if (delay <= 0) {
      void this.fire(row.id);
      return;
    }

    const ms = Math.min(delay, MAX_DELAY);
    const isPartial = ms < delay;

    this.timers.set(row.id, setTimeout(() => {
      this.timers.delete(row.id);
      if (isPartial) {
        this.rescheduleFromDb(row.id);
      } else {
        void this.fire(row.id);
      }
    }, ms));
  }

  async fire(id: number): Promise<void> {
    const row = await triggerStore.getById(id);
    if (!row || row.status !== 'active') return;

    try {
      await this.fireHandler?.(row);
    } catch (err) {
      console.error('[scheduler] Fire handler error:', (err as Error).message);
    }

    if (row.repeatSeconds) {
      let next = new Date(row.fireAt).getTime();
      const step = row.repeatSeconds * 1000;
      const now = Date.now();
      while (next <= now) next += step;
      await triggerStore.reschedule(id, new Date(next));
      const updated = await triggerStore.getById(id);
      if (updated) this.schedule(updated);
    } else {
      await triggerStore.markFired(id, new Date());
    }
  }

  cancel(id: number): void {
    this.cancelTimer(id);
    void triggerStore.cancel(id);
  }

  cancelTimer(id: number): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private async rescheduleFromDb(id: number): Promise<void> {
    const row = await triggerStore.getById(id);
    if (row && row.status === 'active') {
      this.schedule(row);
    }
  }

  async init(): Promise<void> {
    const rows = await triggerStore.loadAllActive();
    for (const r of rows) {
      this.schedule(r);
    }
    console.log(`[scheduler] Loaded ${rows.length} active time triggers`);
  }
}

export const scheduler = new Scheduler();