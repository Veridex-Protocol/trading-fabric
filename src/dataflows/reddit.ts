/**
 * @packageDocumentation
 * @module dataflows/reddit
 * @description Public Reddit search across finance subreddits. No API key
 * required; uses Reddit's public JSON endpoints which permit ~10 req/min/IP.
 * Returns a prompt-ready plaintext block matching the Python implementation.
 */

import type { FileCache } from './cache';
import { httpGetJson } from './http';

export const DEFAULT_SUBREDDITS = ['wallstreetbets', 'stocks', 'investing'] as const;

export interface RedditDeps {
  cache: FileCache;
  ttlMs?: number;
  /** Per-subreddit limit. */
  limitPerSub?: number;
  /** Inter-request delay in ms (default 400) to stay under public rate limits. */
  interRequestDelayMs?: number;
}

interface RedditListing {
  data?: {
    children?: Array<{ data?: RedditPost }>;
  };
}

interface RedditPost {
  title?: string;
  score?: number;
  num_comments?: number;
  created_utc?: number;
  selftext?: string;
}

async function fetchSub(ticker: string, sub: string, limit: number): Promise<RedditPost[]> {
  const qs = new URLSearchParams({
    q: ticker,
    restrict_sr: 'on',
    sort: 'new',
    t: 'week',
    limit: String(limit),
  });
  const url = `https://www.reddit.com/r/${sub}/search.json?${qs.toString()}`;
  try {
    const json = await httpGetJson<RedditListing>(url, { timeoutMs: 10_000, retries: 1 });
    return (json.data?.children ?? []).map((c) => c.data ?? {});
  } catch {
    return [];
  }
}

export async function fetchRedditPosts(
  ticker: string,
  subreddits: readonly string[],
  deps: RedditDeps,
): Promise<string> {
  const limitPerSub = deps.limitPerSub ?? 5;
  const delay = deps.interRequestDelayMs ?? 400;
  const cacheKey = `reddit:${ticker.toUpperCase()}:${subreddits.join(',')}:${limitPerSub}`;
  return deps.cache.memo<string>(cacheKey, deps.ttlMs ?? 15 * 60 * 1000, async () => {
    const blocks: string[] = [];
    let total = 0;
    for (let i = 0; i < subreddits.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, delay));
      const posts = await fetchSub(ticker, subreddits[i], limitPerSub);
      total += posts.length;
      if (posts.length === 0) {
        blocks.push(`r/${subreddits[i]}: <no posts found mentioning ${ticker.toUpperCase()} in the past 7 days>`);
        continue;
      }
      const lines = [`r/${subreddits[i]} — ${posts.length} recent posts mentioning ${ticker.toUpperCase()}:`];
      for (const p of posts) {
        const title = (p.title ?? '').replace(/\n/g, ' ').trim();
        const score = p.score ?? 0;
        const comments = p.num_comments ?? 0;
        const created = p.created_utc ? new Date(p.created_utc * 1000).toISOString().slice(0, 10) : '?';
        let body = (p.selftext ?? '').replace(/\n/g, ' ').trim();
        if (body.length > 240) body = `${body.slice(0, 240)}…`;
        lines.push(
          `  [${created} · ${String(score).padStart(4, ' ')}↑ · ${String(comments).padStart(3, ' ')}c] ${title}` +
            (body ? `\n    body excerpt: ${body}` : ''),
        );
      }
      blocks.push(lines.join('\n'));
    }
    if (total === 0) {
      return `<no Reddit posts found mentioning ${ticker.toUpperCase()} across ${subreddits.map((s) => `r/${s}`).join(', ')} in the past 7 days>`;
    }
    return blocks.join('\n\n');
  });
}
