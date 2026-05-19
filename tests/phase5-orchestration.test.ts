/**
 * Phase 5 tests — `Orchestrator` walking the full 12-agent graph.
 *
 * No network. We register a `ScriptedProvider` that classifies each call
 * by inspecting the system prompt's unique phrase and returns a canned
 * response with `finishReason: 'stop'` so analyst agents never invoke
 * their registered tools.
 *
 * Assertions:
 * - All 4 analyst reports are produced in `selected_analysts` order.
 * - Debate captures `max_debate_rounds * 2` turns (bull/bear).
 * - Risk debate captures `max_risk_discuss_rounds * 3` turns (round-robin).
 * - `ResearchPlan` / `TraderProposal` / `PortfolioDecision` JSON parsed
 *   and rendered into the result.
 * - `execution` is `null` (Phase 7-8 deferred).
 * - Emits structured events for every phase transition.
 * - `runId` is unique per run.
 * - Quick agents route to the quick provider; deep agents route to deep.
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
import { Orchestrator, type OrchestrationEvent } from '../src/orchestration';
import { createDataflowTools } from '../src/tools';

// ─── Scripted provider ───────────────────────────────────────────────────

interface CallRecord {
  providerName: string;
  systemPrompt: string;
  userPrompt: string;
}

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
  throw new Error(`ScriptedProvider could not classify system prompt:\n${systemPrompt.slice(0, 200)}`);
}

const CANNED: Record<Role, string> = {
  market: '# Market analysis\n\nRSI overbought; MACD bullish crossover.',
  social: '# Sentiment report\n\nReddit cautiously optimistic; Stocktwits bullish.',
  news: '# News report\n\nNo material adverse headlines; positive sector momentum.',
  fundamentals: '# Fundamentals report\n\nStrong cashflow; balance sheet healthy.',
  bull: 'The growth runway here is enormous — analysts undersell the operating leverage.',
  bear: 'Multiple compression is inevitable as rates stay elevated and competition tightens.',
  'research-manager': JSON.stringify({
    recommendation: 'Overweight',
    rationale:
      'The bull case on operating leverage outweighs the bear concerns on multiple compression.',
    strategic_actions: 'Scale in over the next 2 weeks; cap exposure at 5% of book.',
  }),
  trader: JSON.stringify({
    action: 'Buy',
    reasoning: 'Plan is constructive; analyst signals align; risk/reward favorable.',
    entry_price: 187.5,
    stop_loss: 175.0,
    position_sizing: '5% of portfolio',
  }),
  aggressive:
    'The conservative view is overweighting tail risk that has historically not materialized in this sector.',
  neutral:
    'Both sides have merit — a phased entry balances upside capture with prudent drawdown limits.',
  conservative:
    'A 5% allocation is too aggressive given macro uncertainty; halve the size or wait for confirmation.',
  'portfolio-manager': JSON.stringify({
    rating: 'Overweight',
    executive_summary:
      'Phased entry at $187.50 with a hard stop at $175. Target 4% book weighting over 2 weeks.',
    investment_thesis:
      'Bull thesis on operating leverage is supported by fundamentals; risk team flagged sizing concerns which we partially incorporate.',
    price_target: 215,
    time_horizon: '3–6 months',
  }),
};

function makeScriptedProvider(name: string, calls: CallRecord[]): ModelProvider {
  return {
    name,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      calls.push({ providerName: name, systemPrompt: system, userPrompt: user });
      const role = classify(system);
      return {
        content: CANNED[role],
        model: `scripted-${role}`,
        provider: name,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

// ─── Test fixtures ───────────────────────────────────────────────────────

function makeMockClient(): DataflowClient {
  const stub = (label: string) => async () => `mock:${label}`;
  return {
    availableVendors: ['yfinance'],
    getStockData: stub('stock'),
    getIndicators: stub('indicators'),
    getFundamentals: stub('fundamentals'),
    getBalanceSheet: stub('balance'),
    getCashflow: stub('cashflow'),
    getIncomeStatement: stub('income'),
    getInsiderTransactions: stub('insider'),
    getNews: stub('news'),
    getGlobalNews: stub('global'),
    getRedditPosts: stub('reddit'),
    getStocktwitsMessages: stub('stocktwits'),
  } as unknown as DataflowClient;
}

function buildOrchestrator(overrides: Partial<TradingFabricConfig> = {}) {
  const config: TradingFabricConfig = { ...DEFAULT_CONFIG, ...overrides };
  const tools = createDataflowTools({ client: makeMockClient() });
  const agents = createTradingAgents({ config, tools });

  const calls: CallRecord[] = [];
  const quickProvider = makeScriptedProvider(config.llm_provider, calls);
  const deepProvider = makeScriptedProvider(`${config.llm_provider}:deep`, calls);

  const events: OrchestrationEvent[] = [];
  const orchestrator = new Orchestrator({
    agents,
    config,
    runtimeOptions: {
      modelProviders: {
        quick: quickProvider,
        deep: deepProvider,
      },
      enableTracing: false,
    },
    onEvent: (e) => events.push(e),
  });
  return { orchestrator, events, calls, config };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Orchestrator', () => {
  test('walks the full 12-agent graph and assembles a result', async () => {
    const { orchestrator } = buildOrchestrator();
    const result = await orchestrator.run({
      ticker: 'AAPL',
      trade_date: '2026-05-19',
    });

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.ticker).toBe('AAPL');
    expect(result.trade_date).toBe('2026-05-19');
    expect(result.asset_type).toBe('stock');
    expect(result.analysts).toEqual(['market', 'social', 'news', 'fundamentals']);

    expect(result.reports).toHaveLength(4);
    expect(result.reports.map((r) => r.kind)).toEqual(['market', 'social', 'news', 'fundamentals']);
    expect(result.reports[0].content).toContain('RSI overbought');

    // 1 debate round × (bull + bear) = 2 turns.
    expect(result.risk_debate).toHaveLength(3);
    expect(result.risk_debate.map((t) => t.speaker)).toEqual([
      'aggressive',
      'neutral',
      'conservative',
    ]);

    // Structured outputs rendered to markdown.
    expect(result.research_plan).toContain('**Recommendation**: Overweight');
    expect(result.trader_proposal).toContain('FINAL TRANSACTION PROPOSAL: **BUY**');
    expect(result.portfolio_decision).toContain('**Rating**: Overweight');

    expect(result.execution).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('respects max_debate_rounds and max_risk_discuss_rounds', async () => {
    const { orchestrator } = buildOrchestrator({
      max_debate_rounds: 2,
      max_risk_discuss_rounds: 2,
    });
    const result = await orchestrator.run({
      ticker: 'TSLA',
      trade_date: '2026-05-19',
    });
    expect(result.risk_debate).toHaveLength(6); // 2 rounds × 3 speakers
  });

  test('emits structured events in the expected order', async () => {
    const { orchestrator, events } = buildOrchestrator({
      selected_analysts: ['market', 'fundamentals'],
    });
    await orchestrator.run({ ticker: 'MSFT', trade_date: '2026-05-19' });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types[types.length - 1]).toBe('run_completed');
    expect(types).toContain('analyst_started');
    expect(types).toContain('analyst_completed');
    expect(types).toContain('debate_turn');
    expect(types).toContain('research_plan_ready');
    expect(types).toContain('trader_proposal_ready');
    expect(types).toContain('risk_turn');
    expect(types).toContain('portfolio_decision_ready');
  });

  test('routes researchManager and portfolioManager to the deep provider', async () => {
    const { orchestrator, calls, config } = buildOrchestrator();
    await orchestrator.run({ ticker: 'NVDA', trade_date: '2026-05-19' });

    const deepName = `${config.llm_provider}:deep`;
    const deepCalls = calls.filter((c) => c.providerName === deepName);
    const quickCalls = calls.filter((c) => c.providerName === config.llm_provider);

    // researchManager + portfolioManager → 2 deep calls.
    expect(deepCalls).toHaveLength(2);
    expect(deepCalls.some((c) => c.systemPrompt.includes('Research Manager and debate facilitator'))).toBe(true);
    expect(deepCalls.some((c) => c.systemPrompt.includes('Portfolio Manager'))).toBe(true);

    // Every other agent (4 analysts + bull + bear + trader + 3 risk = 10) hits quick.
    expect(quickCalls).toHaveLength(10);
  });

  test('produces unique runIds across runs', async () => {
    const { orchestrator } = buildOrchestrator();
    const a = await orchestrator.run({ ticker: 'AMD', trade_date: '2026-05-19' });
    const b = await orchestrator.run({ ticker: 'AMD', trade_date: '2026-05-19' });
    expect(a.runId).not.toBe(b.runId);
  });

  test('asset_type override propagates through the run', async () => {
    const { orchestrator } = buildOrchestrator();
    const result = await orchestrator.run({
      ticker: 'BTC',
      trade_date: '2026-05-19',
      asset_type: 'crypto',
    });
    expect(result.asset_type).toBe('crypto');
  });
});
