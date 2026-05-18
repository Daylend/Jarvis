import axios from 'axios';
import type { Client } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { config } from '../config';
import { toolRegistry } from './jarvis-tools';
import type { CommandHandler, JarvisPayload } from './action-router';

const MAX_TOOL_LOOP = 5;
const APPROVAL_TIMEOUT_MS = 30_000;

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

function splitChunks(text: string, maxLen = 2000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function buildUserPrompt(payload: JarvisPayload): string {
  let prompt = `Owner's command: ${payload.command}`;

  if (payload.contextBlock) {
    const ctxSec = config.jarvisContextSeconds;
    prompt =
      `Voice chat context (last ${ctxSec}s):\n` +
      `${payload.contextBlock}\n\n` +
      prompt;
  }

  return prompt;
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

export function createJarvisHandler(client: Client): CommandHandler {
  return async (payload) => {
    const t0 = performance.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: config.jarvisSystemPrompt },
      { role: 'user', content: buildUserPrompt(payload) },
    ];

    console.log(`[jarvis] Dispatching to LLM — command: "${payload.command}"`);

    let finalText: string | null = null;
    let toolDelivered = false;
    let iterCount = 0;

    for (let iter = 0; iter < MAX_TOOL_LOOP; iter++) {
      iterCount = iter + 1;
      console.log(`[jarvis] LLM call iteration ${iterCount}/${MAX_TOOL_LOOP}`);

      try {
        const response = await axios.post(
          `${config.llamaCppUrl}/chat/completions`,
          {
            model: 'local',
            messages,
            tools: toolRegistry.getAllDefinitions(),
            temperature: 0.7,
            max_tokens: 2048,
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

        const assistantMsg = choice.message as ChatMessage & { reasoning_content?: string };
        const sanitizedContent = sanitizeLlmContent(assistantMsg.content);
        console.log(`[jarvis] Raw LLM message:`, JSON.stringify({ role: assistantMsg.role, content_preview: assistantMsg.content?.slice(0, 300), sanitized_preview: sanitizedContent?.slice(0, 300), tool_calls: assistantMsg.tool_calls, finish_reason: choice.finish_reason, reasoning_preview: assistantMsg.reasoning_content?.slice(0, 200) }));

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
                guildId: payload.ctx.guildId,
                channelId: payload.ctx.channelId,
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

          continue;
        }

        if (sanitizedContent) {
          messages.push(assistantMsg);
          finalText = sanitizedContent;
          break;
        }

        if (choice.finish_reason === 'length') {
          console.warn('[jarvis] LLM hit token limit during reasoning — no output produced (try increasing max_tokens). reasoning_content:', (assistantMsg as any).reasoning_content?.slice(0, 200));
        }
        console.warn('[jarvis] LLM returned neither content nor tool calls, keys:', Object.keys(assistantMsg), 'finish_reason:', choice.finish_reason);
        break;
      } catch (err) {
        const errorMsg = (err as Error).message;
        console.error('[jarvis] LLM call failed:', errorMsg);
        try {
          const owner = await client.users.fetch(config.ownerId);
          await owner.send('Jarvis: could not reach LLM');
        } catch {} // eslint-disable-line no-empty
        return;
      }
    }

    const elapsed = Math.round(performance.now() - t0);

    if (finalText && !toolDelivered) {
      console.log(`[jarvis] Response in ${elapsed}ms: "${finalText.slice(0, 120)}${finalText.length > 120 ? '...' : ''}"`);

      try {
        const owner = await client.users.fetch(config.ownerId);
        const chunks = splitChunks(finalText);
        for (const chunk of chunks) {
          await owner.send(chunk);
        }
        console.log(`[jarvis] DM sent to owner (${chunks.length} chunk(s))`);
      } catch (err) {
        console.error(`[jarvis] Failed to DM owner: ${(err as Error).message}`);
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
            const owner = await client.users.fetch(config.ownerId);
            for (const chunk of splitChunks(lastContent)) {
              await owner.send(chunk);
            }
          } catch {} // eslint-disable-line no-empty
        }
      }
    }
  };
}
