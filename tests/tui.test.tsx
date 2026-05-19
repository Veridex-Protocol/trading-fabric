import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, test } from 'vitest';

import type { OrchestrationEvent } from '../src/orchestration';
import {
  TradingFabricTui,
  createTuiEventSink,
  deriveTuiState,
  getAgentProgress,
} from '../src/tui';

function visibleFrame(frame: string | undefined): string {
  return (frame ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

const fixtureEvents: OrchestrationEvent[] = [
  {
    type: 'run_started',
    runId: 'run-1',
    ticker: 'AAPL',
    trade_date: '2026-05-19',
    asset_type: 'stock',
  },
  { type: 'analyst_started', runId: 'run-1', role: 'market' },
  {
    type: 'analyst_completed',
    runId: 'run-1',
    role: 'market',
    report: {
      kind: 'market',
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      content: '# Market\nRSI constructive; MACD bullish crossover.',
    },
  },
  {
    type: 'research_plan_ready',
    runId: 'run-1',
    plan: {
      recommendation: 'Overweight',
      rationale: 'Bull case wins on operating leverage.',
      strategic_actions: 'Scale in over two weeks.',
    },
  },
  {
    type: 'trader_proposal_ready',
    runId: 'run-1',
    proposal: {
      action: 'Buy',
      reasoning: 'Signals align with the research plan.',
      entry_price: 187.5,
      stop_loss: 175,
      position_sizing: '4% of book',
    },
  },
  {
    type: 'risk_turn',
    runId: 'run-1',
    turn: {
      speaker: 'neutral',
      round: 1,
      content: 'A phased entry balances upside capture with drawdown control.',
      timestamp: '2026-05-19T12:00:00Z',
    },
  },
  {
    type: 'portfolio_decision_ready',
    runId: 'run-1',
    decision: {
      rating: 'Overweight',
      executive_summary: 'Open a phased starter position with a hard stop.',
      investment_thesis: 'Analyst evidence favors upside while risk remains manageable.',
      price_target: 215,
      time_horizon: '3-6 months',
    },
  },
  {
    type: 'policy_evaluated',
    runId: 'run-1',
    proposal: {
      decisionId: 'decision-1',
      runId: 'run-1',
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      rating: 'Overweight',
      action: 'Buy',
      amountUsd: 12.5,
    },
    decision: {
      decision: 'allow',
      primaryReason: null,
      verdicts: [{ ruleId: 'max-position', decision: 'allow', reason: 'within limit' }],
    },
  },
  {
    type: 'execution_skipped',
    runId: 'run-1',
    reason: 'execute_enabled_false',
  },
  { type: 'run_completed', runId: 'run-1', durationMs: 42 },
];

describe('Phase 9 TUI state', () => {
  test('folds orchestration events into progress, logs, and counters', () => {
    const state = deriveTuiState(fixtureEvents, {
      timestampForEvent: (_event, index) => `12:00:0${index}`,
      maxTimelineItems: 20,
    });

    expect(state.ticker).toBe('AAPL');
    expect(getAgentProgress(state, 'market').status).toBe('completed');
    expect(getAgentProgress(state, 'researchManager').detail).toBe('Overweight');
    expect(getAgentProgress(state, 'policy').status).toBe('completed');
    expect(getAgentProgress(state, 'execution').status).toBe('skipped');
    expect(state.counters.llmCalls).toBe(5);
    expect(state.counters.generatedReports).toBe(4);
    expect(state.completed).toBe(true);
    expect(state.timeline.map((item) => item.type)).toContain('portfolio_decision_ready');
  });

  test('event sink updates subscribers and keeps a replayable event log', () => {
    const sink = createTuiEventSink({ timestampForEvent: () => '12:00:00' });
    const snapshots: string[] = [];
    const unsubscribe = sink.subscribe((state) => {
      snapshots.push(state.ticker ?? 'none');
    });

    sink.onEvent(fixtureEvents[0]);
    sink.onEvent(fixtureEvents[1]);
    unsubscribe();
    sink.onEvent(fixtureEvents[2]);

    expect(snapshots).toEqual(['none', 'AAPL', 'AAPL']);
    expect(sink.getEvents()).toHaveLength(3);
    expect(getAgentProgress(sink.getState(), 'market').status).toBe('completed');
  });
});

describe('Phase 9 Ink rendering', () => {
  test('renders the Rich-style terminal layout from a recorded run', () => {
    const state = deriveTuiState(fixtureEvents, {
      timestampForEvent: () => '12:00:00',
      maxTimelineItems: 20,
    });
    const view = render(<TradingFabricTui state={state} width={96} />);

    expect(visibleFrame(view.lastFrame())).toMatchInlineSnapshot(`
      " _____ _____
      |_   _|  ___|
        | | | |_
        | | |  _|
        |_| |_|
      Welcome to Trading Fabric
      Run: AAPL / 2026-05-19 / stock
      ------------------------------------------------------------------------------------------------

      Agent Progress                        Messages & Tools
      Agent               State Detail      Time     Type                       Message
      ------------------------------------  --------------------------------------------------------
      Market Analyst      [OK]  Report...   12:00:00 run_started                AAPL stock run fo...
      Social Analyst      [ ]   Waiting     12:00:00 analyst_started            Market Analyst st...
      News Analyst        [ ]   Waiting     12:00:00 analyst_completed          Market Analyst re...
      Fundamentals        [ ]   Waiting     12:00:00 research_plan_ready        Research Manager ...
      Bull Researcher     [ ]   Waiting     12:00:00 trader_proposal_ready      Trader proposes Buy
      Bear Researcher     [ ]   Waiting     12:00:00 risk_turn                  Neutral Risk round 1
      Research Manager    [OK]  Overwe...   12:00:00 portfolio_decision_ready   Portfolio Manager...
      Trader              [OK]  Buy         12:00:00 policy_evaluated           Policy allow
      Aggressive Risk     [ ]   Waiting     12:00:00 execution_skipped          Execution skipped...
      Neutral Risk        [OK]  Round 1     12:00:00 run_completed              Run completed in ...
      Conservative Risk   [ ]   Waiting
      Portfolio Manager   [OK]  Overwe...
      Policy Gate         [OK]  allow
      Approval            [ ]   Waiting
      Execution           [--]  execut...

      ------------------------------------------------------------------------------------------------
      Portfolio Decision
      **Rating**: Overweight

      **Executive Summary**: Open a phased starter position with a hard stop.

      **Investment Thesis**: Analyst evidence favors upside while risk remains manageable.

      **Price Target**: 215

      ...

      ------------------------------------------------------------------------------------------------
      LLM calls: 5 | Tool calls: 0 | Reports: 4 | Events: 10 | Status: completed | Completed in 42ms"
    `);
    view.unmount();
  });
});
