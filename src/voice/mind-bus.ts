/**
 * Tiny in-process event bus for the mind-dashboard.
 * Mirrors the `Bus` class in `dashboard/mockups/shared/fake-mind.js`.
 * Fire-and-forget: the jarvis loop must NEVER await emits (concurrency/lock safety).
 */
import type { MindEvent, MindEventType, MindEventPayload } from './mind-types';

type Listener = (e: MindEvent) => void;

class MindBus {
  private subs = new Set<Listener>();

  on(fn: Listener): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  emit<T extends MindEventType>(type: T, payload: MindEventPayload<T>): void {
    const evt: MindEvent<T> = { type, payload, t: Date.now() };
    for (const fn of this.subs) {
      try {
        fn(evt as MindEvent);
      } catch (err) {
        console.error('[mind-bus] subscriber error:', err);
      }
    }
  }
}

export const mindBus = new MindBus();
