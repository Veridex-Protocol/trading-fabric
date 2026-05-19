/**
 * @packageDocumentation
 * @module dataflows/indicators
 * @description Technical indicators computed from OHLCV bars.
 *
 * Implementations are self-contained (no `stockstats`, no `technicalindicators`
 * dep) so that the data layer stays lean and auditable. Naming and outputs
 * match TradingAgents' `stockstats`-style keys (e.g. `close_50_sma`, `macd`,
 * `boll_ub`) so prompts that reference these keys remain faithful.
 *
 * Indicator descriptions are lifted verbatim from
 * `tradingagents/dataflows/y_finance.py::get_stock_stats_indicators_window`
 * to preserve prompt semantics.
 */

import type { OhlcvBar } from './types';

export type IndicatorKey =
  | 'close_50_sma'
  | 'close_200_sma'
  | 'close_10_ema'
  | 'macd'
  | 'macds'
  | 'macdh'
  | 'rsi'
  | 'boll'
  | 'boll_ub'
  | 'boll_lb'
  | 'atr'
  | 'vwma'
  | 'mfi';

export const INDICATOR_DEFINITIONS: Record<IndicatorKey, string> = {
  close_50_sma:
    '50 SMA: A medium-term trend indicator. Usage: Identify trend direction and serve as dynamic support/resistance. Tips: It lags price; combine with faster indicators for timely signals.',
  close_200_sma:
    '200 SMA: A long-term trend benchmark. Usage: Confirm overall market trend and identify golden/death cross setups. Tips: It reacts slowly; best for strategic trend confirmation rather than frequent trading entries.',
  close_10_ema:
    '10 EMA: A responsive short-term average. Usage: Capture quick shifts in momentum and potential entry points. Tips: Prone to noise in choppy markets; use alongside longer averages for filtering false signals.',
  macd:
    'MACD: Computes momentum via differences of EMAs. Usage: Look for crossovers and divergence as signals of trend changes. Tips: Confirm with other indicators in low-volatility or sideways markets.',
  macds:
    'MACD Signal: An EMA smoothing of the MACD line. Usage: Use crossovers with the MACD line to trigger trades. Tips: Should be part of a broader strategy to avoid false positives.',
  macdh:
    'MACD Histogram: Shows the gap between the MACD line and its signal. Usage: Visualize momentum strength and spot divergence early. Tips: Can be volatile; complement with additional filters in fast-moving markets.',
  rsi:
    'RSI: Measures momentum to flag overbought/oversold conditions. Usage: Apply 70/30 thresholds and watch for divergence to signal reversals. Tips: In strong trends, RSI may remain extreme; always cross-check with trend analysis.',
  boll:
    'Bollinger Middle: A 20 SMA serving as the basis for Bollinger Bands. Usage: Acts as a dynamic benchmark for price movement. Tips: Combine with the upper and lower bands to effectively spot breakouts or reversals.',
  boll_ub:
    'Bollinger Upper Band: Typically 2 standard deviations above the middle line. Usage: Signals potential overbought conditions and breakout zones. Tips: Confirm signals with other tools; prices may ride the band in strong trends.',
  boll_lb:
    'Bollinger Lower Band: Typically 2 standard deviations below the middle line. Usage: Indicates potential oversold conditions. Tips: Use additional analysis to avoid false reversal signals.',
  atr:
    'ATR: Averages true range to measure volatility. Usage: Set stop-loss levels and adjust position sizes based on current market volatility. Tips: It is a reactive measure, so use it as part of a broader risk management strategy.',
  vwma:
    'VWMA: A moving average weighted by volume. Usage: Confirm trends by integrating price action with volume data. Tips: Watch for skewed results from volume spikes; use in combination with other volume analyses.',
  mfi:
    'MFI: The Money Flow Index is a momentum indicator that uses both price and volume to measure buying and selling pressure. Usage: Identify overbought (>80) or oversold (<20) conditions and confirm the strength of trends or reversals. Tips: Use alongside RSI or MACD to confirm signals; divergence between price and MFI can indicate potential reversals.',
};

export const SUPPORTED_INDICATORS = Object.keys(INDICATOR_DEFINITIONS) as IndicatorKey[];

// ── primitives ──────────────────────────────────────────────────────────────

function sma(series: number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(series.length).fill(null);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= window) sum -= series[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function ema(series: number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(series.length).fill(null);
  if (series.length === 0) return out;
  const k = 2 / (window + 1);
  // Seed with SMA of first `window` values to match stockstats behavior.
  if (series.length < window) return out;
  let seed = 0;
  for (let i = 0; i < window; i++) seed += series[i];
  out[window - 1] = seed / window;
  for (let i = window; i < series.length; i++) {
    const prev = out[i - 1] as number;
    out[i] = series[i] * k + prev * (1 - k);
  }
  return out;
}

function stddev(series: number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(series.length).fill(null);
  for (let i = window - 1; i < series.length; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += series[j];
    mean /= window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) v += (series[j] - mean) ** 2;
    out[i] = Math.sqrt(v / window);
  }
  return out;
}

// ── public API ──────────────────────────────────────────────────────────────

/** Compute one indicator series across all bars. Values aligned to `bars` index. */
export function computeIndicator(bars: OhlcvBar[], indicator: IndicatorKey): Array<number | null> {
  const close = bars.map((b) => b.close);
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const volume = bars.map((b) => b.volume);

  switch (indicator) {
    case 'close_50_sma':
      return sma(close, 50);
    case 'close_200_sma':
      return sma(close, 200);
    case 'close_10_ema':
      return ema(close, 10);
    case 'macd':
    case 'macds':
    case 'macdh': {
      const ema12 = ema(close, 12);
      const ema26 = ema(close, 26);
      const macd: number[] = [];
      const macdIndex: Array<number | null> = ema12.map((v, i) => {
        if (v === null || ema26[i] === null) return null;
        const m = v - (ema26[i] as number);
        macd.push(m);
        return m;
      });
      if (indicator === 'macd') return macdIndex;
      // Compute signal as EMA(9) of the macd series, but we must reattach
      // alignment to the original bar index.
      const sigDense = ema(macd, 9);
      const aligned: Array<number | null> = new Array(bars.length).fill(null);
      let denseIdx = 0;
      for (let i = 0; i < bars.length; i++) {
        if (macdIndex[i] !== null) {
          aligned[i] = sigDense[denseIdx] ?? null;
          denseIdx++;
        }
      }
      if (indicator === 'macds') return aligned;
      // macdh = macd - macds
      return macdIndex.map((m, i) => (m === null || aligned[i] === null ? null : m - (aligned[i] as number)));
    }
    case 'rsi': {
      const window = 14;
      const out: Array<number | null> = new Array(bars.length).fill(null);
      let gain = 0;
      let loss = 0;
      for (let i = 1; i < bars.length; i++) {
        const diff = close[i] - close[i - 1];
        const g = Math.max(0, diff);
        const l = Math.max(0, -diff);
        if (i <= window) {
          gain += g;
          loss += l;
          if (i === window) {
            gain /= window;
            loss /= window;
            out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
          }
        } else {
          gain = (gain * (window - 1) + g) / window;
          loss = (loss * (window - 1) + l) / window;
          out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
        }
      }
      return out;
    }
    case 'boll':
      return sma(close, 20);
    case 'boll_ub': {
      const mid = sma(close, 20);
      const sd = stddev(close, 20);
      return mid.map((m, i) => (m === null || sd[i] === null ? null : m + 2 * (sd[i] as number)));
    }
    case 'boll_lb': {
      const mid = sma(close, 20);
      const sd = stddev(close, 20);
      return mid.map((m, i) => (m === null || sd[i] === null ? null : m - 2 * (sd[i] as number)));
    }
    case 'atr': {
      const window = 14;
      const tr: number[] = new Array(bars.length).fill(0);
      tr[0] = high[0] - low[0];
      for (let i = 1; i < bars.length; i++) {
        tr[i] = Math.max(
          high[i] - low[i],
          Math.abs(high[i] - close[i - 1]),
          Math.abs(low[i] - close[i - 1]),
        );
      }
      const out: Array<number | null> = new Array(bars.length).fill(null);
      if (bars.length < window) return out;
      let prev = 0;
      for (let i = 0; i < window; i++) prev += tr[i];
      prev /= window;
      out[window - 1] = prev;
      for (let i = window; i < bars.length; i++) {
        prev = (prev * (window - 1) + tr[i]) / window;
        out[i] = prev;
      }
      return out;
    }
    case 'vwma': {
      const window = 20;
      const out: Array<number | null> = new Array(bars.length).fill(null);
      let pvSum = 0;
      let vSum = 0;
      for (let i = 0; i < bars.length; i++) {
        pvSum += close[i] * volume[i];
        vSum += volume[i];
        if (i >= window) {
          pvSum -= close[i - window] * volume[i - window];
          vSum -= volume[i - window];
        }
        if (i >= window - 1 && vSum > 0) out[i] = pvSum / vSum;
      }
      return out;
    }
    case 'mfi': {
      const window = 14;
      const out: Array<number | null> = new Array(bars.length).fill(null);
      const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
      const rmf = tp.map((t, i) => t * volume[i]);
      for (let i = window; i < bars.length; i++) {
        let pos = 0;
        let neg = 0;
        for (let j = i - window + 1; j <= i; j++) {
          if (tp[j] > tp[j - 1]) pos += rmf[j];
          else if (tp[j] < tp[j - 1]) neg += rmf[j];
        }
        out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
      }
      return out;
    }
    default: {
      const _exhaustive: never = indicator;
      throw new Error(`Unsupported indicator: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Render a windowed indicator report mirroring
 * `get_stock_stats_indicators_window` so existing TradingAgents prompts remain
 * verbatim-compatible.
 */
export function renderIndicatorWindow(
  symbol: string,
  indicator: IndicatorKey,
  bars: OhlcvBar[],
  currDate: string,
  lookBackDays: number,
): string {
  if (!INDICATOR_DEFINITIONS[indicator]) {
    throw new Error(
      `Indicator ${indicator} is not supported. Choose from: ${SUPPORTED_INDICATORS.join(', ')}`,
    );
  }
  const series = computeIndicator(bars, indicator);
  const byDate = new Map<string, number | null>();
  bars.forEach((b, i) => byDate.set(b.date, series[i]));

  const end = new Date(`${currDate}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - lookBackDays);

  const lines: string[] = [];
  for (let d = new Date(end); d >= start; d.setUTCDate(d.getUTCDate() - 1)) {
    const ds = d.toISOString().slice(0, 10);
    const v = byDate.get(ds);
    if (v === undefined) {
      lines.push(`${ds}: N/A: Not a trading day (weekend or holiday)`);
    } else if (v === null) {
      lines.push(`${ds}: N/A`);
    } else {
      lines.push(`${ds}: ${v}`);
    }
  }

  return [
    `## ${indicator} values from ${start.toISOString().slice(0, 10)} to ${currDate}:`,
    '',
    lines.join('\n'),
    '',
    '',
    INDICATOR_DEFINITIONS[indicator],
  ].join('\n');
}
