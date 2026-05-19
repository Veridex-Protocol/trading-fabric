/**
 * @packageDocumentation
 * @module dataflows/stocktwits
 * @description StockTwits public per-symbol stream. No API key required.
 * Returns prompt-ready plaintext, matching the Python implementation.
 */

import type { FileCache } from './cache';
import { httpGetJson } from './http';

export interface StocktwitsDeps {
  cache: FileCache;
  ttlMs?: number;
  limit?: number;
}

interface StocktwitsResponse {
  messages?: Array<{
    created_at?: string;
    user?: { username?: string };
    entities?: { sentiment?: { basic?: string } | null };
    body?: string;
  }>;
}

export async function fetchStocktwitsMessages(ticker: string, deps: StocktwitsDeps): Promise<string> {
  const limit = deps.limit ?? 30;
  const cacheKey = `stocktwits:${ticker.toUpperCase()}:${limit}`;
  return deps.cache.memo<string>(cacheKey, deps.ttlMs ?? 10 * 60 * 1000, async () => {
    const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(ticker.toUpperCase())}.json`;
    let data: StocktwitsResponse;
    try {
      data = await httpGetJson<StocktwitsResponse>(url, { timeoutMs: 10_000, retries: 1 });
    } catch (err) {
      return `<stocktwits unavailable: ${err instanceof Error ? err.name : 'Error'}>`;
    }

    const messages = data.messages ?? [];
    if (messages.length === 0) return `<no StockTwits messages found for $${ticker.toUpperCase()}>`;

    let bullish = 0;
    let bearish = 0;
    let unlabeled = 0;
    const lines: string[] = [];
    for (const m of messages.slice(0, limit)) {
      const created = m.created_at ?? '';
      const user = m.user?.username ?? '?';
      const sentiment = m.entities?.sentiment?.basic ?? null;
      let body = (m.body ?? '').replace(/\n/g, ' ').trim();
      if (body.length > 280) body = `${body.slice(0, 280)}…`;
      let tag: string;
      if (sentiment === 'Bullish') {
        bullish++;
        tag = 'Bullish';
      } else if (sentiment === 'Bearish') {
        bearish++;
        tag = 'Bearish';
      } else {
        unlabeled++;
        tag = 'no-label';
      }
      lines.push(`[${created} · @${user} · ${tag}] ${body}`);
    }
    const total = bullish + bearish + unlabeled;
    const bullPct = total ? Math.round((100 * bullish) / total) : 0;
    const bearPct = total ? Math.round((100 * bearish) / total) : 0;
    const summary = `Bullish: ${bullish} (${bullPct}%) · Bearish: ${bearish} (${bearPct}%) · Unlabeled: ${unlabeled} · Total: ${total} most-recent messages`;
    return `${summary}\n\n${lines.join('\n')}`;
  });
}
