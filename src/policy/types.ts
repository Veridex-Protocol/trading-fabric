/**
 * @packageDocumentation
 * @module policy/types
 * @description Trading-fabric policy surface. A `Proposal` is derived from
 * a Portfolio Manager decision; rules score it and emit `Verdict`s; the
 * engine reduces those into a final `EngineDecision` (allow / deny /
 * escalate). Escalations are routed to a `HumanApprovalQueue`.
 *
 * Verdicts are *additive*: every rule that touches the proposal contributes
 * one verdict, even when the result is `allow`. Auditors expect to see the
 * full ledger, not just the negative ones.
 */

import type { PortfolioRating } from '../schemas/index.js';
import type { Ticker, TradeDate } from '../types/index.js';

/** What the trader wants to do with the position. Derived from `PortfolioRating`. */
export type ProposalAction = 'Buy' | 'Sell' | 'Hold';

/** Single proposed trade evaluated by the policy engine. */
export interface Proposal {
  /** Stable id used by approvals / audit log. */
  decisionId: string;
  runId: string;
  ticker: Ticker;
  trade_date: TradeDate;
  rating: PortfolioRating;
  action: ProposalAction;
  /** Notional USD value of the proposed position (sizer output). */
  amountUsd: number;
}

/**
 * Mutable runtime context the engine reads. Callers populate the parts
 * relevant to their rules; missing fields default to neutral values
 * (e.g. `dailySpendUsd === 0` if no prior trades).
 */
export interface PolicyContext {
  /** Total USD already committed today across this account. */
  dailySpendUsd: number;
  /** UTC ms of the last executed trade — used by cooldown rules. */
  lastTradeAt: number | null;
  /** Alpha return of the most recent resolved memory entry, if any. */
  lastAlphaReturn: number | null;
  /** Wall-clock for rules that compare against `Date.now()`. Injectable for tests. */
  now: () => Date;
}

export type VerdictDecision = 'allow' | 'deny' | 'escalate';

/** Output of one rule evaluation. `decision: 'allow'` rules are still emitted for audit. */
export interface Verdict {
  ruleId: string;
  decision: VerdictDecision;
  reason?: string;
  /** Free-form metadata the rule wants to surface (limits, observed values, etc). */
  data?: Record<string, unknown>;
}

/**
 * A policy rule. Implementations should be pure with respect to the
 * `(proposal, ctx, config)` triple — side effects belong elsewhere.
 */
export interface PolicyRule {
  readonly id: string;
  evaluate(input: PolicyRuleInput): Verdict | null;
}

export interface PolicyRuleInput {
  proposal: Proposal;
  ctx: PolicyContext;
  /** Limits + allowlists pulled from `TradingFabricConfig`. */
  limits: PolicyLimits;
}

/** Configuration slice the engine actually needs — keeps types decoupled. */
export interface PolicyLimits {
  daily_spend_cap_usd: number;
  max_position_usd: number;
  instrument_allowlist: string[];
  /** Optional cooldown (hours) imposed after a losing trade. 0 disables. */
  cooldown_after_loss_hours?: number;
  /** Alpha threshold (e.g. -0.05) below which `cooldown_after_loss` triggers. */
  cooldown_loss_threshold?: number;
}

/** Final reduced decision over all verdicts for one proposal. */
export interface EngineDecision {
  decision: VerdictDecision;
  verdicts: Verdict[];
  /** First deny / escalate reason, in evaluation order. Pure UX sugar. */
  primaryReason: string | null;
}
