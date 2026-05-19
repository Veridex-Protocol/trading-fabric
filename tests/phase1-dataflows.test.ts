/**
 * Phase 1 tests — dataflow router, cache, and indicators. Network-bound
 * vendor functions are exercised via fake impls so the suite stays
 * hermetic (no real HTTP, no real keys).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, resolveConfig } from '../src/config';
import {
  AlphaVantageRateLimitError,
  type DataflowMethod,
} from '../src/dataflows';
import { FileCache } from '../src/dataflows/cache';
import {
  INDICATOR_DEFINITIONS,
  SUPPORTED_INDICATORS,
  computeIndicator,
  renderIndicatorWindow,
} from '../src/dataflows/indicators';
import {
  type MethodImplMap,
  routeToVendor,
  selectVendors,
} from '../src/dataflows/router';
import type { OhlcvBar } from '../src/dataflows/types';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tf-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('FileCache', () => {
  test('roundtrips values within TTL', async () => {
    const cache = new FileCache({ cacheDir: tmp, namespace: 'unit' });
    await cache.set('k1', { hello: 'world' }, 60_000);
    expect(await cache.get('k1')).toEqual({ hello: 'world' });
  });

  test('returns undefined after TTL expiry', async () => {
    const cache = new FileCache({ cacheDir: tmp, namespace: 'unit' });
    await cache.set('k2', 42, 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get('k2')).toBeUndefined();
  });

  test('memo computes once and reuses', async () => {
    const cache = new FileCache({ cacheDir: tmp, namespace: 'unit' });
    let calls = 0;
    const compute = async () => {
      calls++;
      return 'value';
    };
    expect(await cache.memo('m', 60_000, compute)).toBe('value');
    expect(await cache.memo('m', 60_000, compute)).toBe('value');
    expect(calls).toBe(1);
  });
});

describe('Router', () => {
  test('selectVendors honors tool-level override, then category, then defaults', () => {
    const cfg = resolveConfig({
      data_vendors: { ...DEFAULT_CONFIG.data_vendors, news_data: 'alpha_vantage' },
      tool_vendors: { get_news: 'yfinance' },
    });
    expect(selectVendors('get_news', cfg, ['yfinance', 'alpha_vantage'])).toEqual([
      'yfinance',
      'alpha_vantage',
    ]);
    // category-level when no tool override
    expect(selectVendors('get_global_news', cfg, ['yfinance', 'alpha_vantage'])).toEqual([
      'alpha_vantage',
      'yfinance',
    ]);
  });

  test('falls back when primary vendor raises AlphaVantageRateLimitError', async () => {
    const impls: MethodImplMap = {
      get_stock_data: {
        alpha_vantage: async () => {
          throw new AlphaVantageRateLimitError('quota');
        },
        yfinance: async () => 'yfin-data',
      },
    };
    const cfg = resolveConfig({
      data_vendors: { ...DEFAULT_CONFIG.data_vendors, core_stock_apis: 'alpha_vantage' },
    });
    const out = await routeToVendor('get_stock_data' as DataflowMethod, cfg, impls, [
      'AAPL',
      '2025-01-01',
      '2025-06-01',
    ]);
    expect(out).toBe('yfin-data');
  });

  test('non-rate-limit errors propagate immediately', async () => {
    const impls: MethodImplMap = {
      get_stock_data: {
        yfinance: async () => {
          throw new Error('boom');
        },
        alpha_vantage: async () => 'fallback',
      },
    };
    await expect(
      routeToVendor('get_stock_data', DEFAULT_CONFIG, impls, ['X', '2025-01-01', '2025-06-01']),
    ).rejects.toThrow('boom');
  });
});

describe('Indicators', () => {
  // 30 synthetic bars: monotonically increasing close, fixed volume.
  const bars: OhlcvBar[] = Array.from({ length: 30 }, (_, i) => ({
    date: `2025-01-${String(i + 1).padStart(2, '0')}`,
    open: 100 + i,
    high: 100 + i + 0.5,
    low: 100 + i - 0.5,
    close: 100 + i,
    volume: 1_000_000,
  }));

  test('exports a definition for every supported indicator', () => {
    for (const k of SUPPORTED_INDICATORS) {
      expect(INDICATOR_DEFINITIONS[k]).toBeTruthy();
    }
  });

  test('SMA(10) over linear input is the centered mean', () => {
    const series = computeIndicator(bars, 'close_10_ema');
    // EMA seeded with SMA of first 10 closes = mean(100..109) = 104.5
    expect(series[9]).toBeCloseTo(104.5, 4);
  });

  test('RSI on monotonically-increasing series stays at 100', () => {
    const rsi = computeIndicator(bars, 'rsi');
    expect(rsi[20]).toBe(100);
  });

  test('renderIndicatorWindow includes the definition trailer', () => {
    const txt = renderIndicatorWindow('TEST', 'rsi', bars, '2025-01-30', 5);
    expect(txt).toContain('## rsi values from');
    expect(txt).toContain(INDICATOR_DEFINITIONS.rsi);
  });
});
