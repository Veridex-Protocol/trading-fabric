/**
 * @packageDocumentation
 * @module dataflows/http
 * @description Tiny `fetch` wrapper with timeout + bounded retries. No deps.
 */

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Total retry attempts on network/5xx errors (default: 2). */
  retries?: number;
  /** Base delay between retries in ms (default: 500). Exponential backoff. */
  backoffMs?: number;
  /**
   * Caller-supplied predicate that decides whether a 200-class response should
   * still be treated as transient (e.g. AlphaVantage rate-limit-as-JSON-200).
   */
  isTransient?: (body: string, status: number) => boolean;
}

const DEFAULT_UA =
  'trading-fabric/0.1 (+https://github.com/Veridex-Protocol)';

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<string> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15_000,
    retries = 2,
    backoffMs = 500,
    isTransient,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...headers },
        body,
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} on ${url}`);
      } else if (!res.ok) {
        // Non-retryable client error — surface immediately with body for context.
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} on ${url}: ${text.slice(0, 200)}`);
      } else {
        const text = await res.text();
        if (isTransient && isTransient(text, res.status)) {
          lastErr = new Error(`Transient signal in 2xx body from ${url}`);
        } else {
          return text;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }

    if (attempt < retries) {
      const delay = backoffMs * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function httpGetJson<T = unknown>(url: string, opts?: HttpOptions): Promise<T> {
  const text = await httpRequest(url, opts);
  return JSON.parse(text) as T;
}
