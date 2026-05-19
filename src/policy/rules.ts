/**
 * @packageDocumentation
 * @module policy/rules
 * @description Built-in policy rules wired by the default engine.
 *
 * Each rule returns `null` when it does not apply (e.g. a Hold proposal
 * trivially bypasses spend caps), or a `Verdict` carrying `allow`,
 * `deny`, or `escalate`. Rules **must not** mutate inputs.
 */

import type { PolicyRule, PolicyRuleInput, Verdict } from './types.js';

/**
 * Denies trades on tickers not in `instrument_allowlist`. An empty list
 * disables the rule (matches `TradingFabricConfig` semantics).
 */
export const instrumentAllowlistRule: PolicyRule = {
  id: 'instrument-allowlist',
  evaluate({ proposal, limits }: PolicyRuleInput): Verdict | null {
    if (proposal.action === 'Hold') return null;
    if (limits.instrument_allowlist.length === 0) return null;
    const allowed = limits.instrument_allowlist.includes(proposal.ticker);
    if (allowed) {
      return {
        ruleId: 'instrument-allowlist',
        decision: 'allow',
        data: { ticker: proposal.ticker },
      };
    }
    return {
      ruleId: 'instrument-allowlist',
      decision: 'deny',
      reason: `Ticker ${proposal.ticker} is not in the configured allowlist`,
      data: { ticker: proposal.ticker, allowlist: [...limits.instrument_allowlist] },
    };
  },
};

/**
 * Denies trades whose notional exceeds the hard per-trade ceiling. This
 * is the *hard* cap — `daily-spend-cap` handles the softer escalation case.
 */
export const maxPositionRule: PolicyRule = {
  id: 'max-position',
  evaluate({ proposal, limits }: PolicyRuleInput): Verdict | null {
    if (proposal.action === 'Hold') return null;
    if (proposal.amountUsd <= limits.max_position_usd) {
      return {
        ruleId: 'max-position',
        decision: 'allow',
        data: { amountUsd: proposal.amountUsd, max: limits.max_position_usd },
      };
    }
    return {
      ruleId: 'max-position',
      decision: 'deny',
      reason:
        `Proposed amount $${proposal.amountUsd.toFixed(2)} exceeds the ` +
        `per-trade cap of $${limits.max_position_usd.toFixed(2)}`,
      data: { amountUsd: proposal.amountUsd, max: limits.max_position_usd },
    };
  },
};

/**
 * Escalates (does not deny) when the running daily spend plus this
 * proposal would breach `daily_spend_cap_usd`. A human can still wave it
 * through; without one, the trade does not execute.
 */
export const dailySpendCapRule: PolicyRule = {
  id: 'daily-spend-cap',
  evaluate({ proposal, ctx, limits }: PolicyRuleInput): Verdict | null {
    if (proposal.action === 'Hold') return null;
    const projected = ctx.dailySpendUsd + proposal.amountUsd;
    if (projected <= limits.daily_spend_cap_usd) {
      return {
        ruleId: 'daily-spend-cap',
        decision: 'allow',
        data: { projected, cap: limits.daily_spend_cap_usd },
      };
    }
    return {
      ruleId: 'daily-spend-cap',
      decision: 'escalate',
      reason:
        `Projected daily spend $${projected.toFixed(2)} would exceed the ` +
        `cap of $${limits.daily_spend_cap_usd.toFixed(2)}`,
      data: {
        projected,
        cap: limits.daily_spend_cap_usd,
        priorSpend: ctx.dailySpendUsd,
      },
    };
  },
};

/**
 * Escalates trades issued within `cooldown_after_loss_hours` of a losing
 * trade (alpha below `cooldown_loss_threshold`). Disabled unless both
 * config knobs are non-zero / non-null.
 */
export const cooldownAfterLossRule: PolicyRule = {
  id: 'cooldown-after-loss',
  evaluate({ proposal, ctx, limits }: PolicyRuleInput): Verdict | null {
    if (proposal.action === 'Hold') return null;
    const hours = limits.cooldown_after_loss_hours ?? 0;
    const threshold = limits.cooldown_loss_threshold ?? 0;
    if (hours <= 0) return null;
    if (ctx.lastTradeAt === null) return null;
    if (ctx.lastAlphaReturn === null) return null;
    if (ctx.lastAlphaReturn >= threshold) return null;
    const elapsedMs = ctx.now().getTime() - ctx.lastTradeAt;
    const cooldownMs = hours * 3_600_000;
    if (elapsedMs >= cooldownMs) {
      return {
        ruleId: 'cooldown-after-loss',
        decision: 'allow',
        data: { elapsedMs, cooldownMs },
      };
    }
    return {
      ruleId: 'cooldown-after-loss',
      decision: 'escalate',
      reason:
        `Cooldown active: last alpha ${(ctx.lastAlphaReturn * 100).toFixed(2)}% ` +
        `and only ${(elapsedMs / 3_600_000).toFixed(1)}h elapsed (need ${hours}h)`,
      data: {
        lastAlphaReturn: ctx.lastAlphaReturn,
        elapsedMs,
        cooldownMs,
      },
    };
  },
};

/** The default ordered rule set wired by `PolicyEngine.withDefaults()`. */
export const DEFAULT_RULES: readonly PolicyRule[] = Object.freeze([
  instrumentAllowlistRule,
  maxPositionRule,
  dailySpendCapRule,
  cooldownAfterLossRule,
]);
