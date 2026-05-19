/**
 * @packageDocumentation
 * @module execution/sera/provider
 * @description Real Sera CLOB execution provider.
 *
 * Flow per request:
 *   1. Refuse `Hold` (return a `skipped` envelope).
 *   2. Refuse tickers not in the InstrumentMap.
 *   3. Compute base-unit `from_amount` from `amountUsd` using the cash
 *      token's decimals (Sera quote-side denomination).
 *   4. POST /swap/quote → receive `uuid`, `route_params`, optional permit.
 *   5. Sign the intent (and the permit when present) via `IntentSigner`.
 *   6. POST /swap with the signed payload → receive `tx_hash`.
 *   7. Return an envelope stamped `surface: 'testnet'` (or whatever the
 *      operator configured).
 *
 * Failures are encoded into the envelope (`status: 'rejected'`); the
 * provider only throws on infrastructure faults the caller didn't ask
 * about (e.g. invalid config at construction time).
 */

import { baseEnvelope, type ExecutionProvider, type ExecutionRequest } from '../types.js';
import type { ExecutionEnvelope } from '../../types/index.js';
import { SeraApiException, type SeraClient } from './client.js';
import type { InstrumentMap } from './instrumentMap.js';
import type { IntentSigner } from './signer.js';

export interface SeraExecutionProviderOptions {
  client: SeraClient;
  instruments: InstrumentMap;
  signer: IntentSigner;
  /** Recipient of the bought asset. Defaults to `signer.ownerAddress`. */
  recipient?: `0x${string}`;
  /**
   * Network the operator believes they're hitting. Stamped onto the
   * envelope; default `'testnet'`. Set to `'mainnet'` only when the
   * client baseUrl points at production Sera.
   */
  surface?: 'testnet' | 'mainnet';
  /** Quote validity window (seconds from now). Default: 300. */
  quoteExpirationSeconds?: number;
  /** Sera `gas_mode`. Default: `'receive_less'`. */
  gasMode?: 'receive_less' | 'pay_more';
  /**
   * When `true`, fetch a quote but skip the `/swap` call. Surface becomes
   * `'quote_only'` — useful for dry-run dashboards.
   */
  quoteOnly?: boolean;
  /** Override the wall clock (tests). */
  now?: () => Date;
}

export class SeraExecutionProvider implements ExecutionProvider {
  readonly id = 'sera';
  private readonly client: SeraClient;
  private readonly instruments: InstrumentMap;
  private readonly signer: IntentSigner;
  private readonly recipient: `0x${string}`;
  private readonly surface: 'testnet' | 'mainnet';
  private readonly quoteExpirationSeconds: number;
  private readonly gasMode: 'receive_less' | 'pay_more';
  private readonly quoteOnly: boolean;
  private readonly now: () => Date;

  constructor(opts: SeraExecutionProviderOptions) {
    this.client = opts.client;
    this.instruments = opts.instruments;
    this.signer = opts.signer;
    this.recipient = opts.recipient ?? opts.signer.ownerAddress;
    this.surface = opts.surface ?? 'testnet';
    this.quoteExpirationSeconds = opts.quoteExpirationSeconds ?? 300;
    this.gasMode = opts.gasMode ?? 'receive_less';
    this.quoteOnly = opts.quoteOnly ?? false;
    this.now = opts.now ?? (() => new Date());
  }

  supports(request: ExecutionRequest): boolean {
    if (request.action === 'Hold') return true;
    return this.instruments.has(request.ticker);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionEnvelope> {
    const executedAt = this.now().toISOString();

    if (request.action === 'Hold') {
      return baseEnvelope(request, this.id, {
        surface: 'simulation',
        status: 'skipped',
        executedAt,
        metadata: { reason: 'hold' },
      });
    }

    const instrument = this.instruments.get(request.ticker);
    if (!instrument) {
      return baseEnvelope(request, this.id, {
        surface: 'failed',
        status: 'rejected',
        executedAt,
        error: {
          code: 'INSTRUMENT_NOT_MAPPED',
          message: `Sera: no token mapping for ${request.ticker}`,
        },
      });
    }

    const cash = this.instruments.cash;
    const [fromToken, toToken, fromDecimals] =
      request.action === 'Buy'
        ? [cash.address, instrument.address, cash.decimals]
        : [instrument.address, cash.address, instrument.decimals];

    const fromAmountBaseUnits = toBaseUnits(request.amountUsd, fromDecimals);
    if (fromAmountBaseUnits === '0') {
      return baseEnvelope(request, this.id, {
        surface: 'failed',
        status: 'rejected',
        executedAt,
        error: {
          code: 'AMOUNT_BELOW_MIN',
          message: 'amountUsd resolves to zero base units',
        },
      });
    }

    const expiration =
      Math.floor(this.now().getTime() / 1000) + this.quoteExpirationSeconds;

    let quote;
    try {
      quote = await this.client.quote({
        from_token: fromToken,
        to_token: toToken,
        from_amount: fromAmountBaseUnits,
        owner_address: this.signer.ownerAddress,
        recipient: this.recipient,
        expiration,
        gas_mode: this.gasMode,
      });
    } catch (err) {
      return errorEnvelope(request, this.id, executedAt, err, 'QUOTE_FAILED');
    }

    if (this.quoteOnly) {
      return baseEnvelope(request, this.id, {
        surface: 'quote_only',
        status: 'pending',
        executedAt,
        metadata: {
          quoteUuid: quote.uuid,
          fromToken,
          toToken,
          fromAmountBaseUnits,
          toAmountBaseUnits: quote.to_amount,
          feeBreakdown: quote.fee_breakdown,
          expiresAt: quote.expires_at,
        },
      });
    }

    let signed;
    try {
      signed = await this.signer.signIntent(quote);
    } catch (err) {
      return errorEnvelope(request, this.id, executedAt, err, 'SIGN_FAILED');
    }

    let swapResp;
    try {
      swapResp = await this.client.swap({
        uuid: quote.uuid,
        signature: signed.signature,
        permit_signature: signed.permitSignature,
        permit_deadline: signed.permitDeadline,
      });
    } catch (err) {
      return errorEnvelope(request, this.id, executedAt, err, 'SWAP_FAILED');
    }

    const txHash = swapResp.tx_hash ?? swapResp.transaction_hash ?? null;
    const status = swapResp.status?.toLowerCase();
    const filled = status === undefined || status === 'filled' || status === 'success' || status === 'submitted';

    return baseEnvelope(request, this.id, {
      surface: this.surface,
      status: filled ? 'filled' : 'pending',
      executedAt,
      txHash,
      signedAction: signed.signature,
      metadata: {
        quoteUuid: quote.uuid,
        fromToken,
        toToken,
        fromAmountBaseUnits,
        toAmountBaseUnits: quote.to_amount,
        feeBreakdown: quote.fee_breakdown,
        seraStatus: swapResp.status,
      },
    });
  }
}

function errorEnvelope(
  request: ExecutionRequest,
  provider: string,
  executedAt: string,
  err: unknown,
  fallbackCode: string,
): ExecutionEnvelope {
  if (err instanceof SeraApiException) {
    return baseEnvelope(request, provider, {
      surface: 'failed',
      status: 'rejected',
      executedAt,
      error: {
        code: err.code ?? fallbackCode,
        message: err.message,
      },
      metadata: { httpStatus: err.status, raw: err.raw },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return baseEnvelope(request, provider, {
    surface: 'failed',
    status: 'rejected',
    executedAt,
    error: { code: fallbackCode, message },
  });
}

/**
 * Convert a fractional USD-denominated number to a base-unit decimal
 * string without losing precision via floats. Rounded down.
 */
export function toBaseUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  const scale = 10 ** decimals;
  const units = Math.trunc(amount * scale);
  if (!Number.isSafeInteger(units)) {
    throw new Error('amount is too large to convert safely from a number');
  }
  return units.toString();
}
