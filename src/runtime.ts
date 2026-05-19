import * as path from 'node:path';

import type { ModelProvider, RuntimeOptions, ToolContract } from '@veridex/agents';

import { createTradingAgents, type TradingAgentSet } from './agents';
import type { TradingFabricConfig } from './config';
import { createDataflowClient, type DataflowClient } from './dataflows';
import { PaperExecutionProvider, type ExecutionProvider } from './execution';
import { createProvider } from './llm';
import { TradingMemoryLog } from './memory/log';
import { FileMemoryStore, expandHome } from './memory/store';
import { FileApprovalQueue, type HumanApprovalQueue } from './policy/approvals';
import { PolicyEngine } from './policy/engine';
import type { PolicyContext } from './policy/types';
import { createDataflowTools } from './tools';

export interface RuntimeCompositionOptions {
  config: TradingFabricConfig;
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
}

export interface RuntimeComposition {
  runtimeOptions: RuntimeOptions;
  dataflowClient: DataflowClient;
  tools: ToolContract[];
  agents: TradingAgentSet;
  memory: TradingMemoryLog | null;
  policy: PolicyEngine | null;
  approvals: HumanApprovalQueue | null;
  executor: ExecutionProvider | null;
  simulationExecutor: ExecutionProvider | null;
}

export function createDefaultRuntimeOptions(args: {
  config: TradingFabricConfig;
  env?: NodeJS.ProcessEnv;
  overrides?: RuntimeOptions;
}): RuntimeOptions {
  if (args.overrides?.modelProviders) return args.overrides;

  const quick = createProvider(args.config.llm_provider, {
    config: args.config,
    model: args.config.quick_think_llm,
    env: args.env,
  });
  const deep = withProviderName(
    createProvider(args.config.llm_provider, {
      config: args.config,
      model: args.config.deep_think_llm,
      env: args.env,
    }),
    `${args.config.llm_provider}:deep`,
  );

  return {
    enableTracing: true,
    ...args.overrides,
    modelProviders: {
      quick,
      deep,
    },
  };
}

export function createRuntimeComposition(
  opts: RuntimeCompositionOptions,
): RuntimeComposition {
  const env = opts.env ?? process.env;
  const runtimeOptions = createDefaultRuntimeOptions({
    config: opts.config,
    env,
    overrides: opts.runtimeOptions,
  });
  const dataflowClient =
    opts.dataflowClient ?? createDataflowClient({ config: opts.config, env });
  const tools = opts.tools ?? createDataflowTools({ client: dataflowClient });
  const agents = opts.agents ?? createTradingAgents({ config: opts.config, tools });
  const memory =
    opts.memory === undefined
      ? new TradingMemoryLog({
          store: new FileMemoryStore(opts.config.memory_log_path),
          maxEntries: opts.config.memory_log_max_entries,
        })
      : opts.memory;
  const policy =
    opts.policy === undefined
      ? new PolicyEngine({ limits: policyLimitsFromConfig(opts.config) })
      : opts.policy;
  const approvals =
    opts.approvals === undefined
      ? new FileApprovalQueue({ dir: defaultApprovalDir(opts.config) })
      : opts.approvals;
  const simulationExecutor =
    opts.simulationExecutor === undefined
      ? new PaperExecutionProvider({ ledgerPath: defaultPaperLedgerPath(opts.config) })
      : opts.simulationExecutor;

  return {
    runtimeOptions,
    dataflowClient,
    tools,
    agents,
    memory,
    policy,
    approvals,
    executor: opts.executor ?? null,
    simulationExecutor,
  };
}

export function policyLimitsFromConfig(config: TradingFabricConfig) {
  return {
    daily_spend_cap_usd: config.daily_spend_cap_usd,
    max_position_usd: config.max_position_usd,
    instrument_allowlist: config.instrument_allowlist,
  };
}

export function defaultPolicyContext(): PolicyContext {
  return {
    dailySpendUsd: 0,
    lastTradeAt: null,
    lastAlphaReturn: null,
    now: () => new Date(),
  };
}

export function defaultApprovalDir(config: TradingFabricConfig): string {
  return path.join(expandHome(config.data_dir), 'approvals');
}

export function defaultPaperLedgerPath(config: TradingFabricConfig): string {
  return path.join(expandHome(config.results_dir), 'paper-ledger.jsonl');
}

function withProviderName(provider: ModelProvider, name: string): ModelProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'name') return name;
      return Reflect.get(target, prop, receiver);
    },
  });
}
