import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, render } from 'ink';

import type { OrchestrationEvent } from '../orchestration';
import {
  TUI_STATUS_LABELS,
  createInitialTuiState,
  deriveTuiState,
  type TuiAgentProgress,
  type TuiState,
  type TuiStateSource,
  type TuiTimelineItem,
} from './state';

export interface TradingFabricTuiProps {
  state?: TuiState;
  events?: readonly OrchestrationEvent[];
  source?: TuiStateSource;
  width?: number;
  maxTimelineItems?: number;
  timestampForEvent?: (event: OrchestrationEvent, index: number) => string;
}

const ASCII_LOGO = [' _____ _____ ', '|_   _|  ___|', '  | | | |_   ', '  | | |  _|  ', '  |_| |_|    '];

export function TradingFabricTui(props: TradingFabricTuiProps): JSX.Element {
  const derivedState = useMemo(() => {
    if (!props.events) return null;
    return deriveTuiState(props.events, {
      timestampForEvent: props.timestampForEvent,
      maxTimelineItems: props.maxTimelineItems,
    });
  }, [props.events, props.timestampForEvent, props.maxTimelineItems]);

  const [sourceState, setSourceState] = useState<TuiState | null>(() =>
    props.source ? props.source.getState() : null,
  );

  useEffect(() => {
    if (!props.source) {
      setSourceState(null);
      return;
    }
    return props.source.subscribe(setSourceState);
  }, [props.source]);

  const state = props.state ?? sourceState ?? derivedState ?? createInitialTuiState();
  const width = props.width ?? 100;
  const leftWidth = Math.min(38, Math.max(32, Math.floor(width * 0.38)));
  const rightWidth = Math.max(40, width - leftWidth - 4);

  return (
    <Box flexDirection="column" width={width}>
      <Header state={state} width={width} />
      <Box flexDirection="row" columnGap={2}>
        <AgentProgressTable agents={state.agents} width={leftWidth} />
        <TimelineLog items={state.timeline} width={rightWidth} />
      </Box>
      <ReportPanel state={state} width={width} />
      <Footer state={state} width={width} />
    </Box>
  );
}

export function renderTradingFabricTui(props: TradingFabricTuiProps): ReturnType<typeof render> {
  return render(<TradingFabricTui {...props} />);
}

function Header({ state, width }: { state: TuiState; width: number }): JSX.Element {
  const runLabel = state.ticker
    ? `${state.ticker} / ${state.trade_date ?? 'date pending'} / ${state.asset_type ?? 'asset pending'}`
    : 'No active run';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{ASCII_LOGO.join('\n')}</Text>
      <Text bold>{'Welcome to Trading Fabric'}</Text>
      <Text>{truncate(`Run: ${runLabel}`, width)}</Text>
      <Text>{rule(width)}</Text>
    </Box>
  );
}

function AgentProgressTable({
  agents,
  width,
}: {
  agents: readonly TuiAgentProgress[];
  width: number;
}): JSX.Element {
  const agentWidth = Math.min(20, width - 17);
  const detailWidth = Math.max(8, width - agentWidth - 8);
  const lines = [
    `${pad('Agent', agentWidth)} ${pad('State', 5)} Detail`,
    rule(width),
    ...agents.map((agent) =>
      `${pad(agent.label, agentWidth)} ${pad(TUI_STATUS_LABELS[agent.status], 5)} ${truncate(
        agent.detail,
        detailWidth,
      )}`,
    ),
  ];
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{'Agent Progress'}</Text>
      <Text>{lines.join('\n')}</Text>
    </Box>
  );
}

function TimelineLog({ items, width }: { items: readonly TuiTimelineItem[]; width: number }): JSX.Element {
  const rows = items.length > 0 ? items.map((item) => formatTimelineItem(item, width)) : ['Waiting for events'];
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{'Messages & Tools'}</Text>
      <Text>{`${pad('Time', 8)} ${pad('Type', 26)} Message`}</Text>
      <Text>{rule(width)}</Text>
      <Text>{rows.join('\n')}</Text>
    </Box>
  );
}

function ReportPanel({ state, width }: { state: TuiState; width: number }): JSX.Element {
  const title = truncate(state.currentReport.title, width);
  const body = visibleReportLines(state.currentReport.body, width, 8).join('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{rule(width)}</Text>
      <Text bold>{title}</Text>
      <Text>{body}</Text>
    </Box>
  );
}

function Footer({ state, width }: { state: TuiState; width: number }): JSX.Element {
  const completed = state.completed ? 'completed' : 'running';
  const line = [
    `LLM calls: ${state.counters.llmCalls}`,
    `Tool calls: ${state.counters.toolCalls}`,
    `Reports: ${state.counters.generatedReports}`,
    `Events: ${state.eventCount}`,
    `Status: ${completed}`,
    state.footer,
  ].join(' | ');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{rule(width)}</Text>
      <Text>{truncate(line, width)}</Text>
    </Box>
  );
}

function formatTimelineItem(item: TuiTimelineItem, width: number): string {
  const prefix = `${pad(item.timestamp, 8)} ${pad(item.type, 26)} `;
  return `${prefix}${truncate(item.content, Math.max(8, width - prefix.length))}`;
}

function visibleReportLines(body: string, width: number, maxLines: number): string[] {
  const lines = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, source) => line.length > 0 || index < source.length - 1)
    .slice(0, maxLines)
    .map((line) => truncate(line, width));
  if (lines.length === 0) return ['No report content yet.'];
  if (body.split('\n').length > maxLines) {
    lines.push(truncate('...', width));
  }
  return lines;
}

function pad(value: string, width: number): string {
  const trimmed = truncate(value, width);
  return trimmed + ' '.repeat(Math.max(0, width - trimmed.length));
}

function truncate(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function rule(width: number): string {
  return '-'.repeat(Math.max(8, width));
}
