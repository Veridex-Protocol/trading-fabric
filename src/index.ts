/**
 * @veridex/trading-fabric — public entry.
 *
 * Phase 0 surface: configuration, schemas, types, and a stub
 * `createTradingFabric` factory that downstream phases will fill in with
 * agents, tools, orchestration, memory, policy, approvals, and execution.
 */

import {
  DEFAULT_CONFIG,
  resolveConfig,
  type TradingFabricConfig,
} from './config/index.js';
import type { TradingFabricRunResult } from './types/index.js';

export const VERSION = '0.1.0';

export * from './types/index.js';
export * from './config/index.js';
export * as schemas from './schemas/index.js';
export * as orchestration from './orchestration/index.js';
export * as memory from './memory/index.js';
export * as policy from './policy/index.js';
export * as execution from './execution/index.js';

export interface CreateTradingFabricOptions {
  config?: Partial<TradingFabricConfig>;
  env?: NodeJS.ProcessEnv;
}

export interface TradingFabricRunInput {
  ticker: string;
  trade_date?: string;
  asset_type?: 'stock' | 'crypto';
  analysts?: Array<'market' | 'social' | 'news' | 'fundamentals'>;
}

export interface TradingFabric {
  readonly config: TradingFabricConfig;
  /**
   * Execute the full analyst → debate → trader → risk → portfolio-manager
   * pipeline. Implemented incrementally across Phases 1–8; Phase 0 returns
   * a placeholder result so the build + smoke test can pass.
   */
  run(input: TradingFabricRunInput): Promise<TradingFabricRunResult>;
}

/**
 * Construct a TradingFabric instance with merged configuration.
 *
 * Phase 0 returns a stub `run()` that throws unless `analysts` is empty
 * (smoke-test path). Real wiring lands in Phase 5 (Orchestration graph).
 */
export function createTradingFabric(
  options: CreateTradingFabricOptions = {},
): TradingFabric {
  const config = resolveConfig(options.config ?? {}, options.env);

  return {
    config,
    async run(input) {
      const trade_date = input.trade_date ?? new Date().toISOString().slice(0, 10);
      const analysts = input.analysts ?? config.selected_analysts;
      const asset_type = input.asset_type ?? config.default_asset_type;

      // Phase 0 stub: returns an empty result envelope so build/tests pass
      // without spinning up an LLM. Real pipeline lands in later phases.
      return {
        runId: `run_${Date.now()}`,
        ticker: input.ticker,
        trade_date,
        asset_type,
        analysts,
        reports: [],
        research_plan: '',
        trader_proposal: '',
        risk_debate: [],
        portfolio_decision: '',
        execution: null,
        durationMs: 0,
      };
    },
  };
}

export { DEFAULT_CONFIG };
