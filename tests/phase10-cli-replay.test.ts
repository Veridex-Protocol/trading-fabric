import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildProgram } from '../src/cli/index.js';
import { DEFAULT_CONFIG, type TradingFabricConfig } from '../src/config/index.js';
import { createRunArtifact, loadRunArtifact, replayRunArtifact, summarizeReplay, writeRunArtifact } from '../src/replay/index.js';
import type { OrchestrationEvent } from '../src/orchestration/index.js';
import { FileApprovalQueue, type ApprovalRecord, type Proposal } from '../src/policy/index.js';
import { FileMemoryStore, TradingMemoryLog } from '../src/memory/index.js';
import type { TradingFabricRunResult } from '../src/types/index.js';

const events: OrchestrationEvent[] = [
  {
    type: 'run_started',
    runId: 'run-phase10',
    ticker: 'AAPL',
    trade_date: '2026-05-19',
    asset_type: 'stock',
  },
  { type: 'run_completed', runId: 'run-phase10', durationMs: 42 },
];

const result: TradingFabricRunResult = {
  runId: 'run-phase10',
  ticker: 'AAPL',
  trade_date: '2026-05-19',
  asset_type: 'stock',
  analysts: [],
  reports: [],
  research_plan: '',
  trader_proposal: '',
  risk_debate: [],
  portfolio_decision: '',
  proposal: null,
  policy_decision: null,
  approval: null,
  execution: null,
  durationMs: 42,
};

const proposal: Proposal = {
  decisionId: 'decision-phase10',
  runId: 'run-phase10',
  ticker: 'AAPL',
  trade_date: '2026-05-19',
  rating: 'Buy',
  action: 'Buy',
  amountUsd: 12,
};

function testConfig(dir: string): TradingFabricConfig {
  return {
    ...DEFAULT_CONFIG,
    results_dir: path.join(dir, 'results'),
    memory_log_path: path.join(dir, 'memory.jsonl'),
  };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const output: string[] = [];
  const program = buildProgram({
    env,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  program.exitOverride();
  await program.parseAsync(['node', 'trading-fabric', ...args], { from: 'node' });
  return output.join('');
}

describe('Phase 10 replay artifacts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tf-phase10-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes, loads, and folds a run artifact into TUI state', async () => {
    const artifact = createRunArtifact({
      version: '0.0.0-test',
      input: { ticker: 'AAPL', trade_date: '2026-05-19' },
      result,
      events,
      recordedAt: '2026-05-19T12:00:00.000Z',
    });
    const filePath = await writeRunArtifact({ config: testConfig(dir), artifact });
    const loaded = await loadRunArtifact({ config: testConfig(dir), runIdOrPath: result.runId });
    const replay = replayRunArtifact(loaded.artifact);

    expect(filePath).toContain(path.join('results', 'runs', 'run-phase10.json'));
    expect(loaded.filePath).toBe(filePath);
    expect(replay.state.completed).toBe(true);
    expect(replay.state.ticker).toBe('AAPL');
    expect(summarizeReplay(replay)).toContain('Status: completed');
  });

  test('replay command can emit deterministic JSON from an artifact path', async () => {
    const artifact = createRunArtifact({
      version: '0.0.0-test',
      input: { ticker: 'AAPL' },
      result,
      events,
      recordedAt: '2026-05-19T12:00:00.000Z',
    });
    const filePath = await writeRunArtifact({ config: testConfig(dir), artifact });

    const output = await runCli(['replay', filePath, '--no-tui', '--json']);
    const parsed = JSON.parse(output) as { artifact: { runId: string }; state: { completed: boolean } };

    expect(parsed.artifact.runId).toBe('run-phase10');
    expect(parsed.state.completed).toBe(true);
  });
});

describe('Phase 10 CLI surfaces', () => {
  let dir: string;
  let previousExitCode: string | number | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tf-cli-'));
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  });

  test('approves a file-backed approval record', async () => {
    const queue = new FileApprovalQueue({
      dir,
      idFactory: () => 'approval-phase10',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });
    await queue.submit({ proposal, verdicts: [] });

    const output = await runCli(['approve', 'approval-phase10', '--dir', dir, '--json']);
    const parsed = JSON.parse(output) as ApprovalRecord;

    expect(parsed.status).toBe('approved');
    expect(parsed.resolvedAt).not.toBeNull();
  });

  test('prints ticker-scoped memory as JSON', async () => {
    const filePath = path.join(dir, 'memory.jsonl');
    const log = new TradingMemoryLog({ store: new FileMemoryStore(filePath) });
    await log.storeDecision({
      ticker: 'AAPL',
      trade_date: '2026-05-19',
      rating: 'Buy',
      decision: 'Buy with a hard stop.',
    });

    const output = await runCli(['memory', 'show', 'AAPL', '--memory-path', filePath, '--json']);
    const parsed = JSON.parse(output) as { ticker: string; total: number; pending: number };

    expect(parsed.ticker).toBe('AAPL');
    expect(parsed.total).toBe(1);
    expect(parsed.pending).toBe(1);
  });

  test('validates policy config files and reports dry-run checks', async () => {
    const filePath = path.join(dir, 'policy.json');
    writeFileSync(
      filePath,
      JSON.stringify({ limits: { daily_spend_cap_usd: 50, max_position_usd: 25 } }),
      'utf8',
    );

    const output = await runCli(['policy', 'validate', filePath, '--json']);
    const parsed = JSON.parse(output) as { ok: boolean; checks: Array<{ passed: boolean }> };

    expect(parsed.ok).toBe(true);
    expect(parsed.checks.every((check) => check.passed)).toBe(true);
  });

  test('runs the policy eval suite through the CLI', async () => {
    const output = await runCli(['eval', 'run', 'policy', '--json']);
    const parsed = JSON.parse(output) as { suite: string; passed: boolean; total: number };

    expect(parsed.suite).toBe('policy');
    expect(parsed.passed).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });
});
