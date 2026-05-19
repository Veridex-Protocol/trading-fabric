import type { OrchestrationEvent } from '../orchestration';
import {
  renderPortfolioDecision,
  renderResearchPlan,
  renderTraderProposal,
} from '../schemas';

export type TuiStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'blocked' | 'failed';

export type TuiAgentKey =
  | 'market'
  | 'social'
  | 'news'
  | 'fundamentals'
  | 'bull'
  | 'bear'
  | 'researchManager'
  | 'trader'
  | 'aggressiveRisk'
  | 'neutralRisk'
  | 'conservativeRisk'
  | 'portfolioManager'
  | 'policy'
  | 'approval'
  | 'execution';

export interface TuiAgentProgress {
  key: TuiAgentKey;
  label: string;
  status: TuiStatus;
  detail: string;
}

export interface TuiTimelineItem {
  id: string;
  timestamp: string;
  type: string;
  content: string;
}

export interface TuiReportPanel {
  title: string;
  body: string;
}

export interface TuiCounters {
  toolCalls: number;
  llmCalls: number;
  generatedReports: number;
}

export interface TuiState {
  runId: string | null;
  ticker: string | null;
  trade_date: string | null;
  asset_type: string | null;
  agents: TuiAgentProgress[];
  timeline: TuiTimelineItem[];
  currentReport: TuiReportPanel;
  counters: TuiCounters;
  footer: string;
  eventCount: number;
  completed: boolean;
  durationMs: number | null;
}

export interface ApplyTuiEventOptions {
  timestamp?: string;
  maxTimelineItems?: number;
}

export interface DeriveTuiStateOptions {
  timestampForEvent?: (event: OrchestrationEvent, index: number) => string;
  maxTimelineItems?: number;
}

export interface TuiStateSource {
  getState(): TuiState;
  subscribe(listener: (state: TuiState) => void): () => void;
}

export interface TuiEventSink extends TuiStateSource {
  onEvent(event: OrchestrationEvent): void;
  getEvents(): readonly OrchestrationEvent[];
  reset(): void;
}

export interface TuiEventSinkOptions extends DeriveTuiStateOptions {
  initialEvents?: readonly OrchestrationEvent[];
}

const AGENT_ROWS: ReadonlyArray<{ key: TuiAgentKey; label: string }> = [
  { key: 'market', label: 'Market Analyst' },
  { key: 'social', label: 'Social Analyst' },
  { key: 'news', label: 'News Analyst' },
  { key: 'fundamentals', label: 'Fundamentals' },
  { key: 'bull', label: 'Bull Researcher' },
  { key: 'bear', label: 'Bear Researcher' },
  { key: 'researchManager', label: 'Research Manager' },
  { key: 'trader', label: 'Trader' },
  { key: 'aggressiveRisk', label: 'Aggressive Risk' },
  { key: 'neutralRisk', label: 'Neutral Risk' },
  { key: 'conservativeRisk', label: 'Conservative Risk' },
  { key: 'portfolioManager', label: 'Portfolio Manager' },
  { key: 'policy', label: 'Policy Gate' },
  { key: 'approval', label: 'Approval' },
  { key: 'execution', label: 'Execution' },
];

export const TUI_STATUS_LABELS: Record<TuiStatus, string> = {
  pending: '[ ]',
  in_progress: '[..]',
  completed: '[OK]',
  skipped: '[--]',
  blocked: '[!!]',
  failed: '[XX]',
};

export function createInitialTuiState(): TuiState {
  return {
    runId: null,
    ticker: null,
    trade_date: null,
    asset_type: null,
    agents: AGENT_ROWS.map((row) => ({ ...row, status: 'pending', detail: 'Waiting' })),
    timeline: [],
    currentReport: {
      title: 'Current Report',
      body: 'Waiting for the first generated report.',
    },
    counters: { toolCalls: 0, llmCalls: 0, generatedReports: 0 },
    footer: 'Idle',
    eventCount: 0,
    completed: false,
    durationMs: null,
  };
}

export function getAgentProgress(state: TuiState, key: TuiAgentKey): TuiAgentProgress {
  const agent = state.agents.find((row) => row.key === key);
  if (!agent) {
    throw new Error(`Unknown TUI agent key: ${key}`);
  }
  return agent;
}

export function deriveTuiState(
  events: readonly OrchestrationEvent[],
  options: DeriveTuiStateOptions = {},
): TuiState {
  return events.reduce<TuiState>((state, event, index) => {
    return applyOrchestrationEvent(state, event, {
      timestamp: options.timestampForEvent?.(event, index),
      maxTimelineItems: options.maxTimelineItems,
    });
  }, createInitialTuiState());
}

export function createTuiEventSink(options: TuiEventSinkOptions = {}): TuiEventSink {
  const events: OrchestrationEvent[] = [];
  const listeners = new Set<(state: TuiState) => void>();
  let state = createInitialTuiState();

  if (options.initialEvents) {
    for (const event of options.initialEvents) {
      const index = events.length;
      events.push(event);
      state = applyOrchestrationEvent(state, event, {
        timestamp: options.timestampForEvent?.(event, index),
        maxTimelineItems: options.maxTimelineItems,
      });
    }
  }

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  return {
    onEvent(event) {
      const index = events.length;
      events.push(event);
      state = applyOrchestrationEvent(state, event, {
        timestamp: options.timestampForEvent?.(event, index),
        maxTimelineItems: options.maxTimelineItems,
      });
      notify();
    },
    getState() {
      return state;
    },
    getEvents() {
      return events;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      events.length = 0;
      state = createInitialTuiState();
      notify();
    },
  };
}

export function applyOrchestrationEvent(
  current: TuiState,
  event: OrchestrationEvent,
  options: ApplyTuiEventOptions = {},
): TuiState {
  const state = appendTimeline(current, event, summarizeEvent(event), options);

  switch (event.type) {
    case 'run_started':
      return {
        ...state,
        runId: event.runId,
        ticker: event.ticker,
        trade_date: event.trade_date,
        asset_type: event.asset_type,
        footer: `Running ${event.ticker} for ${event.trade_date}`,
        completed: false,
        durationMs: null,
      };
    case 'analyst_started':
      return updateAgent(state, event.role, 'in_progress', 'Gathering evidence');
    case 'analyst_completed':
      return withGeneratedReport(
        updateAgent(state, event.role, 'completed', 'Report ready'),
        `${labelForAgent(event.role)} Report`,
        event.report.content,
        { llmCalls: 1, generatedReports: 1 },
      );
    case 'debate_turn':
      return withGeneratedReport(
        updateAgent(state, event.turn.speaker, 'completed', `Round ${event.turn.round}`),
        `${labelForAgent(event.turn.speaker)} Debate`,
        event.turn.content,
        { llmCalls: 1, generatedReports: 0 },
      );
    case 'research_plan_ready':
      return withGeneratedReport(
        updateAgent(state, 'researchManager', 'completed', event.plan.recommendation),
        'Research Plan',
        renderResearchPlan(event.plan),
        { llmCalls: 1, generatedReports: 1 },
      );
    case 'trader_proposal_ready':
      return withGeneratedReport(
        updateAgent(state, 'trader', 'completed', event.proposal.action),
        'Trader Proposal',
        renderTraderProposal(event.proposal),
        { llmCalls: 1, generatedReports: 1 },
      );
    case 'risk_turn':
      return withGeneratedReport(
        updateAgent(state, riskKey(event.turn.speaker), 'completed', `Round ${event.turn.round}`),
        `${labelForAgent(riskKey(event.turn.speaker))} View`,
        event.turn.content,
        { llmCalls: 1, generatedReports: 0 },
      );
    case 'portfolio_decision_ready':
      return withGeneratedReport(
        updateAgent(state, 'portfolioManager', 'completed', event.decision.rating),
        'Portfolio Decision',
        renderPortfolioDecision(event.decision),
        { llmCalls: 1, generatedReports: 1 },
      );
    case 'structured_output_failed': {
      const key = agentKeyFromName(event.agent);
      const failed = key
        ? updateAgent(state, key, 'failed', event.error.message)
        : state;
      return {
        ...failed,
        currentReport: {
          title: 'Structured Output Failed',
          body: `${event.agent}: ${event.error.message}`,
        },
        footer: 'Structured output validation failed',
      };
    }
    case 'memory_resolved':
      return { ...state, footer: `Resolved ${event.entries.length} memory entries` };
    case 'memory_decision_stored':
      return { ...state, footer: `Stored memory entry ${event.entry.id}` };
    case 'policy_evaluated':
      return updateAgent(
        state,
        'policy',
        policyStatus(event.decision.decision),
        event.decision.primaryReason ?? event.decision.decision,
      );
    case 'approval_required':
      return updateAgent(state, 'approval', 'in_progress', `Approval ${event.approvalId}`);
    case 'approval_resolved':
      return updateAgent(
        state,
        'approval',
        event.record.status === 'approved' ? 'completed' : 'blocked',
        event.record.status,
      );
    case 'execution_started':
      return updateAgent(
        state,
        'execution',
        'in_progress',
        `${event.request.action} ${formatUsd(event.request.amountUsd)}`,
      );
    case 'execution_completed':
      return {
        ...updateAgent(
          state,
          'execution',
          event.envelope.status === 'rejected' ? 'failed' : 'completed',
          `${event.envelope.provider}:${event.envelope.status}`,
        ),
        currentReport: {
          title: 'Execution Envelope',
          body: [
            `Provider: ${event.envelope.provider}`,
            `Surface: ${event.envelope.surface}`,
            `Status: ${event.envelope.status}`,
            `Tx Hash: ${event.envelope.txHash ?? 'none'}`,
          ].join('\n'),
        },
      };
    case 'execution_skipped':
      return updateAgent(state, 'execution', 'skipped', event.reason);
    case 'execution_failed':
      return updateAgent(state, 'execution', 'failed', event.error.message);
    case 'run_completed':
      return {
        ...state,
        completed: true,
        durationMs: event.durationMs,
        footer: `Completed in ${event.durationMs}ms`,
      };
  }
}

function appendTimeline(
  state: TuiState,
  event: OrchestrationEvent,
  content: string,
  options: ApplyTuiEventOptions,
): TuiState {
  const eventCount = state.eventCount + 1;
  const max = options.maxTimelineItems ?? 8;
  const item: TuiTimelineItem = {
    id: `evt_${eventCount}`,
    timestamp: formatTimestamp(options.timestamp ?? new Date().toISOString()),
    type: event.type,
    content,
  };
  return {
    ...state,
    eventCount,
    timeline: [...state.timeline, item].slice(-max),
  };
}

function updateAgent(
  state: TuiState,
  key: TuiAgentKey,
  status: TuiStatus,
  detail: string,
): TuiState {
  return {
    ...state,
    agents: state.agents.map((agent) =>
      agent.key === key ? { ...agent, status, detail } : agent,
    ),
  };
}

function withGeneratedReport(
  state: TuiState,
  title: string,
  body: string,
  increments: Partial<TuiCounters>,
): TuiState {
  return {
    ...state,
    currentReport: { title, body },
    counters: {
      toolCalls: state.counters.toolCalls + (increments.toolCalls ?? 0),
      llmCalls: state.counters.llmCalls + (increments.llmCalls ?? 0),
      generatedReports: state.counters.generatedReports + (increments.generatedReports ?? 0),
    },
  };
}

function summarizeEvent(event: OrchestrationEvent): string {
  switch (event.type) {
    case 'run_started':
      return `${event.ticker} ${event.asset_type} run for ${event.trade_date}`;
    case 'analyst_started':
      return `${labelForAgent(event.role)} started`;
    case 'analyst_completed':
      return `${labelForAgent(event.role)} report ready`;
    case 'debate_turn':
      return `${labelForAgent(event.turn.speaker)} round ${event.turn.round}`;
    case 'research_plan_ready':
      return `Research Manager recommends ${event.plan.recommendation}`;
    case 'trader_proposal_ready':
      return `Trader proposes ${event.proposal.action}`;
    case 'risk_turn':
      return `${labelForAgent(riskKey(event.turn.speaker))} round ${event.turn.round}`;
    case 'portfolio_decision_ready':
      return `Portfolio Manager rates ${event.decision.rating}`;
    case 'structured_output_failed':
      return `${event.agent} output failed: ${event.error.message}`;
    case 'memory_resolved':
      return `Resolved ${event.entries.length} memory entries`;
    case 'memory_decision_stored':
      return `Stored memory entry ${event.entry.id}`;
    case 'policy_evaluated':
      return `Policy ${event.decision.decision}`;
    case 'approval_required':
      return `Approval required: ${event.approvalId}`;
    case 'approval_resolved':
      return `Approval ${event.record.status}: ${event.approvalId}`;
    case 'execution_started':
      return `Execution started: ${event.request.action} ${formatUsd(event.request.amountUsd)}`;
    case 'execution_completed':
      return `Execution ${event.envelope.status} via ${event.envelope.provider}`;
    case 'execution_skipped':
      return `Execution skipped: ${event.reason}`;
    case 'execution_failed':
      return `Execution failed: ${event.error.message}`;
    case 'run_completed':
      return `Run completed in ${event.durationMs}ms`;
  }
}

function labelForAgent(key: TuiAgentKey | 'aggressive' | 'neutral' | 'conservative'): string {
  if (key === 'aggressive') return 'Aggressive Risk';
  if (key === 'neutral') return 'Neutral Risk';
  if (key === 'conservative') return 'Conservative Risk';
  return AGENT_ROWS.find((row) => row.key === key)?.label ?? key;
}

function riskKey(speaker: 'aggressive' | 'neutral' | 'conservative'): TuiAgentKey {
  switch (speaker) {
    case 'aggressive':
      return 'aggressiveRisk';
    case 'neutral':
      return 'neutralRisk';
    case 'conservative':
      return 'conservativeRisk';
  }
}

function policyStatus(decision: 'allow' | 'deny' | 'escalate'): TuiStatus {
  if (decision === 'allow') return 'completed';
  if (decision === 'deny') return 'blocked';
  return 'in_progress';
}

function agentKeyFromName(agent: string): TuiAgentKey | null {
  const name = agent.toLowerCase();
  if (name.includes('market')) return 'market';
  if (name.includes('sentiment') || name.includes('social')) return 'social';
  if (name.includes('news')) return 'news';
  if (name.includes('fundamental')) return 'fundamentals';
  if (name.includes('bull')) return 'bull';
  if (name.includes('bear')) return 'bear';
  if (name.includes('research')) return 'researchManager';
  if (name.includes('trader')) return 'trader';
  if (name.includes('aggressive')) return 'aggressiveRisk';
  if (name.includes('neutral')) return 'neutralRisk';
  if (name.includes('conservative')) return 'conservativeRisk';
  if (name.includes('portfolio')) return 'portfolioManager';
  return null;
}

function formatTimestamp(value: string): string {
  const timeMatch = value.match(/T(\d{2}:\d{2}:\d{2})/);
  if (timeMatch) return timeMatch[1];
  return value;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}
