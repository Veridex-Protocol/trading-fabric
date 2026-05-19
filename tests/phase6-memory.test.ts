/**
 * Phase 6 tests — memory log + reflection loop.
 *
 * Coverage:
 *   1. `resolveBenchmark` — suffix map + explicit override.
 *   2. `TradingMemoryLog.storeDecision` — write + idempotency.
 *   3. `getPastContext` — same-ticker + cross-ticker formatting.
 *   4. `batchResolveEntries` — atomic resolution + rotation.
 *   5. `Reflector.reflect` — routes to the deep provider via AgentRuntime.
 *   6. `PendingResolver` — skips entries whose prices are not yet available.
 *   7. End-to-end: 3 sequential `Orchestrator.run()` calls with a mocked
 *      price fetcher. Run 1 writes a pending entry, run 2 resolves it
 *      (reflection written), run 3 reads the reflection via `past_context`.
 *   8. `FileMemoryStore` — JSONL persistence + atomic rewrite survive a
 *      reload.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ModelMessage,
  ModelProvider,
  ModelResponse,
} from '@veridex/agents';

import { createTradingAgents } from '../src/agents';
import { DEFAULT_CONFIG, type TradingFabricConfig } from '../src/config';
import type { DataflowClient } from '../src/dataflows';
import { Orchestrator } from '../src/orchestration';
import { createDataflowTools } from '../src/tools';
import {
  FileMemoryStore,
  InMemoryMemoryStore,
  PendingResolver,
  Reflector,
  TradingMemoryLog,
  resolveBenchmark,
  type PriceBar,
  type PriceFetcher,
} from '../src/memory';

// ─── Scripted provider (mirrors Phase 5 pattern) ─────────────────────────

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
  | 'portfolio-manager'
  | 'reflector';

function classify(systemPrompt: string): Role {
  if (systemPrompt.includes('senior portfolio reviewer')) return 'reflector';
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
  throw new Error(`Cannot classify:\n${systemPrompt.slice(0, 200)}`);
}

function cannedFor(role: Role, userPrompt: string): string {
  switch (role) {
    case 'market':
      return '# Market analysis\n\nRSI overbought; MACD bullish crossover.';
    case 'social':
      return '# Sentiment report\n\nReddit cautiously optimistic.';
    case 'news':
      return '# News report\n\nNo material adverse headlines.';
    case 'fundamentals':
      return '# Fundamentals\n\nHealthy balance sheet.';
    case 'bull':
      return 'Operating leverage is enormous.';
    case 'bear':
      return 'Multiple compression looms.';
    case 'research-manager':
      return JSON.stringify({
        recommendation: 'Overweight',
        rationale: 'Bull case wins on operating leverage.',
        strategic_actions: 'Scale in over 2 weeks.',
      });
    case 'trader':
      return JSON.stringify({
        action: 'Buy',
        reasoning: 'Plan is constructive.',
        entry_price: 187.5,
        stop_loss: 175.0,
        position_sizing: '5% of portfolio',
      });
    case 'aggressive':
      return 'Conservative view overweights tail risk.';
    case 'neutral':
      return 'A phased entry balances both sides.';
    case 'conservative':
      return 'Halve the size; macro uncertainty is real.';
    case 'portfolio-manager':
      return JSON.stringify({
        rating: 'Overweight',
        executive_summary: 'Phased entry at $187.50.',
        investment_thesis: 'Operating leverage thesis supported.',
        price_target: 215,
        time_horizon: '3-6 months',
      });
    case 'reflector':
      // Echo a snippet of the user prompt so the test can assert that
      // the reflection actually saw the realised return.
      return `Reflection: alpha was visible (${extractAlpha(userPrompt)}). Thesis on operating leverage held; sizing could have been tighter.`;
  }
}

function extractAlpha(userPrompt: string): string {
  const m = userPrompt.match(/Alpha vs [^:]+: ([+-][0-9.]+%)/);
  return m ? m[1] : '?';
}

function makeScriptedProvider(name: string, calls: CallRecord[]): ModelProvider {
  return {
    name,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      calls.push({ providerName: name, systemPrompt: system, userPrompt: user });
      const role = classify(system);
      return {
        content: cannedFor(role, user),
        model: `scripted-${role}`,
        provider: name,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

// ─── Dataflow stub ───────────────────────────────────────────────────────

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

// ─── Price fetcher stub ──────────────────────────────────────────────────

class ScriptedPriceFetcher implements PriceFetcher {
  /** Map of `${symbol}|${baseDate}` → ordered close prices. */
  series = new Map<string, number[]>();

  set(symbol: string, baseDate: string, closes: number[]): void {
    this.series.set(`${symbol.toUpperCase()}|${baseDate}`, closes);
  }

  async fetch(symbol: string, start: string, _end: string): Promise<PriceBar[]> {
    const closes = this.series.get(`${symbol.toUpperCase()}|${start}`);
    if (!closes) return []; // simulate "no data starting on this date"
    return closes.map((close, i) => ({
      date: addDays(start, i),
      close,
    }));
  }
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('resolveBenchmark', () => {
  test('uses explicit override when set', () => {
    const cfg = { ...DEFAULT_CONFIG, benchmark_ticker: 'QQQ' };
    expect(resolveBenchmark('7203.T', cfg)).toBe('QQQ');
    expect(resolveBenchmark('AAPL', cfg)).toBe('QQQ');
  });

  test('matches longest suffix and falls back to SPY', () => {
    const cfg = { ...DEFAULT_CONFIG };
    expect(resolveBenchmark('7203.T', cfg)).toBe('^N225');
    expect(resolveBenchmark('SHOP.TO', cfg)).toBe('^GSPTSE'); // longer suffix beats `.T`
    expect(resolveBenchmark('AAPL', cfg)).toBe('SPY');
    expect(resolveBenchmark('BRK.B', cfg)).toBe('SPY'); // unknown suffix → default
  });
});

describe('TradingMemoryLog', () => {
  test('storeDecision is idempotent for matching pending entries', async () => {
    const log = new TradingMemoryLog({ store: new InMemoryMemoryStore() });
    const a = await log.storeDecision({
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      rating: 'Buy',
      decision: 'Buy AAPL',
    });
    const b = await log.storeDecision({
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      rating: 'Buy',
      decision: 'Buy AAPL again',
    });
    expect(a.id).toBe(b.id);
    expect((await log.loadAll())).toHaveLength(1);
  });

  test('getPastContext respects nSame / nCross caps and ignores pending', async () => {
    const log = new TradingMemoryLog({ store: new InMemoryMemoryStore() });
    // Three resolved AAPL entries.
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await log.storeDecision({ ticker: 'AAPL', trade_date: date, rating: 'Buy', decision: `d ${date}` });
      await log.resolveEntry({
        ticker: 'AAPL',
        trade_date: date,
        raw_return: 0.05,
        alpha_return: 0.02,
        holding_days: 5,
        benchmark: 'SPY',
        reflection: `reflection ${date}`,
      });
    }
    // One MSFT (cross-ticker) resolved.
    await log.storeDecision({ ticker: 'MSFT', trade_date: '2026-02-15', rating: 'Hold', decision: 'd msft' });
    await log.resolveEntry({
      ticker: 'MSFT',
      trade_date: '2026-02-15',
      raw_return: -0.01,
      alpha_return: 0.0,
      holding_days: 5,
      benchmark: 'SPY',
      reflection: 'msft reflection',
    });
    // One AAPL pending — must NOT appear in context.
    await log.storeDecision({ ticker: 'AAPL', trade_date: '2026-04-01', rating: 'Sell', decision: 'pending' });

    const ctx = await log.getPastContext('AAPL', { nSame: 2, nCross: 1 });
    expect(ctx).toContain('Past analyses of AAPL');
    expect(ctx).toContain('reflection 2026-03-01');
    expect(ctx).toContain('reflection 2026-02-01');
    expect(ctx).not.toContain('reflection 2026-01-01'); // capped at nSame=2
    expect(ctx).toContain('Recent cross-ticker lessons');
    expect(ctx).toContain('msft reflection');
    expect(ctx).not.toContain('pending'); // pending entry filtered out
  });

  test('batchResolveEntries applies updates atomically + rotates resolved entries', async () => {
    const log = new TradingMemoryLog({
      store: new InMemoryMemoryStore(),
      maxEntries: 2, // tight cap so we can see rotation
    });
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await log.storeDecision({ ticker: 'AAPL', trade_date: date, rating: 'Buy', decision: `d ${date}` });
    }
    const resolved = await log.batchResolveEntries(
      ['2026-01-01', '2026-02-01', '2026-03-01'].map((d) => ({
        ticker: 'AAPL',
        trade_date: d,
        raw_return: 0.01,
        alpha_return: 0.005,
        holding_days: 5,
        benchmark: 'SPY',
        reflection: `r ${d}`,
      })),
    );
    expect(resolved).toHaveLength(3);
    const all = await log.loadAll();
    // Rotation kept only the 2 newest resolved entries.
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.trade_date)).toEqual(['2026-02-01', '2026-03-01']);
  });
});

describe('FileMemoryStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tf-memlog-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('persists entries across instances + survives a rewrite', async () => {
    const file = path.join(dir, 'memory.jsonl');
    const log = new TradingMemoryLog({ store: new FileMemoryStore(file) });
    await log.storeDecision({ ticker: 'AAPL', trade_date: '2026-05-19', rating: 'Buy', decision: 'd' });
    await log.resolveEntry({
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      raw_return: 0.04,
      alpha_return: 0.02,
      holding_days: 5,
      benchmark: 'SPY',
      reflection: 'r',
    });

    // New instance reading the same file sees the resolved entry.
    const log2 = new TradingMemoryLog({ store: new FileMemoryStore(file) });
    const all = await log2.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('resolved');
    expect(all[0].reflection).toBe('r');
    expect(all[0].alpha_return).toBe(0.02);
  });
});

describe('Reflector', () => {
  test('routes to the deep provider through AgentRuntime', async () => {
    const calls: CallRecord[] = [];
    const deep = makeScriptedProvider(`${DEFAULT_CONFIG.llm_provider}:deep`, calls);
    const reflector = new Reflector({
      config: DEFAULT_CONFIG,
      runtimeOptions: { modelProviders: { deep }, enableTracing: false },
    });
    const out = await reflector.reflect({
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      decision: 'Buy AAPL',
      raw_return: 0.04,
      alpha_return: 0.02,
      benchmark: 'SPY',
      holding_days: 5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].providerName).toBe(`${DEFAULT_CONFIG.llm_provider}:deep`);
    expect(calls[0].systemPrompt).toContain('senior portfolio reviewer');
    expect(out).toContain('+2.00%'); // alpha was passed to the LLM
  });
});

describe('PendingResolver', () => {
  test('skips entries whose price data is not yet available', async () => {
    const log = new TradingMemoryLog({ store: new InMemoryMemoryStore() });
    await log.storeDecision({ ticker: 'AAPL', trade_date: '2026-05-19', rating: 'Buy', decision: 'd' });

    const calls: CallRecord[] = [];
    const deep = makeScriptedProvider(`${DEFAULT_CONFIG.llm_provider}:deep`, calls);
    const reflector = new Reflector({
      config: DEFAULT_CONFIG,
      runtimeOptions: { modelProviders: { deep }, enableTracing: false },
    });

    const resolver = new PendingResolver({
      log,
      config: DEFAULT_CONFIG,
      prices: new ScriptedPriceFetcher(), // empty — nothing available
      reflector,
      // "Today" is well past trade_date, so window has elapsed, but
      // the fetcher returns no bars → resolver must skip cleanly.
      now: () => new Date('2026-06-01T00:00:00Z'),
    });

    const resolved = await resolver.resolvePendingFor('AAPL');
    expect(resolved).toHaveLength(0);
    expect(calls).toHaveLength(0); // reflector never invoked
    expect(await log.getPending()).toHaveLength(1); // still pending, will retry
  });
});

// ─── End-to-end: 3 sequential runs ───────────────────────────────────────

function buildHarness(overrides: Partial<TradingFabricConfig> = {}) {
  const config: TradingFabricConfig = { ...DEFAULT_CONFIG, ...overrides };
  const tools = createDataflowTools({ client: makeMockClient() });
  const agents = createTradingAgents({ config, tools });

  const calls: CallRecord[] = [];
  const quickProvider = makeScriptedProvider(config.llm_provider, calls);
  const deepProvider = makeScriptedProvider(`${config.llm_provider}:deep`, calls);

  const runtimeOptions = {
    modelProviders: { quick: quickProvider, deep: deepProvider },
    enableTracing: false,
  };

  const memory = new TradingMemoryLog({ store: new InMemoryMemoryStore() });
  const prices = new ScriptedPriceFetcher();
  const reflector = new Reflector({ config, runtimeOptions });

  return { config, agents, calls, runtimeOptions, memory, prices, reflector };
}

describe('Orchestrator + memory end-to-end', () => {
  test('three sequential runs: store → resolve → reflection feeds past_context', async () => {
    const h = buildHarness();

    // Day-1 prices: AAPL rises 4%, SPY rises 2% → alpha +2%.
    h.prices.set('AAPL', '2026-05-19', [100, 101, 102, 103, 104, 104]);
    h.prices.set('SPY', '2026-05-19', [400, 401, 402, 403, 404, 408]);

    // ── Run 1: no past_context, writes a pending entry ──
    const orch1 = new Orchestrator({
      agents: h.agents,
      config: h.config,
      runtimeOptions: h.runtimeOptions,
      memory: h.memory,
      resolver: new PendingResolver({
        log: h.memory,
        config: h.config,
        prices: h.prices,
        reflector: h.reflector,
        now: () => new Date('2026-05-19T00:00:00Z'), // same day → can't resolve yet
      }),
    });
    const r1 = await orch1.run({ ticker: 'AAPL', trade_date: '2026-05-19' });
    expect(r1.portfolio_decision).toContain('Overweight');
    const pending = await h.memory.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].rating).toBe('Overweight');

    // ── Run 2: window has elapsed → resolver writes reflection ──
    const events2: unknown[] = [];
    const orch2 = new Orchestrator({
      agents: h.agents,
      config: h.config,
      runtimeOptions: h.runtimeOptions,
      memory: h.memory,
      onEvent: (e) => events2.push(e),
      resolver: new PendingResolver({
        log: h.memory,
        config: h.config,
        prices: h.prices,
        reflector: h.reflector,
        now: () => new Date('2026-06-10T00:00:00Z'), // well past window
      }),
    });
    // Use a different trade_date so we get a second pending entry too.
    h.prices.set('AAPL', '2026-06-09', [110, 111, 112, 113, 114, 115]);
    h.prices.set('SPY', '2026-06-09', [410, 411, 412, 413, 414, 415]);
    await orch2.run({ ticker: 'AAPL', trade_date: '2026-06-09' });

    // Run-1 entry should now be resolved with reflection text.
    const all = await h.memory.loadAll();
    const r1Entry = all.find((e) => e.trade_date === '2026-05-19');
    expect(r1Entry?.status).toBe('resolved');
    expect(r1Entry?.alpha_return).toBeCloseTo(0.04 - 0.02, 4);
    expect(r1Entry?.reflection).toContain('Reflection');
    expect(r1Entry?.reflection).toContain('+2.00%');

    // ── Run 3: past_context should now include run-1's reflection ──
    const reflectorCallsBefore = h.calls.filter((c) =>
      c.systemPrompt.includes('senior portfolio reviewer'),
    ).length;
    const orch3 = new Orchestrator({
      agents: h.agents,
      config: h.config,
      runtimeOptions: h.runtimeOptions,
      memory: h.memory,
      // No resolver this run — we only care that past_context surfaces.
    });
    h.prices.set('AAPL', '2026-07-01', [120, 121, 122, 123, 124, 125]);
    await orch3.run({ ticker: 'AAPL', trade_date: '2026-07-01' });

    // Analyst calls in run 3 should carry the reflection in their user prompt.
    const marketCalls = h.calls.filter((c) =>
      c.systemPrompt.includes('select the **most relevant indicators**'),
    );
    const lastMarketCall = marketCalls[marketCalls.length - 1];
    expect(lastMarketCall.userPrompt).toContain('Past analyses of AAPL');
    expect(lastMarketCall.userPrompt).toContain('Reflection');

    // No new reflector calls in run 3 (no resolver was wired).
    const reflectorCallsAfter = h.calls.filter((c) =>
      c.systemPrompt.includes('senior portfolio reviewer'),
    ).length;
    expect(reflectorCallsAfter).toBe(reflectorCallsBefore);
  });
});
