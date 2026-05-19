/**
 * Phase 3 tests — analyst tool surface.
 *
 * Validates the Zod-typed `tool()` contracts produced by
 * `createDataflowTools` against a mocked `DataflowClient`. We verify:
 *
 * - The full tool set is built (11 tools, all `safetyClass: 'read'`).
 * - Each tool's `execute` returns a `ToolResult` with prompt-ready text
 *   and a JSON attachment carrying the `_trust` marker.
 * - Zod input schemas reject malformed inputs (bad date, bad indicator,
 *   bad subreddit name).
 * - `metadata.trustClass` is correct per category and untrusted tools
 *   surface a `followUpHints` warning.
 * - `toolsForRole` matches the documented analyst whitelist.
 * - `hashToolManifest` is stable across reconstruction — guards the
 *   downstream TPA (Tool Poisoning Attack) detector.
 */

import { describe, expect, test } from 'vitest';

import { hashToolManifest } from '@veridex/agents';

import type { DataflowClient } from '../src/dataflows';
import {
  createDataflowTools,
  TRADING_FABRIC_TOOLS_BY_ROLE,
  toolsForRole,
} from '../src/tools';

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

const CTX = { runId: 'r', agentId: 'a', turnIndex: 0 } as const;

describe('createDataflowTools', () => {
  test('builds the full 11-tool surface, all read-only', () => {
    const tools = createDataflowTools({ client: makeMockClient() });
    expect(tools).toHaveLength(11);
    for (const t of tools) {
      expect(t.safetyClass).toBe('read');
      expect(t.idempotent).toBe(true);
    }
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'get_balance_sheet',
        'get_cashflow',
        'get_fundamentals',
        'get_global_news',
        'get_income_statement',
        'get_indicators',
        'get_insider_transactions',
        'get_news',
        'get_reddit_sentiment',
        'get_stock_data',
        'get_stocktwits',
      ].sort(),
    );
  });

  test('tags trust class on metadata and emits follow-up hints on untrusted tools', () => {
    const tools = createDataflowTools({ client: makeMockClient() });
    const trust = (name: string) =>
      tools.find((t) => t.name === name)?.metadata?.trustClass;

    expect(trust('get_stock_data')).toBe('trusted-data');
    expect(trust('get_indicators')).toBe('trusted-data');
    expect(trust('get_fundamentals')).toBe('trusted-data');
    expect(trust('get_balance_sheet')).toBe('trusted-data');
    expect(trust('get_cashflow')).toBe('trusted-data');
    expect(trust('get_income_statement')).toBe('trusted-data');
    expect(trust('get_insider_transactions')).toBe('trusted-data');

    expect(trust('get_news')).toBe('untrusted-content');
    expect(trust('get_global_news')).toBe('untrusted-content');
    expect(trust('get_reddit_sentiment')).toBe('untrusted-content');
    expect(trust('get_stocktwits')).toBe('untrusted-content');
  });
});

describe('tool execute returns structured ToolResult', () => {
  const cases: Array<{
    name: string;
    input: unknown;
    expectedTrust: 'trusted-data' | 'untrusted-content';
    expectHints: boolean;
  }> = [
    {
      name: 'get_stock_data',
      input: { symbol: 'aapl', start_date: '2025-01-02', end_date: '2025-01-31' },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
    {
      name: 'get_indicators',
      input: { symbol: 'AAPL', indicator: 'rsi', curr_date: '2025-02-01', look_back_days: 14 },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
    {
      name: 'get_news',
      input: { ticker: 'NVDA', start_date: '2025-02-01', end_date: '2025-02-22' },
      expectedTrust: 'untrusted-content',
      expectHints: true,
    },
    {
      name: 'get_global_news',
      input: { curr_date: '2025-03-19', look_back_days: 7 },
      expectedTrust: 'untrusted-content',
      expectHints: true,
    },
    {
      name: 'get_reddit_sentiment',
      input: { ticker: 'NVDA' },
      expectedTrust: 'untrusted-content',
      expectHints: true,
    },
    {
      name: 'get_stocktwits',
      input: { ticker: 'NVDA' },
      expectedTrust: 'untrusted-content',
      expectHints: true,
    },
    {
      name: 'get_insider_transactions',
      input: { symbol: 'AAPL' },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
    {
      name: 'get_fundamentals',
      input: { symbol: 'AAPL' },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
    {
      name: 'get_balance_sheet',
      input: { symbol: 'AAPL' },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
    {
      name: 'get_cashflow',
      input: { symbol: 'AAPL' },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
    {
      name: 'get_income_statement',
      input: { symbol: 'AAPL' },
      expectedTrust: 'trusted-data',
      expectHints: false,
    },
  ];

  for (const c of cases) {
    test(`${c.name} → success, JSON attachment with _trust=${c.expectedTrust}`, async () => {
      const tools = createDataflowTools({ client: makeMockClient() });
      const tool = tools.find((t) => t.name === c.name);
      expect(tool, c.name).toBeDefined();
      const parsed = tool!.input.parse(c.input);
      const result = await tool!.execute({ input: parsed, context: CTX });
      expect(result.success).toBe(true);
      expect(typeof result.llmOutput).toBe('string');
      expect((result.llmOutput as string).length).toBeGreaterThan(0);

      const attach = result.attachments?.[0];
      expect(attach).toBeDefined();
      expect(attach!.mimeType).toBe('application/json');
      const payload = JSON.parse(attach!.content as string);
      expect(payload._trust).toBe(c.expectedTrust);

      if (c.expectHints) {
        expect(result.followUpHints?.length ?? 0).toBeGreaterThan(0);
      }
    });
  }
});

describe('input validation', () => {
  const tools = createDataflowTools({ client: makeMockClient() });
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  test('rejects non-ISO dates', () => {
    expect(() =>
      byName('get_stock_data').input.parse({
        symbol: 'AAPL',
        start_date: '01/02/2025',
        end_date: '2025-01-31',
      }),
    ).toThrow();
  });

  test('rejects unsupported indicator keys', () => {
    expect(() =>
      byName('get_indicators').input.parse({
        symbol: 'AAPL',
        indicator: 'not_a_real_indicator',
        curr_date: '2025-02-01',
        look_back_days: 14,
      }),
    ).toThrow();
  });

  test('accepts every SUPPORTED_INDICATORS key', () => {
    const indicators = [
      'close_50_sma',
      'close_200_sma',
      'close_10_ema',
      'macd',
      'macds',
      'macdh',
      'rsi',
      'boll',
      'boll_ub',
      'boll_lb',
      'atr',
      'vwma',
      'mfi',
    ] as const;
    for (const ind of indicators) {
      expect(() =>
        byName('get_indicators').input.parse({
          symbol: 'AAPL',
          indicator: ind,
          curr_date: '2025-02-01',
        }),
      ).not.toThrow();
    }
  });

  test('rejects malformed subreddit names', () => {
    expect(() =>
      byName('get_reddit_sentiment').input.parse({
        ticker: 'NVDA',
        subreddits: ['wallstreetbets', 'has spaces!'],
      }),
    ).toThrow();
  });

  test('uppercases tickers via the TICKER transform', () => {
    const parsed = byName('get_stock_data').input.parse({
      symbol: '  aapl  ',
      start_date: '2025-01-02',
      end_date: '2025-01-31',
    });
    expect(parsed.symbol).toBe('AAPL');
  });
});

describe('role whitelist', () => {
  test('TRADING_FABRIC_TOOLS_BY_ROLE matches the documented allow-list', () => {
    expect(TRADING_FABRIC_TOOLS_BY_ROLE).toEqual({
      market: ['get_stock_data', 'get_indicators'],
      social: ['get_news', 'get_reddit_sentiment', 'get_stocktwits'],
      news: ['get_news', 'get_global_news', 'get_insider_transactions'],
      fundamentals: [
        'get_fundamentals',
        'get_balance_sheet',
        'get_cashflow',
        'get_income_statement',
      ],
    });
  });

  test('toolsForRole filters to the configured names', () => {
    const tools = createDataflowTools({ client: makeMockClient() });
    expect(toolsForRole(tools, 'market').map((t) => t.name)).toEqual([
      'get_stock_data',
      'get_indicators',
    ]);
    expect(toolsForRole(tools, 'fundamentals').map((t) => t.name).sort()).toEqual(
      [
        'get_balance_sheet',
        'get_cashflow',
        'get_fundamentals',
        'get_income_statement',
      ].sort(),
    );
  });
});

describe('TPA hash stability', () => {
  test('hashToolManifest is deterministic across reconstruction', async () => {
    const a = createDataflowTools({ client: makeMockClient() });
    const b = createDataflowTools({ client: makeMockClient() });
    const ha = await hashToolManifest(a);
    const hb = await hashToolManifest(b);
    expect(ha).toBe(hb);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
  });
});
