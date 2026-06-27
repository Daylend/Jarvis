import axios from 'axios';
import type { Client, Message, VoiceBasedChannel, GuildTextBasedChannel } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { config } from '../config';
import { toolRegistry } from './jarvis-tools';
import { noteStore } from './note-store';
import { skillStore } from './skill-store';
import { personalityStore } from './personality-store';
import { llmProviderStore } from './llm-provider-store';
import { conversationStore, type StoredChatMessage } from './conversation-store';
import { mindBus } from './mind-bus';
import { mindState } from './mind-state';
import type { HistoryMessage, SystemPromptParts, TransientFields, TurnSource, VoiceLine } from './mind-types';
import type { CommandHandler, JarvisPayload, SessionContext } from './action-router';

const APPROVAL_TIMEOUT_MS = 30_000;

function ownerHistoryKey(): string {
  return `owner:${config.ownerId}`;
}

const ownerLock = new Map<string, Promise<void>>();

export function clearGuildHistory(_guildId: string): void {
  // History is now owner-scoped + persisted; clearing is async via the store.
  void conversationStore.clearHistory(config.ownerId)
    .then(() => emitClearedContext())
    .catch((err) => console.error('[jarvis] Failed to clear persisted history:', err));
}

export function clearAllHistory(): void {
  void conversationStore.clearHistory(config.ownerId)
    .then(() => emitClearedContext())
    .catch((err) => console.error('[jarvis] Failed to clear persisted history:', err));
}

/** After a memory wipe, emit an empty context snapshot so the dashboard reflects it. */
async function emitClearedContext(): Promise<void> {
  try {
    const structuredPrompt = await buildStructuredSystemPrompt('');
    const tokenBudget = config.llmContextLength - config.llmMaxTokens;
    mindState.emitContext(
      structuredPrompt,
      [],
      { time: formatCurrentTime(), members: [], voiceCtx: [], command: '' },
      { used: 0, budget: tokenBudget },
    );
  } catch (err) {
    console.warn('[jarvis] Failed to emit cleared mind context:', err);
  }
}

type ChatMessage = StoredChatMessage;

interface JarvisLoopOpts {
  client: Client;
  historyKey: string;
  command: string;
  contextPreamble: string | null;
  guildId: string;
  channelId: string;
  replyFn: (text: string) => Promise<void>;
  errorFn: (text: string) => Promise<void>;
  suppressEmptyFallback?: boolean;
}

interface TriggerFirePayload {
  trigger: {
    id: number;
    ownerId: string;
    guildId?: string | null;
    channelId?: string | null;
    label?: string | null;
    instruction: string;
    phrases?: string[];
    type: string;
  };
  occasion: 'time' | 'phrase' | 'skill-autostart';
  matchedUtterance?: string;
  ctx?: SessionContext;
}

function estimateTokens(messages: ChatMessage[]): number {
  let totalChars = 0;
  for (const m of messages) {
    if (m.content) totalChars += m.content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        totalChars += tc.function.name.length + tc.function.arguments.length;
      }
    }
    totalChars += 16;
  }
  return Math.ceil(totalChars / 4);
}

function splitChunks(text: string, maxLen = 2000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

interface BuiltPrompt {
  command: string;
  contextPreamble: string | null;
}

function buildUserPrompt(payload: JarvisPayload): BuiltPrompt {
  const command = `Owner's command: ${payload.command}`;

  let contextPreamble: string | null = null;
  const parts: string[] = [];

  if (payload.memberList) {
    parts.push(payload.memberList);
  }

  if (payload.contextBlock) {
    const ctxSec = config.jarvisContextSeconds;
    parts.push(`Voice chat context (last ${ctxSec}s):\n${payload.contextBlock}`);
  }

  if (parts.length > 0) {
    contextPreamble = parts.join('\n\n');
  }

  return { command, contextPreamble };
}

function formatCurrentTime(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.reminderTimezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    timeZoneName: 'short',
  }).format(new Date());
}

function sanitizeLlmContent(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/<\|[^|]*\|>/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Build the structured system-prompt object (notes + skills appended) for the dashboard. */
async function buildStructuredSystemPrompt(guildId: string): Promise<SystemPromptParts> {
  const parts = personalityStore.getActivePromptParts();
  const notes: SystemPromptParts['notes'] = [];
  if (guildId) {
    try {
      const titles = await noteStore.getTitles(guildId);
      if (titles.length > 0) {
        const maxNotes = 50;
        const visible = titles.slice(0, maxNotes);
        for (const n of visible) notes.push({ id: n.id, title: n.title });
      }
    } catch (err) {
      console.warn('[jarvis] Failed to load notes for structured prompt:', err);
    }
  }
  const skills: SystemPromptParts['skills'] = [];
  try {
    const skillRows = await skillStore.summaries(config.ownerId);
    for (const s of skillRows as any[]) {
      skills.push({ name: s.name, desc: s.description, active: !!s.active });
    }
  } catch (err) {
    console.warn('[jarvis] Failed to load skills for structured prompt:', err);
  }
  return { ...parts, notes, skills };
}

/** Convert persisted StoredChatMessage[] to dashboard HistoryMessage[]. */
function toHistoryMessages(msgs: StoredChatMessage[]): HistoryMessage[] {
  return msgs.map((m) => {
    const text = m.content ?? '';
    let name: string | undefined;
    if (m.role === 'tool' && m.tool_call_id) name = 'tool';
    return { role: m.role, text, name };
  });
}

/** Parse the transient user message back into structured TransientFields for the dashboard. */
function parseTransient(userContent: string): TransientFields {
  const timeMatch = userContent.match(/^Current time: (.+)$/m);
  const time = timeMatch ? timeMatch[1] : '';
  const voiceMatch = userContent.match(/\[VOICE CHANNEL\]\n([\s\S]*?)\n\n\[COMMAND\]/);
  const commandMatch = userContent.match(/\[COMMAND\]\n([\s\S]*)$/);

  const voiceCtx: VoiceLine[] = [];
  if (voiceMatch) {
    for (const line of voiceMatch[1].split('\n')) {
      const m = line.match(/^\[(\d{2}:\d{2})\] (.+?): (.+)$/);
      if (m) {
        const owner = m[2].endsWith('(Owner)');
        voiceCtx.push({
          mmss: m[1],
          name: owner ? m[2].replace(' (Owner)', '') : m[2],
          owner,
          text: m[3],
        });
      }
    }
  }
  return {
    time,
    members: [],
    voiceCtx,
    command: commandMatch ? commandMatch[1] : userContent,
  };
}

/** Derive the turn source from the command string (handlers prefix it). */
function detectSource(command: string): TurnSource {
  if (command.startsWith('Owner\'s message (via @mention')) return 'mention';
  if (command.startsWith('Owner\'s message (via DM')) return 'dm';
  if (command.startsWith('[PHRASE TRIGGER') || command.startsWith('[TIME REMINDER') || command.startsWith('[SKILL AUTOSTART')) return 'trigger';
  return 'voice';
}

async function requestApproval(
  client: Client,
  ownerId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  try {
    const user = await client.users.fetch(ownerId);
    const argsPreview = JSON.stringify(args, null, 2).slice(0, 500);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('approve')
        .setLabel('Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('deny')
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await user.send({
      content: `Jarvis wants to use **${toolName}**:\n\`\`\`json\n${argsPreview}\n\`\`\``,
      components: [row as any],
    });

    const interaction = await msg
      .awaitMessageComponent({
        filter: (i) => i.user.id === ownerId,
        componentType: ComponentType.Button,
        time: APPROVAL_TIMEOUT_MS,
      })
      .catch(() => null);

    await msg.delete().catch(() => {});

    if (!interaction) {
      console.log(`[jarvis] Approval for ${toolName} timed out`);
      return false;
    }

    const approved = interaction.customId === 'approve';
    await interaction.deferUpdate().catch(() => {});
    console.log(`[jarvis] Owner ${approved ? 'approved' : 'denied'} tool ${toolName}`);
    return approved;
  } catch (err) {
    console.error(`[jarvis] Approval flow error for ${toolName}:`, err);
    return false;
  }
}

async function runJarvisLoop(opts: JarvisLoopOpts): Promise<void> {
  const { client, historyKey, command, contextPreamble, guildId, channelId, replyFn, errorFn, suppressEmptyFallback } = opts;

  const prev = ownerLock.get(historyKey) ?? Promise.resolve();
  let releaseLock: () => void;
  const current = new Promise<void>((resolve) => { releaseLock = resolve; });
  ownerLock.set(historyKey, current);
  await prev;

  try {
    const t0 = performance.now();
    let history: ChatMessage[] = [];
    try {
      history = await conversationStore.loadHistory(config.ownerId);
    } catch (err) {
      console.error('[jarvis] Failed to load persisted history (continuing empty):', err);
    }

    const structuredPrompt = await buildStructuredSystemPrompt(guildId);

    let systemPrompt = personalityStore.getActivePrompt();
    if (guildId) {
      try {
        const titles = await noteStore.getTitles(guildId);
        if (titles.length > 0) {
          const maxNotes = 50;
          const visible = titles.slice(0, maxNotes);
          const overflow = titles.length - visible.length;
          const lines = visible.map((n) => `#${n.id} ${n.title}`);
          let block = `\n\nYOUR NOTES (use search_notes with the id to read full content):\n${lines.join('\n')}`;
          if (overflow > 0) {
            block += `\n(... and ${overflow} more — use search_notes to find older ones)`;
          }
          systemPrompt += block;
        }
      } catch (err) {
        console.warn('[jarvis] Failed to load notes for context injection:', err);
      }
    }

    try {
      const skillRows = await skillStore.summaries(config.ownerId);
      if (skillRows.length > 0) {
        const lines = skillRows.map((s: any) => `- ${s.name} — ${s.description}${s.active ? ' [active]' : ''}`);
        systemPrompt += `\n\nYOUR SKILLS (activate by name with start_skill):\n${lines.join('\n')}`;
      }
    } catch (err) {
      console.warn('[jarvis] Failed to load skills for context injection:', err);
    }

    const tokenBudget = config.llmContextLength - config.llmMaxTokens;
    const estimateCurrentSize = (): number => {
      const preview: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history,
      ];
      if (contextPreamble) {
        preview.push({ role: 'user', content: `[Voice Channel Context]\n${contextPreamble}` });
      }
      preview.push({ role: 'user', content: command });
      return estimateTokens(preview);
    };
    while (history.length > 0 && estimateCurrentSize() > tokenBudget) {
      history.shift();
      const used = estimateCurrentSize();
      console.log(`[jarvis] Trimmed oldest history message to fit context budget (est. ${used} tokens, budget ${tokenBudget})`);
      mindBus.emit('llm:trim', { used, budget: tokenBudget });
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    const nowLine = `Current time: ${formatCurrentTime()} (${config.reminderTimezone})`;

    let userContent: string;
    if (contextPreamble) {
      userContent = `${nowLine}\n\n[VOICE CHANNEL]\n${contextPreamble}\n\n[COMMAND]\n${command}`;
    } else {
      userContent = `${nowLine}\n\n[COMMAND]\n${command}`;
    }

    const historyStart = messages.length;
    messages.push({ role: 'user', content: userContent });

    // ── mind-bus: emit context snapshot + capture an inference slice ──
    const turnSource = detectSource(command);
    const usedTokens = estimateCurrentSize();
    const transient = parseTransient(userContent);
    mindState.beginTurn();
    mindState.updateContext({ used: usedTokens, budget: tokenBudget });
    mindState.emitContext(
      structuredPrompt,
      toHistoryMessages(history),
      transient,
      { used: usedTokens, budget: tokenBudget },
      { captureSlice: true, command },
    );

    console.log(`[jarvis] Dispatching to LLM (key=${historyKey} backend=${llmProviderStore.getBackend()} model=${llmProviderStore.getModel()}) — prompt: "${command.slice(0, 120)}..."`);

    mindBus.emit('llm:dispatch', {
      key: historyKey,
      prompt: command.slice(0, 200),
      source: turnSource,
      backend: llmProviderStore.getBackend(),
      model: llmProviderStore.getModel(),
    });
    // Mark the dashboard session active for this turn (status pill).
    mindState.setSession(true, guildId, channelId);

    let finalText: string | null = null;
    let toolDelivered = false;
    let iterCount = 0;

    for (let iter = 0; iter < config.llmMaxToolLoop; iter++) {
      iterCount = iter + 1;
      console.log(`[jarvis] LLM call iteration ${iterCount}/${config.llmMaxToolLoop}`);
      mindState.updateStats({ iter: iterCount });
      mindBus.emit('llm:iter', { key: historyKey, iter: iterCount, max: config.llmMaxToolLoop });

      try {
        const { url, headers, body } = llmProviderStore.buildRequest(messages, toolRegistry.getAllDefinitions());
        const response = await axios.post(url, body, { headers, timeout: config.jarvisLlmTimeoutMs });

        console.log(
          `[jarvis] LLM HTTP ${response.status}, choices: ${response.data.choices?.length ?? 'none'}, raw: ${JSON.stringify(response.data).slice(0, 500)}`,
        );

        const choice = response.data.choices?.[0];
        if (!choice) {
          console.error('[jarvis] LLM response had no choices');
          break;
        }

        const assistantMsg = choice.message as ChatMessage;
        const sanitizedContent = sanitizeLlmContent(assistantMsg.content);
        console.log(`[jarvis] Raw LLM message:`, JSON.stringify({ role: assistantMsg.role, content_preview: assistantMsg.content?.slice(0, 300), sanitized_preview: sanitizedContent?.slice(0, 300), tool_calls: assistantMsg.tool_calls, finish_reason: choice.finish_reason }));

        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          messages.push(assistantMsg);

          for (const tc of assistantMsg.tool_calls) {
            const toolName = tc.function.name;
            console.log(`[jarvis] LLM requested tool "${toolName}"`);

            const tool = toolRegistry.get(toolName);
            if (!tool) {
              mindBus.emit('llm:tool_request', { key: historyKey, name: toolName, args: {}, requiresApproval: false });
              mindBus.emit('llm:tool_result', { key: historyKey, name: toolName, result: `Tool "${toolName}" not found`, ok: false });
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `Tool "${toolName}" not found`,
              });
              continue;
            }

            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              mindBus.emit('llm:tool_request', { key: historyKey, name: toolName, args: {}, requiresApproval: false });
              mindBus.emit('llm:tool_result', { key: historyKey, name: toolName, result: 'Failed to parse tool arguments', ok: false });
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: 'Failed to parse tool arguments',
              });
              continue;
            }

            const requiresApproval = !!tool.requiresApproval;
            mindBus.emit('llm:tool_request', { key: historyKey, name: toolName, args, requiresApproval });
            mindState.patchSlice({ hadTool: true, tool: { name: toolName, args, requiresApproval, result: null } });

            if (requiresApproval) {
              const approved = await requestApproval(
                client,
                config.ownerId,
                toolName,
                args,
              );
              if (!approved) {
                mindBus.emit('llm:tool_result', { key: historyKey, name: toolName, result: 'Tool call denied by user', ok: false });
                mindState.patchSlice({ tool: { name: toolName, args, requiresApproval, result: 'denied by user' } });
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: 'Tool call denied by user',
                });
                continue;
              }
            }

            try {
              const result = await tool.execute(args, {
                client,
                ownerId: config.ownerId,
                guildId,
                channelId,
                clearHistory: () => {
                  history.length = 0;
                  void conversationStore.clearHistory(config.ownerId).catch((err) =>
                    console.error('[jarvis] Failed to clear persisted history:', err),
                  );
                },
              });
              if (toolName === 'send_dm' || toolName === 'speak_tts') toolDelivered = true;
              mindBus.emit('llm:tool_result', { key: historyKey, name: toolName, result: result.slice(0, 2000), ok: true });
              mindState.patchSlice({ tool: { name: toolName, args, requiresApproval, result: result.slice(0, 2000) } });
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result,
              });
            } catch (err) {
              const errorMsg = (err as Error).message;
              console.error(`[jarvis] Tool "${toolName}" execution error:`, errorMsg);
              mindBus.emit('llm:tool_result', { key: historyKey, name: toolName, result: `Tool error: ${errorMsg}`, ok: false });
              mindState.patchSlice({ tool: { name: toolName, args, requiresApproval, result: `Tool error: ${errorMsg}` } });
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `Tool error: ${errorMsg}`,
              });
            }
          }

          if (toolDelivered) {
            console.log(`[jarvis] Tool delivered — stopping loop`);
            break;
          }
          continue;
        }

        if (sanitizedContent) {
          messages.push(assistantMsg);
          finalText = sanitizedContent;
          // Non-streaming (Phase 1): no token deltas. Emit a single ttft ≈ total
          // generation time and the whole reply as one final. Phase 2 replaces
          // this with real streaming llm:token/llm:ttft/llm:think deltas.
          break;
        }

        if (choice.finish_reason === 'length') {
          console.warn('[jarvis] LLM hit token limit — no output produced (try increasing max_tokens)');
        }
        console.warn('[jarvis] LLM returned neither content nor tool calls, keys:', Object.keys(assistantMsg), 'finish_reason:', choice.finish_reason);
        break;
      } catch (err) {
        const errorMsg = (err as Error).message;
        console.error('[jarvis] LLM call failed:', errorMsg);
        if (!toolDelivered) {
          await errorFn('Jarvis: could not reach LLM').catch(() => {});
        } else {
          console.log(`[jarvis] LLM call failed but tool already delivered — suppressing error`);
        }
        break;
      }
    }

    const newMessages = messages.slice(historyStart);
    const updatedHistory = [...history, ...newMessages].slice(-config.llmMaxHistory);
    try {
      await conversationStore.appendMessages(config.ownerId, newMessages);
      history = updatedHistory;
    } catch (err) {
      console.error('[jarvis] Failed to persist new history messages:', err);
    }

    const elapsed = Math.round(performance.now() - t0);
    mindState.updateStats({ lastElapsed: elapsed, iter: iterCount });

    if (finalText && !toolDelivered) {
      console.log(`[jarvis] Response in ${elapsed}ms: "${finalText.slice(0, 120)}${finalText.length > 120 ? '...' : ''}"`);
      const tokensOut = Math.max(1, Math.round(finalText.length / 4));
      const tokensIn = Math.max(1, Math.round(usedTokens));
      const tokPerSec = elapsed > 0 ? Math.round((tokensOut / elapsed) * 1000) : 0;
      mindState.updateStats({ tokPerSec, ttft: elapsed });
      // Non-streaming (Phase 1): emit the whole reply as a single token delta so
      // the generating tail renders, then finalize. Phase 2 replaces this with a
      // real streamed token sequence.
      mindBus.emit('llm:ttft', { key: historyKey, ms: elapsed });
      mindBus.emit('llm:token', { key: historyKey, text: finalText });
      mindBus.emit('llm:final', { key: historyKey, text: finalText, tokensIn, tokensOut, tokPerSec, elapsedMs: elapsed });
      mindState.patchSlice({ reply: finalText, status: 'done', stats: { ...mindState.stats } });
      try {
        const chunks = splitChunks(finalText);
        for (const chunk of chunks) {
          await replyFn(chunk);
        }
        console.log(`[jarvis] Reply sent (${chunks.length} chunk(s))`);
      } catch (err) {
        console.error(`[jarvis] Failed to send reply: ${(err as Error).message}`);
      }
    } else if (toolDelivered) {
      console.log(`[jarvis] Tool already delivered response (${elapsed}ms)`);
      mindState.patchSlice({ reply: null, status: 'done', stats: { ...mindState.stats } });
    } else {
      console.warn(`[jarvis] No final response after ${iterCount} iterations (${elapsed}ms)`);
      mindState.patchSlice({ reply: null, status: 'done', stats: { ...mindState.stats } });

      if (!suppressEmptyFallback && messages.length > 0) {
        const lastContent = messages
          .filter((m) => m.role === 'assistant' && m.content)
          .pop()?.content;

        if (lastContent) {
          try {
            for (const chunk of splitChunks(lastContent)) {
              await replyFn(chunk);
            }
          } catch {} // eslint-disable-line no-empty
        }
      } else if (suppressEmptyFallback) {
        console.log('[jarvis] Empty fallback suppressed (trigger silence)');
      }
    }

    // ── mind-bus: re-emit context reflecting the now-persisted history ──
    mindState.setSession(false, guildId, channelId);
    try {
      const refreshedHistory = await conversationStore.loadHistory(config.ownerId);
      mindState.emitContext(
        structuredPrompt,
        toHistoryMessages(refreshedHistory),
        transient,
        { used: estimateCurrentSize(), budget: tokenBudget },
      );
    } catch (err) {
      console.warn('[jarvis] Failed to re-emit mind context post-turn:', err);
    }
  } finally {
    releaseLock!();
    // Release the ack hold for this guild (no-op if no ack session / not in voice).
    if (guildId) {
      try {
        const { ttsClient } = await import('./tts-client');
        ttsClient.endAck(guildId);
        mindBus.emit('ack:state', { guild: guildId, active: false });
      } catch (err) {
        console.warn('[jarvis] Failed to release ack:', (err as Error).message);
      }
    }
  }
}

export function createJarvisHandler(client: Client): CommandHandler {
  return async (payload) => {
    const replyFn = async (text: string) => {
      const owner = await client.users.fetch(config.ownerId);
      await owner.send(text);
    };

    const { command, contextPreamble } = buildUserPrompt(payload);

    await runJarvisLoop({
      client,
      historyKey: ownerHistoryKey(),
      command,
      contextPreamble,
      guildId: payload.ctx.guildId,
      channelId: payload.ctx.channelId,
      replyFn,
      errorFn: replyFn,
    });
  };
}

export function createTriggerFirer(client: Client): (payload: TriggerFirePayload) => Promise<void> {
  return async ({ trigger, occasion, matchedUtterance, ctx }) => {
    // Lazy-import to break circular dependency
    const { sessionManager } = await import('./session-manager');

    let guildId = '';
    let channelId = '';
    let inVoice = false;
    let channelName = '';

    if (trigger.guildId) {
      const session = sessionManager.get(trigger.guildId);
      if (session) {
        guildId = session.guildId;
        channelId = session.channelId;
        inVoice = true;
        try {
          const guild = client.guilds.cache.get(guildId);
          const channel = guild?.channels.cache.get(channelId);
          channelName = channel?.name ?? '';
        } catch {}
      }
    }

    if (!inVoice) {
      for (const [gId] of client.guilds.cache) {
        const session = sessionManager.get(gId);
        if (session) {
          guildId = session.guildId;
          channelId = session.channelId;
          inVoice = true;
          try {
            const guild = client.guilds.cache.get(guildId);
            const channel = guild?.channels.cache.get(channelId);
            channelName = channel?.name ?? '';
          } catch {}
          break;
        }
      }
    }

    if (!inVoice) {
      guildId = '';
      channelId = '';
    }

    const historyKey = ownerHistoryKey();

    const voiceLine = inVoice
      ? `You are currently in voice channel "${channelName}".`
      : `You are NOT currently in any voice channel.`;

    let command: string;
    if (occasion === 'phrase') {
      const labelLine = trigger.label ? ` — label "${trigger.label}"` : '';
      command = `[PHRASE TRIGGER fired${labelLine}]\nHeard: "${matchedUtterance ?? ''}"\n${voiceLine}\nOriginal instruction: "${trigger.instruction}"\n\nDecide if this genuinely indicates the event described. If not, take no action and stay silent.`;
    } else if (occasion === 'time') {
      const labelLine = trigger.label ? ` — label "${trigger.label}"` : '';
      command = `[TIME REMINDER fired${labelLine}]\n${voiceLine}\nInstruction: "${trigger.instruction}"`;
    } else {
      command = `[SKILL AUTOSTART]\n${voiceLine}\nInstruction: "${trigger.instruction}"`;
    }

    const replyFn = async (text: string) => {
      const owner = await client.users.fetch(config.ownerId);
      await owner.send(text);
    };

    await runJarvisLoop({
      client,
      historyKey,
      command,
      contextPreamble: null,
      guildId,
      channelId,
      replyFn,
      errorFn: replyFn,
      suppressEmptyFallback: occasion === 'phrase',
    });
  };
}

function buildContextPreamble(memberList: string, contextBlock: string): string | null {
  const ctxParts: string[] = [];
  if (memberList) ctxParts.push(memberList);
  if (contextBlock) {
    const ctxSec = config.jarvisContextSeconds;
    ctxParts.push(`Voice chat context (last ${ctxSec}s):\n${contextBlock}`);
  }
  return ctxParts.length > 0 ? ctxParts.join('\n\n') : null;
}

interface VoiceContext {
  guildId: string;
  channelId: string;
  memberList: string;
  contextBlock: string;
}

async function gatherVoiceContext(client: Client): Promise<VoiceContext> {
  const { sessionManager } = await import('./session-manager');
  const { transcriptStore } = await import('./transcript-store');

  let guildId = '';
  let channelId = '';
  let contextBlock = '';
  let memberList = '';

  for (const [gId] of client.guilds.cache) {
    const ctx = sessionManager.get(gId);
    if (ctx) {
      guildId = ctx.guildId;
      channelId = ctx.channelId;

      try {
        const windowMs = config.jarvisContextSeconds * 1000;
        const rows = await transcriptStore.contextWindow(guildId, channelId, windowMs);

        const guild = client.guilds.cache.get(guildId);

        if (rows.length > 0) {
          const nameMap = new Map<string, string>();
          if (guild) {
            const uniqueUserIds = [...new Set(rows.map((r: any) => r.userId as string))];
            for (const uid of uniqueUserIds) {
              const member = guild.members.cache.get(uid);
              if (member) {
                nameMap.set(uid, uid === config.ownerId ? `${member.displayName} (Owner)` : member.displayName);
              }
            }
          }

          const formatStamp = (ms: number) => {
            const totalSec = Math.floor(ms / 1000);
            const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
            const s = (totalSec % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
          };

          contextBlock = rows
            .map((r: any) => {
              const name = nameMap.get(r.userId) ?? `<@${r.userId}>`;
              return `[${formatStamp(r.startMs)}] ${name}: ${r.textNormalized}`;
            })
            .join('\n');
        }

        const channel = guild?.channels.cache.get(channelId);
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
        console.warn('[jarvis] Failed to pull voice context:', err);
      }

      break;
    }
  }

  return { guildId, channelId, memberList, contextBlock };
}

export async function handleDmJarvis(client: Client, message: Message): Promise<void> {
  const command = message.content.trim();
  if (!command) return;

  const channel = message.channel as any;
  await channel.sendTyping().catch(() => {});

  const { guildId, channelId, memberList, contextBlock } = await gatherVoiceContext(client);
  const contextPreamble = buildContextPreamble(memberList, contextBlock);
  const dmCommand = `Owner's message (via DM): ${command}`;

  const replyFn = async (text: string) => {
    await channel.send(text);
  };

  await runJarvisLoop({
    client,
    historyKey: ownerHistoryKey(),
    command: dmCommand,
    contextPreamble,
    guildId,
    channelId,
    replyFn,
    errorFn: replyFn,
  });
}

export async function handleMentionJarvis(client: Client, message: Message): Promise<void> {
  if (!config.jarvisMentionEnabled) return;
  if (message.author.id !== config.ownerId) return;

  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) return;

  const channel = message.channel as GuildTextBasedChannel;
  await channel.sendTyping().catch(() => {});

  const { guildId, channelId, memberList, contextBlock } = await gatherVoiceContext(client);
  const contextPreamble = buildContextPreamble(memberList, contextBlock);

  let where: string;
  try {
    const guild = message.guild;
    const guildName = guild?.name ?? 'unknown server';
    where = `Owner's message (via @mention in #${channel.name}, guild "${guildName}"): ${content}`;
  } catch {
    where = `Owner's message (via @mention): ${content}`;
  }

  const replyFn = async (text: string) => {
    await message.reply(text);
  };

  await runJarvisLoop({
    client,
    historyKey: ownerHistoryKey(),
    command: where,
    contextPreamble,
    guildId,
    channelId,
    replyFn,
    errorFn: replyFn,
  });
}