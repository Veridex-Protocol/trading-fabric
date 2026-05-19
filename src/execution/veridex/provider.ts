/**
 * @packageDocumentation
 * @module execution/veridex/provider
 * @description Native Veridex execution provider.
 *
 * The preferred execution path is session-key based:
 *   1. Build a mock-USDC transfer payload with the Veridex SDK.
 *   2. Ensure a 24h / $50 USDC SessionManager session exists.
 *   3. Sign the transfer action with the session key.
 *   4. Submit the session-signed action through a relayer.
 *
 * The current SDK also exposes `transferViaRelayer`; we retain it as a
 * fallback for environments that have not wired session-action relaying
 * yet. Tests pin the session path so the differentiator does not drift.
 */

import { baseEnvelope, type ExecutionProvider, type ExecutionRequest } from '../types.js';
import type { ExecutionEnvelope } from '../../types/index.js';

export interface VeridexTransferResult {
  transactionHash: string;
  sequence?: bigint | number | string;
  signedAction?: string;
}

export interface VeridexTransferParams {
  targetChain: number;
  token: string;
  recipient: string;
  amount: bigint;
}

export interface VeridexSessionInfo {
  keyHash?: string;
  userKeyHash?: string;
  expiresAt?: number;
  expiry?: number;
  maxValue?: bigint;
}

export interface VeridexSessionAction {
  action: 'transfer';
  targetChain: number;
  value: bigint;
  payload: Uint8Array;
  nonce: number;
  deadline?: number;
}

export interface VeridexSessionSignedAction {
  action: VeridexSessionAction;
  signature: unknown;
  readyToSubmit?: boolean;
}

export interface VeridexRelayerSubmitRequest {
  action: 'transfer';
  targetChain: number;
  value: string;
  payload: string;
  nonce: number;
  signature: unknown;
}

export interface VeridexRelayerResult {
  success?: boolean;
  txHash?: string;
  transactionHash?: string;
  sequence?: bigint | number | string;
  error?: string;
}

export interface VeridexRelayerLike {
  submitSignedAction(request: VeridexRelayerSubmitRequest): Promise<VeridexRelayerResult>;
}

/** Narrow SDK surface used by the executor; `@veridex/sdk` remains optional. */
export interface VeridexSDKLike {
  buildTransferPayload?(params: VeridexTransferParams): Promise<string>;
  getNonce?(): Promise<bigint | number | string>;
  transferViaRelayer?(params: VeridexTransferParams): Promise<VeridexTransferResult>;
}

export interface VeridexSessionManagerLike {
  getActiveSession?(): Promise<VeridexSessionInfo | null>;
  getSession?(): VeridexSessionInfo | null;
  loadSession?(keyHash?: string): Promise<VeridexSessionInfo | null>;
  createSession?(config: { maxValue: bigint; duration: number }): Promise<VeridexSessionInfo>;
  signAction?(action: VeridexSessionAction): Promise<VeridexSessionSignedAction>;
}

export interface VeridexExecutionProviderOptions {
  /** Primary/user vault SDK. Used for BUY transfers into the paper vault. */
  sdk: VeridexSDKLike;
  /** BUY-side session manager. */
  sessionManager?: VeridexSessionManagerLike;
  /** BUY-side relayer for session-signed action submission. */
  relayer?: VeridexRelayerLike;
  /** Paper-vault SDK used for SELL reverse transfers. Defaults to `sdk`. */
  sellSdk?: VeridexSDKLike;
  /** SELL-side session manager. */
  sellSessionManager?: VeridexSessionManagerLike;
  /** SELL-side relayer. Defaults to `relayer`. */
  sellRelayer?: VeridexRelayerLike;
  /** USDC (or mock-USDC) ERC-20 address on the target chain. */
  usdcAddress: string;
  /** Wormhole chain id for the target spoke. */
  targetChainId: number;
  /** Vault that receives funds on `Buy`. The paper-trade recipient. */
  paperRecipientVault: string;
  /** Vault that receives funds on `Sell` (usually the user's vault). */
  sellRecipientVault?: string;
  /** USDC decimals. Default 6. */
  usdcDecimals?: number;
  /** Session limit minted on first run. Default: $50 USDC. */
  sessionMaxValueUsd?: number;
  /** Session lifetime minted on first run. Default: 86_400 seconds. */
  sessionDurationSeconds?: number;
  /** Stamped on the envelope. Default `'testnet'`. */
  surface?: 'testnet' | 'mainnet';
  /** Override wall clock (tests). */
  now?: () => Date;
}

interface ExecutionPathResult {
  transactionHash: string;
  sequence?: bigint | number | string;
  signedAction: string | null;
  session: VeridexSessionInfo | null;
  mode: 'session' | 'legacy-transfer-via-relayer';
}

export class VeridexExecutionProvider implements ExecutionProvider {
  readonly id = 'veridex';
  private readonly sdk: VeridexSDKLike;
  private readonly sessionManager: VeridexSessionManagerLike | null;
  private readonly relayer: VeridexRelayerLike | null;
  private readonly sellSdk: VeridexSDKLike;
  private readonly sellSessionManager: VeridexSessionManagerLike | null;
  private readonly sellRelayer: VeridexRelayerLike | null;
  private readonly usdcAddress: string;
  private readonly targetChainId: number;
  private readonly paperRecipientVault: string;
  private readonly sellRecipientVault: string;
  private readonly usdcDecimals: number;
  private readonly sessionMaxValueUsd: number;
  private readonly sessionDurationSeconds: number;
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
    this.relayer = opts.relayer ?? null;
    this.sellSdk = opts.sellSdk ?? opts.sdk;
    this.sellSessionManager = opts.sellSessionManager ?? opts.sessionManager ?? null;
    this.sellRelayer = opts.sellRelayer ?? opts.relayer ?? null;
    this.usdcAddress = opts.usdcAddress;
    this.targetChainId = opts.targetChainId;
    this.paperRecipientVault = opts.paperRecipientVault;
    this.sellRecipientVault = opts.sellRecipientVault ?? opts.paperRecipientVault;
    this.usdcDecimals = opts.usdcDecimals ?? 6;
    this.sessionMaxValueUsd = opts.sessionMaxValueUsd ?? 50;
    this.sessionDurationSeconds = opts.sessionDurationSeconds ?? 86_400;
    this.surface = opts.surface ?? 'testnet';
    this.now = opts.now ?? (() => new Date());
  }

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

    const recipient = request.action === 'Buy' ? this.paperRecipientVault : this.sellRecipientVault;
    const direction =
      request.action === 'Buy'
        ? 'user_vault_to_paper_vault'
        : 'paper_vault_to_user_vault';
    const params: VeridexTransferParams = {
      targetChain: this.targetChainId,
      token: this.usdcAddress,
      recipient,
      amount,
    };

    let result: ExecutionPathResult;
    try {
      result = await this.dispatch(request.action, params);
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
        metadata: { direction },
      });
    }

    return baseEnvelope(request, this.id, {
      surface: this.surface,
      status: 'filled',
      executedAt,
      txHash: result.transactionHash || null,
      signedAction: result.signedAction,
      metadata: {
        targetChainId: this.targetChainId,
        token: this.usdcAddress,
        recipient,
        direction,
        amountBaseUnits: amount.toString(),
        sequence: result.sequence?.toString(),
        session: normalizeSession(result.session),
        executionMode: result.mode,
      },
    });
  }

  private async dispatch(
    action: 'Buy' | 'Sell',
    params: VeridexTransferParams,
  ): Promise<ExecutionPathResult> {
    const activeSdk = action === 'Sell' ? this.sellSdk : this.sdk;
    const activeSessionManager = action === 'Sell' ? this.sellSessionManager : this.sessionManager;
    const activeRelayer = action === 'Sell' ? this.sellRelayer : this.relayer;

    if (
      activeSdk.buildTransferPayload &&
      activeSdk.getNonce &&
      activeSessionManager?.signAction &&
      activeRelayer
    ) {
      const session = await this.ensureSession(activeSessionManager);
      const payload = await activeSdk.buildTransferPayload(params);
      const nonce = toSafeNonce(await activeSdk.getNonce());
      const sessionAction: VeridexSessionAction = {
        action: 'transfer',
        targetChain: params.targetChain,
        value: params.amount,
        payload: hexToBytes(payload),
        nonce,
      };
      const signed = await activeSessionManager.signAction(sessionAction);
      const relayerResult = await activeRelayer.submitSignedAction({
        action: 'transfer',
        targetChain: params.targetChain,
        value: params.amount.toString(),
        payload,
        nonce,
        signature: signed.signature,
      });
      if (relayerResult.success === false) {
        throw Object.assign(new Error(relayerResult.error ?? 'Relayer rejected signed action'), {
          code: 'RELAYER_REJECTED',
        });
      }
      return {
        transactionHash: relayerResult.txHash ?? relayerResult.transactionHash ?? '',
        sequence: relayerResult.sequence,
        signedAction: serializeSignedAction(signed),
        session,
        mode: 'session',
      };
    }

    if (!activeSdk.transferViaRelayer) {
      throw Object.assign(
        new Error('No session relayer path or legacy transferViaRelayer path configured'),
        { code: 'EXECUTOR_NOT_CONFIGURED' },
      );
    }

    const legacy = await activeSdk.transferViaRelayer(params);
    const session = activeSessionManager ? await this.lookupSession(activeSessionManager) : null;
    return {
      transactionHash: legacy.transactionHash,
      sequence: legacy.sequence,
      signedAction: legacy.signedAction ?? null,
      session,
      mode: 'legacy-transfer-via-relayer',
    };
  }

  private async ensureSession(
    manager: VeridexSessionManagerLike,
  ): Promise<VeridexSessionInfo | null> {
    const existing = await this.lookupSession(manager);
    if (existing) return existing;
    if (!manager.createSession) return null;
    return manager.createSession({
      maxValue: usdToBaseUnits(this.sessionMaxValueUsd, this.usdcDecimals),
      duration: this.sessionDurationSeconds,
    });
  }

  private async lookupSession(
    manager: VeridexSessionManagerLike,
  ): Promise<VeridexSessionInfo | null> {
    if (manager.getActiveSession) {
      const active = await manager.getActiveSession();
      if (active) return active;
    }
    if (manager.getSession) {
      const active = manager.getSession();
      if (active) return active;
    }
    if (manager.loadSession) {
      const loaded = await manager.loadSession();
      if (loaded) return loaded;
    }
    return null;
  }
}

export function usdToBaseUnits(amountUsd: number, decimals: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0n;
  const scale = 10 ** decimals;
  const units = Math.trunc(amountUsd * scale);
  if (!Number.isSafeInteger(units)) {
    throw new Error('amountUsd is too large to convert safely from a number');
  }
  return BigInt(units);
}

function normalizeSession(session: VeridexSessionInfo | null): Record<string, unknown> | null {
  if (!session) return null;
  return {
    keyHash: session.keyHash,
    userKeyHash: session.userKeyHash,
    expiresAt: session.expiresAt ?? session.expiry,
    maxValue: session.maxValue?.toString(),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length === 0) return new Uint8Array();
  const even = normalized.length % 2 === 0 ? normalized : `0${normalized}`;
  const bytes = new Uint8Array(even.length / 2);
  for (let index = 0; index < even.length; index += 2) {
    bytes[index / 2] = Number.parseInt(even.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function toSafeNonce(value: bigint | number | string): number {
  const parsed = typeof value === 'bigint' ? value : BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('nonce is too large to represent safely');
  }
  return Number(parsed);
}

function serializeSignedAction(signed: VeridexSessionSignedAction): string {
  return JSON.stringify(signed, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return bytesToHex(value);
    return value;
  });
}