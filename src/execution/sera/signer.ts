/**
 * @packageDocumentation
 * @module execution/sera/signer
 * @description Abstract signing surface for Sera EIP-712 intents.
 *
 * trading-fabric does not bundle a wallet — production deployments wire
 * in a viem / ethers signer, an HSM-backed signer, or a Veridex session
 * key. The framework only needs the contract:
 *
 *  - given a Sera quote (`route_params`, `permit`), return the hex
 *    signatures and (when applicable) the permit deadline.
 *
 * A `MockIntentSigner` is provided for tests and paper-style dry runs.
 */

import type { SeraQuoteResponse } from './types.js';

export interface SignedIntent {
  /** EIP-712 signature over `route_params`. */
  signature: `0x${string}`;
  /** EIP-712 permit signature when `quote.permit` is non-null. */
  permitSignature?: `0x${string}`;
  /** Unix seconds — required when `permitSignature` is set. */
  permitDeadline?: number;
}

export interface IntentSigner {
  /** Ethereum address authorized to spend the from-token. */
  readonly ownerAddress: `0x${string}`;
  signIntent(quote: SeraQuoteResponse): Promise<SignedIntent>;
}

export interface MockIntentSignerOptions {
  ownerAddress?: `0x${string}`;
  signature?: `0x${string}`;
  permitSignature?: `0x${string}`;
  permitDeadlineSeconds?: number;
}

/**
 * Deterministic signer for tests and dry runs. Returns canned hex blobs;
 * real Sera execution will reject these, so in production wire a real
 * signer (e.g. viem `WalletClient.signTypedData`).
 */
export class MockIntentSigner implements IntentSigner {
  readonly ownerAddress: `0x${string}`;
  private readonly signature: `0x${string}`;
  private readonly permitSignature: `0x${string}`;
  private readonly permitDeadlineSeconds: number;

  constructor(opts: MockIntentSignerOptions = {}) {
    this.ownerAddress =
      opts.ownerAddress ?? '0x0000000000000000000000000000000000000001';
    this.signature =
      opts.signature ?? `0x${'a'.repeat(130)}` as `0x${string}`;
    this.permitSignature =
      opts.permitSignature ?? `0x${'b'.repeat(130)}` as `0x${string}`;
    this.permitDeadlineSeconds =
      opts.permitDeadlineSeconds ?? 60 * 60; // 1h
  }

  async signIntent(quote: SeraQuoteResponse): Promise<SignedIntent> {
    const needsPermit = quote.permit !== null && quote.permit !== undefined;
    const out: SignedIntent = { signature: this.signature };
    if (needsPermit) {
      out.permitSignature = this.permitSignature;
      out.permitDeadline = Math.floor(Date.now() / 1000) + this.permitDeadlineSeconds;
    }
    return out;
  }
}
