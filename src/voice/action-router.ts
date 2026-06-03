import type { Client, VoiceBasedChannel } from 'discord.js';
import { config } from '../config';
import { transcriptStore } from './transcript-store';
import type { SessionContext, AsrMessage } from './types';
import { phraseTriggerRegistry } from './phrase-trigger-registry';

export type { SessionContext } from './types';

function formatStamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export interface JarvisPayload {
  command: string;
  contextBlock: string;
  memberList: string;
  ctx: SessionContext;
  ownerText: string;
  ownerStartMs: number;
}

export type CommandHandler = (payload: JarvisPayload) => Promise<void>;

export type TriggerFirer = (payload: {
  trigger: any;
  occasion: 'time' | 'phrase' | 'skill-autostart';
  matchedUtterance?: string;
  ctx?: SessionContext;
}) => Promise<void>;

class ActionRouter {
  private client: Client | null = null;

  setClient(client: Client): void {
    this.client = client;
  }

  private handler: CommandHandler = async (p) => {
    console.log(`[jarvis] command: "${p.command}"`);
    console.log(`[jarvis] context window (${config.jarvisContextSeconds}s):\n${p.contextBlock || '(empty)'}`);
  };

  setHandler(h: CommandHandler): void {
    this.handler = h;
  }

  private triggerFirer: TriggerFirer = async () => {};

  setTriggerFirer(fn: TriggerFirer): void {
    this.triggerFirer = fn;
  }

  onPartial(_ctx: SessionContext, _msg: AsrMessage): void {
  }

  async onFinal(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
  ): Promise<void> {
    const isOwner = msg.userId === config.ownerId;

    if (isOwner) {
      if (msg.streamId !== undefined && msg.lineId !== undefined) {
        const key = `${msg.streamId}:${msg.lineId}`;
        this.cancelEarlyTimer(key);
        if (this.dispatchedKeys.has(key)) {
          const finalText = msg.textNormalized ?? '';
          const dispatchedText = this.dispatchedTexts.get(key) ?? '';
          if (finalText !== dispatchedText) {
            console.log(`[jarvis] final correction lineId=${msg.lineId}: "${finalText}" (dispatched as "${dispatchedText}")`);
          } else {
            console.log(`[jarvis] final for already-dispatched utterance lineId=${msg.lineId} — skipping`);
          }
          this.dispatchedKeys.delete(key);
          this.dispatchedTexts.delete(key);
        }
      }

      if (!this.dispatchedKeys.has(`${msg.streamId}:${msg.lineId}`)) {
        const trigger = config.triggerPhrase.toLowerCase();
        const normalized = msg.textNormalized.toLowerCase();
        const idx = normalized.indexOf(trigger);
        if (idx >= 0) {
          const after = msg.textNormalized
            .slice(idx + trigger.length)
            .replace(/^[\s,.;:!?-]+/, '')
            .trim();

          const before = msg.textNormalized
            .slice(0, idx)
            .replace(/[\s,.;:!?-]+$/, '')
            .trim();

          const command = after || before;

          if (command) {
            console.log(`[jarvis] dispatching from final streamId=${msg.streamId} lineId=${msg.lineId} command="${command}"`);
            void this.dispatchJarvis(ctx, msg, command).catch((err) =>
              console.error('[jarvis] Handler error:', err),
            );
          } else {
            console.log(`[jarvis] Trigger detected but no command text found. Ignoring.`);
          }
        }
      }
    }

    const matches = phraseTriggerRegistry.match(msg.textNormalized, isOwner);
    const filteredMatches = matches.filter((t) => {
      if (isOwner) {
        const wakeWord = config.triggerPhrase.toLowerCase();
        const hasWakeWordPhrase = t.phrases.some((p) => p.toLowerCase() === wakeWord);
        if (hasWakeWordPhrase) {
          console.log(`[jarvis] Skipping wake-word phrase trigger "${t.label || t.id}" for owner to prevent double-firing`);
          return false;
        }
      }
      return true;
    });

    for (const t of filteredMatches) {
      phraseTriggerRegistry.touch(t.id);
      if (t.oneShot) {
        const { scheduler } = await import('./scheduler');
        void scheduler.cancel(t.id);
        phraseTriggerRegistry.remove(t.id);
      }
      void this.triggerFirer({
        trigger: t,
        occasion: 'phrase',
        matchedUtterance: msg.textNormalized,
        ctx,
      }).catch((err) => console.error('[jarvis] Trigger firer error:', err));
    }
  }

  private async dispatchJarvis(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
    command: string,
  ): Promise<void> {
    const windowMs = config.jarvisContextSeconds * 1000;
    const rows = await transcriptStore.contextWindow(ctx.guildId, ctx.channelId, windowMs);

    const nameMap = new Map<string, string>();
    if (this.client) {
      const guild = this.client.guilds.cache.get(ctx.guildId);
      if (guild) {
        const uniqueUserIds = [...new Set(rows.map((r: any) => r.userId as string))];
        for (const uid of uniqueUserIds) {
          const member = guild.members.cache.get(uid);
          if (member) {
            const display = member.displayName;
            nameMap.set(uid, uid === config.ownerId ? `${display} (Owner)` : display);
          }
        }
      }
    }

    const contextBlock = rows
      .map((r: any) => {
        const name = nameMap.get(r.userId) ?? `<@${r.userId}>`;
        return `[${formatStamp(r.startMs)}] ${name}: ${r.textNormalized}`;
      })
      .join('\n');

    let memberList = '';
    if (this.client) {
      try {
        const guild = this.client.guilds.cache.get(ctx.guildId);
        const channel = guild?.channels.cache.get(ctx.channelId);
        if (channel && 'members' in channel) {
          const voiceChannel = channel as VoiceBasedChannel;
          const names = voiceChannel.members
            .filter((m) => !m.user.bot)
            .map((m) => m.id === config.ownerId ? `${m.displayName} (Owner)` : m.displayName);
          if (names.length > 0) {
            memberList = `Users currently in voice channel: ${names.join(', ')}`;
          }
        }
      } catch (err) {
        console.warn('[jarvis] Failed to build member list:', err);
      }
    }

    const payload: JarvisPayload = {
      command,
      contextBlock,
      memberList,
      ctx,
      ownerText: msg.textNormalized,
      ownerStartMs: msg.startMs ?? 0,
    };

    await this.handler(payload);
  }

  private static readonly PARTIAL_TRACKING_MAX = 1024;

  private partialFirstSeen = new Map<string, {
    firstSeenAt: number;
    latestTail: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private partialKeyOrder: string[] = [];
  private dispatchedKeys = new Set<string>();
  private dispatchedTexts = new Map<string, string>();

  noteEarlyJarvis(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
  ): void {
    if (!config.earlyJarvisPartials) return;
    if (msg.userId !== config.ownerId) return;
    if (msg.streamId === undefined || msg.lineId === undefined) return;

    const key = `${msg.streamId}:${msg.lineId}`;
    if (this.dispatchedKeys.has(key)) return;

    const trigger = config.triggerPhrase.toLowerCase();
    const idx = msg.textNormalized.toLowerCase().indexOf(trigger);
    if (idx < 0) return;

    let tail = msg.textNormalized
      .slice(idx + trigger.length)
      .replace(/^[\s,.;:!?-]+/, '')
      .trim();
    let tailWords = tail.split(/\s+/).filter(Boolean);
    if (tailWords.length < 2) {
      tail = msg.textNormalized
        .slice(0, idx)
        .replace(/[\s,.;:!?-]+$/, '')
        .trim();
      tailWords = tail.split(/\s+/).filter(Boolean);
    }
    if (tailWords.length < 2) return;

    const existing = this.partialFirstSeen.get(key);

    if (existing) {
      existing.latestTail = tail;
      console.log(`[jarvis] early candidate (update) streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}" cutoffIn=${Math.round((config.earlyJarvisCutoffMs - (Date.now() - existing.firstSeenAt)) / 100) / 10}s`);
      return;
    }

    this.partialKeyOrder.push(key);
    while (this.partialKeyOrder.length > ActionRouter.PARTIAL_TRACKING_MAX) {
      const oldest = this.partialKeyOrder.shift()!;
      const entry = this.partialFirstSeen.get(oldest);
      if (entry) {
        clearTimeout(entry.timer);
        this.partialFirstSeen.delete(oldest);
      }
      this.dispatchedKeys.delete(oldest);
      this.dispatchedTexts.delete(oldest);
    }

    const entry = {
      firstSeenAt: Date.now(),
      latestTail: tail,
      timer: null as any as ReturnType<typeof setTimeout>,
    };

    entry.timer = setTimeout(() => {
      const cur = this.partialFirstSeen.get(key);
      if (!cur) return;

      const dispatchTail = cur.latestTail;
      this.dispatchedKeys.add(key);
      this.dispatchedTexts.set(key, dispatchTail);
      this.partialFirstSeen.delete(key);

      console.log(`[jarvis] dispatching from timer streamId=${msg.streamId} lineId=${msg.lineId} tail="${dispatchTail}" cutoffMs=${config.earlyJarvisCutoffMs}`);

      this.dispatchJarvis(ctx, msg, dispatchTail).catch((err) =>
        console.error('[jarvis] Timer dispatch error:', err),
      );
    }, config.earlyJarvisCutoffMs);

    this.partialFirstSeen.set(key, entry);

    console.log(`[jarvis] early candidate (first) streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}" timerStarted=${config.earlyJarvisCutoffMs}ms`);
  }

  private cancelEarlyTimer(key: string): void {
    const entry = this.partialFirstSeen.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.partialFirstSeen.delete(key);
    }
  }
}

export const actionRouter = new ActionRouter();