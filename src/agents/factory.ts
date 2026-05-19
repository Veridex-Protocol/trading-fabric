/**
 * @packageDocumentation
 * @module agents/factory
 * @description `createTradingAgents()` — produces the full 12-agent
 * `AgentDefinition` set used by Phase 5's orchestrator. No LLM calls
 * happen here; this is a pure configuration step.
 *
 * Tool wiring follows `TRADING_FABRIC_TOOLS_BY_ROLE`. Analysts are bound
 * to their role-scoped tool subset; researchers, the trader, risk
 * debators, and managers receive no tools (their work is text reasoning
 * over information the orchestrator has already gathered).
 *
 * Structured-output schemas are advertised via
 * `metadata.structuredOutputSchema` so the orchestrator knows which
 * agents to wrap with `bindStructuredOutput()`:
 *
 * - `research-manager` → `ResearchPlan`
 * - `trader`           → `TraderProposal`
 * - `portfolio-manager`→ `PortfolioDecision`
 */

import type { AgentDefinition, ModelConfig, ToolContract } from '@veridex/agents';

import type { TradingFabricConfig } from '../config';
import {
  TRADING_FABRIC_TOOLS_BY_ROLE,
  toolsForRole,
  type AnalystRole,
} from '../tools/dataflowTools';
import {
  aggressiveRiskInstructions,
  analystCollaboratorPreamble,
  bearResearcherInstructions,
  bullResearcherInstructions,
  conservativeRiskInstructions,
  fundamentalsAnalystInstructions,
  marketAnalystInstructions,
  neutralRiskInstructions,
  newsAnalystInstructions,
  portfolioManagerInstructions,
  researchManagerInstructions,
  sentimentAnalystInstructions,
  traderInstructions,
} from './instructions';

export interface CreateTradingAgentsOptions {
  /** Fully-resolved trading-fabric config. */
  config: TradingFabricConfig;
  /** All dataflow tools (from `createDataflowTools`). The factory filters
   * per role via `toolsForRole`. */
  tools: ToolContract[];
  /** Optional per-agent runtime caps. */
  defaults?: {
    maxTurns?: number;
    maxTokens?: number;
  };
}

/** The complete agent surface produced for one trading-fabric run. */
export interface TradingAgentSet {
  marketAnalyst: AgentDefinition;
  sentimentAnalyst: AgentDefinition;
  newsAnalyst: AgentDefinition;
  fundamentalsAnalyst: AgentDefinition;
  bullResearcher: AgentDefinition;
  bearResearcher: AgentDefinition;
  researchManager: AgentDefinition;
  trader: AgentDefinition;
  aggressiveRisk: AgentDefinition;
  neutralRisk: AgentDefinition;
  conservativeRisk: AgentDefinition;
  portfolioManager: AgentDefinition;
}

function quickModel(config: TradingFabricConfig): ModelConfig {
  return {
    provider: config.llm_provider,
    model: config.quick_think_llm,
  };
}

function deepModel(config: TradingFabricConfig): ModelConfig {
  return {
    provider: `${config.llm_provider}:deep`,
    model: config.deep_think_llm,
  };
}

function promptOpts(config: TradingFabricConfig) {
  return {
    outputLanguage: config.output_language,
    assetType: config.default_asset_type,
  } as const;
}

function withPreamble(toolNames: readonly string[], body: string): string {
  return `${analystCollaboratorPreamble(toolNames)}\n\n${body}`;
}

function analystDef(
  id: string,
  name: string,
  role: AnalystRole,
  body: string,
  opts: CreateTradingAgentsOptions,
): AgentDefinition {
  const tools = toolsForRole(opts.tools, role);
  const toolNames = tools.map((t) => t.name);
  return {
    id,
    name,
    model: quickModel(opts.config),
    instructions: withPreamble(toolNames, body),
    tools,
    maxTurns: opts.defaults?.maxTurns,
    maxTokens: opts.defaults?.maxTokens,
    metadata: {
      tradingFabric: true,
      role,
      expectedTools: TRADING_FABRIC_TOOLS_BY_ROLE[role],
    },
  };
}

function reasonerDef(args: {
  id: string;
  name: string;
  instructions: string;
  model: ModelConfig;
  role: string;
  structuredOutputSchema?: string;
  opts: CreateTradingAgentsOptions;
}): AgentDefinition {
  return {
    id: args.id,
    name: args.name,
    model: args.model,
    instructions: args.instructions,
    tools: [],
    maxTurns: args.opts.defaults?.maxTurns,
    maxTokens: args.opts.defaults?.maxTokens,
    metadata: {
      tradingFabric: true,
      role: args.role,
      ...(args.structuredOutputSchema
        ? { structuredOutputSchema: args.structuredOutputSchema }
        : {}),
    },
  };
}

/**
 * Build the 12-agent set for trading-fabric. Pure — no I/O, no LLM calls.
 *
 * Agents are returned as a typed record so call sites can destructure
 * without index-lookup ceremony.
 */
export function createTradingAgents(
  opts: CreateTradingAgentsOptions,
): TradingAgentSet {
  const p = promptOpts(opts.config);

  return {
    // ── Analysts ─────────────────────────────────────────────────────
    marketAnalyst: analystDef(
      'trading-fabric:market-analyst',
      'Market Analyst',
      'market',
      marketAnalystInstructions(p),
      opts,
    ),
    sentimentAnalyst: analystDef(
      'trading-fabric:sentiment-analyst',
      'Sentiment Analyst',
      'social',
      sentimentAnalystInstructions(p),
      opts,
    ),
    newsAnalyst: analystDef(
      'trading-fabric:news-analyst',
      'News Analyst',
      'news',
      newsAnalystInstructions(p),
      opts,
    ),
    fundamentalsAnalyst: analystDef(
      'trading-fabric:fundamentals-analyst',
      'Fundamentals Analyst',
      'fundamentals',
      fundamentalsAnalystInstructions(p),
      opts,
    ),

    // ── Researchers ──────────────────────────────────────────────────
    bullResearcher: reasonerDef({
      id: 'trading-fabric:bull-researcher',
      name: 'Bull Researcher',
      instructions: bullResearcherInstructions(p),
      model: quickModel(opts.config),
      role: 'bull',
      opts,
    }),
    bearResearcher: reasonerDef({
      id: 'trading-fabric:bear-researcher',
      name: 'Bear Researcher',
      instructions: bearResearcherInstructions(p),
      model: quickModel(opts.config),
      role: 'bear',
      opts,
    }),

    // ── Research Manager (deep model, structured output) ─────────────
    researchManager: reasonerDef({
      id: 'trading-fabric:research-manager',
      name: 'Research Manager',
      instructions: researchManagerInstructions(p),
      model: deepModel(opts.config),
      role: 'research-manager',
      structuredOutputSchema: 'ResearchPlan',
      opts,
    }),

    // ── Trader (quick model, structured output) ──────────────────────
    trader: reasonerDef({
      id: 'trading-fabric:trader',
      name: 'Trader',
      instructions: traderInstructions(p),
      model: quickModel(opts.config),
      role: 'trader',
      structuredOutputSchema: 'TraderProposal',
      opts,
    }),

    // ── Risk debate ──────────────────────────────────────────────────
    aggressiveRisk: reasonerDef({
      id: 'trading-fabric:risk-aggressive',
      name: 'Aggressive Risk Analyst',
      instructions: aggressiveRiskInstructions(p),
      model: quickModel(opts.config),
      role: 'risk-aggressive',
      opts,
    }),
    neutralRisk: reasonerDef({
      id: 'trading-fabric:risk-neutral',
      name: 'Neutral Risk Analyst',
      instructions: neutralRiskInstructions(p),
      model: quickModel(opts.config),
      role: 'risk-neutral',
      opts,
    }),
    conservativeRisk: reasonerDef({
      id: 'trading-fabric:risk-conservative',
      name: 'Conservative Risk Analyst',
      instructions: conservativeRiskInstructions(p),
      model: quickModel(opts.config),
      role: 'risk-conservative',
      opts,
    }),

    // ── Portfolio Manager (deep model, structured output) ────────────
    portfolioManager: reasonerDef({
      id: 'trading-fabric:portfolio-manager',
      name: 'Portfolio Manager',
      instructions: portfolioManagerInstructions(p),
      model: deepModel(opts.config),
      role: 'portfolio-manager',
      structuredOutputSchema: 'PortfolioDecision',
      opts,
    }),
  };
}
