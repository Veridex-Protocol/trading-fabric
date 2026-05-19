/**
 * @packageDocumentation
 * @module execution/sera/types
 * @description Shapes of the Sera REST surface we depend on. These are
 * intentionally *narrow* — we model only the fields trading-fabric reads
 * or writes so we don't break when Sera evolves unrelated metadata.
 *
 * Canonical reference: https://docs.testnet.sera.cx/api-reference/
 */

import { z } from 'zod';

export const SeraTokenSchema = z
  .object({
    address: z.string(),
    symbol: z.string(),
    decimals: z.number().int().nonnegative(),
    name: z.string().optional(),
  })
  .passthrough();
export type SeraToken = z.infer<typeof SeraTokenSchema>;

export const SeraMarketSchema = z
  .object({
    base_token: z.string(),
    quote_token: z.string(),
  })
  .passthrough();
export type SeraMarket = z.infer<typeof SeraMarketSchema>;

export const SeraQuoteRequestSchema = z.object({
  from_token: z.string(),
  to_token: z.string(),
  from_amount: z.string(), // base-unit string
  owner_address: z.string(),
  recipient: z.string(),
  expiration: z.number().int().positive(),
  gas_mode: z.enum(['receive_less', 'pay_more']).default('receive_less'),
});
export type SeraQuoteRequest = z.infer<typeof SeraQuoteRequestSchema>;

/** Subset of /swap/quote response we care about. */
export const SeraQuoteResponseSchema = z
  .object({
    uuid: z.string(),
    route_params: z.unknown(),
    expires_at: z.union([z.number(), z.string()]),
    fee_breakdown: z.unknown().optional(),
    permit: z.unknown().nullable().optional(),
    /** Min-out amount, base units, for slippage assertions. */
    to_amount: z.string().optional(),
  })
  .passthrough();
export type SeraQuoteResponse = z.infer<typeof SeraQuoteResponseSchema>;

export const SeraSwapRequestSchema = z.object({
  uuid: z.string(),
  signature: z.string(),
  permit_signature: z.string().optional(),
  permit_deadline: z.number().int().positive().optional(),
});
export type SeraSwapRequest = z.infer<typeof SeraSwapRequestSchema>;

/** Subset of /swap response we care about. */
export const SeraSwapResponseSchema = z
  .object({
    tx_hash: z.string().optional(),
    transaction_hash: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type SeraSwapResponse = z.infer<typeof SeraSwapResponseSchema>;

/** Normalized error envelope distilled from Sera's many shapes. */
export interface SeraApiError {
  status: number;
  code?: string;
  message: string;
  raw?: unknown;
}
