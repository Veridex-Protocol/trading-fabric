/**
 * @packageDocumentation
 * @module dataflows/types
 * @description Shared dataflow contracts. All public dataflow methods return
 * **prompt-ready strings** (matching TradingAgents' Python interface) so that
 * agents can paste output directly into context windows. Structured types are
 * exposed for callers that want to render their own views (e.g. the TUI).
 */

export type Iso8601Date = string; // YYYY-MM-DD
export type VendorKey = 'yfinance' | 'alpha_vantage';

export interface OhlcvBar {
  date: Iso8601Date;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose?: number;
  volume: number;
}

export interface NewsItem {
  title: string;
  publisher: string;
  link?: string;
  summary?: string;
  publishedAt?: string; // ISO timestamp
}

/** Map of indicator key → numeric series indexed by trading day. */
export type IndicatorSeries = Record<string, Array<{ date: Iso8601Date; value: number | null }>>;

export interface DataflowError extends Error {
  vendor?: VendorKey;
  /** True when the failure is a rate-limit/quota signal and the router should fall back. */
  retryable?: boolean;
}

/** Thrown when an Alpha Vantage call is rate-limited; router uses this to fall back. */
export class AlphaVantageRateLimitError extends Error implements DataflowError {
  readonly vendor: VendorKey = 'alpha_vantage';
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'AlphaVantageRateLimitError';
  }
}
