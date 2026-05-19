#!/usr/bin/env node
/**
 * `trading-fabric` CLI entry. Keep this file thin: argument parsing,
 * terminal rendering, and JSON output live here; graph execution,
 * replay, policy, memory, approvals, and evals live in the library.
 */

import { promises as fs } from 'node:fs';

import { Command } from 'commander';

import {
  createTradingFabric,
  resolveConfig,
  VERSION,
} from '../index.js';
import type { LLMProviderKey } from '../config/index.js';
import { FileMemoryStore, TradingMemoryLog } from '../memory/index.js';
import { FileApprovalQueue } from '../policy/approvals.js';
import { parsePolicyConfigText, validatePolicyConfig } from '../policy/config.js';
import { createDefaultRuntimeOptions, defaultApprovalDir } from '../runtime.js';
import { runTradingEvalSuite, type TradingEvalSuiteId } from '../evals/index.js';
import { createTuiEventSink, renderTradingFabricTui } from '../tui/index.js';

export interface BuildProgramOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface RunCommandOptions {
  date?: string;
  analysts?: string;
  asset?: string;
  provider?: string;
  tui?: boolean;
  execute?: boolean;
}

interface JsonOption {
  json?: boolean;
}

interface ReplayCommandOptions extends JsonOption {
  tui?: boolean;
}

interface ApproveCommandOptions extends JsonOption {
  deny?: boolean;
  reason?: string;
  dir?: string;
}

interface MemoryShowOptions extends JsonOption {
  memoryPath?: string;
}

interface EvalRunOptions extends JsonOption {
  live?: boolean;
  provider?: string;
}

const PROVIDER_KEYS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'qwen',
  'qwen_cn',
  'glm',
  'glm_cn',
  'minimax',
  'minimax_cn',
  'openrouter',
  'ollama',
  'azure',
] as const satisfies readonly LLMProviderKey[];

export function buildProgram(cli: BuildProgramOptions = {}): Command {
  const env = cli.env ?? process.env;
  const stdout = cli.stdout ?? ((text: string) => process.stdout.write(text));
  const program = new Command();
  program
    .name('trading-fabric')
    .description(
      'Multi-agent trading framework on @veridex/agents — full TradingAgents ' +
        'parity with native Veridex execution, policy, approvals, memory, and audit.',
    )
    .version(VERSION);

  program
    .command('run')
    .description('Run the full analyst → trader → portfolio-manager pipeline')
    .argument('<ticker>', 'Ticker symbol (e.g. SPY, BTC-USD)')
    .option('-d, --date <date>', 'Trade date as YYYY-MM-DD (default: today)')
    .option(
      '-a, --analysts <list>',
      'Comma-separated analysts: market,social,news,fundamentals',
    )
    .option('--asset <type>', 'Asset class: stock | crypto', 'stock')
    .option('--provider <name>', 'LLM provider override')
    .option('--no-tui', 'Disable the Ink TUI; print JSON to stdout')
    .option('--execute', 'Enable real testnet execution via @veridex/sdk')
    .action(async (ticker: string, command: RunCommandOptions) => {
      const provider = parseProvider(command.provider);
      const sink = command.tui === false ? null : createTuiEventSink();
      const view = sink ? renderTradingFabricTui({ source: sink }) : null;
      const fabric = createTradingFabric({
        env,
        persistRuns: true,
        onEvent: sink ? (event) => sink.onEvent(event) : undefined,
        config: {
          ...(provider ? { llm_provider: provider } : {}),
          ...(command.execute === true ? { execute_enabled: true } : {}),
        },
      });

      try {
        const result = await fabric.run({
          ticker: ticker.toUpperCase(),
          trade_date: command.date,
          asset_type: command.asset === 'crypto' ? 'crypto' : 'stock',
          analysts: parseAnalysts(command.analysts),
        });
        view?.unmount();
        if (command.tui === false) writeJson(stdout, result);
        else stdout(`Run ${result.runId} completed for ${result.ticker}\n`);
      } catch (err) {
        view?.unmount();
        throw err;
      }
    });

  program
    .command('replay')
    .description('Replay a saved run artifact by run id or file path')
    .argument('<run-id-or-path>', 'Run id under results/runs or path to a JSON artifact')
    .option('--no-tui', 'Do not render the Ink replay view')
    .option('--json', 'Print replay artifact and derived state as JSON')
    .action(async (runIdOrPath: string, command: ReplayCommandOptions) => {
      const fabric = createTradingFabric({ env });
      const replay = await fabric.replay({ runIdOrPath });
      if (command.json) {
        writeJson(stdout, replay);
        return;
      }
      if (command.tui !== false) {
        const view = renderTradingFabricTui({ state: replay.state });
        view.unmount();
      }
      stdout(`Replayed ${replay.artifact.runId} from ${replay.filePath}\n`);
    });

  program
    .command('approve')
    .description('Resolve a pending file-backed approval')
    .argument('<approval-id>', 'Approval id')
    .option('--deny', 'Deny instead of approve')
    .option('--reason <reason>', 'Decision reason')
    .option('--dir <dir>', 'Approval inbox directory')
    .option('--json', 'Print the approval record as JSON')
    .action(async (approvalId: string, command: ApproveCommandOptions) => {
      const config = resolveConfig({}, env);
      const queue = new FileApprovalQueue({ dir: command.dir ?? defaultApprovalDir(config) });
      const record = await queue.decide(
        approvalId,
        command.deny ? 'denied' : 'approved',
        command.reason,
      );
      if (command.json) writeJson(stdout, record);
      else stdout(`Approval ${record.id} ${record.status}\n`);
    });

  const memory = program.command('memory').description('Inspect trading-fabric memory');
  memory
    .command('show')
    .description('Show reflections and pending outcomes for a ticker')
    .argument('<ticker>', 'Ticker symbol')
    .option('--memory-path <path>', 'Memory JSONL path')
    .option('--json', 'Print memory entries as JSON')
    .action(async (ticker: string, command: MemoryShowOptions) => {
      const config = resolveConfig({}, env);
      const log = new TradingMemoryLog({
        store: new FileMemoryStore(command.memoryPath ?? config.memory_log_path),
        maxEntries: config.memory_log_max_entries,
      });
      const symbol = ticker.toUpperCase();
      const entries = (await log.loadAll()).filter((entry) => entry.ticker === symbol);
      const payload = {
        ticker: symbol,
        total: entries.length,
        pending: entries.filter((entry) => entry.status === 'pending').length,
        resolved: entries.filter((entry) => entry.status === 'resolved').length,
        entries,
      };
      if (command.json) writeJson(stdout, payload);
      else stdout(renderMemorySummary(payload));
    });

  const policy = program.command('policy').description('Inspect and validate policy files');
  policy
    .command('validate')
    .description('Validate a JSON or simple YAML policy file')
    .argument('<file>', 'Policy config path')
    .option('--json', 'Print validation result as JSON')
    .action(async (file: string, command: JsonOption) => {
      const config = resolveConfig({}, env);
      const text = await fs.readFile(file, 'utf8');
      const parsed = parsePolicyConfigText(text);
      const result = validatePolicyConfig(config, parsed);
      if (!result.ok) process.exitCode = 1;
      if (command.json) writeJson(stdout, result);
      else stdout(renderPolicyValidation(result));
    });

  const evalCommand = program.command('eval').description('Run trading-fabric eval suites');
  evalCommand
    .command('run')
    .description('Run an eval suite: structured-output | policy | stateful | all')
    .argument('<suite>', 'Eval suite id')
    .option('--live', 'Use configured live model providers instead of deterministic replay fixtures')
    .option('--provider <name>', 'LLM provider override')
    .option('--json', 'Print eval report as JSON')
    .action(async (suite: TradingEvalSuiteId, command: EvalRunOptions) => {
      const provider = parseProvider(command.provider);
      const config = resolveConfig(
        provider ? { llm_provider: provider } : {},
        env,
      );
      const runtimeOptions = command.live
        ? createDefaultRuntimeOptions({ config, env })
        : undefined;
      const report = await runTradingEvalSuite({ suite, config, runtimeOptions });
      if (!report.passed) process.exitCode = 1;
      if (command.json) writeJson(stdout, report);
      else stdout(renderEvalReport(report));
    });

  return program;
}

function parseProvider(raw: string | undefined): LLMProviderKey | undefined {
  if (!raw) return undefined;
  for (const provider of PROVIDER_KEYS) {
    if (provider === raw) return provider;
  }
  throw new Error(`Unknown provider '${raw}'. Expected one of: ${PROVIDER_KEYS.join(', ')}`);
}

function parseAnalysts(raw: string | undefined): Array<'market' | 'social' | 'news' | 'fundamentals'> | undefined {
  if (!raw) return undefined;
  const allowed = new Set(['market', 'social', 'news', 'fundamentals']);
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is 'market' | 'social' | 'news' | 'fundamentals' => allowed.has(entry));
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function renderMemorySummary(payload: {
  ticker: string;
  total: number;
  pending: number;
  resolved: number;
}): string {
  return [
    `Memory for ${payload.ticker}`,
    `Total: ${payload.total}`,
    `Pending: ${payload.pending}`,
    `Resolved: ${payload.resolved}`,
  ].join('\n') + '\n';
}

function renderPolicyValidation(result: ReturnType<typeof validatePolicyConfig>): string {
  const lines = [`Policy validation: ${result.ok ? 'passed' : 'failed'}`];
  for (const check of result.checks) {
    lines.push(`${check.passed ? 'PASS' : 'FAIL'} ${check.id}: ${check.decision}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderEvalReport(report: Awaited<ReturnType<typeof runTradingEvalSuite>>): string {
  const lines = [
    `Eval suite: ${report.suite}`,
    `Status: ${report.passed ? 'passed' : 'failed'}`,
    `Cases: ${report.total}`,
    `Failed: ${report.failed}`,
  ];
  for (const entry of report.cases) {
    lines.push(`${entry.status.toUpperCase()} ${entry.id}`);
  }
  return `${lines.join('\n')}\n`;
}

// Only auto-run when invoked as a script (so tests can import buildProgram).
const isMain =
  typeof require !== 'undefined' && require.main === module
    ? true
    : import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  buildProgram().parseAsync(process.argv).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
