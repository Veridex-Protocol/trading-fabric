/**
 * @packageDocumentation
 * @module memory/benchmark
 * @description Pure helper that picks the alpha-baseline ticker for a
 * given instrument. Mirrors `TradingAgentsGraph._resolve_benchmark`.
 */

import type { TradingFabricConfig } from '../config/index.js';

/**
 * Resolve the benchmark ticker for alpha calculation against `ticker`.
 *
 * Resolution order:
 *  1. `config.benchmark_ticker` — explicit override wins unconditionally.
 *  2. Longest matching suffix in `config.benchmark_map` (e.g. `.T` →
 *     `^N225`). Matching is case-insensitive and prefers longer suffixes
 *     so that `.TO` does not mis-match against `.T`.
 *  3. Empty-suffix entry (default `SPY`).
 */
export function resolveBenchmark(ticker: string, config: TradingFabricConfig): string {
  if (config.benchmark_ticker) return config.benchmark_ticker;

  const upper = ticker.toUpperCase();
  const map = config.benchmark_map;

  // Iterate keys longest-first so `.TO` beats `.T`.
  const suffixes = Object.keys(map)
    .filter((k) => k.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const suffix of suffixes) {
    if (upper.endsWith(suffix.toUpperCase())) {
      return map[suffix];
    }
  }
  return map[''] ?? 'SPY';
}
