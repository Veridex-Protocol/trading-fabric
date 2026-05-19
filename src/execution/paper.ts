/**
 * @packageDocumentation
 * @module execution/paper
 * @description Deterministic paper-trading provider. Maintains an
 * in-memory position book + cash balance; optionally persists every
 * envelope to a JSONL ledger.
 *
 * The book is intentionally minimal — entry price, qty, opened-at. It
 * exists so the same provider can be asked to close positions later
 * (and produce realistic P&L if the caller supplies a current price).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ExecutionEnvelope } from '../types/index.js';
import { baseEnvelope, type ExecutionProvider, type ExecutionRequest } from './types.js';

export interface PaperPosition {
  ticker: string;
  qty: number;
  /** Average entry price in USD. */
  entryPriceUsd: number;
  openedAt: string;
}

export interface PaperLedgerEntry {
  envelope: ExecutionEnvelope;
  position: PaperPosition | null;
  cashUsd: number;
}

export interface PaperExecutionProviderOptions {
  /** Starting cash balance. Default: 100_000 USD. */
  startingCashUsd?: number;
  /**
   * Optional pricer used to convert `amountUsd` into a quantity and to
   * mark current positions for sell-side fills. Defaults to a constant
   * $100/unit — adequate for testing the plumbing.
   */
  pricer?: (ticker: string, trade_date: string) => number | Promise<number>;
  /** When set, every envelope is appended as a JSONL line to this path. */
  ledgerPath?: string | null;
  /** Override the id factory (tests). */
  txHashFactory?: () => string;
  /** Override the wall clock (tests). */
  now?: () => Date;
}

/**
 * Process-local paper-trading provider. Concurrency-safe at the JS event
 * loop level (single-threaded mutations) but NOT cross-process — ship a
 * disk-backed implementation when sharing state across workers.
 */
export class PaperExecutionProvider implements ExecutionProvider {
  readonly id = 'paper';
  private cashUsd: number;
  private readonly positions = new Map<string, PaperPosition>();
  private readonly pricer: (
    ticker: string,
    trade_date: string,
  ) => number | Promise<number>;
  private readonly ledgerPath: string | null;
  private readonly txHashFactory: () => string;
  private readonly now: () => Date;
  /** Append-only in-memory ledger. Mirrors the on-disk JSONL when enabled. */
  readonly ledger: PaperLedgerEntry[] = [];

  constructor(opts: PaperExecutionProviderOptions = {}) {
    this.cashUsd = opts.startingCashUsd ?? 100_000;
    this.pricer = opts.pricer ?? (() => 100);
    this.ledgerPath = opts.ledgerPath ?? null;
    this.txHashFactory =
      opts.txHashFactory ?? (() => `paper-${randomUUID().slice(0, 12)}`);
    this.now = opts.now ?? (() => new Date());
  }

  /** Paper accepts every request. */
  supports(): boolean {
    return true;
  }

  /** Current cash balance. */
  getCash(): number {
    return this.cashUsd;
  }

  /** Open position for a ticker, or `null` if none. */
  getPosition(ticker: string): PaperPosition | null {
    return this.positions.get(ticker) ?? null;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionEnvelope> {
    const executedAt = this.now().toISOString();

    if (request.action === 'Hold') {
      return this.finish(
        request,
        baseEnvelope(request, this.id, {
          surface: 'simulation',
          status: 'skipped',
          executedAt,
          metadata: { reason: 'hold' },
        }),
      );
    }

    const price = await this.pricer(request.ticker, request.trade_date);
    if (!Number.isFinite(price) || price <= 0) {
      return this.finish(
        request,
        baseEnvelope(request, this.id, {
          surface: 'failed',
          status: 'rejected',
          executedAt,
          error: { code: 'NO_PRICE', message: 'Pricer returned no usable price' },
        }),
      );
    }
    const qty = request.amountUsd / price;

    if (request.action === 'Buy') {
      if (request.amountUsd > this.cashUsd) {
        return this.finish(
          request,
          baseEnvelope(request, this.id, {
            surface: 'failed',
            status: 'rejected',
            executedAt,
            error: {
              code: 'INSUFFICIENT_CASH',
              message: `Need $${request.amountUsd.toFixed(2)}, have $${this.cashUsd.toFixed(2)}`,
            },
          }),
        );
      }
      this.cashUsd -= request.amountUsd;
      const existing = this.positions.get(request.ticker);
      if (existing) {
        const totalQty = existing.qty + qty;
        const newAvg =
          (existing.qty * existing.entryPriceUsd + qty * price) / totalQty;
        this.positions.set(request.ticker, {
          ticker: request.ticker,
          qty: totalQty,
          entryPriceUsd: newAvg,
          openedAt: existing.openedAt,
        });
      } else {
        this.positions.set(request.ticker, {
          ticker: request.ticker,
          qty,
          entryPriceUsd: price,
          openedAt: executedAt,
        });
      }
      return this.finish(
        request,
        baseEnvelope(request, this.id, {
          surface: 'simulation',
          status: 'filled',
          executedAt,
          txHash: this.txHashFactory(),
          metadata: { fillPriceUsd: price, qty, cashAfter: this.cashUsd },
        }),
      );
    }

    // action === 'Sell'
    const existing = this.positions.get(request.ticker);
    if (!existing) {
      return this.finish(
        request,
        baseEnvelope(request, this.id, {
          surface: 'failed',
          status: 'rejected',
          executedAt,
          error: { code: 'NO_POSITION', message: `No open position for ${request.ticker}` },
        }),
      );
    }
    const sellQty = Math.min(qty, existing.qty);
    const proceeds = sellQty * price;
    this.cashUsd += proceeds;
    const remaining = existing.qty - sellQty;
    if (remaining <= 1e-9) {
      this.positions.delete(request.ticker);
    } else {
      this.positions.set(request.ticker, { ...existing, qty: remaining });
    }
    return this.finish(
      request,
      baseEnvelope(request, this.id, {
        surface: 'simulation',
        status: 'filled',
        executedAt,
        txHash: this.txHashFactory(),
        metadata: {
          fillPriceUsd: price,
          qty: sellQty,
          proceeds,
          cashAfter: this.cashUsd,
          realizedPnlUsd: (price - existing.entryPriceUsd) * sellQty,
        },
      }),
    );
  }

  private async finish(
    request: ExecutionRequest,
    envelope: ExecutionEnvelope,
  ): Promise<ExecutionEnvelope> {
    const entry: PaperLedgerEntry = {
      envelope,
      position: this.positions.get(request.ticker) ?? null,
      cashUsd: this.cashUsd,
    };
    this.ledger.push(entry);
    if (this.ledgerPath) {
      await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
      await fs.appendFile(this.ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
    }
    return envelope;
  }
}
