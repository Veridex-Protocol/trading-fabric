/**
 * @packageDocumentation
 * @module memory/reflector
 * @description Reflection LLM call. Given a final decision and the
 * realised raw + alpha returns, produces a 2-4 sentence post-mortem
 * that is written into the memory log alongside the resolved entry.
 *
 * Routing: per the Phase 6 spec the reflector targets the *deep*
 * thinking model. Like every other LLM call in trading-fabric this
 * goes through `AgentRuntime` so policy gates, audit log, and trace
 * events are honoured uniformly.
 */

import { createAgent } from '@veridex/agents';
import type { AgentDefinition, RuntimeOptions } from '@veridex/agents';

import type { TradingFabricConfig } from '../config/index.js';

const REFLECTOR_INSTRUCTIONS = `You are a senior portfolio reviewer. Given a prior trading decision and its realised outcome (raw return + benchmark-adjusted alpha), write a 2-4 sentence post-mortem in plain prose.

Cover, in order:
  (1) Was the directional call correct? Cite the alpha vs the benchmark.
  (2) Which part of the original thesis held, and which part failed?
  (3) One concrete lesson for future decisions on this instrument or asset class.

Do not restate the original decision verbatim. Do not use bullet points or headings prose only. Keep it terse and falsifiable.`;

/**
 * Build the reflector `AgentDefinition`. The reflector targets the
 * **deep** thinking model, so the provider name follows the Phase 5
 * convention `<llm_provider>:deep`.
 */
export function buildReflectorDefinition(config: TradingFabricConfig): AgentDefinition {
  return {
    id: 'trading-fabric:reflector',
    name: 'TradingReflector',
    instructions: REFLECTOR_INSTRUCTIONS,
    model: {
      provider: `${config.llm_provider}:deep`,
      model: config.deep_think_llm,
    },
  };
}

export interface ReflectionInput {
  decision: string;
  raw_return: number;
  alpha_return: number;
  benchmark: string;
  ticker: string;
  trade_date: string;
  holding_days: number;
}

export interface ReflectorOptions {
  /** Trading-fabric config — used to build the deep `ModelConfig`. */
  config: TradingFabricConfig;
  /** RuntimeOptions providing the `<llm_provider>:deep` provider. */
  runtimeOptions: RuntimeOptions;
  /** Override the definition (mostly for tests). */
  definition?: AgentDefinition;
}

function fmtPct(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(2)}%`;
}

/** Build the user message handed to the reflector LLM. */
export function reflectorUserMessage(input: ReflectionInput): string {
  return [
    `Ticker: ${input.ticker}`,
    `Decision date: ${input.trade_date}`,
    `Holding window: ${input.holding_days} trading days`,
    `Benchmark: ${input.benchmark}`,
    `Raw return: ${fmtPct(input.raw_return)}`,
    `Alpha vs ${input.benchmark}: ${fmtPct(input.alpha_return)}`,
    '',
    'Original decision:',
    input.decision,
    '',
    'Write the post-mortem now.',
  ].join('\n');
}

export class Reflector {
  private readonly runtimeOptions: RuntimeOptions;
  private readonly definition: AgentDefinition;

  constructor(opts: ReflectorOptions) {
    this.runtimeOptions = opts.runtimeOptions;
    this.definition = opts.definition ?? buildReflectorDefinition(opts.config);
  }

  async reflect(input: ReflectionInput): Promise<string> {
    const runtime = createAgent(this.definition, this.runtimeOptions);
    const result = await runtime.run(reflectorUserMessage(input));
    return result.output.trim();
  }
}
