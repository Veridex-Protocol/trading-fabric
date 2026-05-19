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

/**
 * Sanitize a string for use in a filesystem path segment.
 *
 * Replaces anything that isn't an alphanumeric, hyphen, dot, or
 * underscore with `_`. Keeps the segment short and predictable across
 * macOS / Linux / Windows.
 */
function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * Format a Date as `YYYYMMDD-HHMMSS` in UTC. Used in the per-run
 * folder name so the human-friendly directory is sortable.
 */
function formatRunTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown-time';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

const ANALYST_REPORT_TITLE: Record<string, string> = {
  market: 'Market Analyst',
  social: 'Social Sentiment Analyst',
  news: 'News Analyst',
  fundamentals: 'Fundamentals Analyst',
};

/**
 * Resolve the folder where human-readable per-run markdown reports
 * live, alongside a copy of the canonical JSON artifact. The folder
 * name embeds the ticker and the recorded timestamp so an operator
 * can find a run by eye without grepping JSON.
 */
export function defaultRunReportsDir(
  config: TradingFabricConfig,
  artifact: TradingFabricRunArtifact,
): string {
  const ticker = sanitizePathSegment(artifact.result.ticker || 'UNKNOWN');
  const stamp = formatRunTimestamp(artifact.recordedAt);
  const short = sanitizePathSegment(artifact.runId.slice(0, 8));
  return path.join(
    expandHome(config.results_dir),
    'runs',
    `${ticker}-${stamp}-${short}`,
  );
}

/**
 * Write a folder containing one markdown file per agent output plus
 * a copy of the run JSON artifact. This is in addition to (not a
 * replacement for) the canonical `runs/<runId>.json` file used by
 * the replay loader — that path is unchanged for back-compat.
 *
 * Returns the folder path. Empty/missing sections are skipped so
 * partial (failed) runs still produce useful output.
 */
export async function writeRunReports(args: {
  config: TradingFabricConfig;
  artifact: TradingFabricRunArtifact;
  dir?: string;
}): Promise<string> {
  const dir = args.dir ?? defaultRunReportsDir(args.config, args.artifact);
  await fs.mkdir(dir, { recursive: true });
  const { artifact } = args;
  const { result } = artifact;

  const writes: Array<Promise<unknown>> = [];
  const write = (file: string, body: string): void => {
    writes.push(fs.writeFile(path.join(dir, file), body.endsWith('\n') ? body : `${body}\n`, 'utf8'));
  };

  write('run.json', `${JSON.stringify(artifact, null, 2)}\n`);

  const header = (title: string): string =>
    [
      `# ${title}`,
      ``,
      `- Ticker: ${result.ticker}`,
      `- Trade date: ${result.trade_date}`,
      `- Asset type: ${result.asset_type}`,
      `- Run id: ${result.runId}`,
      `- Recorded at: ${artifact.recordedAt}`,
      ``,
    ].join('\n');

  for (const report of result.reports ?? []) {
    if (!report.content?.trim()) continue;
    const title = ANALYST_REPORT_TITLE[report.kind] ?? `${report.kind} Analyst`;
    const slug = sanitizePathSegment(report.kind);
    write(`${slug}-analyst.md`, `${header(title)}\n${report.content.trim()}\n`);
  }

  if (result.research_plan?.trim()) {
    write('research-plan.md', `${header('Research Plan')}\n${result.research_plan.trim()}\n`);
  }

  if (result.trader_proposal?.trim()) {
    write('trader-proposal.md', `${header('Trader Proposal')}\n${result.trader_proposal.trim()}\n`);
  }

  if (Array.isArray(result.risk_debate) && result.risk_debate.length > 0) {
    const body = result.risk_debate
      .map(
        (turn) =>
          `## Round ${turn.round} — ${turn.speaker}\n\n` +
          `_${turn.timestamp}_\n\n${turn.content.trim()}\n`,
      )
      .join('\n');
    write('risk-debate.md', `${header('Risk Debate')}\n${body}`);
  }

  if (result.portfolio_decision?.trim()) {
    write(
      'portfolio-decision.md',
      `${header('Portfolio Decision')}\n${result.portfolio_decision.trim()}\n`,
    );
  }

  const summaryLines: string[] = [
    header(`Run Summary — ${result.ticker}`),
    `## Status`,
    ``,
    `- Duration: ${result.durationMs}ms`,
    `- Analysts: ${(result.analysts ?? []).join(', ') || '(none)'}`,
    `- Reports captured: ${result.reports?.length ?? 0}`,
    `- Execution: ${result.execution ? `${result.execution.action} (${result.execution.status ?? 'n/a'})` : 'none'}`,
  ];
  if (result.error) {
    summaryLines.push(``, `## Error`, ``, '```', result.error, '```');
  }
  summaryLines.push(``, `## Files`, ``);
  summaryLines.push(`- run.json — canonical replay artifact`);
  for (const report of result.reports ?? []) {
    if (!report.content?.trim()) continue;
    summaryLines.push(`- ${sanitizePathSegment(report.kind)}-analyst.md`);
  }
  if (result.research_plan?.trim()) summaryLines.push(`- research-plan.md`);
  if (result.trader_proposal?.trim()) summaryLines.push(`- trader-proposal.md`);
  if ((result.risk_debate ?? []).length > 0) summaryLines.push(`- risk-debate.md`);
  if (result.portfolio_decision?.trim()) summaryLines.push(`- portfolio-decision.md`);
  write('README.md', summaryLines.join('\n'));

  await Promise.all(writes);
  return dir;
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
