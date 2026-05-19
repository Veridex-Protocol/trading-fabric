/**
 * @packageDocumentation
 * @module execution/sera/instrumentMap
 * @description Maps trading-fabric tickers (`AAPL`, `ETH`, ...) to Sera
 * token metadata. Sera is a non-custodial FX/CLOB whose universe is
 * on-chain tokens; equity tickers therefore need an explicit override or
 * are considered unsupported.
 *
 * The map is configuration, not heuristics — operators must opt-in.
 */

export interface InstrumentMapping {
  /** Sera token address (checksummed when possible). */
  address: `0x${string}`;
  /** ERC-20 decimals; used to convert USD notional → base units. */
  decimals: number;
  /** Optional Sera market symbol for diagnostics. */
  symbol?: string;
}

export interface InstrumentMapOptions {
  /** Ticker → Sera token. Keys are upper-cased on lookup. */
  tickers: Record<string, InstrumentMapping>;
  /**
   * Stable-coin token used as the *cash* leg of every swap. All buys
   * spend this token; all sells receive it.
   */
  cash: InstrumentMapping;
}

export class InstrumentMap {
  private readonly byTicker: Map<string, InstrumentMapping>;
  readonly cash: InstrumentMapping;

  constructor(opts: InstrumentMapOptions) {
    this.byTicker = new Map();
    for (const [t, m] of Object.entries(opts.tickers)) {
      this.byTicker.set(t.toUpperCase(), m);
    }
    this.cash = opts.cash;
  }

  get(ticker: string): InstrumentMapping | null {
    return this.byTicker.get(ticker.toUpperCase()) ?? null;
  }

  has(ticker: string): boolean {
    return this.byTicker.has(ticker.toUpperCase());
  }
}
