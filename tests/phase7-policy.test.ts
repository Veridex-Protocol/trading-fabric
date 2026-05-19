/**
 * Phase 7 tests — policy engine, approval queue, and orchestrator
 * integration.
 *
 * No network. The orchestrator runs through a scripted provider that
 * returns canned analyst / debate / structured outputs (same pattern as
 * Phase 5 + 6); we assert that the policy engine evaluates the
 * Portfolio-Manager-derived proposal, that escalations route through the
 * approval queue, and that the run result surfaces verdicts + approvals.
 */

import { describe, expect, test } from 'vitest';
import type {
  ModelMessage,
  ModelProvider,
  ModelResponse,
} from '@veridex/agents';

import { createTradingAgents } from '../src/agents';
import { DEFAULT_CONFIG, type TradingFabricConfig } from '../src/config';
import type { DataflowClient } from '../src/dataflows';
import {
  Orchestrator,
  type OrchestrationEvent,
} from '../src/orchestration';
import {
  DEFAULT_RULES,
  InMemoryApprovalQueue,
  PolicyEngine,
  cooldownAfterLossRule,
  dailySpendCapRule,
  defaultSizer,
  instrumentAllowlistRule,
  maxPositionRule,
  ratingToAction,
  type PolicyContext,
  type PolicyLimits,
  type Proposal,
} from '../src/policy';
import { createDataflowTools } from '../src/tools';

// ─── Scripted provider (minimal — same pattern as phase5/6) ──────────────

type Role =
  | 'market'
  | 'social'
  | 'news'
  | 'fundamentals'
  | 'bull'
  | 'bear'
  | 'research-manager'
  | 'trader'
  | 'aggressive'
  | 'neutral'
  | 'conservative'
  | 'portfolio-manager';

function classify(systemPrompt: string): Role {
  if (systemPrompt.includes('select the **most relevant indicators**')) return 'market';
  if (systemPrompt.includes('financial market sentiment analyst')) return 'social';
  if (systemPrompt.includes('news researcher tasked with analyzing recent news')) return 'news';
  if (systemPrompt.includes('analyzing fundamental information over the past week'))
    return 'fundamentals';
  if (systemPrompt.includes('Bull Analyst advocating')) return 'bull';
  if (systemPrompt.includes('Bear Analyst making the case')) return 'bear';
  if (systemPrompt.includes('Research Manager and debate facilitator')) return 'research-manager';
  if (systemPrompt.includes('trading agent analyzing market data')) return 'trader';
  if (systemPrompt.includes('Aggressive Risk Analyst')) return 'aggressive';
  if (systemPrompt.includes('Conservative Risk Analyst')) return 'conservative';
  if (systemPrompt.includes('Neutral Risk Analyst')) return 'neutral';
  if (systemPrompt.includes('Portfolio Manager')) return 'portfolio-manager';
  throw new Error(`Could not classify system prompt:\n${systemPrompt.slice(0, 200)}`);
}

function cannedFor(role: Role, rating: 'Buy' | 'Hold'): string {
  switch (role) {
    case 'market':
      return '# Market\nRSI 65; MACD bullish crossover.';
    case 'social':
      return '# Sentiment\nMildly bullish.';
    case 'news':
      return '# News\nNo material headlines.';
    case 'fundamentals':
      return '# Fundamentals\nStable.';
    case 'bull':
      return 'Upside thesis intact.';
    case 'bear':
      return 'Margin compression risk.';
    case 'research-manager':
      return JSON.stringify({
        recommendation: rating === 'Buy' ? 'Buy' : 'Hold',
        rationale: 'Bull case wins.',
        strategic_actions: 'Phased entry.',
      });
    case 'trader':
      return JSON.stringify({
        action: rating === 'Buy' ? 'Buy' : 'Hold',
        reasoning: 'Plan constructive.',
        entry_price: 100,
        stop_loss: 95,
        position_sizing: '5%',
      });
    case 'aggressive':
      return 'Take the trade.';
    case 'neutral':
      return 'Phased entry is prudent.';
    case 'conservative':
      return 'Risk is elevated.';
    case 'portfolio-manager':
      return JSON.stringify({
        rating,
        executive_summary: 'Phased entry plan.',
        investment_thesis: 'Bull thesis grounded in analyst evidence.',
        price_target: 120,
        time_horizon: '3 months',
      });
  }
}

function makeProvider(name: string, rating: 'Buy' | 'Hold'): ModelProvider {
  return {
    name,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const role = classify(system);
      return {
        content: cannedFor(role, rating),
        model: `scripted-${role}`,
        provider: name,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

function mockClient(): DataflowClient {
  const stub = () => async () => 'mock';
  return {
    availableVendors: ['yfinance'],
    getStockData: stub(),
    getIndicators: stub(),
    getFundamentals: stub(),
    getBalanceSheet: stub(),
    getCashflow: stub(),
    getIncomeStatement: stub(),
    getInsiderTransactions: stub(),
    getNews: stub(),
    getGlobalNews: stub(),
    getRedditPosts: stub(),
    getStocktwitsMessages: stub(),
  } as unknown as DataflowClient;
}

// ─── PolicyEngine + rule unit tests ──────────────────────────────────────

const baseLimits: PolicyLimits = {
  daily_spend_cap_usd: 50,
  max_position_usd: 25,
  instrument_allowlist: [],
};

const baseCtx: PolicyContext = {
  dailySpendUsd: 0,
  lastTradeAt: null,
  lastAlphaReturn: null,
  now: () => new Date('2026-05-19T12:00:00Z'),
};

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    decisionId: 'd-1',
    runId: 'r-1',
    ticker: 'AAPL',
    trade_date: '2026-05-19',
    rating: 'Buy',
    action: 'Buy',
    amountUsd: 20,
    ...overrides,
  };
}

describe('defaultSizer + ratingToAction', () => {
  test('maps ratings to actions', () => {
    expect(ratingToAction('Buy')).toBe('Buy');
    expect(ratingToAction('Overweight')).toBe('Buy');
    expect(ratingToAction('Hold')).toBe('Hold');
    expect(ratingToAction('Underweight')).toBe('Sell');
    expect(ratingToAction('Sell')).toBe('Sell');
  });

  test('sizes ratings against max_position_usd', () => {
    expect(defaultSizer('Buy', 25)).toBe(25);
    expect(defaultSizer('Sell', 25)).toBe(25);
    expect(defaultSizer('Overweight', 25)).toBe(12.5);
    expect(defaultSizer('Underweight', 25)).toBe(12.5);
    expect(defaultSizer('Hold', 25)).toBe(0);
    expect(defaultSizer('Buy', 0)).toBe(0);
  });
});

describe('instrumentAllowlistRule', () => {
  test('disabled when allowlist is empty', () => {
    const v = instrumentAllowlistRule.evaluate({
      proposal: makeProposal(),
      ctx: baseCtx,
      limits: baseLimits,
    });
    expect(v).toBeNull();
  });

  test('allows tickers on the list', () => {
    const v = instrumentAllowlistRule.evaluate({
      proposal: makeProposal({ ticker: 'AAPL' }),
      ctx: baseCtx,
      limits: { ...baseLimits, instrument_allowlist: ['AAPL', 'MSFT'] },
    });
    expect(v?.decision).toBe('allow');
  });

  test('denies tickers not on the list', () => {
    const v = instrumentAllowlistRule.evaluate({
      proposal: makeProposal({ ticker: 'TSLA' }),
      ctx: baseCtx,
      limits: { ...baseLimits, instrument_allowlist: ['AAPL'] },
    });
    expect(v?.decision).toBe('deny');
    expect(v?.reason).toContain('TSLA');
  });

  test('skips Hold proposals', () => {
    const v = instrumentAllowlistRule.evaluate({
      proposal: makeProposal({ action: 'Hold', rating: 'Hold' }),
      ctx: baseCtx,
      limits: { ...baseLimits, instrument_allowlist: ['NOPE'] },
    });
    expect(v).toBeNull();
  });
});

describe('maxPositionRule', () => {
  test('allows within cap', () => {
    const v = maxPositionRule.evaluate({
      proposal: makeProposal({ amountUsd: 25 }),
      ctx: baseCtx,
      limits: baseLimits,
    });
    expect(v?.decision).toBe('allow');
  });

  test('denies above cap', () => {
    const v = maxPositionRule.evaluate({
      proposal: makeProposal({ amountUsd: 26 }),
      ctx: baseCtx,
      limits: baseLimits,
    });
    expect(v?.decision).toBe('deny');
    expect(v?.reason).toContain('26.00');
  });
});

describe('dailySpendCapRule', () => {
  test('allows when projected ≤ cap', () => {
    const v = dailySpendCapRule.evaluate({
      proposal: makeProposal({ amountUsd: 20 }),
      ctx: { ...baseCtx, dailySpendUsd: 30 },
      limits: baseLimits,
    });
    expect(v?.decision).toBe('allow');
  });

  test('escalates when projected > cap', () => {
    const v = dailySpendCapRule.evaluate({
      proposal: makeProposal({ amountUsd: 21 }),
      ctx: { ...baseCtx, dailySpendUsd: 30 },
      limits: baseLimits,
    });
    expect(v?.decision).toBe('escalate');
    expect(v?.reason).toContain('51.00');
  });
});

describe('cooldownAfterLossRule', () => {
  const cdLimits: PolicyLimits = {
    ...baseLimits,
    cooldown_after_loss_hours: 24,
    cooldown_loss_threshold: -0.05,
  };

  test('disabled when cooldown hours = 0', () => {
    const v = cooldownAfterLossRule.evaluate({
      proposal: makeProposal(),
      ctx: { ...baseCtx, lastTradeAt: Date.now(), lastAlphaReturn: -0.1 },
      limits: baseLimits,
    });
    expect(v).toBeNull();
  });

  test('escalates within cooldown window after a loss', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const v = cooldownAfterLossRule.evaluate({
      proposal: makeProposal(),
      ctx: {
        ...baseCtx,
        lastTradeAt: now.getTime() - 3 * 3_600_000,
        lastAlphaReturn: -0.08,
        now: () => now,
      },
      limits: cdLimits,
    });
    expect(v?.decision).toBe('escalate');
  });

  test('allows after cooldown elapses', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const v = cooldownAfterLossRule.evaluate({
      proposal: makeProposal(),
      ctx: {
        ...baseCtx,
        lastTradeAt: now.getTime() - 30 * 3_600_000,
        lastAlphaReturn: -0.08,
        now: () => now,
      },
      limits: cdLimits,
    });
    expect(v?.decision).toBe('allow');
  });

  test('does not fire when last alpha ≥ threshold', () => {
    const now = new Date();
    const v = cooldownAfterLossRule.evaluate({
      proposal: makeProposal(),
      ctx: {
        ...baseCtx,
        lastTradeAt: now.getTime() - 1 * 3_600_000,
        lastAlphaReturn: 0.02,
        now: () => now,
      },
      limits: cdLimits,
    });
    expect(v).toBeNull();
  });
});

describe('PolicyEngine reduction', () => {
  test('deny short-circuits even when other rules allow', () => {
    const engine = new PolicyEngine({
      limits: { ...baseLimits, instrument_allowlist: ['MSFT'] },
    });
    const decision = engine.evaluate(
      makeProposal({ ticker: 'TSLA', amountUsd: 10 }),
      baseCtx,
    );
    expect(decision.decision).toBe('deny');
    expect(decision.verdicts.some((v) => v.ruleId === 'instrument-allowlist')).toBe(true);
    expect(decision.primaryReason).toContain('TSLA');
  });

  test('escalate is returned when no deny but at least one escalate', () => {
    const engine = new PolicyEngine({ limits: baseLimits });
    const decision = engine.evaluate(
      makeProposal({ amountUsd: 20 }),
      { ...baseCtx, dailySpendUsd: 40 },
    );
    expect(decision.decision).toBe('escalate');
    expect(decision.verdicts.find((v) => v.ruleId === 'daily-spend-cap')?.decision).toBe(
      'escalate',
    );
  });

  test('allow when every rule passes', () => {
    const engine = new PolicyEngine({ limits: baseLimits });
    const decision = engine.evaluate(makeProposal({ amountUsd: 10 }), baseCtx);
    expect(decision.decision).toBe('allow');
  });

  test('Hold proposals trivially allow with no verdicts', () => {
    const engine = new PolicyEngine({ limits: baseLimits });
    const decision = engine.evaluate(
      makeProposal({ rating: 'Hold', action: 'Hold', amountUsd: 0 }),
      baseCtx,
    );
    expect(decision.decision).toBe('allow');
    expect(decision.verdicts).toHaveLength(0);
  });

  test('rule list defaults to DEFAULT_RULES', () => {
    const engine = new PolicyEngine({ limits: baseLimits });
    expect(engine.rules).toBe(DEFAULT_RULES);
  });
});

// ─── InMemoryApprovalQueue ───────────────────────────────────────────────

describe('InMemoryApprovalQueue', () => {
  test('submit → decide approved resolves the awaiter', async () => {
    const q = new InMemoryApprovalQueue();
    const handle = await q.submit({ proposal: makeProposal(), verdicts: [] });
    const pending = q.decide(handle.id, 'approved', 'looks good');
    const rec = await handle.awaitDecision();
    await pending;
    expect(rec.status).toBe('approved');
    expect(rec.decisionNote).toBe('looks good');
    expect(rec.resolvedAt).not.toBeNull();
  });

  test('decide denied surfaces in the record', async () => {
    const q = new InMemoryApprovalQueue();
    const handle = await q.submit({ proposal: makeProposal(), verdicts: [] });
    await q.decide(handle.id, 'denied', 'too risky');
    const rec = await handle.awaitDecision();
    expect(rec.status).toBe('denied');
  });

  test('deciding twice throws', async () => {
    const q = new InMemoryApprovalQueue();
    const handle = await q.submit({ proposal: makeProposal(), verdicts: [] });
    await q.decide(handle.id, 'approved');
    await expect(q.decide(handle.id, 'denied')).rejects.toThrow(/already resolved/);
  });

  test('await after decide returns immediately', async () => {
    const q = new InMemoryApprovalQueue();
    const handle = await q.submit({ proposal: makeProposal(), verdicts: [] });
    await q.decide(handle.id, 'approved');
    const rec = await handle.awaitDecision();
    expect(rec.status).toBe('approved');
  });

  test('list returns all records', async () => {
    const q = new InMemoryApprovalQueue();
    await q.submit({ proposal: makeProposal({ decisionId: 'a' }), verdicts: [] });
    await q.submit({ proposal: makeProposal({ decisionId: 'b' }), verdicts: [] });
    const all = await q.list();
    expect(all).toHaveLength(2);
  });
});

// ─── Orchestrator integration ────────────────────────────────────────────

function buildOrchestrator(opts: {
  rating: 'Buy' | 'Hold';
  policy?: PolicyEngine;
  approvals?: InMemoryApprovalQueue;
  policyContext?: () => PolicyContext;
  config?: Partial<TradingFabricConfig>;
}) {
  const config: TradingFabricConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const tools = createDataflowTools({ client: mockClient() });
  const agents = createTradingAgents({ config, tools });
  const events: OrchestrationEvent[] = [];

  const orchestrator = new Orchestrator({
    agents,
    config,
    runtimeOptions: {
      modelProviders: {
        quick: makeProvider(config.llm_provider, opts.rating),
        deep: makeProvider(`${config.llm_provider}:deep`, opts.rating),
      },
      enableTracing: false,
    },
    policy: opts.policy,
    approvals: opts.approvals,
    policyContext: opts.policyContext,
    onEvent: (e) => events.push(e),
  });
  return { orchestrator, events };
}

describe('Orchestrator + policy integration', () => {
  test('no policy → result fields are null and no policy events emitted', async () => {
    const { orchestrator, events } = buildOrchestrator({ rating: 'Buy' });
    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });
    expect(result.proposal).toBeNull();
    expect(result.policy_decision).toBeNull();
    expect(result.approval).toBeNull();
    expect(events.find((e) => e.type === 'policy_evaluated')).toBeUndefined();
  });

  test('allowlist deny short-circuits — no approval queue consulted', async () => {
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 100,
        max_position_usd: 25,
        instrument_allowlist: ['MSFT'], // AAPL not on list
      },
    });
    const approvals = new InMemoryApprovalQueue();
    const { orchestrator, events } = buildOrchestrator({
      rating: 'Buy',
      policy,
      approvals,
    });
    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    expect(result.policy_decision?.decision).toBe('deny');
    expect(result.proposal?.ticker).toBe('AAPL');
    expect(result.proposal?.amountUsd).toBe(25);
    expect(result.approval).toBeNull();

    const policyEvent = events.find((e) => e.type === 'policy_evaluated');
    expect(policyEvent).toBeDefined();
    expect(events.find((e) => e.type === 'approval_required')).toBeUndefined();
    expect(await approvals.list()).toHaveLength(0);
  });

  test('escalation routes through approval queue → approved completes run', async () => {
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 20, // sizer will produce 25 → exceeds cap → escalate
        max_position_usd: 25,
        instrument_allowlist: [],
      },
    });
    const approvals = new InMemoryApprovalQueue();
    const { orchestrator, events } = buildOrchestrator({
      rating: 'Buy',
      policy,
      approvals,
    });

    const runPromise = orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    // Wait for approval_required to land then decide.
    let approvalId: string | null = null;
    for (let i = 0; i < 50 && approvalId === null; i++) {
      const evt = events.find((e) => e.type === 'approval_required');
      if (evt && evt.type === 'approval_required') approvalId = evt.approvalId;
      else await new Promise((r) => setTimeout(r, 5));
    }
    expect(approvalId).not.toBeNull();
    await approvals.decide(approvalId!, 'approved', 'manual override');

    const result = await runPromise;
    expect(result.policy_decision?.decision).toBe('escalate');
    expect(result.approval?.status).toBe('approved');
    expect(result.approval?.decisionNote).toBe('manual override');

    const resolved = events.find((e) => e.type === 'approval_resolved');
    expect(resolved).toBeDefined();
  });

  test('escalation routes through approval queue → denied completes run', async () => {
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 20,
        max_position_usd: 25,
        instrument_allowlist: [],
      },
    });
    const approvals = new InMemoryApprovalQueue();
    const { orchestrator, events } = buildOrchestrator({
      rating: 'Buy',
      policy,
      approvals,
    });

    const runPromise = orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    let approvalId: string | null = null;
    for (let i = 0; i < 50 && approvalId === null; i++) {
      const evt = events.find((e) => e.type === 'approval_required');
      if (evt && evt.type === 'approval_required') approvalId = evt.approvalId;
      else await new Promise((r) => setTimeout(r, 5));
    }
    await approvals.decide(approvalId!, 'denied', 'too risky now');

    const result = await runPromise;
    expect(result.approval?.status).toBe('denied');
  });

  test('escalation without an approvals queue collapses to deny', async () => {
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 20,
        max_position_usd: 25,
        instrument_allowlist: [],
      },
    });
    const { orchestrator } = buildOrchestrator({ rating: 'Buy', policy });
    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    expect(result.policy_decision?.decision).toBe('deny');
    expect(result.policy_decision?.primaryReason).toContain('approval queue');
    expect(result.approval).toBeNull();
  });

  test('Hold rating yields allow + no approval needed', async () => {
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 50,
        max_position_usd: 25,
        instrument_allowlist: [],
      },
    });
    const approvals = new InMemoryApprovalQueue();
    const { orchestrator, events } = buildOrchestrator({
      rating: 'Hold',
      policy,
      approvals,
    });
    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    expect(result.proposal?.action).toBe('Hold');
    expect(result.proposal?.amountUsd).toBe(0);
    expect(result.policy_decision?.decision).toBe('allow');
    expect(events.find((e) => e.type === 'approval_required')).toBeUndefined();
  });

  test('policyContext is consulted with the run input', async () => {
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 50,
        max_position_usd: 25,
        instrument_allowlist: [],
      },
    });
    let seenTicker: string | null = null;
    const approvals = new InMemoryApprovalQueue();
    const { orchestrator, events } = buildOrchestrator({
      rating: 'Buy',
      policy,
      approvals,
      policyContext: ((input: { ticker: string }) => {
        seenTicker = input.ticker;
        return {
          dailySpendUsd: 40, // 40 + 25 = 65 → exceeds cap → escalate
          lastTradeAt: null,
          lastAlphaReturn: null,
          now: () => new Date(),
        };
      }) as unknown as () => PolicyContext,
    });

    const runPromise = orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });
    let approvalId: string | null = null;
    for (let i = 0; i < 50 && approvalId === null; i++) {
      const evt = events.find((e) => e.type === 'approval_required');
      if (evt && evt.type === 'approval_required') approvalId = evt.approvalId;
      else await new Promise((r) => setTimeout(r, 5));
    }
    await approvals.decide(approvalId!, 'denied');
    const result = await runPromise;

    expect(seenTicker).toBe('AAPL');
    expect(result.policy_decision?.decision).toBe('escalate');
  });
});
