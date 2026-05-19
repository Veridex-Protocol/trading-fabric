/**
 * Phase 4 tests — `AgentDefinition` set produced by `createTradingAgents`.
 *
 * Pure-configuration phase: no LLM calls, no network, no I/O. We assert:
 *
 * - The factory yields exactly 12 agents with the expected ids/names.
 * - Tool wiring matches `TRADING_FABRIC_TOOLS_BY_ROLE` (analysts) and is
 *   empty for researchers, the trader, risk debators, and managers.
 * - Sentiment/news instructions carry the prompt-injection security note.
 * - The market-analyst prompt includes the full indicator menu.
 * - Structured-output agents tag `metadata.structuredOutputSchema`.
 * - `researchManager` + `portfolioManager` use the `:deep` provider; the
 *   rest use the quick provider.
 * - Output language override propagates into instructions.
 * - Asset-type override switches "stock" → "asset" wording in researcher
 *   prompts.
 */

import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config';
import {
  createDataflowTools,
  TRADING_FABRIC_TOOLS_BY_ROLE,
} from '../src/tools';
import type { DataflowClient } from '../src/dataflows';
import { createTradingAgents } from '../src/agents';

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

function buildSet(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const tools = createDataflowTools({ client: makeMockClient() });
  return createTradingAgents({ config, tools });
}

describe('createTradingAgents', () => {
  test('yields the full 12-agent set with unique ids', () => {
    const set = buildSet();
    const agents = Object.values(set);
    expect(agents).toHaveLength(12);
    const ids = agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(12);
    for (const id of ids) expect(id).toMatch(/^trading-fabric:/);
  });

  test('every agent has non-empty instructions and a model config', () => {
    const set = buildSet();
    for (const agent of Object.values(set)) {
      expect(agent.instructions.length).toBeGreaterThan(50);
      expect(agent.model.provider).toBeTruthy();
      expect(agent.model.model).toBeTruthy();
      expect(agent.metadata?.tradingFabric).toBe(true);
    }
  });

  test('analysts get role-scoped tools matching TRADING_FABRIC_TOOLS_BY_ROLE', () => {
    const set = buildSet();
    const pairs: Array<[keyof typeof set, keyof typeof TRADING_FABRIC_TOOLS_BY_ROLE]> = [
      ['marketAnalyst', 'market'],
      ['sentimentAnalyst', 'social'],
      ['newsAnalyst', 'news'],
      ['fundamentalsAnalyst', 'fundamentals'],
    ];
    for (const [agentKey, role] of pairs) {
      const agent = set[agentKey];
      const names = (agent.tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual([...TRADING_FABRIC_TOOLS_BY_ROLE[role]].sort());
    }
  });

  test('researchers, trader, risk debators, and managers get no tools', () => {
    const set = buildSet();
    const toolless = [
      set.bullResearcher,
      set.bearResearcher,
      set.researchManager,
      set.trader,
      set.aggressiveRisk,
      set.neutralRisk,
      set.conservativeRisk,
      set.portfolioManager,
    ];
    for (const agent of toolless) {
      expect(agent.tools ?? []).toEqual([]);
    }
  });

  test('analyst instructions embed the collaborator preamble + tool names', () => {
    const set = buildSet();
    const market = set.marketAnalyst.instructions;
    expect(market).toContain('You are a helpful AI assistant');
    expect(market).toContain('get_stock_data');
    expect(market).toContain('get_indicators');

    // Market analyst must carry the full indicator menu.
    for (const indicator of [
      'close_50_sma',
      'close_200_sma',
      'macd',
      'rsi',
      'boll_ub',
      'atr',
      'vwma',
    ]) {
      expect(market).toContain(indicator);
    }
  });

  test('sentiment + news instructions carry the prompt-injection security note', () => {
    const set = buildSet();
    expect(set.sentimentAnalyst.instructions).toContain('attacker-controllable');
    expect(set.newsAnalyst.instructions).toContain('attacker-controllable');
  });

  test('structured-output agents advertise their schema in metadata', () => {
    const set = buildSet();
    expect(set.researchManager.metadata?.structuredOutputSchema).toBe(
      'ResearchPlan',
    );
    expect(set.trader.metadata?.structuredOutputSchema).toBe('TraderProposal');
    expect(set.portfolioManager.metadata?.structuredOutputSchema).toBe(
      'PortfolioDecision',
    );
  });

  test('research + portfolio managers use the deep provider; rest use quick', () => {
    const set = buildSet();
    const quickName = DEFAULT_CONFIG.llm_provider;
    const deepName = `${DEFAULT_CONFIG.llm_provider}:deep`;

    expect(set.researchManager.model.provider).toBe(deepName);
    expect(set.researchManager.model.model).toBe(DEFAULT_CONFIG.deep_think_llm);
    expect(set.portfolioManager.model.provider).toBe(deepName);
    expect(set.portfolioManager.model.model).toBe(DEFAULT_CONFIG.deep_think_llm);

    for (const agent of [
      set.marketAnalyst,
      set.sentimentAnalyst,
      set.newsAnalyst,
      set.fundamentalsAnalyst,
      set.bullResearcher,
      set.bearResearcher,
      set.trader,
      set.aggressiveRisk,
      set.neutralRisk,
      set.conservativeRisk,
    ]) {
      expect(agent.model.provider).toBe(quickName);
      expect(agent.model.model).toBe(DEFAULT_CONFIG.quick_think_llm);
    }
  });

  test('output language override propagates into instructions', () => {
    const set = buildSet({ output_language: 'Japanese' });
    expect(set.marketAnalyst.instructions).toContain('Produce the report in Japanese');
    expect(set.fundamentalsAnalyst.instructions).toContain(
      'Produce the report in Japanese',
    );
  });

  test('crypto asset-type override switches researcher wording', () => {
    const stockSet = buildSet({ default_asset_type: 'stock' });
    const cryptoSet = buildSet({ default_asset_type: 'crypto' });
    expect(stockSet.bullResearcher.instructions).toContain(
      'advocating for investing in the stock',
    );
    expect(cryptoSet.bullResearcher.instructions).toContain(
      'advocating for investing in the asset',
    );
    expect(cryptoSet.bearResearcher.instructions).toContain(
      'investing in the asset',
    );
  });

  test('expectedTools metadata mirrors the role whitelist', () => {
    const set = buildSet();
    expect(set.marketAnalyst.metadata?.expectedTools).toEqual(
      TRADING_FABRIC_TOOLS_BY_ROLE.market,
    );
    expect(set.newsAnalyst.metadata?.expectedTools).toEqual(
      TRADING_FABRIC_TOOLS_BY_ROLE.news,
    );
  });
});
