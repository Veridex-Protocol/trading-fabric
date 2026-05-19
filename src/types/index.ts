/**
 * Core domain types used across trading-fabric.
 *
 * Keep these provider/transport-agnostic. Anything that references an LLM,
 * an exchange, or a data vendor lives in its dedicated module.
 */

/** Asset class supported by the framework. */
export type AssetType = 'stock' | 'crypto';

/** A ticker symbol — vendor- and exchange-agnostic at this layer. */
export type Ticker = string;

/** ISO-8601 trade date (YYYY-MM-DD). */
export type TradeDate = string;

/** Identifier for which analysts to include in a run. */
export type AnalystKey = 'market' | 'social' | 'news' | 'fundamentals';

/** Reasoning depth knob: maps to provider-specific reasoning_effort/thinking. */
export type ReasoningDepth = 'quick' | 'deep';

/**
 * A report produced by one of the analyst agents. The `kind` field tells
 * downstream consumers (researchers, trader, memory) which slot to fill.
 */
export interface AnalystReport {
  kind: AnalystKey;
  ticker: Ticker;
  trade_date: TradeDate;
  /** Markdown body — what readers see and what researchers consume. */
  content: string;
  /** Free-form metadata (tool calls made, indicators chosen, sources, etc). */
  metadata?: Record<string, unknown>;
}

/**
 * One turn in the bull/bear researcher debate.
 *
 * Stored in working memory only; the Research Manager synthesises these
 * into a `ResearchPlan` at the end. We do NOT replay raw history into
 * every turn — debate rounds are summarised by the context compiler to
 * avoid the long-multi-round degradation cliff.
 */
export interface DebateTurn {
  speaker: 'bull' | 'bear';
  round: number;
  content: string;
  timestamp: string;
}

/**
 * One turn in the 3-way risk debate. Round-robin between aggressive,
 * neutral, and conservative analysts under `max_risk_discuss_rounds`.
 */
export interface RiskDebateTurn {
  speaker: 'aggressive' | 'neutral' | 'conservative';
  round: number;
  content: string;
  timestamp: string;
}

/**
 * The envelope written when the Portfolio Manager's decision is executed.
 *
 * In simulation mode `txHash` is a synthetic id and `signedAction` is
 * absent. In real-execution mode this carries the @veridex/sdk session
 * key signed action and the on-chain transaction hash from the relayer.
 *
 * `policyVerdicts` captures every PolicyEngine decision that the proposal
 * passed through; `traceId` indexes into the EventBus log so a reader can
 * reconstruct the full chain of reasoning that produced the trade.
 */
export interface ExecutionEnvelope {
  decisionId: string;
  ticker: Ticker;
  trade_date: TradeDate;
  action: 'Buy' | 'Sell' | 'Hold';
  amountUsd: number;
  txHash: string | null;
  signedAction: string | null;
  policyVerdicts: Array<{
    ruleId: string;
    decision: 'allow' | 'deny' | 'escalate';
    reason?: string;
  }>;
  traceId: string;
  executedAt: string;
  /** `simulation` when --execute=false; `testnet` when a real tx happened. */
  surface: 'simulation' | 'testnet';
}

/**
 * The full result of one `trading-fabric run` invocation. This is what
 * the CLI prints, what evals diff against goldens, and what the audit
 * exporter serialises.
 */
export interface TradingFabricRunResult {
  runId: string;
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  analysts: AnalystKey[];
  reports: AnalystReport[];
  research_plan: string;
  trader_proposal: string;
  risk_debate: RiskDebateTurn[];
  portfolio_decision: string;
  execution: ExecutionEnvelope | null;
  durationMs: number;
}
