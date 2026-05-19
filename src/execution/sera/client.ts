/**
 * @packageDocumentation
 * @module execution/sera/client
 * @description Typed wrapper around Sera REST endpoints. Auth is none on
 * the read endpoints; authorization on `/swap` is the EIP-712 Intent
 * signature included in the request body, so the client itself stays
 * stateless.
 *
 * `fetchImpl` is injectable so tests run without network access.
 */

import {
  SeraMarketSchema,
  SeraQuoteRequestSchema,
  SeraQuoteResponseSchema,
  SeraSwapRequestSchema,
  SeraSwapResponseSchema,
  SeraTokenSchema,
  type SeraApiError,
  type SeraMarket,
  type SeraQuoteRequest,
  type SeraQuoteResponse,
  type SeraSwapRequest,
  type SeraSwapResponse,
  type SeraToken,
} from './types.js';

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SeraClientOptions {
  /** REST base, e.g. `https://api-testnet.sera.cx/api/v1`. No trailing slash. */
  baseUrl: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout (ms). Default: 15_000. */
  timeoutMs?: number;
  /** Optional default headers (correlation ids, etc.). */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 15_000;

export class SeraApiException extends Error {
  readonly status: number;
  readonly code?: string;
  readonly raw?: unknown;
  constructor(err: SeraApiError) {
    super(err.message);
    this.name = 'SeraApiException';
    this.status = err.status;
    this.code = err.code;
    this.raw = err.raw;
  }
}

export class SeraClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(opts: SeraClientOptions) {
    if (!opts.baseUrl) throw new Error('SeraClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl =
      opts.fetchImpl ??
      ((input, init) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  }

  async listTokens(): Promise<SeraToken[]> {
    const data = await this.request<unknown>('GET', '/tokens');
    const arr = Array.isArray(data) ? data : (data as { tokens?: unknown[]; data?: unknown[] }).tokens ?? (data as { data?: unknown[] }).data ?? [];
    return SeraTokenSchema.array().parse(arr);
  }

  async listMarkets(): Promise<SeraMarket[]> {
    const data = await this.request<unknown>('GET', '/markets');
    const arr = Array.isArray(data) ? data : (data as { markets?: unknown[]; data?: unknown[] }).markets ?? (data as { data?: unknown[] }).data ?? [];
    return SeraMarketSchema.array().parse(arr);
  }

  async quote(req: SeraQuoteRequest): Promise<SeraQuoteResponse> {
    const body = SeraQuoteRequestSchema.parse(req);
    const data = await this.request<unknown>('POST', '/swap/quote', body);
    return SeraQuoteResponseSchema.parse(data);
  }

  async swap(req: SeraSwapRequest): Promise<SeraSwapResponse> {
    const body = SeraSwapRequestSchema.parse(req);
    const data = await this.request<unknown>('POST', '/swap', body);
    return SeraSwapResponseSchema.parse(data);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        throw new SeraApiException(normalizeError(res.status, json));
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Sera serves at least three error shapes; collapse to one for callers.
 *   1. { detail: { detail, error_code } }
 *   2. { detail: { success: false, error: "no_liquidity" } }
 *   3. { detail: "..." }
 */
function normalizeError(status: number, payload: unknown): SeraApiError {
  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>;
    const inner = root.detail;
    if (inner && typeof inner === 'object') {
      const innerRec = inner as Record<string, unknown>;
      const code =
        (innerRec.error_code as string | undefined) ??
        (innerRec.code as string | undefined) ??
        (typeof innerRec.error === 'string' ? (innerRec.error as string) : undefined);
      const message =
        (innerRec.detail as string | undefined) ??
        (typeof innerRec.error === 'string' ? (innerRec.error as string) : undefined) ??
        `Sera request failed (${status})`;
      return {
        status,
        code: code ? code.toUpperCase() : undefined,
        message,
        raw: payload,
      };
    }
    if (typeof inner === 'string') {
      return { status, message: inner, raw: payload };
    }
  }
  return { status, message: `Sera request failed (${status})`, raw: payload };
}
