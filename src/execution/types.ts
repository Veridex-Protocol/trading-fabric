/**
 * @packageDocumentation
 * @module execution/types
 * @description First-principles execution surface.
 *
 * The trading-fabric core treats execution as a *single typed boundary*:
 * given a policy-approved `ExecutionRequest`, return a settled (or
 * deterministically rejected) `ExecutionEnvelope`. Each protocol — paper,
 * Sera CLOB, a future broker — implements `ExecutionProvider`. Higher-
 * level routing belongs to `ExecutionRouter`.
 *
 * Design contract:
 *  1. Providers are PURE with respect to inputs except for explicit
 *     network or ledger side effects. They MUST NOT mutate the request.
 *  2. Providers ALWAYS return an envelope — never throw on a
 *     business-logic rejection. Throw only on infrastructure faults
 *     (network down, malformed config) so the orchestrator can attach
 *     a generic `provider_error` envelope and move on.
 *  3. Envelopes are immutable and JSON-serializable; an audit consumer
 *     should be able to reconstruct what happened from the envelope
 *     alone, without re-querying the provider.
 */

import type { Verdict } from '../policy/types.js';
import type { PortfolioRating } from '../schemas/index.js';
import type {
  ExecutionEnvelope,
  Ticker,
  TradeDate,
} from '../types/index.js';

/** Input to an `ExecutionProvider`. */
export interface ExecutionRequest {
  /** Stable id derived from the proposal that won policy approval. */
  decisionId: string;
  runId: string;
  ticker: Ticker;
  trade_date: TradeDate;
  rating: PortfolioRating;
  action: 'Buy' | 'Sell' | 'Hold';
  /** Notional USD value the policy engine signed off on. */
  amountUsd: number;
  /** Full verdict ledger — embedded in the resulting envelope for audit. */
  policyVerdicts: Verdict[];
  /** Optional run-correlation id from the AgentRuntime trace. */
  traceId?: string;
  /** Free-form provider hints (e.g. preferred venue, slippage bps). */
  hints?: Record<string, unknown>;
}

/**
 * A provider can implement any subset of asset classes / actions; the
 * `supports` predicate is consulted by `ExecutionRouter` before
 * `execute` is called.
 */
export interface ExecutionProvider {
  /** Stable identifier (e.g. `paper`, `sera`). Surfaced on the envelope. */
  readonly id: string;
  /** Returns true iff this provider should handle the given request. */
  supports(request: ExecutionRequest): boolean | Promise<boolean>;
  /**
   * Carry out (or simulate) the trade. Must always resolve to an envelope.
   * Throwing here is reserved for infrastructure faults the caller
   * cannot reasonably interpret as a rejection.
   */
  execute(request: ExecutionRequest): Promise<ExecutionEnvelope>;
}

/** Helper exported for providers that build their own envelopes. */
export function baseEnvelope(
  request: ExecutionRequest,
  provider: string,
  patch: Partial<ExecutionEnvelope>,
): ExecutionEnvelope {
  return {
    decisionId: request.decisionId,
    ticker: request.ticker,
    trade_date: request.trade_date,
    action: request.action,
    amountUsd: request.amountUsd,
    txHash: null,
    signedAction: null,
    policyVerdicts: request.policyVerdicts.map((v) => ({
      ruleId: v.ruleId,
      decision: v.decision,
      reason: v.reason,
    })),
    traceId: request.traceId ?? request.runId,
    executedAt: new Date().toISOString(),
    surface: 'simulation',
    provider,
    status: 'skipped',
    metadata: undefined,
    error: null,
    ...patch,
  };
}

/** Re-export so callers can `import { ExecutionEnvelope } from 'execution'`. */
export type { ExecutionEnvelope } from '../types/index.js';
