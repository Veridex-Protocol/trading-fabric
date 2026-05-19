/**
 * @packageDocumentation
 * @module agents
 * @description Public surface for the 12-agent trading-fabric set.
 *
 * Consumers will typically only need `createTradingAgents` (the factory)
 * plus the prompt builders if they want to customise instructions before
 * registration. Individual agent factories aren't re-exported because
 * the factory bundles them in a single typed record.
 */

export {
  createTradingAgents,
  type CreateTradingAgentsOptions,
  type TradingAgentSet,
} from './factory';

export {
  analystCollaboratorPreamble,
  marketAnalystInstructions,
  sentimentAnalystInstructions,
  newsAnalystInstructions,
  fundamentalsAnalystInstructions,
  bullResearcherInstructions,
  bearResearcherInstructions,
  researchManagerInstructions,
  portfolioManagerInstructions,
  traderInstructions,
  aggressiveRiskInstructions,
  neutralRiskInstructions,
  conservativeRiskInstructions,
  type PromptOptions,
} from './instructions';
