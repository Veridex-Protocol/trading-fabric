/**
 * @packageDocumentation
 * @module execution/VeridexExecutor
 * @description Public Phase 8 Veridex executor entrypoint.
 *
 * This file exists as the stable import path requested by the Phase 8
 * plan. The implementation lives under `execution/veridex/provider` so
 * future providers can keep their own folders without crowding the root.
 */

export {
  VeridexExecutionProvider as VeridexExecutor,
  VeridexExecutionProvider,
  usdToBaseUnits,
} from './veridex/provider.js';

export type {
  VeridexExecutionProviderOptions,
  VeridexRelayerLike,
  VeridexRelayerResult,
  VeridexRelayerSubmitRequest,
  VeridexSDKLike,
  VeridexSessionAction,
  VeridexSessionInfo,
  VeridexSessionManagerLike,
  VeridexSessionSignedAction,
  VeridexTransferParams,
  VeridexTransferResult,
} from './veridex/provider.js';