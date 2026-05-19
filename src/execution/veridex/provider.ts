/**
 * @packageDocumentation
 * @module execution/veridex/provider
 * @description Native Veridex execution provider.
 *
 * Uses `@veridex/sdk` `createSDK('base')` + `SessionManager` to dispatch
 * mock-USDC `transferViaRelayer` calls — the gasless, session-key-signed
 * code path Veridex demos exercise. The provider does not import
 * `@veridex/sdk` directly (it's an *optional* peer dependency of
 * trading-fabric); production code injects a concrete SDK that conforms
 * to the minimal `VeridexSDKLike` interface below.
 *
 * Bootstrap flow (caller's responsibility, performed once):
 *   1. `sdk = createSDK('base', { network })`
 *   2. Register a passkey (browser helper) → `sdk.passkey.setCredential(...)`
 *   3. Provision a vault (`sdk.vault.provision(...)`)
 *   4. `sessionManager = new SessionManager(...)`,
 *      `await sessionManager.createSession({ maxValue: USDC(50), duration: 86_400 })`
 *
 * The provider is then constructed with the SDK + session manager + the
 * static configuration the orchestrator needs (USDC address, target
 * Wormhole chain id, paper-trade recipient vault, optional source vault
 * for SELL flows).
 */

import { baseEnvelope, type ExecutionProvider, type ExecutionRequest } from '../types.js';
import type { ExecutionEnvelope } from '../../types/index.js';

/** Result shape the provider expects from `transferViaRelayer`. */
export interface VeridexTransferResult {
  transactionHash: string;
  sequence?: bigint | number | string;
  /** Optional pre-image of the signed action; useful for audit trails. */
  signedAction?: string;
}

/** Inputs forwarded to `transferViaRelayer`. Matches `@veridex/sdk` TransferParams. */
export interface VeridexTransferParams {
  targetChain: number;
  token: string;
  recipient: string;
  amount: bigint;
}

/**
 * Minimal subset of the Veridex SDK used by the executor. Keeping this
 * narrow lets trading-fabric tree-shake / type-check without depending
 * on the full `@veridex/sdk` surface.
 */
export interface VeridexSDKLike {
  transferViaRelayer(
    params: VeridexTransferParams,
  ): Promise<VeridexTransferResult>;
}

/**
 * Subset of `SessionManager` used here. The session manager is held
 * primarily for diagnostics (current session, expiry) and to surface
 * a `signedAction` blob when the SDK returns one.
 */
export interface VeridexSessionManagerLike {
  /** Optional — when present, embedded in envelope metadata. */
  getActiveSession?(): Promise<{ keyHash?: string; expiresAt?: number } | null>;
}

export interface VeridexExecutionProviderOptions {
  sdk: VeridexSDKLike;
  /** Optional but recommended — surfaces session metadata on the envelope. */
  sessionManager?: VeridexSessionManagerLike;
  /** USDC (or mock-USDC) ERC-20 address on the target chain. */
  usdcAddress: string;
  /** Wormhole chain id for the target spoke. */
  targetChainId: number;
  /** Vault that receives funds on `Buy`. The "paper-trade recipient". */
  paperRecipientVault: string;
  /**
   * Optional vault to receive funds on `Sell`. Defaults to the SDK's
   * own vault by passing `null` here; the provider then assumes the
   * caller pre-funded the recipient.
   *
   * In the default treasury demo, both BUY and SELL move USDC to the
   * paper recipient and rely on reconciliation jobs to flatten exposure.
   */
  sellRecipientVault?: string;
  /** USDC decimals. Default 6. */
  usdcDecimals?: number;
  /** Stamped on the envelope. Default `'testnet'`. */
  surface?: 'testnet' | 'mainnet';
  /** Override wall clock (tests). */
  now?: () => Date;
}

/**
 * `VeridexExecutionProvider` — translates a policy-approved `Proposal`
 * into a session-key-signed gasless transfer.
 *
 * Failures inside `transferViaRelayer` surface as `status: 'rejected'`
 * envelopes (provider does NOT throw on business-logic errors). Throws
 * only on construction-time misconfiguration.
 */
export class VeridexExecutionProvider implements ExecutionProvider {
  readonly id = 'veridex';
  private readonly sdk: VeridexSDKLike;
  private readonly sessionManager: VeridexSessionManagerLike | null;
  private readonly usdcAddress: string;
  private readonly targetChainId: number;
  private readonly paperRecipientVault: string;
  private readonly sellRecipientVault: string;
  private readonly usdcDecimals: number;
  private readonly surface: 'testnet' | 'mainnet';
  private readonly now: () => Date;

  constructor(opts: VeridexExecutionProviderOptions) {
    if (!opts.sdk) throw new Error('VeridexExecutionProvider: sdk is required');
    if (!opts.usdcAddress) throw new Error('VeridexExecutionProvider: usdcAddress is required');
    if (!opts.paperRecipientVault) {
      throw new Error('VeridexExecutionProvider: paperRecipientVault is required');
    }
    if (!Number.isInteger(opts.targetChainId) || opts.targetChainId <= 0) {
      throw new Error('VeridexExecutionProvider: targetChainId must be a positive integer');
    }
    this.sdk = opts.sdk;
    this.sessionManager = opts.sessionManager ?? null;
    this.usdcAddress = opts.usdcAddress;
    this.targetChainId = opts.targetChainId;
    this.paperRecipientVault = opts.paperRecipientVault;
    this.sellRecipientVault = opts.sellRecipientVault ?? opts.paperRecipientVault;
    this.usdcDecimals = opts.usdcDecimals ?? 6;
    this.surface = opts.surface ?? 'testnet';
    this.now = opts.now ?? (() => new Date());
  }

  /** Veridex provider claims every non-Hold request — sizing is policy's job. */
  supports(): boolean {
    return true;
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

    const amount = usdToBaseUnits(request.amountUsd, this.usdcDecimals);
    if (amount === 0n) {
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

    const recipient =
      request.action === 'Buy' ? this.paperRecipientVault : this.sellRecipientVault;

    let session: { keyHash?: string; expiresAt?: number } | null = null;
    if (this.sessionManager?.getActiveSession) {
      try {
        session = await this.sessionManager.getActiveSession();
      } catch {
        // Diagnostics only — never fatal.
      }
    }

    let result: VeridexTransferResult;
    try {
      result = await this.sdk.transferViaRelayer({
        targetChain: this.targetChainId,
        token: this.usdcAddress,
        recipient,
        amount,
      });
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : 'RELAYER_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      return baseEnvelope(request, this.id, {
        surface: 'failed',
        status: 'rejected',
        executedAt,
        error: { code, message },
        metadata: { session },
      });
    }

    return baseEnvelope(request, this.id, {
      surface: this.surface,
      status: 'filled',
      executedAt,
      txHash: result.transactionHash || null,
      signedAction: result.signedAction ?? null,
      metadata: {
        targetChainId: this.targetChainId,
        token: this.usdcAddress,
        recipient,
        amountBaseUnits: amount.toString(),
        sequence: result.sequence?.toString(),
        session,
      },
    });
  }
}

/**
 * Convert a USD amount (possibly fractional) to ERC-20 base units as a
 * `bigint`, rounded down. Pure — exported for tests.
 */
export function usdToBaseUnits(amountUsd: number, decimals: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0n;
  const [intPart, fracPart = ''] = amountUsd.toString().split('.');
  const padded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${padded}`.replace(/^0+/, '');
  return combined.length === 0 ? 0n : BigInt(combined);
}
