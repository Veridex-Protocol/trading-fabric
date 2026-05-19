/**
 * Configuration surface for trading-fabric.
 *
 * Mirrors `tradingagents/default_config.py` with env-var overrides via
 * the `TRADING_FABRIC_*` prefix (TradingAgents uses `TRADINGAGENTS_*`).
 * Programmatic callers pass a `TradingFabricConfig` partial to
 * `createTradingFabric(...)`; missing fields fall back to `DEFAULT_CONFIG`.
 */

import type { AnalystKey, AssetType, ReasoningDepth } from '../types/index.js';

/** Provider keys recognised by the LLM registry. */
export type LLMProviderKey =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'qwen'
  | 'qwen_cn'
  | 'glm'
  | 'glm_cn'
  | 'minimax'
  | 'minimax_cn'
  | 'openrouter'
  | 'ollama'
  | 'azure';

/** Data-vendor categories we route to. */
export type DataVendorCategory =
  | 'core_stock_apis'
  | 'technical_indicators'
  | 'fundamental_data'
  | 'news_data';

export type DataVendor = 'alpha_vantage' | 'yfinance' | 'finnhub';

export interface TradingFabricConfig {
  // --- LLM ---------------------------------------------------------------
  llm_provider: LLMProviderKey;
  /** Model used for the Research Manager and Portfolio Manager. */
  deep_think_llm: string;
  /** Model used for analysts, researchers, trader, and risk debators. */
  quick_think_llm: string;
  /** Optional base URL override for OpenAI-compatible providers. */
  backend_url: string | null;
  /** Provider-specific reasoning knobs (forwarded to RuntimeOptions). */
  openai_reasoning_effort: 'minimal' | 'low' | 'medium' | 'high' | null;
  google_thinking_level: 'low' | 'medium' | 'high' | null;
  anthropic_effort: 'low' | 'medium' | 'high' | null;

  // --- Debate / orchestration -------------------------------------------
  max_debate_rounds: number;
  max_risk_discuss_rounds: number;
  max_recur_limit: number;
  analyst_concurrency_limit: number;
  selected_analysts: AnalystKey[];
  default_asset_type: AssetType;

  // --- Storage ----------------------------------------------------------
  /** Root directory for run logs, cache, memory, checkpoints. */
  data_dir: string;
  data_cache_dir: string;
  results_dir: string;
  memory_log_path: string;
  memory_log_max_entries: number;
  checkpoint_enabled: boolean;

  // --- Data vendor routing ---------------------------------------------
  data_vendors: Record<DataVendorCategory, DataVendor>;
  tool_vendors: Record<string, DataVendor>;

  // --- News article limits ---------------------------------------------
  news_article_limit: number;
  global_news_article_limit: number;
  global_news_lookback_days: number;
  global_news_queries: string[];

  // --- Reflection / benchmarking ---------------------------------------
  benchmark_ticker: string | null;
  benchmark_map: Record<string, string>;

  // --- Localisation ----------------------------------------------------
  output_language: string;

  // --- Execution (Veridex-specific) ------------------------------------
  /** When false, Portfolio Manager decisions are written to a JSON ledger
   *  instead of being executed on-chain. */
  execute_enabled: boolean;
  /** Hard daily spend cap (USD). Enforced by PolicyEngine. */
  daily_spend_cap_usd: number;
  /** Per-trade maximum (USD). Trades above this require approval. */
  max_position_usd: number;
  /** Tickers the trader is allowed to take a position on. Empty = allowlist
   *  disabled (deny-none). */
  instrument_allowlist: string[];
  /** Veridex SDK chain for execution. */
  execution_chain: 'base-sepolia' | 'base' | 'ethereum-sepolia';
}

/**
 * Defaults mirror `tradingagents/default_config.py` where they apply, with
 * Veridex-specific knobs added at the bottom.
 *
 * Storage paths default to `~/.trading-fabric/` (not `~/.tradingagents/`)
 * so the two systems can coexist on the same machine without colliding.
 */
export const DEFAULT_CONFIG: TradingFabricConfig = {
  llm_provider: 'openai',
  deep_think_llm: 'gpt-5.4',
  quick_think_llm: 'gpt-5.4-mini',
  backend_url: null,
  openai_reasoning_effort: null,
  google_thinking_level: null,
  anthropic_effort: null,

  max_debate_rounds: 1,
  max_risk_discuss_rounds: 1,
  max_recur_limit: 100,
  analyst_concurrency_limit: 1,
  selected_analysts: ['market', 'social', 'news', 'fundamentals'],
  default_asset_type: 'stock',

  data_dir: '~/.trading-fabric/data',
  data_cache_dir: '~/.trading-fabric/cache',
  results_dir: '~/.trading-fabric/results',
  memory_log_path: '~/.trading-fabric/memory/trading_memory.md',
  memory_log_max_entries: 500,
  checkpoint_enabled: false,

  data_vendors: {
    core_stock_apis: 'yfinance',
    technical_indicators: 'yfinance',
    fundamental_data: 'yfinance',
    news_data: 'yfinance',
  },
  tool_vendors: {},

  news_article_limit: 20,
  global_news_article_limit: 10,
  global_news_lookback_days: 7,
  global_news_queries: [
    'Federal Reserve interest rates inflation',
    'S&P 500 earnings GDP economic outlook',
    'geopolitical risk trade war sanctions',
    'ECB Bank of England BOJ central bank policy',
    'oil commodities supply chain energy',
  ],

  benchmark_ticker: null,
  benchmark_map: {
    '.NS': '^NSEI',
    '.BO': '^BSESN',
    '.T': '^N225',
    '.HK': '^HSI',
    '.L': '^FTSE',
    '.TO': '^GSPTSE',
    '.AX': '^AXJO',
    '': 'SPY',
  },

  output_language: 'English',

  execute_enabled: false,
  daily_spend_cap_usd: 50,
  max_position_usd: 25,
  instrument_allowlist: [],
  execution_chain: 'base-sepolia',
};

/**
 * Env-var overrides. Each entry maps `TRADING_FABRIC_<KEY>` → config field
 * with the parser to apply. Mirrors the `_ENV_OVERRIDES` table in
 * TradingAgents' default_config.py.
 */
type EnvOverride<K extends keyof TradingFabricConfig> = {
  key: K;
  parse: (raw: string) => TradingFabricConfig[K];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENV_OVERRIDES: Record<string, EnvOverride<any>> = {
  TRADING_FABRIC_LLM_PROVIDER: {
    key: 'llm_provider',
    parse: (v) => v as LLMProviderKey,
  },
  TRADING_FABRIC_DEEP_THINK_LLM: {
    key: 'deep_think_llm',
    parse: (v) => v,
  },
  TRADING_FABRIC_QUICK_THINK_LLM: {
    key: 'quick_think_llm',
    parse: (v) => v,
  },
  TRADING_FABRIC_BACKEND_URL: {
    key: 'backend_url',
    parse: (v) => (v ? v : null),
  },
  TRADING_FABRIC_MAX_DEBATE_ROUNDS: {
    key: 'max_debate_rounds',
    parse: (v) => Math.max(1, parseInt(v, 10)),
  },
  TRADING_FABRIC_MAX_RISK_DISCUSS_ROUNDS: {
    key: 'max_risk_discuss_rounds',
    parse: (v) => Math.max(1, parseInt(v, 10)),
  },
  TRADING_FABRIC_OUTPUT_LANGUAGE: {
    key: 'output_language',
    parse: (v) => v,
  },
  TRADING_FABRIC_EXECUTE: {
    key: 'execute_enabled',
    parse: (v) => v === '1' || v.toLowerCase() === 'true',
  },
  TRADING_FABRIC_DAILY_SPEND_CAP_USD: {
    key: 'daily_spend_cap_usd',
    parse: (v) => Math.max(0, parseFloat(v)),
  },
  TRADING_FABRIC_MAX_POSITION_USD: {
    key: 'max_position_usd',
    parse: (v) => Math.max(0, parseFloat(v)),
  },
  TRADING_FABRIC_DATA_DIR: { key: 'data_dir', parse: (v) => v },
  TRADING_FABRIC_RESULTS_DIR: { key: 'results_dir', parse: (v) => v },
};

/**
 * Resolve final config by merging:  defaults  ←  env overrides  ←  user overrides.
 *
 * Pure function — does not read `process.env` directly; the caller passes in
 * `env` so tests can exercise the merge without polluting global state.
 */
export function resolveConfig(
  userOverrides: Partial<TradingFabricConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): TradingFabricConfig {
  const cfg: TradingFabricConfig = { ...DEFAULT_CONFIG };

  for (const [envKey, override] of Object.entries(ENV_OVERRIDES)) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cfg as any)[override.key] = override.parse(raw);
    } catch {
      // Ignore invalid env values; surface via validator later if needed.
    }
  }

  return { ...cfg, ...userOverrides };
}

/** Map a `ReasoningDepth` to which configured model to use. */
export function modelForDepth(
  cfg: TradingFabricConfig,
  depth: ReasoningDepth,
): string {
  return depth === 'deep' ? cfg.deep_think_llm : cfg.quick_think_llm;
}
