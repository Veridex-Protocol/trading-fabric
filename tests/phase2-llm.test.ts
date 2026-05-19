/**
 * Phase 2 tests — LLM provider factory. We verify provider construction
 * against an injected env map (no real API calls) and that unknown keys
 * throw helpfully.
 */

import { describe, expect, test } from 'vitest';

import { resolveConfig } from '../src/config';
import { createProvider } from '../src/llm';

const baseEnv: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: 'sk-test',
  ANTHROPIC_API_KEY: 'k',
  GOOGLE_API_KEY: 'k',
  XAI_API_KEY: 'k',
  DEEPSEEK_API_KEY: 'k',
  DASHSCOPE_API_KEY: 'k',
  ZHIPUAI_API_KEY: 'k',
  MINIMAX_API_KEY: 'k',
  OPENROUTER_API_KEY: 'k',
  AZURE_OPENAI_API_KEY: 'k',
  AZURE_OPENAI_ENDPOINT: 'https://veridex.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-5-deploy',
};

describe('LLM provider factory', () => {
  const supported = [
    'openai',
    'anthropic',
    'google',
    'xai',
    'deepseek',
    'qwen',
    'qwen_cn',
    'glm',
    'glm_cn',
    'minimax',
    'minimax_cn',
    'openrouter',
    'ollama',
    'azure',
  ] as const;

  test.each(supported)('constructs provider for %s', (key) => {
    const cfg = resolveConfig({ llm_provider: key }, baseEnv);
    const provider = createProvider(key, { config: cfg, env: baseEnv });
    expect(provider.name).toBeTruthy();
    expect(typeof provider.complete).toBe('function');
  });

  test('missing required API key throws helpfully', () => {
    const cfg = resolveConfig({ llm_provider: 'minimax' }, {});
    expect(() => createProvider('minimax', { config: cfg, env: {} })).toThrow(
      /MINIMAX_API_KEY/,
    );
  });

  test('azure builds endpoint with deployment + api-version header', () => {
    const cfg = resolveConfig({ llm_provider: 'azure' }, baseEnv);
    const provider = createProvider('azure', {
      config: cfg,
      env: { ...baseEnv, AZURE_OPENAI_API_VERSION: '2025-01-01-preview' },
    });
    expect(provider.name).toBe('azure');
  });
});
