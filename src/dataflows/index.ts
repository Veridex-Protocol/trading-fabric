/**
 * @packageDocumentation
 * @module dataflows
 * @description Public dataflow surface for trading-fabric. Wires Yahoo,
 * Alpha Vantage, Reddit, and StockTwits behind a single vendor router and
 * exposes high-level helpers (prompt-ready strings) that mirror the
 * TradingAgents Python interface.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { TradingFabricConfig } from '../config';
import {
  getAlphaVantageBalanceSheet,
  getAlphaVantageCashflow,
  getAlphaVantageFundamentals,
  getAlphaVantageGlobalNews,
  getAlphaVantageIncomeStatement,
  getAlphaVantageIndicator,
  getAlphaVantageInsiderTransactions,
  getAlphaVantageNews,
  getAlphaVantageStock,
  type AlphaVantageDeps,
} from './alphaVantage';
import { FileCache } from './cache';
import { fetchRedditPosts, DEFAULT_SUBREDDITS, type RedditDeps } from './reddit';
import {
  type DataflowMethod,
  type MethodImplMap,
  routeToVendor,
} from './router';
import { fetchStocktwitsMessages, type StocktwitsDeps } from './stocktwits';
import type { VendorKey } from './types';
import {
  fetchYahooOhlcv,
  getGlobalNewsYFinance,
  getNewsYFinance,
  getYFinanceBalanceSheet,
  getYFinanceCashflow,
  getYFinanceFundamentals,
  getYFinanceIncomeStatement,
  getYFinanceInsiderTransactions,
  getYFinDataOnline,
  type YahooDeps,
} from './yahoo';
import {
  renderIndicatorWindow,
  type IndicatorKey,
  SUPPORTED_INDICATORS,
} from './indicators';

export * from './types';
export * from './indicators';
export type { DataflowMethod } from './router';
export { DEFAULT_SUBREDDITS } from './reddit';

export interface CreateDataflowClientOptions {
  config: TradingFabricConfig;
  /** Environment for credential lookup. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export interface DataflowClient {
  readonly availableVendors: VendorKey[];
  getStockData(symbol: string, startDate: string, endDate: string): Promise<string>;
  getIndicators(symbol: string, indicator: IndicatorKey, currDate: string, lookBackDays: number): Promise<string>;
  getFundamentals(symbol: string): Promise<string>;
  getBalanceSheet(symbol: string): Promise<string>;
  getCashflow(symbol: string): Promise<string>;
  getIncomeStatement(symbol: string): Promise<string>;
  getInsiderTransactions(symbol: string): Promise<string>;
  getNews(ticker: string, startDate: string, endDate: string): Promise<string>;
  getGlobalNews(currDate: string, lookBackDays?: number): Promise<string>;
  /** Reddit ticker discussion (no API key needed). */
  getRedditPosts(ticker: string, subreddits?: readonly string[]): Promise<string>;
  /** StockTwits ticker sentiment stream (no API key needed). */
  getStocktwitsMessages(ticker: string): Promise<string>;
}

export function createDataflowClient(opts: CreateDataflowClientOptions): DataflowClient {
  const { config } = opts;
  const env = opts.env ?? process.env;
  const cacheRoot = expandHome(config.data_cache_dir);

  const yahooCache = new FileCache({ cacheDir: cacheRoot, namespace: 'yahoo' });
  const yahooDeps: YahooDeps = { cache: yahooCache };

  const avKey = env.ALPHA_VANTAGE_API_KEY;
  const avEntitlement = env.ALPHA_VANTAGE_ENTITLEMENT;
  const avDeps: AlphaVantageDeps | undefined = avKey
    ? {
        apiKey: avKey,
        cache: new FileCache({ cacheDir: cacheRoot, namespace: 'alpha_vantage' }),
        entitlement: avEntitlement,
      }
    : undefined;

  const redditDeps: RedditDeps = {
    cache: new FileCache({ cacheDir: cacheRoot, namespace: 'reddit' }),
  };
  const stocktwitsDeps: StocktwitsDeps = {
    cache: new FileCache({ cacheDir: cacheRoot, namespace: 'stocktwits' }),
  };

  const availableVendors: VendorKey[] = ['yfinance'];
  if (avDeps) availableVendors.push('alpha_vantage');

  const impls: MethodImplMap = {
    get_stock_data: {
      yfinance: (symbol, start, end) =>
        getYFinDataOnline(symbol as string, start as string, end as string, yahooDeps),
      ...(avDeps && {
        alpha_vantage: (symbol, start, end) =>
          getAlphaVantageStock(symbol as string, start as string, end as string, avDeps),
      }),
    },
    get_indicators: {
      yfinance: async (symbol, indicator, currDate, lookBackDays) => {
        const lookback = lookBackDays as number;
        const start = new Date(`${currDate as string}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - lookback - 220);
        const bars = await fetchYahooOhlcv(
          symbol as string,
          start.toISOString().slice(0, 10),
          currDate as string,
          yahooDeps,
        );
        return renderIndicatorWindow(
          symbol as string,
          indicator as IndicatorKey,
          bars,
          currDate as string,
          lookback,
        );
      },
      ...(avDeps && {
        alpha_vantage: (symbol, indicator, currDate, lookBackDays) =>
          getAlphaVantageIndicator(
            symbol as string,
            indicator as string,
            currDate as string,
            lookBackDays as number,
            avDeps,
          ),
      }),
    },
    get_fundamentals: {
      yfinance: (symbol) => getYFinanceFundamentals(symbol as string, yahooDeps),
      ...(avDeps && { alpha_vantage: (symbol) => getAlphaVantageFundamentals(symbol as string, avDeps) }),
    },
    get_balance_sheet: {
      yfinance: (symbol) => getYFinanceBalanceSheet(symbol as string, yahooDeps),
      ...(avDeps && { alpha_vantage: (symbol) => getAlphaVantageBalanceSheet(symbol as string, avDeps) }),
    },
    get_cashflow: {
      yfinance: (symbol) => getYFinanceCashflow(symbol as string, yahooDeps),
      ...(avDeps && { alpha_vantage: (symbol) => getAlphaVantageCashflow(symbol as string, avDeps) }),
    },
    get_income_statement: {
      yfinance: (symbol) => getYFinanceIncomeStatement(symbol as string, yahooDeps),
      ...(avDeps && { alpha_vantage: (symbol) => getAlphaVantageIncomeStatement(symbol as string, avDeps) }),
    },
    get_insider_transactions: {
      yfinance: (symbol) => getYFinanceInsiderTransactions(symbol as string, yahooDeps),
      ...(avDeps && {
        alpha_vantage: (symbol) => getAlphaVantageInsiderTransactions(symbol as string, avDeps),
      }),
    },
    get_news: {
      yfinance: (ticker, start, end) =>
        getNewsYFinance(
          ticker as string,
          start as string,
          end as string,
          config.news_article_limit,
          yahooDeps,
        ),
      ...(avDeps && {
        alpha_vantage: (ticker, start, end) =>
          getAlphaVantageNews(ticker as string, start as string, end as string, avDeps),
      }),
    },
    get_global_news: {
      yfinance: (currDate, lookBackDays) =>
        getGlobalNewsYFinance(
          currDate as string,
          (lookBackDays as number) ?? config.global_news_lookback_days,
          config.global_news_article_limit,
          config.global_news_queries,
          yahooDeps,
        ),
      ...(avDeps && {
        alpha_vantage: (currDate, lookBackDays) =>
          getAlphaVantageGlobalNews(
            currDate as string,
            (lookBackDays as number) ?? config.global_news_lookback_days,
            avDeps,
          ),
      }),
    },
  };

  const route = <Args extends unknown[]>(method: DataflowMethod, args: Args) =>
    routeToVendor(method, config, impls, args);

  return {
    availableVendors,
    getStockData: (symbol, start, end) => route('get_stock_data', [symbol, start, end]),
    getIndicators: (symbol, indicator, currDate, lookBackDays) => {
      if (!SUPPORTED_INDICATORS.includes(indicator)) {
        return Promise.reject(
          new Error(`Indicator '${indicator}' not supported. Choose: ${SUPPORTED_INDICATORS.join(', ')}`),
        );
      }
      return route('get_indicators', [symbol, indicator, currDate, lookBackDays]);
    },
    getFundamentals: (symbol) => route('get_fundamentals', [symbol]),
    getBalanceSheet: (symbol) => route('get_balance_sheet', [symbol]),
    getCashflow: (symbol) => route('get_cashflow', [symbol]),
    getIncomeStatement: (symbol) => route('get_income_statement', [symbol]),
    getInsiderTransactions: (symbol) => route('get_insider_transactions', [symbol]),
    getNews: (ticker, start, end) => route('get_news', [ticker, start, end]),
    getGlobalNews: (currDate, lookBackDays) => route('get_global_news', [currDate, lookBackDays]),
    getRedditPosts: (ticker, subreddits = DEFAULT_SUBREDDITS) =>
      fetchRedditPosts(ticker, subreddits, redditDeps),
    getStocktwitsMessages: (ticker) => fetchStocktwitsMessages(ticker, stocktwitsDeps),
  };
}
