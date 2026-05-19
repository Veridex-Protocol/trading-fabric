/**
 * @packageDocumentation
 * @module dataflows/alphaVantage
 * @description Alpha Vantage vendor (paid; key-gated by `ALPHA_VANTAGE_API_KEY`).
 *
 * Functions mirror `tradingagents/dataflows/alpha_vantage*.py`. Returns
 * prompt-ready text. Detects rate-limit-as-JSON-200 responses and raises
 * `AlphaVantageRateLimitError` so the vendor router can fall back to Yahoo.
 */

import type { FileCache } from './cache';
import { httpRequest } from './http';
import { AlphaVantageRateLimitError } from './types';

const API_BASE = 'https://www.alphavantage.co/query';

export interface AlphaVantageDeps {
  apiKey: string;
  cache: FileCache;
  entitlement?: string;
  defaultTtlMs?: number;
}

function detectRateLimit(body: string): boolean {
  if (!body.trimStart().startsWith('{')) return false;
  try {
    const obj = JSON.parse(body);
    if (typeof obj?.Information === 'string') {
      const info = (obj.Information as string).toLowerCase();
      return info.includes('rate limit') || info.includes('api key');
    }
    return false;
  } catch {
    return false;
  }
}

async function call(deps: AlphaVantageDeps, params: Record<string, string>): Promise<string> {
  const qp = new URLSearchParams({ ...params, apikey: deps.apiKey, source: 'trading_fabric' });
  if (deps.entitlement) qp.set('entitlement', deps.entitlement);
  const url = `${API_BASE}?${qp.toString()}`;
  const body = await httpRequest(url, {
    timeoutMs: 20_000,
    retries: 2,
    isTransient: detectRateLimit,
  });
  if (detectRateLimit(body)) {
    const obj = JSON.parse(body) as { Information?: string };
    throw new AlphaVantageRateLimitError(`Alpha Vantage rate limit exceeded: ${obj.Information ?? ''}`);
  }
  return body;
}

function memoText(deps: AlphaVantageDeps, key: string, fn: () => Promise<string>): Promise<string> {
  return deps.cache.memo<string>(key, deps.defaultTtlMs, fn);
}

function filterCsvByDateRange(csv: string, start: string, end: string): string {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return csv;
  const header = lines[0];
  const startT = new Date(`${start}T00:00:00Z`).getTime();
  const endT = new Date(`${end}T23:59:59Z`).getTime();
  const filtered = lines.slice(1).filter((line) => {
    const dateField = line.split(',')[0];
    if (!dateField) return false;
    const t = Date.parse(dateField);
    if (Number.isNaN(t)) return true;
    return t >= startT && t <= endT;
  });
  return [header, ...filtered].join('\n');
}

// ── Core surfaces ───────────────────────────────────────────────────────────

export function getAlphaVantageStock(
  symbol: string,
  startDate: string,
  endDate: string,
  deps: AlphaVantageDeps,
): Promise<string> {
  return memoText(deps, `av:stock:${symbol}:${startDate}:${endDate}`, async () => {
    const csv = await call(deps, {
      function: 'TIME_SERIES_DAILY_ADJUSTED',
      symbol: symbol.toUpperCase(),
      outputsize: 'full',
      datatype: 'csv',
    });
    const filtered = filterCsvByDateRange(csv, startDate, endDate);
    return [
      `# Alpha Vantage daily-adjusted data for ${symbol.toUpperCase()} from ${startDate} to ${endDate}`,
      filtered,
    ].join('\n');
  });
}

const AV_INDICATOR_FN: Record<string, string> = {
  close_50_sma: 'SMA',
  close_200_sma: 'SMA',
  close_10_ema: 'EMA',
  macd: 'MACD',
  macds: 'MACD',
  macdh: 'MACD',
  rsi: 'RSI',
  boll: 'BBANDS',
  boll_ub: 'BBANDS',
  boll_lb: 'BBANDS',
  atr: 'ATR',
  vwma: 'VWAP', // closest AV equivalent; not identical
  mfi: 'MFI',
};

export function getAlphaVantageIndicator(
  symbol: string,
  indicator: string,
  currDate: string,
  lookBackDays: number,
  deps: AlphaVantageDeps,
): Promise<string> {
  const fn = AV_INDICATOR_FN[indicator];
  if (!fn) {
    return Promise.reject(new Error(`Indicator ${indicator} not mapped to Alpha Vantage function`));
  }
  return memoText(deps, `av:ind:${symbol}:${indicator}:${currDate}:${lookBackDays}`, async () => {
    const params: Record<string, string> = {
      function: fn,
      symbol: symbol.toUpperCase(),
      interval: 'daily',
      series_type: 'close',
      datatype: 'csv',
    };
    if (fn === 'SMA' || fn === 'EMA') {
      params.time_period = indicator.includes('200') ? '200' : indicator.includes('50') ? '50' : '10';
    } else if (fn === 'RSI' || fn === 'ATR' || fn === 'MFI') {
      params.time_period = '14';
    } else if (fn === 'BBANDS') {
      params.time_period = '20';
    }
    const csv = await call(deps, params);
    const endDate = currDate;
    const start = new Date(`${currDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - lookBackDays);
    const startDate = start.toISOString().slice(0, 10);
    const filtered = filterCsvByDateRange(csv, startDate, endDate);
    return `## ${indicator} (Alpha Vantage ${fn}) from ${startDate} to ${endDate}:\n\n${filtered}`;
  });
}

export function getAlphaVantageFundamentals(symbol: string, deps: AlphaVantageDeps): Promise<string> {
  return memoText(deps, `av:fund:${symbol}`, async () => {
    const json = await call(deps, { function: 'OVERVIEW', symbol: symbol.toUpperCase() });
    return `## ${symbol.toUpperCase()} Fundamentals (Alpha Vantage OVERVIEW):\n\n\`\`\`json\n${json}\n\`\`\``;
  });
}

function fundamentalReport(fn: string, label: string) {
  return (symbol: string, deps: AlphaVantageDeps): Promise<string> =>
    memoText(deps, `av:${fn}:${symbol}`, async () => {
      const json = await call(deps, { function: fn, symbol: symbol.toUpperCase() });
      return `## ${symbol.toUpperCase()} ${label} (Alpha Vantage):\n\n\`\`\`json\n${json}\n\`\`\``;
    });
}

export const getAlphaVantageBalanceSheet = fundamentalReport('BALANCE_SHEET', 'Balance Sheet');
export const getAlphaVantageCashflow = fundamentalReport('CASH_FLOW', 'Cashflow');
export const getAlphaVantageIncomeStatement = fundamentalReport('INCOME_STATEMENT', 'Income Statement');
export const getAlphaVantageInsiderTransactions = fundamentalReport('INSIDER_TRANSACTIONS', 'Insider Transactions');

export function getAlphaVantageNews(
  ticker: string,
  startDate: string,
  endDate: string,
  deps: AlphaVantageDeps,
): Promise<string> {
  return memoText(deps, `av:news:${ticker}:${startDate}:${endDate}`, async () => {
    const json = await call(deps, {
      function: 'NEWS_SENTIMENT',
      tickers: ticker.toUpperCase(),
      time_from: `${startDate.replace(/-/g, '')}T0000`,
      time_to: `${endDate.replace(/-/g, '')}T2359`,
      limit: '50',
    });
    return `## ${ticker.toUpperCase()} News (Alpha Vantage), ${startDate} → ${endDate}:\n\n\`\`\`json\n${json}\n\`\`\``;
  });
}

export function getAlphaVantageGlobalNews(
  currDate: string,
  lookBackDays: number,
  deps: AlphaVantageDeps,
): Promise<string> {
  return memoText(deps, `av:globalnews:${currDate}:${lookBackDays}`, async () => {
    const end = new Date(`${currDate}T00:00:00Z`);
    const start = new Date(end.getTime());
    start.setUTCDate(start.getUTCDate() - lookBackDays);
    const json = await call(deps, {
      function: 'NEWS_SENTIMENT',
      topics: 'economy_macro,economy_monetary,economy_fiscal,financial_markets',
      time_from: `${start.toISOString().slice(0, 10).replace(/-/g, '')}T0000`,
      time_to: `${currDate.replace(/-/g, '')}T2359`,
      limit: '50',
    });
    return `## Global Macro News (Alpha Vantage), ${start.toISOString().slice(0, 10)} → ${currDate}:\n\n\`\`\`json\n${json}\n\`\`\``;
  });
}
