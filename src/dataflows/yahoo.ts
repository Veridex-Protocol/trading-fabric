/**
 * @packageDocumentation
 * @module dataflows/yahoo
 * @description Yahoo Finance vendor. Uses the public chart/search endpoints
 * directly via `fetch` — no `yahoo-finance2` dependency.
 *
 * Endpoints used:
 * - OHLCV: `query1.finance.yahoo.com/v8/finance/chart/{symbol}`
 * - News:  `query1.finance.yahoo.com/v1/finance/search?q=...`
 *
 * All public functions return **prompt-ready strings**, faithful to the
 * Python interface, with structured helpers exposed for the TUI.
 */

import type { FileCache } from './cache';
import { httpGetJson } from './http';
import type { NewsItem, OhlcvBar } from './types';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_BASE = 'https://query1.finance.yahoo.com/v1/finance/search';

interface ChartResponse {
  chart: {
    result?: Array<{
      meta: { symbol: string };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open?: number[];
          high?: number[];
          low?: number[];
          close?: number[];
          volume?: number[];
        }>;
        adjclose?: Array<{ adjclose?: number[] }>;
      };
    }>;
    error: { code: string; description: string } | null;
  };
}

export interface YahooDeps {
  cache: FileCache;
  ohlcvTtlMs?: number;
  newsTtlMs?: number;
}

function toIsoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

export async function fetchYahooOhlcv(
  symbol: string,
  startDate: string,
  endDate: string,
  deps: YahooDeps,
): Promise<OhlcvBar[]> {
  const key = `ohlcv:${symbol.toUpperCase()}:${startDate}:${endDate}`;
  return deps.cache.memo<OhlcvBar[]>(key, deps.ohlcvTtlMs ?? 6 * 60 * 60 * 1000, async () => {
    const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
    const period2 = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000);
    const url = `${CHART_BASE}/${encodeURIComponent(symbol.toUpperCase())}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit&includeAdjustedClose=true`;
    const json = await httpGetJson<ChartResponse>(url, { timeoutMs: 12_000, retries: 2 });
    const result = json.chart.result?.[0];
    if (!result || !result.timestamp) return [];
    const ts = result.timestamp;
    const q = result.indicators.quote[0] ?? {};
    const adj = result.indicators.adjclose?.[0]?.adjclose;
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (close == null || Number.isNaN(close)) continue;
      bars.push({
        date: toIsoDate(ts[i]),
        open: round(q.open?.[i]),
        high: round(q.high?.[i]),
        low: round(q.low?.[i]),
        close: round(close),
        adjClose: adj?.[i] != null ? round(adj[i]) : undefined,
        volume: Math.round(q.volume?.[i] ?? 0),
      });
    }
    return bars;
  });
}

function round(v: number | undefined | null): number {
  if (v == null || Number.isNaN(v)) return 0;
  return Math.round(v * 100) / 100;
}

/** Render OHLCV as the CSV-with-header block agents expect. */
export async function getYFinDataOnline(
  symbol: string,
  startDate: string,
  endDate: string,
  deps: YahooDeps,
): Promise<string> {
  validateDate(startDate);
  validateDate(endDate);
  const bars = await fetchYahooOhlcv(symbol, startDate, endDate, deps);
  if (bars.length === 0) {
    return `No data found for symbol '${symbol}' between ${startDate} and ${endDate}`;
  }
  const header = [
    `# Stock data for ${symbol.toUpperCase()} from ${startDate} to ${endDate}`,
    `# Total records: ${bars.length}`,
    `# Data retrieved on: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    '',
    'Date,Open,High,Low,Close,Adj Close,Volume',
  ].join('\n');
  const body = bars
    .map((b) => `${b.date},${b.open},${b.high},${b.low},${b.close},${b.adjClose ?? b.close},${b.volume}`)
    .join('\n');
  return `${header}\n${body}\n`;
}

function validateDate(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date format: ${d}`);
}

// ── News ────────────────────────────────────────────────────────────────────

interface SearchResponse {
  news?: Array<{
    title?: string;
    publisher?: string;
    link?: string;
    providerPublishTime?: number;
    summary?: string;
  }>;
}

async function fetchYahooSearchNews(query: string, limit: number, deps: YahooDeps): Promise<NewsItem[]> {
  const key = `search:${query}:${limit}`;
  return deps.cache.memo<NewsItem[]>(key, deps.newsTtlMs ?? 30 * 60 * 1000, async () => {
    const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}&newsCount=${limit}&quotesCount=0&enableFuzzyQuery=true`;
    const json = await httpGetJson<SearchResponse>(url, { timeoutMs: 12_000 });
    return (json.news ?? []).map((n) => ({
      title: n.title ?? 'No title',
      publisher: n.publisher ?? 'Unknown',
      link: n.link,
      summary: n.summary,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : undefined,
    }));
  });
}

export async function getNewsYFinance(
  ticker: string,
  startDate: string,
  endDate: string,
  articleLimit: number,
  deps: YahooDeps,
): Promise<string> {
  validateDate(startDate);
  validateDate(endDate);
  const items = await fetchYahooSearchNews(ticker, articleLimit, deps);
  if (items.length === 0) return `No news found for ${ticker}`;

  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T23:59:59Z`).getTime() + 24 * 60 * 60 * 1000;
  const filtered = items.filter((it) => {
    if (!it.publishedAt) return true;
    const t = new Date(it.publishedAt).getTime();
    return t >= start && t <= end;
  });

  if (filtered.length === 0) return `No news found for ${ticker} between ${startDate} and ${endDate}`;

  const body = filtered.map((it) => formatNewsItem(it)).join('\n');
  return `## ${ticker} News, from ${startDate} to ${endDate}:\n\n${body}`;
}

export async function getGlobalNewsYFinance(
  currDate: string,
  lookBackDays: number,
  limit: number,
  globalNewsQueries: string[],
  deps: YahooDeps,
): Promise<string> {
  validateDate(currDate);
  const seen = new Set<string>();
  const all: NewsItem[] = [];
  for (const q of globalNewsQueries) {
    if (all.length >= limit) break;
    try {
      const items = await fetchYahooSearchNews(q, limit, deps);
      for (const it of items) {
        if (!seen.has(it.title) && it.title) {
          seen.add(it.title);
          all.push(it);
        }
      }
    } catch {
      // skip a single failing query; continue with the rest
    }
  }
  if (all.length === 0) return `No global news found for ${currDate}`;

  const curr = new Date(`${currDate}T00:00:00Z`);
  const start = new Date(curr.getTime());
  start.setUTCDate(start.getUTCDate() - lookBackDays);
  const startStr = start.toISOString().slice(0, 10);

  const body = all
    .filter((it) => {
      if (!it.publishedAt) return true;
      return new Date(it.publishedAt).getTime() <= curr.getTime() + 24 * 60 * 60 * 1000;
    })
    .slice(0, limit)
    .map((it) => formatNewsItem(it))
    .join('\n');

  return `## Global Market News, from ${startStr} to ${currDate}:\n\n${body}`;
}

function formatNewsItem(it: NewsItem): string {
  const parts = [`### ${it.title} (source: ${it.publisher})`];
  if (it.summary) parts.push(it.summary);
  if (it.link) parts.push(`Link: ${it.link}`);
  parts.push('');
  return parts.join('\n');
}

// ── Fundamentals (best-effort via quoteSummary) ─────────────────────────────

const QUOTE_SUMMARY = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';

interface QuoteSummaryResponse {
  quoteSummary?: { result?: Array<Record<string, unknown>>; error: unknown };
}

async function fetchQuoteSummary(
  symbol: string,
  modules: string[],
  deps: YahooDeps,
): Promise<Record<string, unknown>> {
  const key = `quoteSummary:${symbol}:${modules.join(',')}`;
  return deps.cache.memo<Record<string, unknown>>(key, deps.newsTtlMs ?? 30 * 60 * 1000, async () => {
    const url = `${QUOTE_SUMMARY}/${encodeURIComponent(symbol.toUpperCase())}?modules=${modules.join(',')}`;
    const json = await httpGetJson<QuoteSummaryResponse>(url, { timeoutMs: 12_000 });
    return (json.quoteSummary?.result?.[0] as Record<string, unknown>) ?? {};
  });
}

export async function getYFinanceFundamentals(symbol: string, deps: YahooDeps): Promise<string> {
  const data = await fetchQuoteSummary(
    symbol,
    ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'assetProfile'],
    deps,
  );
  if (Object.keys(data).length === 0) {
    return `No fundamentals available for ${symbol} via Yahoo Finance.`;
  }
  return `## ${symbol.toUpperCase()} Fundamentals (Yahoo Finance):\n\n\`\`\`json\n${JSON.stringify(
    data,
    null,
    2,
  )}\n\`\`\``;
}

export async function getYFinanceBalanceSheet(symbol: string, deps: YahooDeps): Promise<string> {
  const data = await fetchQuoteSummary(symbol, ['balanceSheetHistory', 'balanceSheetHistoryQuarterly'], deps);
  return renderModule(symbol, 'Balance Sheet', data);
}

export async function getYFinanceCashflow(symbol: string, deps: YahooDeps): Promise<string> {
  const data = await fetchQuoteSummary(symbol, ['cashflowStatementHistory', 'cashflowStatementHistoryQuarterly'], deps);
  return renderModule(symbol, 'Cashflow', data);
}

export async function getYFinanceIncomeStatement(symbol: string, deps: YahooDeps): Promise<string> {
  const data = await fetchQuoteSummary(symbol, ['incomeStatementHistory', 'incomeStatementHistoryQuarterly'], deps);
  return renderModule(symbol, 'Income Statement', data);
}

export async function getYFinanceInsiderTransactions(symbol: string, deps: YahooDeps): Promise<string> {
  const data = await fetchQuoteSummary(symbol, ['insiderTransactions', 'insiderHolders'], deps);
  return renderModule(symbol, 'Insider Transactions', data);
}

function renderModule(symbol: string, label: string, data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) return `No ${label} data for ${symbol.toUpperCase()}.`;
  return `## ${symbol.toUpperCase()} ${label} (Yahoo Finance):\n\n\`\`\`json\n${JSON.stringify(
    data,
    null,
    2,
  )}\n\`\`\``;
}
