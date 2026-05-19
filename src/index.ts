/**
 * @veridex/trading-fabric — public entry.
 *
 * Public composition root for trading-fabric. The factory keeps I/O at
 * the edges: callers may inject providers/stores for tests, while the CLI
 * can opt into file-backed memory, approvals, run artifacts, and paper
 * execution ledgers.
 */

import type { RuntimeOptions, ToolContract } from '@veridex/agents';

import type { TradingAgentSet } from './agents';
import {
  DEFAULT_CONFIG,
  resolveConfig,
  type TradingFabricConfig,
} from './config/index.js';
import type { DataflowClient } from './dataflows';
import type { ExecutionProvider } from './execution';
import {
  runTradingEvalSuite,
  type RunTradingEvalSuiteOptions,
  type TradingEvalRunReport,
} from './evals';
import type { TradingMemoryLog } from './memory';
import {
  Orchestrator,
  type OrchestrationEvent,
  type RunInput,
} from './orchestration';
import type { HumanApprovalQueue, PolicyEngine, PolicyContext } from './policy';
import { createRuntimeComposition } from './runtime';
import {
  createRunArtifact,
  loadRunArtifact,
  replayRunArtifact,
  writeRunArtifact,
  writeRunReports,
  type LoadedRunArtifact,
  type ReplayResult,
} from './replay';
import type { TradingFabricRunInput, TradingFabricRunResult } from './types/index.js';

export const VERSION = '0.1.0';

export * from './types/index.js';
export * from './config/index.js';
export * as schemas from './schemas/index.js';
export * as orchestration from './orchestration/index.js';
export * as memory from './memory/index.js';
export * as policy from './policy/index.js';
export * as execution from './execution/index.js';
export * as runtime from './runtime.js';
export * as replay from './replay/index.js';
export * as evals from './evals/index.js';
export * as tui from './tui/index.js';

export interface CreateTradingFabricOptions {
  config?: Partial<TradingFabricConfig>;
  env?: NodeJS.ProcessEnv;
  runtimeOptions?: RuntimeOptions;
  dataflowClient?: DataflowClient;
  tools?: ToolContract[];
  agents?: TradingAgentSet;
  memory?: TradingMemoryLog | null;
  policy?: PolicyEngine | null;
  approvals?: HumanApprovalQueue | null;
  executor?: ExecutionProvider | null;
  simulationExecutor?: ExecutionProvider | null;
  policyContext?: (input: RunInput) => PolicyContext | Promise<PolicyContext>;
  onEvent?: (event: OrchestrationEvent) => void;
  persistRuns?: boolean;
}

export interface TradingFabricReplayInput {
  runIdOrPath: string;
}

export interface TradingFabric {
  readonly config: TradingFabricConfig;
  /**
   * Execute the full analyst → debate → trader → risk → portfolio-manager
   * pipeline. When `persistRuns` is enabled, the emitted orchestration
   * events and final result are written as a replay artifact.
   */
  run(input: TradingFabricRunInput): Promise<TradingFabricRunResult>;
  replay(input: TradingFabricReplayInput): Promise<ReplayResult & LoadedRunArtifact>;
  runEval(input: Omit<RunTradingEvalSuiteOptions, 'config'>): Promise<TradingEvalRunReport>;
}

/**
 * Construct a TradingFabric instance with merged configuration.
 */
export function createTradingFabric(
  options: CreateTradingFabricOptions = {},
): TradingFabric {
  const config = resolveConfig(options.config ?? {}, options.env);
  const env = options.env ?? process.env;

  return {
    config,
    async run(input) {
      const trade_date = input.trade_date ?? new Date().toISOString().slice(0, 10);
      const analysts = input.analysts ?? config.selected_analysts;
      const asset_type = input.asset_type ?? config.default_asset_type;

      if (analysts.length === 0 && !options.runtimeOptions && !options.agents) {
        return emptyRunResult({ ...input, trade_date, asset_type, analysts });
      }

      const runConfig: TradingFabricConfig = {
        ...config,
        selected_analysts: analysts,
        default_asset_type: asset_type,
      };
      const events: OrchestrationEvent[] = [];
      const composition = createRuntimeComposition({
        config: runConfig,
        env,
        runtimeOptions: options.runtimeOptions,
        dataflowClient: options.dataflowClient,
        tools: options.tools,
        agents: options.agents,
        memory: options.memory,
        policy: options.policy,
        approvals: options.approvals,
        executor: options.executor,
        simulationExecutor: options.simulationExecutor,
      });

      const orchestrator = new Orchestrator({
        agents: composition.agents,
        config: runConfig,
        runtimeOptions: composition.runtimeOptions,
        memory: composition.memory ?? undefined,
        policy: composition.policy ?? undefined,
        approvals: composition.approvals ?? undefined,
        executor: composition.executor ?? undefined,
        simulationExecutor: composition.simulationExecutor ?? undefined,
        policyContext: options.policyContext,
        onEvent: (event) => {
          events.push(event);
          options.onEvent?.(event);
        },
      });

      const result = await orchestrator.run({
        ticker: input.ticker,
        trade_date,
        asset_type,
        past_context: input.past_context,
      }).catch(async (err) => {
        // Persist a partial artifact on failure so the captured events
        // (analyst reports, debate turns, etc.) survive process exit and
        // can be inspected via `trading-fabric replay <runId>` or by
        // opening the JSON file directly.
        if (options.persistRuns) {
          const reports = events
            .filter((e): e is Extract<OrchestrationEvent, { type: 'analyst_completed' }> =>
              e.type === 'analyst_completed',
            )
            .map((e) => e.report);
          const runStarted = events.find(
            (e): e is Extract<OrchestrationEvent, { type: 'run_started' }> =>
              e.type === 'run_started',
          );
          const partial: TradingFabricRunResult = {
            ...emptyRunResult({ ...input, trade_date, asset_type, analysts }),
            ...(runStarted ? { runId: runStarted.runId } : {}),
            reports,
            error: err instanceof Error ? err.message : String(err),
          };
          try {
            const artifact = createRunArtifact({
              version: VERSION,
              input,
              result: partial,
              events,
            });
            await writeRunArtifact({ config: runConfig, artifact });
            // Best-effort: human-readable per-run markdown folder.
            try {
              await writeRunReports({ config: runConfig, artifact });
            } catch {
              /* persistence is best-effort on the failure path */
            }
          } catch {
            // Persistence is best-effort on the failure path.
          }
        }
        throw err;
      });

      if (options.persistRuns) {
        const artifact = createRunArtifact({ version: VERSION, input, result, events });
        await writeRunArtifact({ config: runConfig, artifact });
        await writeRunReports({ config: runConfig, artifact });
      }
      return result;
    },
    async replay(input) {
      const loaded = await loadRunArtifact({ config, runIdOrPath: input.runIdOrPath });
      return { ...loaded, ...replayRunArtifact(loaded.artifact) };
    },
    runEval(input) {
      return runTradingEvalSuite({ ...input, config });
    },
  };
}

export { DEFAULT_CONFIG };

function emptyRunResult(input: Required<Pick<TradingFabricRunInput, 'ticker' | 'trade_date' | 'asset_type' | 'analysts'>>): TradingFabricRunResult {
  return {
    runId: `run_${Date.now()}`,
    ticker: input.ticker,
    trade_date: input.trade_date,
    asset_type: input.asset_type,
    analysts: input.analysts,
    reports: [],
    research_plan: '',
    trader_proposal: '',
    risk_debate: [],
    portfolio_decision: '',
    execution: null,
    durationMs: 0,
  };
}
