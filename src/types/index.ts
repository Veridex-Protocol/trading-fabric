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
 * absent. In real-execution mode this carries the protocol-specific
 * settlement reference (e.g. Sera swap UUID + on-chain tx hash).
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
  /**
   * Where the envelope was produced.
   *   - `simulation`  — paper trading; no real action taken.
   *   - `quote_only`  — a quote was fetched but never executed.
   *   - `testnet`     — executed against a test network (e.g. Sera Sepolia).
   *   - `mainnet`     — executed against production rails.
   *   - `failed`      — the provider attempted execution and rejected.
   */
  surface: 'simulation' | 'quote_only' | 'testnet' | 'mainnet' | 'failed';
  /** Logical provider that produced the envelope (e.g. `paper`, `sera`). */
  provider: string;
  /** Final execution status. Useful when settlement is async. */
  status: 'filled' | 'pending' | 'rejected' | 'skipped';
  /** Provider-specific data (quote uuid, route hash, fee breakdown, ...). */
  metadata?: Record<string, unknown>;
  /** Populated when `status === 'rejected'`. */
  error?: { code: string; message: string } | null;
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
  /**
   * The proposal handed to the policy engine. `null` when the run was
   * built without a `PolicyEngine` (e.g. eval harness invocations).
   */
  proposal?: import('../policy/types.js').Proposal | null;
  /**
   * Result of the policy evaluation (verdicts + final reduction). `null`
   * when no policy engine was wired.
   */
  policy_decision?: import('../policy/types.js').EngineDecision | null;
  /**
   * Resolved approval record when the policy engine escalated. `null`
   * when no escalation occurred.
   */
  approval?: import('../policy/approvals.js').ApprovalRecord | null;
  execution: ExecutionEnvelope | null;
  durationMs: number;
}

export interface TradingFabricRunInput {
  ticker: string;
  trade_date?: string;
  asset_type?: AssetType;
  analysts?: AnalystKey[];
  past_context?: string | null;
}
