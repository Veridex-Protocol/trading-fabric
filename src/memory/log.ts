/**
 * @packageDocumentation
 * @module memory/log
 * @description `TradingMemoryLog` — the read/write surface that the
 * Orchestrator interacts with. Wraps a `MemoryStore` and offers:
 *
 *   - `storeDecision(...)` — append a `pending` entry after the portfolio
 *     manager fires. Idempotent: a second call for the same `(ticker,
 *     trade_date)` while still pending is a no-op.
 *   - `getPendingForTicker(ticker)` / `getPending()` — read pending rows.
 *   - `resolveEntry(...)` / `batchResolveEntries(...)` — atomically flip
 *     pending entries to `resolved` with raw/alpha returns + reflection.
 *     Rotation is applied to resolved entries when
 *     `memory_log_max_entries > 0`.
 *   - `getPastContext(ticker, opts)` — assemble the `past_context` blob
 *     injected into analyst + portfolio-manager prompts.
 *
 * The class itself is provider- and pricing-agnostic. The resolver
 * (`memory/resolver.ts`) is what orchestrates pricing + reflection
 * round-trips.
 */

import { randomUUID } from 'node:crypto';

import type {
  MemoryEntry,
  MemoryStore,
  Rating,
  ResolveEntryInput,
  StoreDecisionInput,
} from './types.js';

export interface PastContextOptions {
  /** Max same-ticker entries to include. */
  nSame?: number;
  /** Max cross-ticker entries to include. */
  nCross?: number;
}

const DEFAULT_PAST = { nSame: 5, nCross: 3 } as const;

export interface TradingMemoryLogOptions {
  store: MemoryStore;
  /** Cap on resolved entries. `<= 0` disables rotation. */
  maxEntries?: number;
  /** Override for deterministic ids in tests. */
  idFactory?: () => string;
  /** Override for deterministic timestamps in tests. */
  now?: () => Date;
}

export class TradingMemoryLog {
  private readonly store: MemoryStore;
  private readonly maxEntries: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(opts: TradingMemoryLogOptions) {
    this.store = opts.store;
    this.maxEntries = opts.maxEntries ?? 0;
    this.idFactory = opts.idFactory ?? randomUUID;
    this.now = opts.now ?? (() => new Date());
  }

  // ── Reads ────────────────────────────────────────────────────────

  async loadAll(): Promise<MemoryEntry[]> {
    return this.store.loadAll();
  }

  async getPending(): Promise<MemoryEntry[]> {
    return (await this.loadAll()).filter((e) => e.status === 'pending');
  }

  async getPendingForTicker(ticker: string): Promise<MemoryEntry[]> {
    return (await this.getPending()).filter((e) => e.ticker === ticker);
  }

  // ── Writes ───────────────────────────────────────────────────────

  /**
   * Append a `pending` entry for the latest portfolio-manager decision.
   *
   * Idempotency: if an entry already exists with the same `(ticker,
   * trade_date)` and `status === 'pending'`, returns the existing entry
   * unchanged. This makes it safe to call on retry without polluting
   * the log.
   */
  async storeDecision(input: StoreDecisionInput): Promise<MemoryEntry> {
    const existing = (await this.loadAll()).find(
      (e) =>
        e.ticker === input.ticker &&
        e.trade_date === input.trade_date &&
        e.status === 'pending',
    );
    if (existing) return existing;

    const entry: MemoryEntry = {
      id: this.idFactory(),
      ticker: input.ticker,
      trade_date: input.trade_date,
      rating: input.rating,
      decision: input.decision,
      reflection: '',
      status: 'pending',
      raw_return: null,
      alpha_return: null,
      holding_days: null,
      benchmark: null,
      created_at: this.now().toISOString(),
      resolved_at: null,
    };
    await this.store.append(entry);
    return entry;
  }

  /** Resolve a single pending entry. Returns the updated entry, or null if not found. */
  async resolveEntry(input: ResolveEntryInput): Promise<MemoryEntry | null> {
    const all = await this.loadAll();
    const idx = all.findIndex(
      (e) =>
        e.ticker === input.ticker &&
        e.trade_date === input.trade_date &&
        e.status === 'pending',
    );
    if (idx === -1) return null;
    const updated = this.applyResolution(all[idx], input);
    all[idx] = updated;
    const rotated = this.applyRotation(all);
    await this.store.rewrite(rotated);
    return updated;
  }

  /**
   * Apply many resolutions in a single read + atomic rewrite. Skips any
   * input that does not have a matching pending entry.
   */
  async batchResolveEntries(inputs: ResolveEntryInput[]): Promise<MemoryEntry[]> {
    if (inputs.length === 0) return [];
    const all = await this.loadAll();
    const key = (t: string, d: string) => `${d}|${t}`;
    const byKey = new Map(inputs.map((u) => [key(u.ticker, u.trade_date), u] as const));
    const resolved: MemoryEntry[] = [];

    for (let i = 0; i < all.length; i++) {
      const entry = all[i];
      if (entry.status !== 'pending') continue;
      const upd = byKey.get(key(entry.ticker, entry.trade_date));
      if (!upd) continue;
      all[i] = this.applyResolution(entry, upd);
      resolved.push(all[i]);
      byKey.delete(key(entry.ticker, entry.trade_date));
    }
    if (resolved.length === 0) return [];

    const rotated = this.applyRotation(all);
    await this.store.rewrite(rotated);
    return resolved;
  }

  // ── Past-context formatting ──────────────────────────────────────

  /**
   * Build the `past_context` block that analysts + portfolio manager
   * receive as a memo of prior runs. Only *resolved* entries contribute
   * — pending entries have no outcome data and would be misleading.
   *
   * Recency order: most recent first. Returns an empty string when no
   * material exists.
   */
  async getPastContext(ticker: string, opts: PastContextOptions = {}): Promise<string> {
    const { nSame, nCross } = { ...DEFAULT_PAST, ...opts };
    const entries = (await this.loadAll())
      .filter((e) => e.status === 'resolved')
      .reverse(); // most recent first
    if (entries.length === 0) return '';

    const same: MemoryEntry[] = [];
    const cross: MemoryEntry[] = [];
    for (const e of entries) {
      if (e.ticker === ticker && same.length < nSame) same.push(e);
      else if (e.ticker !== ticker && cross.length < nCross) cross.push(e);
      if (same.length >= nSame && cross.length >= nCross) break;
    }
    if (same.length === 0 && cross.length === 0) return '';

    const parts: string[] = [];
    if (same.length > 0) {
      parts.push(`Past analyses of ${ticker} (most recent first):`);
      for (const e of same) parts.push(formatFullEntry(e));
    }
    if (cross.length > 0) {
      parts.push('Recent cross-ticker lessons:');
      for (const e of cross) parts.push(formatReflectionOnly(e));
    }
    return parts.join('\n\n');
  }

  // ── Internals ────────────────────────────────────────────────────

  private applyResolution(entry: MemoryEntry, input: ResolveEntryInput): MemoryEntry {
    return {
      ...entry,
      status: 'resolved',
      raw_return: input.raw_return,
      alpha_return: input.alpha_return,
      holding_days: input.holding_days,
      benchmark: input.benchmark,
      reflection: input.reflection,
      resolved_at: this.now().toISOString(),
    };
  }

  /**
   * Drop oldest resolved entries when their count exceeds `maxEntries`.
   * Pending entries are always retained — they represent unprocessed work.
   */
  private applyRotation(entries: MemoryEntry[]): MemoryEntry[] {
    if (this.maxEntries <= 0) return entries;
    const resolved = entries.filter((e) => e.status === 'resolved');
    if (resolved.length <= this.maxEntries) return entries;
    let toDrop = resolved.length - this.maxEntries;
    const out: MemoryEntry[] = [];
    for (const e of entries) {
      if (e.status === 'resolved' && toDrop > 0) {
        toDrop--;
        continue;
      }
      out.push(e);
    }
    return out;
  }
}

// ── Formatters ───────────────────────────────────────────────────────

function pct(v: number | null): string {
  if (v === null) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function tagLine(e: MemoryEntry): string {
  const days = e.holding_days != null ? `${e.holding_days}d` : 'n/a';
  return `[${e.trade_date} | ${e.ticker} | ${e.rating} | ${pct(e.raw_return)} | ${pct(e.alpha_return)} | ${days}]`;
}

function formatFullEntry(e: MemoryEntry): string {
  const parts = [tagLine(e), `DECISION:\n${e.decision}`];
  if (e.reflection) parts.push(`REFLECTION:\n${e.reflection}`);
  return parts.join('\n\n');
}

function formatReflectionOnly(e: MemoryEntry): string {
  const head = `[${e.trade_date} | ${e.ticker} | ${e.rating} | ${pct(e.raw_return)}]`;
  if (e.reflection) return `${head}\n${e.reflection}`;
  const decision = e.decision.length > 300 ? `${e.decision.slice(0, 300)}...` : e.decision;
  return `${head}\n${decision}`;
}

// Re-exported for tests that want deterministic asserts.
export const _formatters = { formatFullEntry, formatReflectionOnly, pct, tagLine };
// Re-export `Rating` for callers building `StoreDecisionInput` ad-hoc.
export type { Rating };
