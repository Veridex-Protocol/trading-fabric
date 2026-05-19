/**
 * Structured-output schemas for the three decision-making agents in
 * trading-fabric. These mirror `tradingagents/agents/schemas.py` so that
 * the rebuilt framework consumes and emits the same markdown shape that
 * downstream parsers (memory log, CLI display, saved reports) expect.
 *
 * Each schema doubles as the model's output instructions: Zod descriptions
 * become the structured-output spec for OpenAI/xAI (json_schema), Gemini
 * (response_schema), and Anthropic (tool use). The `render*` helpers turn
 * the parsed object back into the canonical markdown form.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared rating types
// ---------------------------------------------------------------------------

/**
 * 5-tier rating used by the Research Manager and Portfolio Manager.
 */
export const PortfolioRating = z.enum([
  'Buy',
  'Overweight',
  'Hold',
  'Underweight',
  'Sell',
]);
export type PortfolioRating = z.infer<typeof PortfolioRating>;

/**
 * 3-tier transaction direction used by the Trader. Position sizing and the
 * nuanced Overweight/Underweight calls happen later at the Portfolio Manager.
 */
export const TraderAction = z.enum(['Buy', 'Hold', 'Sell']);
export type TraderAction = z.infer<typeof TraderAction>;

// ---------------------------------------------------------------------------
// Research Manager
// ---------------------------------------------------------------------------

export const ResearchPlan = z.object({
  recommendation: PortfolioRating.describe(
    'The investment recommendation. Exactly one of Buy / Overweight / Hold / ' +
      'Underweight / Sell. Reserve Hold for situations where the evidence on ' +
      'both sides is genuinely balanced; otherwise commit to the side with ' +
      'the stronger arguments.',
  ),
  rationale: z
    .string()
    .describe(
      'Conversational summary of the key points from both sides of the ' +
        'debate, ending with which arguments led to the recommendation. ' +
        'Speak naturally, as if to a teammate.',
    ),
  strategic_actions: z
    .string()
    .describe(
      'Concrete steps for the trader to implement the recommendation, ' +
        'including position sizing guidance consistent with the rating.',
    ),
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;

export function renderResearchPlan(plan: ResearchPlan): string {
  return [
    `**Recommendation**: ${plan.recommendation}`,
    '',
    `**Rationale**: ${plan.rationale}`,
    '',
    `**Strategic Actions**: ${plan.strategic_actions}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Trader
// ---------------------------------------------------------------------------

export const TraderProposal = z.object({
  action: TraderAction.describe(
    'The transaction direction. Exactly one of Buy / Hold / Sell.',
  ),
  reasoning: z
    .string()
    .describe(
      "The case for this action, anchored in the analysts' reports and " +
        'the research plan. Two to four sentences.',
    ),
  entry_price: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Optional entry price target in the instrument's quote currency.",
    ),
  stop_loss: z
    .number()
    .nullable()
    .optional()
    .describe("Optional stop-loss price in the instrument's quote currency."),
  position_sizing: z
    .string()
    .nullable()
    .optional()
    .describe("Optional sizing guidance, e.g. '5% of portfolio'."),
});
export type TraderProposal = z.infer<typeof TraderProposal>;

/**
 * Render a TraderProposal to markdown.
 *
 * The trailing `FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL**` line is
 * preserved for backward compatibility with the analyst stop-signal text
 * and any external code that greps for it.
 */
export function renderTraderProposal(proposal: TraderProposal): string {
  const parts: string[] = [
    `**Action**: ${proposal.action}`,
    '',
    `**Reasoning**: ${proposal.reasoning}`,
  ];
  if (proposal.entry_price !== undefined && proposal.entry_price !== null) {
    parts.push('', `**Entry Price**: ${proposal.entry_price}`);
  }
  if (proposal.stop_loss !== undefined && proposal.stop_loss !== null) {
    parts.push('', `**Stop Loss**: ${proposal.stop_loss}`);
  }
  if (proposal.position_sizing) {
    parts.push('', `**Position Sizing**: ${proposal.position_sizing}`);
  }
  parts.push(
    '',
    `FINAL TRANSACTION PROPOSAL: **${proposal.action.toUpperCase()}**`,
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Portfolio Manager
// ---------------------------------------------------------------------------

export const PortfolioDecision = z.object({
  rating: PortfolioRating.describe(
    'The final position rating. Exactly one of Buy / Overweight / Hold / ' +
      "Underweight / Sell, picked based on the analysts' debate.",
  ),
  executive_summary: z
    .string()
    .describe(
      'A concise action plan covering entry strategy, position sizing, ' +
        'key risk levels, and time horizon. Two to four sentences.',
    ),
  investment_thesis: z
    .string()
    .describe(
      "Detailed reasoning anchored in specific evidence from the analysts' " +
        'debate. If prior lessons are referenced in the prompt context, ' +
        'incorporate them; otherwise rely solely on the current analysis.',
    ),
  price_target: z
    .number()
    .nullable()
    .optional()
    .describe("Optional target price in the instrument's quote currency."),
  time_horizon: z
    .string()
    .nullable()
    .optional()
    .describe("Optional recommended holding period, e.g. '3-6 months'."),
});
export type PortfolioDecision = z.infer<typeof PortfolioDecision>;

export function renderPortfolioDecision(decision: PortfolioDecision): string {
  const parts: string[] = [
    `**Rating**: ${decision.rating}`,
    '',
    `**Executive Summary**: ${decision.executive_summary}`,
    '',
    `**Investment Thesis**: ${decision.investment_thesis}`,
  ];
  if (decision.price_target !== undefined && decision.price_target !== null) {
    parts.push('', `**Price Target**: ${decision.price_target}`);
  }
  if (decision.time_horizon) {
    parts.push('', `**Time Horizon**: ${decision.time_horizon}`);
  }
  return parts.join('\n');
}
