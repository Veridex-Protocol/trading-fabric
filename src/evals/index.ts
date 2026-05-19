import { createAgent, type ModelProvider, type RuntimeOptions } from '@veridex/agents';
import { ReplayProvider, type RecordedInteraction } from '@veridex/agents/testing';
import {
  runStatefulScenarios,
  type StatefulRunReport,
  type StatefulTrajectory,
} from '@veridex/agents/evals';

import { createTradingAgents } from '../agents';
import { DEFAULT_CONFIG, type TradingFabricConfig } from '../config';
import type { OrchestrationEvent } from '../orchestration';
import {
  parseStructured,
  portfolioManagerUserMessage,
  researchManagerUserMessage,
  traderUserMessage,
} from '../orchestration';
import { PolicyEngine, type PolicyContext, type Proposal } from '../policy';
import {
  PortfolioDecision,
  ResearchPlan,
  TraderProposal,
  renderPortfolioDecision,
  renderResearchPlan,
  renderTraderProposal,
} from '../schemas';
import type { AnalystReport, DebateTurn, RiskDebateTurn } from '../types';
import { policyLimitsFromConfig } from '../runtime';

export type TradingEvalSuiteId = 'structured-output' | 'policy' | 'stateful' | 'all';

export interface EvalAssertion {
  label: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface TradingEvalCaseResult {
  id: string;
  suite: TradingEvalSuiteId;
  status: 'passed' | 'failed';
  assertions: EvalAssertion[];
}

export interface TradingEvalRunReport {
  suite: TradingEvalSuiteId;
  passed: boolean;
  total: number;
  failed: number;
  cases: TradingEvalCaseResult[];
  stateful?: StatefulRunReport;
}

export interface StructuredOutputSmokeResult {
  passed: boolean;
  researchPlan: ResearchPlan;
  traderProposal: TraderProposal;
  portfolioDecision: PortfolioDecision;
  rendered: {
    researchPlan: string;
    traderProposal: string;
    portfolioDecision: string;
  };
  assertions: EvalAssertion[];
  comparison: {
    reference: string;
    tradingFabric: string;
  };
}

export interface RunStructuredOutputSmokeOptions {
  config?: TradingFabricConfig;
  runtimeOptions?: RuntimeOptions;
}

export interface RunTradingEvalSuiteOptions extends RunStructuredOutputSmokeOptions {
  suite: TradingEvalSuiteId;
}

const SMOKE_REPORTS: AnalystReport[] = [
  {
    kind: 'market',
    ticker: 'NVDA',
    trade_date: '2026-05-19',
    content: 'Market report: momentum is constructive and volume confirms the breakout.',
  },
  {
    kind: 'social',
    ticker: 'NVDA',
    trade_date: '2026-05-19',
    content: 'Sentiment report: builders and retail traders remain optimistic but not euphoric.',
  },
  {
    kind: 'news',
    ticker: 'NVDA',
    trade_date: '2026-05-19',
    content: 'News report: data-center demand and sovereign AI contracts remain the dominant narrative.',
  },
  {
    kind: 'fundamentals',
    ticker: 'NVDA',
    trade_date: '2026-05-19',
    content: 'Fundamentals report: margins, free cash flow, and backlog are all above peer medians.',
  },
];

const SMOKE_DEBATE: DebateTurn[] = [
  {
    speaker: 'bull',
    round: 1,
    content: 'Data-center growth and operating leverage justify adding exposure.',
    timestamp: '2026-05-19T12:00:00Z',
  },
  {
    speaker: 'bear',
    round: 1,
    content: 'Customer concentration and export controls are still material risks.',
    timestamp: '2026-05-19T12:01:00Z',
  },
];

const SMOKE_RISK: RiskDebateTurn[] = [
  {
    speaker: 'aggressive',
    round: 1,
    content: 'Lean in while the trend and fundamentals agree.',
    timestamp: '2026-05-19T12:02:00Z',
  },
  {
    speaker: 'neutral',
    round: 1,
    content: 'Use a phased entry so the position can absorb volatility.',
    timestamp: '2026-05-19T12:03:00Z',
  },
  {
    speaker: 'conservative',
    round: 1,
    content: 'Cap exposure and require a hard stop because valuation risk is real.',
    timestamp: '2026-05-19T12:04:00Z',
  },
];

const FIXTURE_RESEARCH_PLAN: ResearchPlan = {
  recommendation: 'Overweight',
  rationale: 'The bull case on data-center demand outweighs concentration risk.',
  strategic_actions: 'Scale in over two weeks and cap exposure below the policy limit.',
};

const FIXTURE_TRADER_PROPOSAL: TraderProposal = {
  action: 'Buy',
  reasoning: 'The research plan is constructive and risk can be managed with a phased entry.',
  entry_price: 187.5,
  stop_loss: 175,
  position_sizing: '4% of book',
};

const FIXTURE_PORTFOLIO_DECISION: PortfolioDecision = {
  rating: 'Overweight',
  executive_summary: 'Open a phased starter position with a hard stop and stay under the cap.',
  investment_thesis: 'Analyst evidence favors upside while the risk debate argues for measured sizing.',
  price_target: 215,
  time_horizon: '3-6 months',
};

export async function runStructuredOutputSmoke(
  opts: RunStructuredOutputSmokeOptions = {},
): Promise<StructuredOutputSmokeResult> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const runtimeOptions = opts.runtimeOptions ?? createStructuredSmokeRuntimeOptions(config);
  const agents = createTradingAgents({ config, tools: [] });

  const researchRaw = await runAgent(
    agents.researchManager,
    researchManagerUserMessage({
      ticker: 'NVDA',
      trade_date: '2026-05-19',
      asset_type: 'stock',
      reports: SMOKE_REPORTS,
      history: SMOKE_DEBATE,
    }),
    runtimeOptions,
  );
  const researchPlan = parseStructured(researchRaw, ResearchPlan);
  const researchMarkdown = renderResearchPlan(researchPlan);

  const traderRaw = await runAgent(
    agents.trader,
    traderUserMessage({
      ticker: 'NVDA',
      trade_date: '2026-05-19',
      asset_type: 'stock',
      reports: SMOKE_REPORTS,
      research_plan_markdown: researchMarkdown,
    }),
    runtimeOptions,
  );
  const traderProposal = parseStructured(traderRaw, TraderProposal);
  const traderMarkdown = renderTraderProposal(traderProposal);

  const portfolioRaw = await runAgent(
    agents.portfolioManager,
    portfolioManagerUserMessage({
      ticker: 'NVDA',
      trade_date: '2026-05-19',
      asset_type: 'stock',
      research_plan_markdown: researchMarkdown,
      trader_proposal_markdown: traderMarkdown,
      risk_history: SMOKE_RISK,
      past_context: '',
    }),
    runtimeOptions,
  );
  const portfolioDecision = parseStructured(portfolioRaw, PortfolioDecision);
  const portfolioMarkdown = renderPortfolioDecision(portfolioDecision);

  const assertions = [
    contains('research markdown marker', researchMarkdown, '**Recommendation**:'),
    contains('trader markdown marker', traderMarkdown, 'FINAL TRANSACTION PROPOSAL:'),
    contains('portfolio rating marker', portfolioMarkdown, '**Rating**:'),
    contains('portfolio thesis marker', portfolioMarkdown, '**Investment Thesis**:'),
  ];

  return {
    passed: assertions.every((assertion) => assertion.passed),
    researchPlan,
    traderProposal,
    portfolioDecision,
    rendered: {
      researchPlan: researchMarkdown,
      traderProposal: traderMarkdown,
      portfolioDecision: portfolioMarkdown,
    },
    assertions,
    comparison: {
      reference:
        'TradingAgents smoke_structured_output.py calls the three structured agents directly against a live provider.',
      tradingFabric:
        'trading-fabric runs the same three-agent chain through @veridex/agents AgentRuntime and uses ReplayProvider fixtures by default for deterministic CI.',
    },
  };
}

export async function runTradingEvalSuite(
  opts: RunTradingEvalSuiteOptions,
): Promise<TradingEvalRunReport> {
  const suites = opts.suite === 'all' ? ['policy', 'stateful', 'structured-output'] as const : [opts.suite];
  const cases: TradingEvalCaseResult[] = [];
  let stateful: StatefulRunReport | undefined;

  for (const suite of suites) {
    if (suite === 'policy') cases.push(...runPolicyEvalCases(opts.config ?? DEFAULT_CONFIG));
    if (suite === 'structured-output') {
      const smoke = await runStructuredOutputSmoke(opts);
      cases.push({
        id: 'structured-output-smoke',
        suite: 'structured-output',
        status: smoke.passed ? 'passed' : 'failed',
        assertions: smoke.assertions,
      });
    }
    if (suite === 'stateful') {
      stateful = await runTradingStatefulEvalSuite();
      cases.push(
        ...stateful.runs.map((run) => ({
          id: run.scenarioId,
          suite: 'stateful' as const,
          status: run.passed ? 'passed' as const : 'failed' as const,
          assertions: run.results.map((result) => ({
            label: result.criterionId,
            passed: result.pass,
            expected: 'pass',
            actual: result.pass ? 'pass' : result.reason ?? 'fail',
          })),
        })),
      );
    }
  }

  const failed = cases.filter((entry) => entry.status === 'failed').length;
  return {
    suite: opts.suite,
    passed: failed === 0,
    total: cases.length,
    failed,
    cases,
    stateful,
  };
}

export function createStructuredSmokeRuntimeOptions(config: TradingFabricConfig): RuntimeOptions {
  const deepInteractions: RecordedInteraction[] = [
    recordedJson(0, FIXTURE_RESEARCH_PLAN, `${config.llm_provider}:deep`),
    recordedJson(1, FIXTURE_PORTFOLIO_DECISION, `${config.llm_provider}:deep`),
  ];
  const quickInteractions: RecordedInteraction[] = [
    recordedJson(0, FIXTURE_TRADER_PROPOSAL, config.llm_provider),
  ];
  const quick = new ReplayProvider(config.llm_provider, quickInteractions);
  const deep = new ReplayProvider(`${config.llm_provider}:deep`, deepInteractions);
  return {
    enableTracing: false,
    modelProviders: { quick, deep },
  };
}

export function runPolicyEvalCases(
  config: TradingFabricConfig = DEFAULT_CONFIG,
): TradingEvalCaseResult[] {
  const engine = new PolicyEngine({ limits: policyLimitsFromConfig(config) });
  const context: PolicyContext = {
    dailySpendUsd: 49,
    lastTradeAt: null,
    lastAlphaReturn: null,
    now: () => new Date('2026-05-19T12:00:00Z'),
  };
  const scenarios: Array<{ id: string; proposal: Proposal; expected: 'allow' | 'deny' | 'escalate' }> = [
    { id: 'hold-allows-zero-side-effects', proposal: proposal({ action: 'Hold', rating: 'Hold', amountUsd: 0 }), expected: 'allow' },
    { id: 'max-position-denies-oversize', proposal: proposal({ amountUsd: config.max_position_usd + 1 }), expected: 'deny' },
    { id: 'daily-spend-escalates-over-cap', proposal: proposal({ amountUsd: 2 }), expected: 'escalate' },
  ];
  return scenarios.map((scenario) => {
    const decision = engine.evaluate(scenario.proposal, context);
    const assertion: EvalAssertion = {
      label: 'policy decision',
      passed: decision.decision === scenario.expected,
      expected: scenario.expected,
      actual: decision.decision,
    };
    return {
      id: scenario.id,
      suite: 'policy',
      status: assertion.passed ? 'passed' : 'failed',
      assertions: [assertion],
    };
  });
}

export async function runTradingStatefulEvalSuite(): Promise<StatefulRunReport> {
  return runStatefulScenarios([
    {
      id: 'memory-reflection-retains-alpha-lesson',
      goal: 'Resolved trade memories should retain falsifiable alpha lessons.',
      rubric: [
        {
          id: 'final-output-cites-alpha',
          description: 'Final trajectory output mentions alpha.',
          at: 'final',
          outputContains: 'alpha',
        },
        {
          id: 'semantic-memory-has-lesson',
          description: 'Semantic memory includes the operating leverage lesson.',
          at: 'final',
          memoryEntryId: 'lesson-1',
          requiresContent: 'operating leverage',
          minConfidence: 0.8,
          requiresTags: ['NVDA', 'reflection'],
        },
      ],
      execute: async () => sampleStatefulTrajectory(),
    },
  ]);
}

async function runAgent(
  definition: Parameters<typeof createAgent>[0],
  message: string,
  runtimeOptions: RuntimeOptions,
): Promise<string> {
  const runtime = createAgent(definition, runtimeOptions);
  const result = await runtime.run(message);
  return result.output;
}

function recordedJson(
  turnIndex: number,
  data: ResearchPlan | TraderProposal | PortfolioDecision,
  provider: string,
): RecordedInteraction {
  return {
    turnIndex,
    messages: [],
    response: {
      content: JSON.stringify(data),
      provider,
      model: 'replay-structured-output',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    },
  };
}

function contains(label: string, text: string, marker: string): EvalAssertion {
  return {
    label,
    passed: text.includes(marker),
    expected: `contains ${marker}`,
    actual: text,
  };
}

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    decisionId: `eval-${overrides.action ?? 'Buy'}`,
    runId: 'eval-run',
    ticker: 'AAPL',
    trade_date: '2026-05-19',
    rating: 'Buy',
    action: 'Buy',
    amountUsd: 10,
    ...overrides,
  };
}

function sampleStatefulTrajectory(): StatefulTrajectory {
  const finalEvent: OrchestrationEvent = { type: 'run_completed', runId: 'eval-run', durationMs: 10 };
  return {
    scenarioId: 'memory-reflection-retains-alpha-lesson',
    goal: 'Resolved trade memories should retain falsifiable alpha lessons.',
    output: `Final decision beat benchmark alpha after ${finalEvent.durationMs}ms.`,
    durationMs: 10,
    turns: [
      {
        turnIndex: 0,
        role: 'portfolio-manager',
        text: 'Pending outcome stored.',
        memory: {
          turnIndex: 0,
          capturedAt: 1,
          entries: [],
        },
      },
      {
        turnIndex: 1,
        role: 'reflector',
        text: 'Final decision beat benchmark alpha.',
        memory: {
          turnIndex: 1,
          capturedAt: 2,
          entries: [
            {
              id: 'lesson-1',
              tier: 'semantic',
              content: 'NVDA operating leverage mattered more than concentration risk.',
              confidence: 0.9,
              tags: ['NVDA', 'reflection'],
            },
          ],
        },
      },
    ],
  };
}
