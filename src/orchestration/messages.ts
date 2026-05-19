/**
 * @packageDocumentation
 * @module orchestration/messages
 * @description Pure functions that build the per-turn **user messages**
 * fed to each agent. Static persona / tool guidance lives in
 * `agents/instructions.ts`; this file owns the dynamic per-run state
 * (ticker, trade date, prior reports, debate history, etc).
 *
 * Keeping these as pure string builders makes it trivial to fixture-test
 * the orchestrator without touching an LLM.
 */

import type {
  AnalystKey,
  AnalystReport,
  AssetType,
  DebateTurn,
  RiskDebateTurn,
  Ticker,
  TradeDate,
} from '../types';

/** Common header for any agent that needs the basic trade context. */
export function instrumentHeader(args: {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
}): string {
  const noun = args.asset_type === 'crypto' ? 'asset' : 'company';
  return [
    `Ticker: ${args.ticker}`,
    `Trade date: ${args.trade_date}`,
    `Asset type: ${args.asset_type} (${noun})`,
  ].join('\n');
}

// ── Analyst user prompts ─────────────────────────────────────────────────

export function analystUserMessage(args: {
  role: AnalystKey;
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  /** Lookback window in days for time-bounded tools. */
  lookbackDays?: number;
  /** Past-context memo (Phase 6 will populate from semantic memory). */
  past_context?: string | null;
}): string {
  const header = instrumentHeader(args);
  const lookback = args.lookbackDays ?? 7;
  const past = args.past_context?.trim()
    ? `\n\nPrior-decision context (from past runs):\n${args.past_context.trim()}`
    : '';
  return (
    `${header}\nLookback window: ${lookback} days.${past}\n\n` +
    `Produce your ${args.role} analyst report now, following the system instructions above.`
  );
}

// ── Researcher debate prompts ────────────────────────────────────────────

function reportsBlock(reports: AnalystReport[]): string {
  if (reports.length === 0) {
    return '_(No analyst reports were produced this run.)_';
  }
  return reports
    .map((r) => `### ${r.kind} report\n\n${r.content}`)
    .join('\n\n');
}

function debateHistoryBlock(turns: DebateTurn[]): string {
  if (turns.length === 0) return '_(No prior turns — you are opening the debate.)_';
  return turns
    .map((t) => `**${t.speaker}** (round ${t.round}): ${t.content}`)
    .join('\n\n');
}

export function bullResearcherUserMessage(args: {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  reports: AnalystReport[];
  history: DebateTurn[];
  lastBearResponse: string | null;
}): string {
  const counter = args.lastBearResponse
    ? `\n\n## Bear analyst's last argument\n\n${args.lastBearResponse}`
    : '\n\n_(The bear analyst has not spoken yet. Open the debate with your strongest case.)_';
  return [
    instrumentHeader(args),
    '',
    '## Analyst reports',
    '',
    reportsBlock(args.reports),
    '',
    '## Debate history',
    '',
    debateHistoryBlock(args.history),
    counter,
    '',
    'Deliver your next bull argument now.',
  ].join('\n');
}

export function bearResearcherUserMessage(args: {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  reports: AnalystReport[];
  history: DebateTurn[];
  lastBullResponse: string | null;
}): string {
  const counter = args.lastBullResponse
    ? `\n\n## Bull analyst's last argument\n\n${args.lastBullResponse}`
    : '\n\n_(The bull analyst has not spoken yet. Open the debate with your strongest case.)_';
  return [
    instrumentHeader(args),
    '',
    '## Analyst reports',
    '',
    reportsBlock(args.reports),
    '',
    '## Debate history',
    '',
    debateHistoryBlock(args.history),
    counter,
    '',
    'Deliver your next bear argument now.',
  ].join('\n');
}

// ── Manager / Trader prompts (structured-output agents) ──────────────────

const JSON_INSTRUCTION =
  'Respond with **only** a single JSON object matching the schema described in the system prompt. Do not wrap it in code fences, prose, or commentary — emit raw JSON.';

// Per-agent JSON shape examples. Models (especially Gemini) honor
// structured-output requirements far more reliably when the exact field
// names, ordering, and allowed enum values are shown verbatim in the
// user message rather than inferred from prose.
const RESEARCH_PLAN_SHAPE =
  'Required JSON shape (emit exactly these keys, in this order):\n' +
  '{\n' +
  '  "recommendation": "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell",\n' +
  '  "rationale": "<conversational summary ending with which arguments drove the recommendation>",\n' +
  '  "strategic_actions": "<concrete steps for the trader, including position sizing>"\n' +
  '}';

const TRADER_PROPOSAL_SHAPE =
  'Required JSON shape (emit exactly these keys; optional keys may be null but must be present):\n' +
  '{\n' +
  '  "action": "Buy" | "Hold" | "Sell",\n' +
  '  "reasoning": "<2-4 sentences grounded in the analyst reports and research plan>",\n' +
  '  "entry_price": <number | null>,\n' +
  '  "stop_loss": <number | null>,\n' +
  '  "position_sizing": "<string | null>"\n' +
  '}';

const PORTFOLIO_DECISION_SHAPE =
  'Required JSON shape (emit exactly these keys; optional keys may be null but must be present):\n' +
  '{\n' +
  '  "rating": "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell",\n' +
  '  "executive_summary": "<2-4 sentence action plan: entry, sizing, key risk levels, time horizon>",\n' +
  '  "investment_thesis": "<detailed reasoning anchored in specific evidence from the risk debate>",\n' +
  '  "price_target": <number | null>,\n' +
  '  "time_horizon": "<string | null, e.g. \'3-6 months\'>"\n' +
  '}';

export function researchManagerUserMessage(args: {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  reports: AnalystReport[];
  history: DebateTurn[];
}): string {
  return [
    instrumentHeader(args),
    '',
    '## Analyst reports',
    '',
    reportsBlock(args.reports),
    '',
    '## Bull vs bear debate transcript',
    '',
    debateHistoryBlock(args.history),
    '',
    JSON_INSTRUCTION,
    '',
    RESEARCH_PLAN_SHAPE,
  ].join('\n');
}

export function traderUserMessage(args: {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  reports: AnalystReport[];
  research_plan_markdown: string;
}): string {
  return [
    instrumentHeader(args),
    '',
    '## Analyst reports',
    '',
    reportsBlock(args.reports),
    '',
    '## Research Manager plan',
    '',
    args.research_plan_markdown,
    '',
    JSON_INSTRUCTION,
    '',
    TRADER_PROPOSAL_SHAPE,
  ].join('\n');
}

// ── Risk debate ──────────────────────────────────────────────────────────

function riskHistoryBlock(turns: RiskDebateTurn[]): string {
  if (turns.length === 0) {
    return '_(You are opening the risk debate.)_';
  }
  return turns
    .map((t) => `**${t.speaker}** (round ${t.round}): ${t.content}`)
    .join('\n\n');
}

export function riskDebatorUserMessage(args: {
  speaker: 'aggressive' | 'neutral' | 'conservative';
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  reports: AnalystReport[];
  trader_proposal_markdown: string;
  history: RiskDebateTurn[];
}): string {
  const lastByOther = (other: 'aggressive' | 'neutral' | 'conservative') =>
    [...args.history].reverse().find((t) => t.speaker === other);
  const others: Array<'aggressive' | 'neutral' | 'conservative'> = (
    ['aggressive', 'neutral', 'conservative'] as const
  ).filter((s) => s !== args.speaker);
  const counters = others
    .map((other) => {
      const turn = lastByOther(other);
      return turn
        ? `### Last ${other} response\n\n${turn.content}`
        : `### Last ${other} response\n\n_(no prior turn)_`;
    })
    .join('\n\n');

  return [
    instrumentHeader(args),
    '',
    '## Analyst reports',
    '',
    reportsBlock(args.reports),
    '',
    '## Trader proposal',
    '',
    args.trader_proposal_markdown,
    '',
    '## Risk debate history',
    '',
    riskHistoryBlock(args.history),
    '',
    counters,
    '',
    `Deliver your ${args.speaker} response now (conversational style, no special formatting).`,
  ].join('\n');
}

// ── Portfolio manager ────────────────────────────────────────────────────

export function portfolioManagerUserMessage(args: {
  ticker: Ticker;
  trade_date: TradeDate;
  asset_type: AssetType;
  research_plan_markdown: string;
  trader_proposal_markdown: string;
  risk_history: RiskDebateTurn[];
  past_context?: string | null;
}): string {
  const past = args.past_context?.trim()
    ? `\n\n## Prior-decision lessons\n\n${args.past_context.trim()}`
    : '';
  return [
    instrumentHeader(args),
    '',
    '## Research Manager plan',
    '',
    args.research_plan_markdown,
    '',
    '## Trader proposal',
    '',
    args.trader_proposal_markdown,
    '',
    '## Risk debate transcript',
    '',
    riskHistoryBlock(args.risk_history),
    past,
    '',
    JSON_INSTRUCTION,
    '',
    PORTFOLIO_DECISION_SHAPE,
  ].join('\n');
}
