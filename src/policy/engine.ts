/**
 * @packageDocumentation
 * @module policy/engine
 * @description Reduces a list of rule verdicts into a single engine
 * decision.
 *
 * Reduction semantics:
 *   - Any `deny` verdict short-circuits the decision to `deny`.
 *   - Otherwise, the presence of any `escalate` verdict yields `escalate`.
 *   - Otherwise (no verdicts at all is fine — e.g. a Hold proposal),
 *     the result is `allow`.
 *
 * Rules that return `null` are silently skipped. Rules that return
 * `allow` ARE recorded — auditors care about the full trace, not just
 * negatives.
 */

import { DEFAULT_RULES } from './rules.js';
import type {
  EngineDecision,
  PolicyContext,
  PolicyLimits,
  PolicyRule,
  Proposal,
  Verdict,
} from './types.js';

export interface PolicyEngineOptions {
  /** Ordered list of rules. First deny / escalate wins for `primaryReason`. */
  rules?: readonly PolicyRule[];
  limits: PolicyLimits;
}

/**
 * Stateless evaluator. Construct once with a `limits` snapshot; call
 * `evaluate` per proposal. Callers update `PolicyContext` (daily spend
 * etc.) themselves between calls.
 */
export class PolicyEngine {
  readonly rules: readonly PolicyRule[];
  readonly limits: PolicyLimits;

  constructor(options: PolicyEngineOptions) {
    this.rules = options.rules ?? DEFAULT_RULES;
    this.limits = options.limits;
  }

  evaluate(proposal: Proposal, ctx: PolicyContext): EngineDecision {
    const verdicts: Verdict[] = [];
    for (const rule of this.rules) {
      const v = rule.evaluate({ proposal, ctx, limits: this.limits });
      if (v) verdicts.push(v);
    }
    const denied = verdicts.find((v) => v.decision === 'deny');
    if (denied) {
      return {
        decision: 'deny',
        verdicts,
        primaryReason: denied.reason ?? `Denied by ${denied.ruleId}`,
      };
    }
    const escalated = verdicts.find((v) => v.decision === 'escalate');
    if (escalated) {
      return {
        decision: 'escalate',
        verdicts,
        primaryReason: escalated.reason ?? `Escalated by ${escalated.ruleId}`,
      };
    }
    return { decision: 'allow', verdicts, primaryReason: null };
  }
}
