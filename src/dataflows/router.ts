/**
 * @packageDocumentation
 * @module dataflows/router
 * @description Vendor router. Mirrors `tradingagents/dataflows/interface.py`:
 *
 * - Every dataflow method belongs to a category (core_stock_apis,
 *   technical_indicators, fundamental_data, news_data).
 * - Each category can be routed to a vendor (yfinance, alpha_vantage).
 * - When a vendor raises a *retryable* error (Alpha Vantage rate limit), the
 *   router walks the rest of the fallback chain before giving up.
 *
 * Pure & testable: takes the implementation map as an argument so the
 * `DataflowClient` can wire the real vendors and the tests can wire fakes.
 */

import type { TradingFabricConfig } from '../config';
import { AlphaVantageRateLimitError, type VendorKey } from './types';

export type DataflowMethod =
  | 'get_stock_data'
  | 'get_indicators'
  | 'get_fundamentals'
  | 'get_balance_sheet'
  | 'get_cashflow'
  | 'get_income_statement'
  | 'get_news'
  | 'get_global_news'
  | 'get_insider_transactions';

export type DataflowCategory =
  | 'core_stock_apis'
  | 'technical_indicators'
  | 'fundamental_data'
  | 'news_data';

export const METHOD_CATEGORY: Record<DataflowMethod, DataflowCategory> = {
  get_stock_data: 'core_stock_apis',
  get_indicators: 'technical_indicators',
  get_fundamentals: 'fundamental_data',
  get_balance_sheet: 'fundamental_data',
  get_cashflow: 'fundamental_data',
  get_income_statement: 'fundamental_data',
  get_news: 'news_data',
  get_global_news: 'news_data',
  get_insider_transactions: 'news_data',
};

export type VendorImpl<Args extends unknown[] = unknown[]> = (...args: Args) => Promise<string>;

export type MethodImplMap = Partial<Record<DataflowMethod, Partial<Record<VendorKey, VendorImpl>>>>;

export function selectVendors(
  method: DataflowMethod,
  config: TradingFabricConfig,
  available: VendorKey[],
): VendorKey[] {
  const category = METHOD_CATEGORY[method];
  const toolOverride = config.tool_vendors?.[method];
  const categoryOverride = config.data_vendors?.[category];
  const configured = (toolOverride ?? categoryOverride ?? 'yfinance')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean) as VendorKey[];
  const chain: VendorKey[] = [];
  for (const v of configured) if (available.includes(v) && !chain.includes(v)) chain.push(v);
  for (const v of available) if (!chain.includes(v)) chain.push(v);
  return chain;
}

export async function routeToVendor(
  method: DataflowMethod,
  config: TradingFabricConfig,
  impls: MethodImplMap,
  args: unknown[],
): Promise<string> {
  const methodImpls = impls[method];
  if (!methodImpls) throw new Error(`Method '${method}' not supported`);
  const available = Object.keys(methodImpls) as VendorKey[];
  const chain = selectVendors(method, config, available);

  let lastErr: unknown;
  for (const vendor of chain) {
    const impl = methodImpls[vendor];
    if (!impl) continue;
    try {
      return await impl(...args);
    } catch (err) {
      if (err instanceof AlphaVantageRateLimitError) {
        lastErr = err;
        continue; // fall back to next vendor
      }
      throw err; // non-rate-limit errors are not silently masked
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`No available vendor for '${method}'`);
}
