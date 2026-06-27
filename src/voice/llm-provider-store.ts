import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { config } from '../config';

export type LlmBackend = 'local' | 'openrouter';

interface LlmState { backend: LlmBackend; openrouterModel: string; localModel?: string; thinking?: boolean; }

class LlmProviderStore {
  private backend: LlmBackend = 'local';
  private openrouterModel = '';
  private localModel = '';
  private thinking = false;

  init(): void {
    this.backend = config.jarvisLlmBackend;
    this.openrouterModel = config.openRouterModel;
    this.localModel = config.llamaCppModel;
    this.thinking = config.llmThinking;
    const saved = this.readState();
    if (saved) {
      if (saved.backend !== this.backend) {
        console.warn(`[llm-provider] persisted backend "${saved.backend}" overrides env JARVIS_LLM_BACKEND="${this.backend}" (state file: ${config.jarvisLlmStatePath})`);
      }
      this.backend = saved.backend;
      if (saved.openrouterModel) this.openrouterModel = saved.openrouterModel;
      if (saved.localModel) this.localModel = saved.localModel;
      if (saved.thinking !== undefined) this.thinking = saved.thinking;
    }
    if (this.backend === 'openrouter' && !config.openRouterApiKey) {
      console.warn('[llm-provider] backend=openrouter but OPENROUTER_API_KEY empty — falling back to local');
      this.backend = 'local';
    }
    console.log(`[llm-provider] backend=${this.backend} model=${this.getModel()}`);
  }

  getBackend(): LlmBackend { return this.backend; }
  getModel(): string { return this.backend === 'openrouter' ? this.openrouterModel : this.localModel; }
  isThinkingEnabled(): boolean { return this.thinking; }
  getStatus(): { backend: LlmBackend; model: string; ready: boolean; thinking: boolean } {
    return {
      backend: this.backend,
      model: this.getModel(),
      ready: this.backend === 'local' || !!config.openRouterApiKey,
      thinking: this.thinking,
    };
  }

  setThinking(enabled: boolean): void {
    this.thinking = enabled;
    this.writeState();
    console.log(`[llm-provider] set thinking=${this.thinking}`);
  }

  setBackend(backend: LlmBackend, model?: string): void {
    if (backend === 'openrouter') {
      if (!config.openRouterApiKey) throw new Error('OPENROUTER_API_KEY is not set — cannot switch to OpenRouter.');
      this.openrouterModel = model?.trim() || this.openrouterModel || config.openRouterModel;
    } else if (backend === 'local') {
      if (model?.trim()) {
        this.localModel = model.trim();
      }
    }
    this.backend = backend;
    this.writeState();
    console.log(`[llm-provider] set backend=${this.backend} model=${this.getModel()}`);
  }

  buildRequest(messages: unknown[], tools: unknown[]): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const base = {
      messages,
      tools,
      temperature: 0.8,
      top_p: 0.95,
      presence_penalty: 0.2,
      frequency_penalty: 0.0,
      max_tokens: config.llmMaxTokens,
    };
    if (this.backend === 'openrouter') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openRouterApiKey}`,
      };
      if (config.openRouterReferer) headers['HTTP-Referer'] = config.openRouterReferer;
      if (config.openRouterTitle) headers['X-Title'] = config.openRouterTitle;

      const provider: Record<string, unknown> = {
        zdr: config.openRouterProviderZdr,
      };
      if (config.openRouterProviderOnly && config.openRouterProviderOnly.length > 0) {
        provider.only = config.openRouterProviderOnly;
      }

      return {
        url: `${config.openRouterBaseUrl}/chat/completions`,
        headers,
        body: { ...base, model: this.openrouterModel, provider },
      };
    }
    return {
      url: `${config.llamaCppUrl}/chat/completions`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        ...base,
        model: this.localModel,
        min_p: 0.05,
        top_k: 64,
        repeat_penalty: 1.0,
        chat_template_kwargs: { enable_thinking: this.thinking },
      },
    };
  }

  /**
   * Streaming variant: same as buildRequest but with `stream: true`.
   * Both backends (llama.cpp, OpenRouter) support OpenAI-compatible SSE.
   * Returned body is the OpenAI chat-completions request with stream enabled.
   */
  buildStreamRequest(messages: unknown[], tools: unknown[]): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const req = this.buildRequest(messages, tools);
    return { url: req.url, headers: req.headers, body: { ...req.body, stream: true } };
  }

  /** Streaming is always available now (both backends support SSE). */
  isStreamingCapable(): boolean { return true; }

  private readState(): LlmState | null {
    try {
      const data = JSON.parse(fs.readFileSync(config.jarvisLlmStatePath, 'utf-8'));
      if (data && (data.backend === 'local' || data.backend === 'openrouter')) {
        return {
          backend: data.backend as LlmBackend,
          openrouterModel: typeof data.openrouterModel === 'string' ? data.openrouterModel : '',
          localModel: typeof data.localModel === 'string' ? data.localModel : undefined,
          thinking: typeof data.thinking === 'boolean' ? data.thinking : undefined,
        };
      }
    } catch {
      // missing or corrupt — ignore
    }
    return null;
  }

  private writeState(): void {
    try {
      const dir = path.dirname(config.jarvisLlmStatePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        config.jarvisLlmStatePath,
        JSON.stringify({
          backend: this.backend,
          openrouterModel: this.openrouterModel,
          localModel: this.localModel,
          thinking: this.thinking,
        }),
      );
    } catch (err) {
      console.error(`[llm-provider] failed to write state: ${(err as Error).message}`);
    }
  }

  async listModels(): Promise<{ id: string; status: string }[] | null> {
    try {
      const baseUrl = config.llamaCppUrl.replace(/\/v1\/?$/, '');
      const response = await axios.get(`${baseUrl}/models`, { timeout: 3000 });
      if (response.data && Array.isArray(response.data.data)) {
        return response.data.data.map((item: any) => ({
          id: String(item.id || ''),
          status: String(item.status?.value || 'unloaded'),
        }));
      }
      return null;
    } catch (err) {
      console.warn(`[llm-provider] failed to list router models: ${(err as Error).message}`);
      return null;
    }
  }
}

export const llmProviderStore = new LlmProviderStore();