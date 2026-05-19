/**
 * @packageDocumentation
 * @module orchestration/Orchestrator
 * @description Deterministic state machine that walks the 12-agent
 * TradingAgents graph: 4 analysts → bull/bear debate → research manager
 * → trader → 3-way risk debate → portfolio manager.
 *
 * ## Design choice: AgentRuntime for every agent
 *
 * Every agent turn — including the eight tool-less reasoners — runs
 * through a dedicated `AgentRuntime` instance. We do **not** call
 * `provider.complete()` directly anywhere. Reasons:
 *
 *  1. **Governance uniformity.** Policy gates, approval routes, audit
 *     events, and token caps are configured once on the runtime and
 *     apply to every call. A direct provider path would bypass them.
 *  2. **Trace continuity.** Every model call emits typed trace events
 *     that downstream eval / replay infrastructure consumes. Skipping
 *     the runtime for "simple" calls would leave gaps in the audit
 *     log of a trading decision — exactly the calls regulators care
 *     about.
 *  3. **Memory hook surface.** Phase 6 attaches semantic memory writes
 *     to runtime events. Bypassing runtime for some agents would force
 *     a second integration path.
 *  4. **Per-run cost.** Construction of `AgentRuntime` is a handful of
 *     small object allocations (EventBus, PolicyEngine, ContextCompiler).
 *     Network round-trips dominate orchestration latency by orders of
 *     magnitude — instance count is not the bottleneck.
 *
 * Runtimes are constructed once per `Orchestrator.run()` invocation and
 * discarded; we do **not** cache them across runs because each run gets
 * its own run-id, trace, and memory namespace.
 */

import { randomUUID } from 'node:crypto';
import { createAgent } from '@veridex/agents';
import type { AgentDefinition, AgentRuntime, RuntimeOptions } from '@veridex/agents';

import type { TradingAgentSet } from '../agents/factory';
import type { TradingFabricConfig } from '../config';
import {
  PortfolioDecision,
  ResearchPlan,
  TraderProposal,
  renderPortfolioDecision,
  renderResearchPlan,
  renderTraderProposal,
} from '../schemas';
import type {
  AnalystKey,
  AnalystReport,
  AssetType,
  DebateTurn,
  RiskDebateTurn,
  Ticker,
  TradeDate,
  TradingFabricRunResult,
} from '../types';
import type { TradingMemoryLog } from '../memory/log';
import type { PendingResolver } from '../memory/resolver';
import type { MemoryEntry } from '../memory/types';
import type {
  ApprovalRecord,
  EngineDecision,
  HumanApprovalQueue,
  PolicyContext,
  PolicyEngine,
  Proposal,
} from '../policy/index.js';
import { defaultSizer, ratingToAction } from '../policy/index.js';
import {
  analystUserMessage,
  bearResearcherUserMessage,
  bullResearcherUserMessage,
  portfolioManagerUserMessage,
  researchManagerUserMessage,
  riskDebatorUserMessage,
  traderUserMessage,
} from './messages';
import { StructuredOutputError, parseStructured } from './structuredOutput';

/** Mapping from analyst key to the matching agent in the set. */
const ANALYST_DEFINITION_KEY: Record<AnalystKey, keyof TradingAgentSet> = {
  market: 'marketAnalyst',
  social: 'sentimentAnalyst',
  news: 'newsAnalyst',
  fundamentals: 'fundamentalsAnalyst',
};

/** Events emitted by the orchestrator. Mirrors agent-runtime trace shape. */
export type OrchestrationEvent =
  | { type: 'run_started'; runId: string; ticker: Ticker; trade_date: TradeDate; asset_type: AssetType }
  | { type: 'analyst_started'; runId: string; role: AnalystKey }
  | { type: 'analyst_completed'; runId: string; role: AnalystKey; report: AnalystReport }
  | { type: 'debate_turn'; runId: string; turn: DebateTurn }
  | { type: 'research_plan_ready'; runId: string; plan: ResearchPlan }
  | { type: 'trader_proposal_ready'; runId: string; proposal: TraderProposal }
  | { type: 'risk_turn'; runId: string; turn: RiskDebateTurn }
  | { type: 'portfolio_decision_ready'; runId: string; decision: PortfolioDecision }
  | { type: 'structured_output_failed'; runId: string; agent: string; error: StructuredOutputError }
  | { type: 'memory_resolved'; runId: string; ticker: Ticker; entries: MemoryEntry[] }
  | { type: 'memory_decision_stored'; runId: string; entry: MemoryEntry }
  | { type: 'policy_evaluated'; runId: string; proposal: Proposal; decision: EngineDecision }
  | { type: 'approval_required'; runId: string; approvalId: string; proposal: Proposal; decision: EngineDecision }
  | { type: 'approval_resolved'; runId: string; approvalId: string; record: ApprovalRecord }
  | { type: 'run_completed'; runId: string; durationMs: number };

export interface RunInput {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type?: AssetType;
  /** Past-decision memo injected into analyst + portfolio manager prompts. */
  past_context?: string | null;
}

export interface OrchestratorOptions {
  agents: TradingAgentSet;
  config: TradingFabricConfig;
  /**
   * `RuntimeOptions` shared across every agent runtime constructed for
   * the run. Must include `modelProviders` covering both the quick and
   * deep provider names from `config`. Tracing / checkpointing /
   * memory stores are wired through here.
   */
  runtimeOptions: RuntimeOptions;
  /**
   * Optional memory log. When supplied, the orchestrator (a) writes a
   * `pending` entry after each portfolio-manager decision and (b) feeds
   * the resolved `past_context` blob into analyst + portfolio-manager
   * prompts. Outcome resolution requires `resolver` as well.
   */
  memory?: TradingMemoryLog;
  /**
   * Optional pending-entry resolver. When supplied alongside `memory`,
   * the orchestrator calls `resolver.resolvePendingFor(ticker)` at the
   * start of each run so realised returns + reflections land in the
   * log before this run reads it.
   */
  resolver?: PendingResolver;
  /**
   * Optional policy engine. When supplied, the orchestrator builds a
   * `Proposal` from the Portfolio Manager decision via `sizer` (default
   * uses `config.max_position_usd`), evaluates the engine, and:
   *  - on `deny` records the verdicts and skips approval;
   *  - on `escalate` submits to `approvals` (required when escalate is
   *    possible) and awaits the human decision;
   *  - on `allow` records the verdicts and proceeds.
   *
   * Without a `policy` value the run skips this step entirely — useful
   * for unit tests of the graph itself.
   */
  policy?: PolicyEngine;
  /** Required when `policy` may emit `escalate` verdicts. */
  approvals?: HumanApprovalQueue;
  /**
   * Maps `(rating, config)` to a USD notional. Defaults to
   * `defaultSizer(rating, config.max_position_usd)`.
   */
  sizer?: (rating: PortfolioDecision['rating'], config: TradingFabricConfig) => number;
  /**
   * Returns the runtime context (daily spend, last trade time, last
   * alpha) for the policy engine. Defaults to a zeroed snapshot — the
   * caller is responsible for stitching in real state.
   */
  policyContext?: (input: RunInput) => PolicyContext | Promise<PolicyContext>;
  onEvent?: (event: OrchestrationEvent) => void;
}

/**
 * Walks the trading-fabric graph end-to-end. One instance per process is
 * fine — the orchestrator is stateless; per-run state lives inside
 * `run()`.
 */
export class Orchestrator {
  private readonly agents: TradingAgentSet;
  private readonly config: TradingFabricConfig;
  private readonly runtimeOptions: RuntimeOptions;
  private readonly memory: TradingMemoryLog | null;
  private readonly resolver: PendingResolver | null;
  private readonly policy: PolicyEngine | null;
  private readonly approvals: HumanApprovalQueue | null;
  private readonly sizer: (
    rating: PortfolioDecision['rating'],
    config: TradingFabricConfig,
  ) => number;
  private readonly policyContext: (
    input: RunInput,
  ) => PolicyContext | Promise<PolicyContext>;
  private readonly onEvent: (event: OrchestrationEvent) => void;

  constructor(options: OrchestratorOptions) {
    this.agents = options.agents;
    this.config = options.config;
    this.runtimeOptions = options.runtimeOptions;
    this.memory = options.memory ?? null;
    this.resolver = options.resolver ?? null;
    this.policy = options.policy ?? null;
    this.approvals = options.approvals ?? null;
    this.sizer =
      options.sizer ?? ((rating, config) => defaultSizer(rating, config.max_position_usd));
    this.policyContext =
      options.policyContext ??
      (() => ({
        dailySpendUsd: 0,
        lastTradeAt: null,
        lastAlphaReturn: null,
        now: () => new Date(),
      }));
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** Run the full trading graph and return the assembled result. */
  async run(input: RunInput): Promise<TradingFabricRunResult> {
    const runId = randomUUID();
    const started = Date.now();
    const asset_type: AssetType = input.asset_type ?? this.config.default_asset_type;
    const analysts = this.config.selected_analysts.slice();

    this.emit({
      type: 'run_started',
      runId,
      ticker: input.ticker,
      trade_date: input.trade_date,
      asset_type,
    });

    // ── 0. Memory: resolve pending outcomes + build past_context ──
    // Explicit `input.past_context` overrides memory-derived context.
    let past_context: string | null = input.past_context ?? null;
    if (this.memory) {
      if (this.resolver) {
        try {
          const resolved = await this.resolver.resolvePendingFor(input.ticker);
          if (resolved.length > 0) {
            this.emit({ type: 'memory_resolved', runId, ticker: input.ticker, entries: resolved });
          }
        } catch {
          // Resolution failures must never block a run; pending entries
          // are retried on the next invocation.
        }
      }
      if (past_context === null) {
        const memo = await this.memory.getPastContext(input.ticker);
        past_context = memo.length > 0 ? memo : null;
      }
    }

    // ── 1. Analyst phase ──────────────────────────────────────────
    const reports = await this.runAnalysts({
      runId,
      analysts,
      ticker: input.ticker,
      trade_date: input.trade_date,
      asset_type,
      past_context,
    });

    // ── 2. Bull vs Bear debate ────────────────────────────────────
    const debate = await this.runResearchDebate({
      runId,
      ticker: input.ticker,
      trade_date: input.trade_date,
      asset_type,
      reports,
    });

    // ── 3. Research Manager — structured ResearchPlan ─────────────
    const researchPlan = await this.runStructuredAgent({
      runId,
      agentName: 'researchManager',
      definition: this.agents.researchManager,
      userMessage: researchManagerUserMessage({
        ticker: input.ticker,
        trade_date: input.trade_date,
        asset_type,
        reports,
        history: debate,
      }),
      schema: ResearchPlan,
    });
    this.emit({ type: 'research_plan_ready', runId, plan: researchPlan });
    const research_plan_markdown = renderResearchPlan(researchPlan);

    // ── 4. Trader — structured TraderProposal ─────────────────────
    const traderProposal = await this.runStructuredAgent({
      runId,
      agentName: 'trader',
      definition: this.agents.trader,
      userMessage: traderUserMessage({
        ticker: input.ticker,
        trade_date: input.trade_date,
        asset_type,
        reports,
        research_plan_markdown,
      }),
      schema: TraderProposal,
    });
    this.emit({ type: 'trader_proposal_ready', runId, proposal: traderProposal });
    const trader_proposal_markdown = renderTraderProposal(traderProposal);

    // ── 5. 3-way risk debate ──────────────────────────────────────
    const risk_debate = await this.runRiskDebate({
      runId,
      ticker: input.ticker,
      trade_date: input.trade_date,
      asset_type,
      reports,
      trader_proposal_markdown,
    });

    // ── 6. Portfolio Manager — structured PortfolioDecision ───────
    const portfolioDecision = await this.runStructuredAgent({
      runId,
      agentName: 'portfolioManager',
      definition: this.agents.portfolioManager,
      userMessage: portfolioManagerUserMessage({
        ticker: input.ticker,
        trade_date: input.trade_date,
        asset_type,
        research_plan_markdown,
        trader_proposal_markdown,
        risk_history: risk_debate,
        past_context,
      }),
      schema: PortfolioDecision,
    });
    this.emit({ type: 'portfolio_decision_ready', runId, decision: portfolioDecision });

    const portfolio_decision_markdown = renderPortfolioDecision(portfolioDecision);

    // ── 7. Memory: persist pending entry for this decision ───────
    if (this.memory) {
      try {
        const entry = await this.memory.storeDecision({
          ticker: input.ticker,
          trade_date: input.trade_date,
          rating: portfolioDecision.rating,
          decision: portfolio_decision_markdown,
        });
        this.emit({ type: 'memory_decision_stored', runId, entry });
      } catch {
        // Memory write failure must not poison the returned result.
      }
    }

    // ── 8. Policy + (optional) human approval ────────────────────
    let proposal: Proposal | null = null;
    let policyDecision: EngineDecision | null = null;
    let approval: ApprovalRecord | null = null;
    if (this.policy) {
      proposal = {
        decisionId: randomUUID(),
        runId,
        ticker: input.ticker,
        trade_date: input.trade_date,
        rating: portfolioDecision.rating,
        action: ratingToAction(portfolioDecision.rating),
        amountUsd: this.sizer(portfolioDecision.rating, this.config),
      };
      const ctx = await this.policyContext(input);
      policyDecision = this.policy.evaluate(proposal, ctx);
      this.emit({ type: 'policy_evaluated', runId, proposal, decision: policyDecision });

      if (policyDecision.decision === 'escalate') {
        if (!this.approvals) {
          // No approval transport configured — treat as denied to avoid
          // silently executing a flagged trade.
          policyDecision = {
            decision: 'deny',
            verdicts: policyDecision.verdicts,
            primaryReason:
              policyDecision.primaryReason ??
              'Escalation requested but no approval queue is configured',
          };
        } else {
          const handle = await this.approvals.submit({
            proposal,
            verdicts: policyDecision.verdicts,
          });
          this.emit({
            type: 'approval_required',
            runId,
            approvalId: handle.id,
            proposal,
            decision: policyDecision,
          });
          approval = await handle.awaitDecision();
          this.emit({
            type: 'approval_resolved',
            runId,
            approvalId: handle.id,
            record: approval,
          });
        }
      }
    }

    const durationMs = Date.now() - started;
    this.emit({ type: 'run_completed', runId, durationMs });

    return {
      runId,
      ticker: input.ticker,
      trade_date: input.trade_date,
      asset_type,
      analysts,
      reports,
      research_plan: research_plan_markdown,
      trader_proposal: trader_proposal_markdown,
      risk_debate,
      portfolio_decision: portfolio_decision_markdown,
      proposal,
      policy_decision: policyDecision,
      approval,
      execution: null, // Phase 8 will populate this.
      durationMs,
    };
  }

  // ── Phase helpers ─────────────────────────────────────────────────

  private async runAnalysts(ctx: {
    runId: string;
    analysts: AnalystKey[];
    ticker: Ticker;
    trade_date: TradeDate;
    asset_type: AssetType;
    past_context: string | null;
  }): Promise<AnalystReport[]> {
    const concurrency = Math.max(1, this.config.analyst_concurrency_limit);
    const queue = ctx.analysts.slice();
    const out: AnalystReport[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        const role = queue.shift();
        if (!role) return;
        this.emit({ type: 'analyst_started', runId: ctx.runId, role });

        const defKey = ANALYST_DEFINITION_KEY[role];
        const definition = this.agents[defKey];
        const userMessage = analystUserMessage({
          role,
          ticker: ctx.ticker,
          trade_date: ctx.trade_date,
          asset_type: ctx.asset_type,
          past_context: ctx.past_context,
        });

        const output = await this.runAgent(definition, userMessage);
        const report: AnalystReport = {
          kind: role,
          ticker: ctx.ticker,
          trade_date: ctx.trade_date,
          content: output,
          metadata: { agentId: definition.id },
        };
        out.push(report);
        this.emit({ type: 'analyst_completed', runId: ctx.runId, role, report });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, ctx.analysts.length) }, () => worker());
    await Promise.all(workers);

    // Preserve `selected_analysts` order regardless of completion order.
    const ordering = new Map(ctx.analysts.map((a, i) => [a, i] as const));
    out.sort((a, b) => (ordering.get(a.kind) ?? 0) - (ordering.get(b.kind) ?? 0));
    return out;
  }

  private async runResearchDebate(ctx: {
    runId: string;
    ticker: Ticker;
    trade_date: TradeDate;
    asset_type: AssetType;
    reports: AnalystReport[];
  }): Promise<DebateTurn[]> {
    const rounds = Math.max(1, this.config.max_debate_rounds);
    const history: DebateTurn[] = [];

    for (let round = 1; round <= rounds; round++) {
      const lastBear = [...history].reverse().find((t) => t.speaker === 'bear')?.content ?? null;
      const bullOutput = await this.runAgent(
        this.agents.bullResearcher,
        bullResearcherUserMessage({
          ticker: ctx.ticker,
          trade_date: ctx.trade_date,
          asset_type: ctx.asset_type,
          reports: ctx.reports,
          history,
          lastBearResponse: lastBear,
        }),
      );
      const bullTurn: DebateTurn = {
        speaker: 'bull',
        round,
        content: bullOutput,
        timestamp: new Date().toISOString(),
      };
      history.push(bullTurn);
      this.emit({ type: 'debate_turn', runId: ctx.runId, turn: bullTurn });

      const lastBull = bullTurn.content;
      const bearOutput = await this.runAgent(
        this.agents.bearResearcher,
        bearResearcherUserMessage({
          ticker: ctx.ticker,
          trade_date: ctx.trade_date,
          asset_type: ctx.asset_type,
          reports: ctx.reports,
          history,
          lastBullResponse: lastBull,
        }),
      );
      const bearTurn: DebateTurn = {
        speaker: 'bear',
        round,
        content: bearOutput,
        timestamp: new Date().toISOString(),
      };
      history.push(bearTurn);
      this.emit({ type: 'debate_turn', runId: ctx.runId, turn: bearTurn });
    }

    return history;
  }

  private async runRiskDebate(ctx: {
    runId: string;
    ticker: Ticker;
    trade_date: TradeDate;
    asset_type: AssetType;
    reports: AnalystReport[];
    trader_proposal_markdown: string;
  }): Promise<RiskDebateTurn[]> {
    const rounds = Math.max(1, this.config.max_risk_discuss_rounds);
    const speakers: Array<'aggressive' | 'neutral' | 'conservative'> = [
      'aggressive',
      'neutral',
      'conservative',
    ];
    const definitions = {
      aggressive: this.agents.aggressiveRisk,
      neutral: this.agents.neutralRisk,
      conservative: this.agents.conservativeRisk,
    } as const;

    const history: RiskDebateTurn[] = [];
    for (let round = 1; round <= rounds; round++) {
      for (const speaker of speakers) {
        const output = await this.runAgent(
          definitions[speaker],
          riskDebatorUserMessage({
            speaker,
            ticker: ctx.ticker,
            trade_date: ctx.trade_date,
            asset_type: ctx.asset_type,
            reports: ctx.reports,
            trader_proposal_markdown: ctx.trader_proposal_markdown,
            history,
          }),
        );
        const turn: RiskDebateTurn = {
          speaker,
          round,
          content: output,
          timestamp: new Date().toISOString(),
        };
        history.push(turn);
        this.emit({ type: 'risk_turn', runId: ctx.runId, turn });
      }
    }
    return history;
  }

  // ── AgentRuntime plumbing ─────────────────────────────────────────

  private async runStructuredAgent<T>(args: {
    runId: string;
    agentName: string;
    definition: AgentDefinition;
    userMessage: string;
    schema: Parameters<typeof parseStructured<T>>[1];
  }): Promise<T> {
    const raw = await this.runAgent(args.definition, args.userMessage);
    try {
      return parseStructured<T>(raw, args.schema);
    } catch (err) {
      if (err instanceof StructuredOutputError) {
        this.emit({
          type: 'structured_output_failed',
          runId: args.runId,
          agent: args.agentName,
          error: err,
        });
      }
      throw err;
    }
  }

  /**
   * Construct a fresh `AgentRuntime` for one agent turn and execute it.
   *
   * A new runtime per call is intentional: per-run isolation of
   * EventBus / PolicyEngine / Memory state, no cross-agent state
   * pollution, and trivial GC after the call returns. The cost is a
   * handful of allocations — dominated by the LLM round-trip.
   */
  private async runAgent(definition: AgentDefinition, userMessage: string): Promise<string> {
    const runtime: AgentRuntime = createAgent(definition, this.runtimeOptions);
    const result = await runtime.run(userMessage);
    return result.output;
  }

  private emit(event: OrchestrationEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Listener faults must never bring down the run.
    }
  }
}
