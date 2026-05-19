import axios from 'axios';
import type { Client, Message, VoiceBasedChannel } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { config } from '../config';
import { toolRegistry } from './jarvis-tools';
import type { CommandHandler, JarvisPayload } from './action-router';

const APPROVAL_TIMEOUT_MS = 30_000;
const guildHistory = new Map<string, ChatMessage[]>();
const guildLock = new Map<string, Promise<void>>();

/** Clear conversation history for a guild (call on session teardown). */
export function clearGuildHistory(guildId: string): void {
  guildHistory.delete(guildId);
  guildLock.delete(guildId);
}

/** Clear ALL Jarvis conversation history (all guilds + DMs). */
export function clearAllHistory(): void {
  guildHistory.clear();
  guildLock.clear();
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface JarvisLoopOpts {
  client: Client;
  historyKey: string;
  command: string;
  contextPreamble: string | null;
  guildId: string;
  channelId: string;
  replyFn: (text: string) => Promise<void>;
  errorFn: (text: string) => Promise<void>;
}

/**
 * Rough token estimate: ~4 chars per token for English text.
 * Conservative enough to prevent context overflow without needing
 * a real tokenizer. Tool call arguments count toward the estimate.
 */
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

function sanitizeLlmContent(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/<\|[^|]*\|>/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
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
  const { client, historyKey, command, contextPreamble, guildId, channelId, replyFn, errorFn } = opts;

  const prev = guildLock.get(historyKey) ?? Promise.resolve();
  let releaseLock: () => void;
  const current = new Promise<void>((resolve) => { releaseLock = resolve; });
  guildLock.set(historyKey, current);
  await prev;

  try {
    const t0 = performance.now();
    const history = guildHistory.get(historyKey) ?? [];

    const tokenBudget = config.llmContextLength - config.llmMaxTokens;
    const estimateCurrentSize = (): number => {
      const preview: ChatMessage[] = [
        { role: 'system', content: config.jarvisSystemPrompt },
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
      console.log(`[jarvis] Trimmed oldest history message to fit context budget (est. ${estimateCurrentSize()} tokens, budget ${tokenBudget})`);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: config.jarvisSystemPrompt },
      ...history,
    ];

    if (contextPreamble) {
      messages.push({ role: 'user', content: `[Voice Channel Context]\n${contextPreamble}` });
    }

    const historyStart = messages.length;
    messages.push({ role: 'user', content: command });

    console.log(`[jarvis] Dispatching to LLM (key=${historyKey}) — prompt: "${command.slice(0, 120)}..."`);

    let finalText: string | null = null;
    let toolDelivered = false;
    let iterCount = 0;

    for (let iter = 0; iter < config.llmMaxToolLoop; iter++) {
      iterCount = iter + 1;
      console.log(`[jarvis] LLM call iteration ${iterCount}/${config.llmMaxToolLoop}`);

      try {
        const response = await axios.post(
          `${config.llamaCppUrl}/chat/completions`,
          {
            model: 'local',
            messages,
            tools: toolRegistry.getAllDefinitions(),
            temperature: 0.5,
            top_p: 0.90,
            min_p: 0.0,
            top_k: 20,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repeat_penalty: 1.0,
            max_tokens: config.llmMaxTokens,
            chat_template_kwargs: {
              enable_thinking: false,
            },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30_000,
          },
        );

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
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: 'Failed to parse tool arguments',
              });
              continue;
            }

            if (tool.requiresApproval) {
              const approved = await requestApproval(
                client,
                config.ownerId,
                toolName,
                args,
              );
              if (!approved) {
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
                  guildHistory.delete(historyKey);
                  guildLock.delete(historyKey);
                },
              });
              if (toolName === 'send_dm' || toolName === 'speak_tts') toolDelivered = true;
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result,
              });
            } catch (err) {
              const errorMsg = (err as Error).message;
              console.error(`[jarvis] Tool "${toolName}" execution error:`, errorMsg);
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
    guildHistory.set(historyKey, updatedHistory);

    const elapsed = Math.round(performance.now() - t0);

    if (finalText && !toolDelivered) {
      console.log(`[jarvis] Response in ${elapsed}ms: "${finalText.slice(0, 120)}${finalText.length > 120 ? '...' : ''}"`);
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
    } else {
      console.warn(`[jarvis] No final response after ${iterCount} iterations (${elapsed}ms)`);

      if (messages.length > 0) {
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
      }
    }
  } finally {
    releaseLock!();
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
      historyKey: payload.ctx.guildId,
      command,
      contextPreamble,
      guildId: payload.ctx.guildId,
      channelId: payload.ctx.channelId,
      replyFn,
      errorFn: replyFn,
    });
  };
}

/**
 * Handle a DM from the owner through the Jarvis pipeline.
 * Uses the same LLM loop, tools, and system prompt as voice commands.
 * If the owner has an active voice session, includes recent voice context.
 */
export async function handleDmJarvis(client: Client, message: Message): Promise<void> {
  const historyKey = `dm:${config.ownerId}`;
  const command = message.content.trim();

  if (!command) return;

  const channel = message.channel as any;
  await channel.sendTyping().catch(() => {});

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
        console.warn('[dm-jarvis] Failed to pull voice context:', err);
      }

      break;
    }
  }

  const dmCommand = `Owner's message (via DM): ${command}`;

  let contextPreamble: string | null = null;
  const ctxParts: string[] = [];
  if (memberList) {
    ctxParts.push(memberList);
  }
  if (contextBlock) {
    const ctxSec = config.jarvisContextSeconds;
    ctxParts.push(`Voice chat context (last ${ctxSec}s):\n${contextBlock}`);
  }
  if (ctxParts.length > 0) {
    contextPreamble = ctxParts.join('\n\n');
  }

  const replyFn = async (text: string) => {
    await channel.send(text);
  };

  await runJarvisLoop({
    client,
    historyKey,
    command: dmCommand,
    contextPreamble,
    guildId,
    channelId,
    replyFn,
    errorFn: replyFn,
  });
}
