/**
 * @packageDocumentation
 * @module llm
 * @description Provider factory for `@veridex/agents` `ModelProvider`
 * instances, keyed off `TradingFabricConfig.llm_provider`. Trading-fabric
 * supports more providers than the agents core ships natively (OpenRouter,
 * Azure, MiniMax, plus mainland-China `_cn` variants for GLM / Qwen /
 * MiniMax) — those are built on top of `OpenAICompatibleProvider`.
 *
 * The factory is **pure**: it takes an `env` map so tests can inject
 * scoped credentials without touching `process.env`.
 */

import {
  AnthropicProvider,
  DeepSeekProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  QwenProvider,
  XAIProvider,
  ZhipuProvider,
  type ModelRegistry,
} from '@veridex/agents';
import type { ModelProvider } from '@veridex/agents';

import type { LLMProviderKey, TradingFabricConfig } from '../config';

export interface CreateProviderOptions {
  config: TradingFabricConfig;
  /** Model name (defaults to `quick_think_llm`). */
  model?: string;
  /** Environment for API-key lookup. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Construct a `ModelProvider` for the given provider key. Throws if a
 * required API key is missing — callers can catch and degrade.
 */
export function createProvider(
  providerKey: LLMProviderKey,
  opts: CreateProviderOptions,
): ModelProvider {
  const { config } = opts;
  const env = opts.env ?? process.env;
  const model = opts.model ?? config.quick_think_llm;
  const backendUrl = config.backend_url ?? undefined;

  switch (providerKey) {
    case 'openai':
      return new OpenAIProvider({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: backendUrl,
        model,
      });
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model,
      });
    case 'google':
      return new GeminiProvider({
        apiKey: env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY,
        model,
      });
    case 'xai':
      return new XAIProvider({
        apiKey: env.XAI_API_KEY,
        model,
      });
    case 'deepseek':
      return new DeepSeekProvider({
        apiKey: env.DEEPSEEK_API_KEY,
        model,
      });
    case 'qwen':
      return new QwenProvider({
        apiKey: env.DASHSCOPE_API_KEY ?? env.QWEN_API_KEY,
        baseUrl: backendUrl ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        model,
      });
    case 'qwen_cn':
      return new QwenProvider({
        apiKey: env.DASHSCOPE_API_KEY ?? env.QWEN_API_KEY,
        baseUrl: backendUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model,
      });
    case 'glm':
    case 'glm_cn':
      // ZhipuProvider points at open.bigmodel.cn which serves both regions.
      return new ZhipuProvider({
        apiKey: env.ZHIPUAI_API_KEY ?? env.GLM_API_KEY,
        model,
      });
    case 'minimax':
      return new OpenAICompatibleProvider({
        name: 'minimax',
        apiKey: requireKey(env.MINIMAX_API_KEY, 'MINIMAX_API_KEY'),
        baseUrl: backendUrl ?? 'https://api.minimaxi.chat/v1',
        model,
      });
    case 'minimax_cn':
      return new OpenAICompatibleProvider({
        name: 'minimax_cn',
        apiKey: requireKey(env.MINIMAX_API_KEY, 'MINIMAX_API_KEY'),
        baseUrl: backendUrl ?? 'https://api.minimax.chat/v1',
        model,
      });
    case 'openrouter':
      return new OpenAICompatibleProvider({
        name: 'openrouter',
        apiKey: requireKey(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY'),
        baseUrl: backendUrl ?? 'https://openrouter.ai/api/v1',
        model,
        extraHeaders: {
          'HTTP-Referer': env.OPENROUTER_REFERRER ?? 'https://veridex.io',
          'X-Title': env.OPENROUTER_APP_NAME ?? 'trading-fabric',
        },
      });
    case 'ollama':
      return new OllamaProvider({
        baseUrl: backendUrl ?? env.OLLAMA_HOST ?? 'http://localhost:11434/v1',
        model,
      });
    case 'azure': {
      const endpoint = requireKey(env.AZURE_OPENAI_ENDPOINT, 'AZURE_OPENAI_ENDPOINT');
      const deployment = env.AZURE_OPENAI_DEPLOYMENT ?? model;
      const apiVersion = env.AZURE_OPENAI_API_VERSION ?? '2024-08-01-preview';
      const baseUrl = `${endpoint.replace(/\/+$/, '')}/openai/deployments/${deployment}`;
      return new OpenAICompatibleProvider({
        name: 'azure',
        apiKey: requireKey(env.AZURE_OPENAI_API_KEY, 'AZURE_OPENAI_API_KEY'),
        baseUrl,
        model: deployment,
        extraHeaders: { 'api-version': apiVersion },
      });
    }
    default: {
      const _exhaustive: never = providerKey;
      throw new Error(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}

function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export interface RegisterOptions {
  registry: ModelRegistry;
  config: TradingFabricConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Register the configured provider(s) on a runtime's `ModelRegistry`. Both
 * `quick_think_llm` and `deep_think_llm` are wired so callers can switch
 * between them via `ReasoningDepth`.
 *
 * Registered under the names:
 * - `<llm_provider>` (uses `quick_think_llm`)
 * - `<llm_provider>:deep` (uses `deep_think_llm`)
 */
export function registerConfiguredProviders(opts: RegisterOptions): {
  quickName: string;
  deepName: string;
} {
  const { registry, config, env } = opts;
  const quick = createProvider(config.llm_provider, {
    config,
    model: config.quick_think_llm,
    env,
  });
  const deep = createProvider(config.llm_provider, {
    config,
    model: config.deep_think_llm,
    env,
  });

  // Override name on the deep variant so it doesn't collide with quick.
  const deepName = `${config.llm_provider}:deep`;
  const renamedDeep: ModelProvider = new Proxy(deep, {
    get(target, prop, receiver) {
      if (prop === 'name') return deepName;
      return Reflect.get(target, prop, receiver);
    },
  });

  registry.register(quick);
  registry.register(renamedDeep);
  return { quickName: config.llm_provider, deepName };
}
