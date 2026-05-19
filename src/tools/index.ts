/**
 * @packageDocumentation
 * @module tools
 * @description Public tool surface for trading-fabric. The
 * `createDataflowTools` factory binds Zod-typed `tool()` contracts to a
 * `DataflowClient`; the analyst role whitelist is used by Phase 4 to wire
 * each agent to its allowed surface.
 */

export {
  createDataflowTools,
  toolsForRole,
  TRADING_FABRIC_TOOLS_BY_ROLE,
  type AnalystRole,
  type CreateDataflowToolsOptions,
  type TrustClass,
} from './dataflowTools';
