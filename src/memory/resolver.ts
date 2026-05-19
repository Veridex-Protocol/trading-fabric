/**
 * @packageDocumentation
 * @module memory/resolver
 * @description Bridges the memory log to the outside world: pricing
 * data + the reflector LLM. The Orchestrator invokes
 * `resolvePendingFor(ticker)` at the start of each run, which:
 *
 *   1. Loads all pending entries for `ticker`.
 *   2. For each one, fetches OHLCV from `trade_date` through
 *      `trade_date + holding_days + buffer` via the injected
 *      `PriceFetcher`. Computes raw return and alpha vs the
 *      configured benchmark.
 *   3. Invokes the `Reflector` to produce a post-mortem.
 *   4. Atomically writes all resolutions back to the log via
 *      `TradingMemoryLog.batchResolveEntries`.
 *
 * Entries whose price data is not yet available (too recent, delisted,
 * network failure) are skipped silently and retried on the next run.
 */

import type { TradingFabricConfig } from '../config/index.js';
import type { Ticker } from '../types/index.js';

import { resolveBenchmark } from './benchmark.js';
import type { TradingMemoryLog } from './log.js';
import { Reflector } from './reflector.js';
import type { MemoryEntry, ResolveEntryInput } from './types.js';

/** Minimal price-history surface. Returned bars must be daily, ascending. */
export interface PriceBar {
  date: string; // ISO YYYY-MM-DD
  close: number;
}

export interface PriceFetcher {
  /**
   * Return daily closes for `symbol` over `[start, end]` inclusive.
   * Implementations should return an empty array (not throw) when no
   * data is available — empty arrays are interpreted as "not ready
   * yet" and the entry is retried later.
   */
  fetch(symbol: string, start: string, end: string): Promise<PriceBar[]>;
}

export interface ResolverOptions {
  log: TradingMemoryLog;
  config: TradingFabricConfig;
  prices: PriceFetcher;
  reflector: Reflector;
  /** Holding window in trading days. Defaults to 5. */
  holdingDays?: number;
  /** Calendar-day buffer added when fetching prices to cope with weekends/holidays. */
  calendarBufferDays?: number;
  /** Override "today" for tests so we can replay deterministic windows. */
  now?: () => Date;
}

interface ResolutionEvent {
  type:
    | 'resolver_started'
    | 'resolver_skipped'
    | 'resolver_resolved'
    | 'resolver_completed'
    | 'resolver_failed';
  ticker: string;
  trade_date?: string;
  reason?: string;
  count?: number;
  raw_return?: number;
  alpha_return?: number;
  error?: unknown;
}

export class PendingResolver {
  private readonly log: TradingMemoryLog;
  private readonly config: TradingFabricConfig;
  private readonly prices: PriceFetcher;
  private readonly reflector: Reflector;
  private readonly holdingDays: number;
  private readonly calendarBufferDays: number;
  private readonly now: () => Date;

  constructor(opts: ResolverOptions) {
    this.log = opts.log;
    this.config = opts.config;
    this.prices = opts.prices;
    this.reflector = opts.reflector;
    this.holdingDays = opts.holdingDays ?? 5;
    this.calendarBufferDays = opts.calendarBufferDays ?? 7;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Resolve all currently-pending entries for `ticker` whose holding
   * window has elapsed. Returns the list of entries that were just
   * resolved (empty if none were ready).
   */
  async resolvePendingFor(
    ticker: Ticker,
    onEvent?: (e: ResolutionEvent) => void,
  ): Promise<MemoryEntry[]> {
    const pending = await this.log.getPendingForTicker(ticker);
    if (pending.length === 0) return [];

    onEvent?.({ type: 'resolver_started', ticker, count: pending.length });

    const benchmark = resolveBenchmark(ticker, this.config);
    const updates: ResolveEntryInput[] = [];

    for (const entry of pending) {
      try {
        const outcome = await this.computeOutcome(entry, benchmark);
        if (!outcome) {
          onEvent?.({
            type: 'resolver_skipped',
            ticker,
            trade_date: entry.trade_date,
            reason: 'price_unavailable',
          });
          continue;
        }
        const reflection = await this.reflector.reflect({
          ticker: entry.ticker,
          trade_date: entry.trade_date,
          decision: entry.decision,
          raw_return: outcome.raw_return,
          alpha_return: outcome.alpha_return,
          benchmark,
          holding_days: outcome.holding_days,
        });
        updates.push({
          ticker: entry.ticker,
          trade_date: entry.trade_date,
          raw_return: outcome.raw_return,
          alpha_return: outcome.alpha_return,
          holding_days: outcome.holding_days,
          benchmark,
          reflection,
        });
        onEvent?.({
          type: 'resolver_resolved',
          ticker,
          trade_date: entry.trade_date,
          raw_return: outcome.raw_return,
          alpha_return: outcome.alpha_return,
        });
      } catch (err) {
        onEvent?.({ type: 'resolver_failed', ticker, trade_date: entry.trade_date, error: err });
        // continue with the rest — never let one failed entry block others
      }
    }

    const resolved = await this.log.batchResolveEntries(updates);
    onEvent?.({ type: 'resolver_completed', ticker, count: resolved.length });
    return resolved;
  }

  private async computeOutcome(
    entry: MemoryEntry,
    benchmark: string,
  ): Promise<{ raw_return: number; alpha_return: number; holding_days: number } | null> {
    const endDate = this.endDateFor(entry.trade_date);
    const todayIso = this.now().toISOString().slice(0, 10);
    // If the window hasn't fully elapsed yet, skip — definitely not ready.
    if (endDate > todayIso) return null;

    const [stock, bench] = await Promise.all([
      this.prices.fetch(entry.ticker, entry.trade_date, endDate),
      this.prices.fetch(benchmark, entry.trade_date, endDate),
    ]);
    if (stock.length < 2 || bench.length < 2) return null;

    const usableDays = Math.min(this.holdingDays, stock.length - 1, bench.length - 1);
    if (usableDays < 1) return null;

    const stockStart = stock[0].close;
    const stockEnd = stock[usableDays].close;
    const benchStart = bench[0].close;
    const benchEnd = bench[usableDays].close;
    if (!stockStart || !benchStart) return null;

    const raw = (stockEnd - stockStart) / stockStart;
    const benchRet = (benchEnd - benchStart) / benchStart;
    return {
      raw_return: raw,
      alpha_return: raw - benchRet,
      holding_days: usableDays,
    };
  }

  private endDateFor(tradeDate: string): string {
    const [y, m, d] = tradeDate.split('-').map((s) => parseInt(s, 10));
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + this.holdingDays + this.calendarBufferDays);
    return dt.toISOString().slice(0, 10);
  }
}
