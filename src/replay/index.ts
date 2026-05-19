import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export {
  ReplayProvider,
  TraceRecorder,
  compareTraces,
  deserializeGoldenTrace,
  serializeGoldenTrace,
} from '@veridex/agents/testing';
export type {
  EventDiff,
  GoldenTrace,
  RecordedInteraction,
  TraceComparisonResult,
} from '@veridex/agents/testing';

import type { TradingFabricConfig } from '../config';
import type { OrchestrationEvent } from '../orchestration';
import { deriveTuiState, type TuiState } from '../tui';
import type { TradingFabricRunInput, TradingFabricRunResult } from '../types';
import { expandHome } from '../memory/store';

export const RUN_ARTIFACT_SCHEMA = 'trading-fabric.run.v1' as const;

export interface TradingFabricRunArtifact {
  schema: typeof RUN_ARTIFACT_SCHEMA;
  runId: string;
  recordedAt: string;
  input: TradingFabricRunInput;
  result: TradingFabricRunResult;
  events: OrchestrationEvent[];
  metadata: {
    version: string;
    reference: 'TradingAgents propagate + smoke scripts';
    replay: 'orchestration-event-stream';
  };
}

export interface LoadedRunArtifact {
  artifact: TradingFabricRunArtifact;
  filePath: string;
}

export interface ReplayResult {
  artifact: TradingFabricRunArtifact;
  state: TuiState;
}

export function createRunArtifact(args: {
  version: string;
  input: TradingFabricRunInput;
  result: TradingFabricRunResult;
  events: readonly OrchestrationEvent[];
  recordedAt?: string;
}): TradingFabricRunArtifact {
  return {
    schema: RUN_ARTIFACT_SCHEMA,
    runId: args.result.runId,
    recordedAt: args.recordedAt ?? new Date().toISOString(),
    input: args.input,
    result: args.result,
    events: [...args.events],
    metadata: {
      version: args.version,
      reference: 'TradingAgents propagate + smoke scripts',
      replay: 'orchestration-event-stream',
    },
  };
}

export function defaultRunArtifactPath(
  config: TradingFabricConfig,
  runId: string,
): string {
  return path.join(expandHome(config.results_dir), 'runs', `${runId}.json`);
}

export async function writeRunArtifact(args: {
  config: TradingFabricConfig;
  artifact: TradingFabricRunArtifact;
  filePath?: string;
}): Promise<string> {
  const filePath = args.filePath ?? defaultRunArtifactPath(args.config, args.artifact.runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(args.artifact, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
  return filePath;
}

export async function loadRunArtifact(args: {
  config: TradingFabricConfig;
  runIdOrPath: string;
}): Promise<LoadedRunArtifact> {
  const filePath = resolveRunArtifactPath(args.config, args.runIdOrPath);
  const raw = await fs.readFile(filePath, 'utf8');
  const artifact = JSON.parse(raw) as TradingFabricRunArtifact;
  if (artifact.schema !== RUN_ARTIFACT_SCHEMA) {
    throw new Error(`Unsupported replay artifact schema: ${String(artifact.schema)}`);
  }
  return { artifact, filePath };
}

export async function listRunArtifacts(config: TradingFabricConfig): Promise<string[]> {
  const dir = path.join(expandHome(config.results_dir), 'runs');
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function replayRunArtifact(artifact: TradingFabricRunArtifact): ReplayResult {
  return {
    artifact,
    state: deriveTuiState(artifact.events),
  };
}

export function summarizeReplay(result: ReplayResult): string {
  const { artifact, state } = result;
  return [
    `Run: ${artifact.runId}`,
    `Ticker: ${artifact.result.ticker}`,
    `Trade Date: ${artifact.result.trade_date}`,
    `Events: ${artifact.events.length}`,
    `Status: ${state.completed ? 'completed' : 'incomplete'}`,
  ].join('\n');
}

function resolveRunArtifactPath(
  config: TradingFabricConfig,
  runIdOrPath: string,
): string {
  if (
    runIdOrPath.includes('/') ||
    runIdOrPath.includes('\\') ||
    runIdOrPath.endsWith('.json')
  ) {
    return expandHome(runIdOrPath);
  }
  return defaultRunArtifactPath(config, runIdOrPath);
}
