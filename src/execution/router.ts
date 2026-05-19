/**
 * @packageDocumentation
 * @module execution/router
 * @description Composes multiple `ExecutionProvider`s into a single
 * dispatcher. The router walks the registered providers in declaration
 * order, picks the first whose `supports(request)` returns true, and
 * delegates `execute`. When no provider claims the request, the router
 * either falls back to a configured default or returns a deterministic
 * `UNROUTABLE` envelope.
 *
 * This is the public façade most callers should use; build it once at
 * boot and inject into the orchestrator.
 */

import { baseEnvelope, type ExecutionProvider, type ExecutionRequest } from './types.js';
import type { ExecutionEnvelope } from '../types/index.js';

export interface ExecutionRouterOptions {
  /** Ordered list — first match wins. */
  providers: ExecutionProvider[];
  /**
   * Provider invoked when nothing in `providers` claims a request.
   * Typically `PaperExecutionProvider` so unknown tickers degrade to a
   * simulated fill rather than blocking the run.
   */
  fallback?: ExecutionProvider;
}

export class ExecutionRouter implements ExecutionProvider {
  readonly id = 'router';
  private readonly providers: ExecutionProvider[];
  private readonly fallback: ExecutionProvider | null;

  constructor(opts: ExecutionRouterOptions) {
    this.providers = [...opts.providers];
    this.fallback = opts.fallback ?? null;
  }

  /** The router supports a request iff any registered provider does. */
  async supports(request: ExecutionRequest): Promise<boolean> {
    for (const p of this.providers) {
      if (await p.supports(request)) return true;
    }
    return this.fallback ? Boolean(await this.fallback.supports(request)) : false;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionEnvelope> {
    for (const p of this.providers) {
      if (await p.supports(request)) {
        const env = await p.execute(request);
        return { ...env, provider: env.provider || p.id };
      }
    }
    if (this.fallback) {
      const env = await this.fallback.execute(request);
      return { ...env, provider: env.provider || this.fallback.id };
    }
    return baseEnvelope(request, this.id, {
      surface: 'failed',
      status: 'rejected',
      error: {
        code: 'UNROUTABLE',
        message: 'No execution provider claimed the request',
      },
    });
  }
}
