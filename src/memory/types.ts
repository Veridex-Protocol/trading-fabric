/**
 * @packageDocumentation
 * @module memory/types
 * @description Type surface for the trading-fabric memory log.
 *
 * The log stores one entry per portfolio-manager decision, plus the
 * outcome reflection once the holding-window prices become available.
 *
 * Storage format is JSONL (one JSON object per line). This is a
 * deliberate departure from TradingAgents' markdown format:
 *
 *   - Trivially parseable, no regex.
 *   - Atomic appends via `fs.appendFileSync` with no separator concerns.
 *   - Each entry stands alone — easier for audit exports and diffs.
 *
 * Backwards compatibility with the upstream markdown log is not
 * required: trading-fabric uses its own storage path.
 */

import type { Ticker, TradeDate } from '../types/index.js';

/** Canonical 5-tier rating vocabulary (most bullish to most bearish). */
export type Rating = 'Buy' | 'Overweight' | 'Hold' | 'Underweight' | 'Sell';

export const RATINGS_5_TIER: readonly Rating[] = [
  'Buy',
  'Overweight',
  'Hold',
  'Underweight',
  'Sell',
] as const;

/** Status of a memory entry's outcome. */
export type EntryStatus = 'pending' | 'resolved';

/** Shape of a single entry in the log. Serialised one-per-line in JSONL. */
export interface MemoryEntry {
  /** Stable id, useful for joins in audit bundles. */
  id: string;
  /** ISO trade date the decision applied to. */
  trade_date: TradeDate;
  ticker: Ticker;
  rating: Rating;
  /** Full portfolio-manager decision markdown (rendered structured output). */
  decision: string;
  /** Reflection prose written once outcome is known. Empty until resolved. */
  reflection: string;
  status: EntryStatus;
  /** Holding-period return (e.g. 0.042 for +4.2%). Null while pending. */
  raw_return: number | null;
  /** Return minus benchmark return over the same window. Null while pending. */
  alpha_return: number | null;
  /** Effective holding days actually used (may be < requested if data is sparse). */
  holding_days: number | null;
  /** Benchmark ticker used for the alpha calculation. */
  benchmark: string | null;
  /** When the entry was first written. */
  created_at: string;
  /** When the outcome was resolved + reflection written. Null while pending. */
  resolved_at: string | null;
}

/** Input shape for writing a new pending entry. */
export interface StoreDecisionInput {
  ticker: Ticker;
  trade_date: TradeDate;
  rating: Rating;
  decision: string;
}

/** Input shape for resolving a previously-pending entry. */
export interface ResolveEntryInput {
  ticker: Ticker;
  trade_date: TradeDate;
  raw_return: number;
  alpha_return: number;
  holding_days: number;
  benchmark: string;
  reflection: string;
}

/** Storage backend interface — keeps the log decoupled from filesystem code. */
export interface MemoryStore {
  /** Load every entry currently stored. */
  loadAll(): Promise<MemoryEntry[]>;
  /** Append a new entry. */
  append(entry: MemoryEntry): Promise<void>;
  /**
   * Replace one or more entries in place. Implementations should make
   * this atomic (temp-file + rename for filesystem-backed stores) so a
   * crash mid-write never corrupts the log.
   */
  rewrite(entries: MemoryEntry[]): Promise<void>;
}
