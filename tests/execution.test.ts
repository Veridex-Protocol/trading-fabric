/**
 * Phase 8 execution tests.
 *
 * Tests are intentionally staged so failures isolate cleanly:
 *  - Stage 1: pure helpers + paper simulation provider.
 *  - Stage 2: Veridex provider with mocked SDK/session key surface.
 *  - Stage 3: orchestrator execution gate.
 *  - Stage 4: env-gated live Base Sepolia integration.
 */

import { describe, expect, test } from 'vitest';
import type {
  ModelMessage,
  ModelProvider,
  ModelResponse,
} from '@veridex/agents';

import { createTradingAgents } from '../src/agents';
import { DEFAULT_CONFIG, type TradingFabricConfig } from '../src/config';
import type { DataflowClient } from '../src/dataflows';
import {
  PaperExecutionProvider,
  VeridexExecutionProvider,
  type ExecutionProvider,
  usdToBaseUnits,
  type ExecutionRequest,
  type VeridexRelayerLike,
  type VeridexRelayerSubmitRequest,
  type VeridexSDKLike,
  type VeridexSessionAction,
  type VeridexSessionManagerLike,
  type VeridexTransferParams,
} from '../src/execution';
import { Orchestrator, type OrchestrationEvent } from '../src/orchestration';
import { PolicyEngine, type PolicyContext } from '../src/policy';
import { createDataflowTools } from '../src/tools';

const liveBaseSepoliaTest =
  process.env.TRADING_FABRIC_LIVE_BASE_SEPOLIA === 'true' ? test : test.skip;

const baseRequest: ExecutionRequest = {
  decisionId: 'decision-1',
  runId: 'run-1',
  ticker: 'AAPL',
  trade_date: '2026-05-19',
  rating: 'Buy',
  action: 'Buy',
  amountUsd: 25,
  policyVerdicts: [
    {
      ruleId: 'test-rule',
      decision: 'allow',
      reason: 'unit test approval',
    },
  ],
  traceId: 'trace-1',
};

type Role =
  | 'market'
  | 'social'
  | 'news'
  | 'fundamentals'
  | 'bull'
  | 'bear'
  | 'research-manager'
  | 'trader'
  | 'aggressive'
  | 'neutral'
  | 'conservative'
  | 'portfolio-manager';

function classify(systemPrompt: string): Role {
  if (systemPrompt.includes('select the **most relevant indicators**')) return 'market';
  if (systemPrompt.includes('financial market sentiment analyst')) return 'social';
  if (systemPrompt.includes('news researcher tasked with analyzing recent news')) return 'news';
  if (systemPrompt.includes('analyzing fundamental information over the past week')) {
    return 'fundamentals';
  }
  if (systemPrompt.includes('Bull Analyst advocating')) return 'bull';
  if (systemPrompt.includes('Bear Analyst making the case')) return 'bear';
  if (systemPrompt.includes('Research Manager and debate facilitator')) return 'research-manager';
  if (systemPrompt.includes('trading agent analyzing market data')) return 'trader';
  if (systemPrompt.includes('Aggressive Risk Analyst')) return 'aggressive';
  if (systemPrompt.includes('Conservative Risk Analyst')) return 'conservative';
  if (systemPrompt.includes('Neutral Risk Analyst')) return 'neutral';
  if (systemPrompt.includes('Portfolio Manager')) return 'portfolio-manager';
  throw new Error(`Could not classify system prompt:\n${systemPrompt.slice(0, 200)}`);
}

function cannedFor(role: Role): string {
  switch (role) {
    case 'market':
      return '# Market\nRSI 65; MACD bullish crossover.';
    case 'social':
      return '# Sentiment\nMildly bullish.';
    case 'news':
      return '# News\nNo material headlines.';
    case 'fundamentals':
      return '# Fundamentals\nStable.';
    case 'bull':
      return 'Upside thesis intact.';
    case 'bear':
      return 'Margin compression risk.';
    case 'research-manager':
      return JSON.stringify({
        recommendation: 'Buy',
        rationale: 'Bull case wins.',
        strategic_actions: 'Phased entry.',
      });
    case 'trader':
      return JSON.stringify({
        action: 'Buy',
        reasoning: 'Plan constructive.',
        entry_price: 100,
        stop_loss: 95,
        position_sizing: '5%',
      });
    case 'aggressive':
      return 'Take the trade.';
    case 'neutral':
      return 'Phased entry is prudent.';
    case 'conservative':
      return 'Risk is elevated.';
    case 'portfolio-manager':
      return JSON.stringify({
        rating: 'Buy',
        executive_summary: 'Phased entry plan.',
        investment_thesis: 'Bull thesis grounded in analyst evidence.',
        price_target: 120,
        time_horizon: '3 months',
      });
  }
}

function makeProvider(name: string): ModelProvider {
  return {
    name,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const role = classify(system);
      return {
        content: cannedFor(role),
        model: `scripted-${role}`,
        provider: name,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

function mockClient(): DataflowClient {
  const stub = () => async () => 'mock';
  return {
    availableVendors: ['yfinance'],
    getStockData: stub(),
    getIndicators: stub(),
    getFundamentals: stub(),
    getBalanceSheet: stub(),
    getCashflow: stub(),
    getIncomeStatement: stub(),
    getInsiderTransactions: stub(),
    getNews: stub(),
    getGlobalNews: stub(),
    getRedditPosts: stub(),
    getStocktwitsMessages: stub(),
  } as unknown as DataflowClient;
}

function buildOrchestrator(opts: {
  config?: Partial<TradingFabricConfig>;
  executor?: ExecutionProvider;
  simulationExecutor?: ExecutionProvider;
  policy?: PolicyEngine;
  policyContext?: () => PolicyContext;
}) {
  const config: TradingFabricConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const tools = createDataflowTools({ client: mockClient() });
  const agents = createTradingAgents({ config, tools });
  const events: OrchestrationEvent[] = [];
  const policy =
    opts.policy ??
    new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 100,
        max_position_usd: 25,
        instrument_allowlist: [],
      },
    });

  return {
    events,
    orchestrator: new Orchestrator({
      agents,
      config,
      runtimeOptions: {
        modelProviders: {
          quick: makeProvider(config.llm_provider),
          deep: makeProvider(`${config.llm_provider}:deep`),
        },
        enableTracing: false,
      },
      policy,
      policyContext: opts.policyContext,
      executor: opts.executor,
      simulationExecutor: opts.simulationExecutor,
      onEvent: (event) => events.push(event),
    }),
  };
}

describe('Stage 1: execution units', () => {
  test('usdToBaseUnits converts USD to USDC base units', () => {
    expect(usdToBaseUnits(50, 6)).toBe(50_000_000n);
    expect(usdToBaseUnits(0.25, 6)).toBe(250_000n);
    expect(usdToBaseUnits(0.0000009, 6)).toBe(0n);
  });

  test('PaperExecutionProvider fills buys and writes an audit envelope', async () => {
    const paper = new PaperExecutionProvider({
      startingCashUsd: 100,
      pricer: () => 10,
      txHashFactory: () => 'paper-fixed',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });

    const envelope = await paper.execute(baseRequest);

    expect(envelope.provider).toBe('paper');
    expect(envelope.surface).toBe('simulation');
    expect(envelope.status).toBe('filled');
    expect(envelope.txHash).toBe('paper-fixed');
    expect(envelope.signedAction).toBeNull();
    expect(envelope.policyVerdicts).toHaveLength(1);
    expect(paper.getCash()).toBe(75);
    expect(paper.getPosition('AAPL')?.qty).toBe(2.5);
    expect(paper.ledger).toHaveLength(1);
    expect(paper.ledger[0]?.envelope.decisionId).toBe('decision-1');
  });

  test('PaperExecutionProvider skips Hold without spending cash', async () => {
    const paper = new PaperExecutionProvider({
      startingCashUsd: 100,
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });

    const envelope = await paper.execute({
      ...baseRequest,
      rating: 'Hold',
      action: 'Hold',
      amountUsd: 0,
    });

    expect(envelope.status).toBe('skipped');
    expect(envelope.metadata).toEqual({ reason: 'hold' });
    expect(paper.getCash()).toBe(100);
    expect(paper.getPosition('AAPL')).toBeNull();
  });
});

describe('Stage 2: Veridex provider with mocked session-key SDK', () => {
  test('BUY creates/signs with a user session key and relays into the paper vault', async () => {
    const payloadCalls: VeridexTransferParams[] = [];
    const signedActions: VeridexSessionAction[] = [];
    const relayerRequests: VeridexRelayerSubmitRequest[] = [];
    const sdk: VeridexSDKLike = {
      async buildTransferPayload(params) {
        payloadCalls.push(params);
        return '0x1234';
      },
      async getNonce() {
        return 7n;
      },
    };
    const createdSessions: Array<{ maxValue: bigint; duration: number }> = [];
    const sessionManager: VeridexSessionManagerLike = {
      getActiveSession: async () => null,
      async createSession(config) {
        createdSessions.push(config);
        return { keyHash: 'session-user', expiresAt: 1_779_216_000, maxValue: config.maxValue };
      },
      async signAction(action) {
        signedActions.push(action);
        return {
          action,
          signature: { sessionKeyHash: 'session-user', signature: '0xsig' },
          readyToSubmit: true,
        };
      },
    };
    const relayer: VeridexRelayerLike = {
      async submitSignedAction(request) {
        relayerRequests.push(request);
        return { success: true, txHash: '0xbuy', sequence: 7n };
      },
    };

    const provider = new VeridexExecutionProvider({
      sdk,
      sessionManager,
      relayer,
      usdcAddress: '0xmockusdc',
      targetChainId: 30,
      paperRecipientVault: '0xpaper',
      sellRecipientVault: '0xuser',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });

    const envelope = await provider.execute(baseRequest);

    expect(createdSessions).toEqual([{ maxValue: 50_000_000n, duration: 86_400 }]);
    expect(payloadCalls).toEqual([
      {
        targetChain: 30,
        token: '0xmockusdc',
        recipient: '0xpaper',
        amount: 25_000_000n,
      },
    ]);
    expect(signedActions).toEqual([
      {
        action: 'transfer',
        targetChain: 30,
        value: 25_000_000n,
        payload: new Uint8Array([0x12, 0x34]),
        nonce: 7,
      },
    ]);
    expect(relayerRequests).toEqual([
      {
        action: 'transfer',
        targetChain: 30,
        value: '25000000',
        payload: '0x1234',
        nonce: 7,
        signature: { sessionKeyHash: 'session-user', signature: '0xsig' },
      },
    ]);
    expect(envelope.provider).toBe('veridex');
    expect(envelope.surface).toBe('testnet');
    expect(envelope.status).toBe('filled');
    expect(envelope.txHash).toBe('0xbuy');
    expect(envelope.signedAction).toContain('session-user');
    expect(envelope.metadata).toMatchObject({
      direction: 'user_vault_to_paper_vault',
      executionMode: 'session',
      session: {
        keyHash: 'session-user',
        expiresAt: 1_779_216_000,
        maxValue: '50000000',
      },
    });
  });

  test('SELL uses the paper-vault session key and relays mock-USDC back to the user vault', async () => {
    const buyPayloadCalls: VeridexTransferParams[] = [];
    const sellPayloadCalls: VeridexTransferParams[] = [];
    const sellSignedActions: VeridexSessionAction[] = [];
    const sellRelayerRequests: VeridexRelayerSubmitRequest[] = [];
    const buySdk: VeridexSDKLike = {
      async buildTransferPayload(params) {
        buyPayloadCalls.push(params);
        return '0xbuy-payload';
      },
      async getNonce() {
        return 1n;
      },
    };
    const sellSdk: VeridexSDKLike = {
      async buildTransferPayload(params) {
        sellPayloadCalls.push(params);
        return '0xabcd';
      },
      async getNonce() {
        return 9n;
      },
    };
    const sellSessionManager: VeridexSessionManagerLike = {
      getActiveSession: async () => ({ keyHash: 'session-paper', expiresAt: 1_779_216_000 }),
      async signAction(action) {
        sellSignedActions.push(action);
        return {
          action,
          signature: { sessionKeyHash: 'session-paper', signature: '0xsell-sig' },
          readyToSubmit: true,
        };
      },
    };
    const sellRelayer: VeridexRelayerLike = {
      async submitSignedAction(request) {
        sellRelayerRequests.push(request);
        return { success: true, txHash: '0xsell' };
      },
    };

    const provider = new VeridexExecutionProvider({
      sdk: buySdk,
      sellSdk,
      sellSessionManager,
      sellRelayer,
      usdcAddress: '0xmockusdc',
      targetChainId: 30,
      paperRecipientVault: '0xpaper',
      sellRecipientVault: '0xuser',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });

    const envelope = await provider.execute({
      ...baseRequest,
      rating: 'Sell',
      action: 'Sell',
    });

    expect(buyPayloadCalls).toEqual([]);
    expect(sellPayloadCalls).toEqual([
      {
        targetChain: 30,
        token: '0xmockusdc',
        recipient: '0xuser',
        amount: 25_000_000n,
      },
    ]);
    expect(sellSignedActions[0]?.nonce).toBe(9);
    expect(sellRelayerRequests[0]?.signature).toEqual({
      sessionKeyHash: 'session-paper',
      signature: '0xsell-sig',
    });
    expect(envelope.txHash).toBe('0xsell');
    expect(envelope.signedAction).toContain('session-paper');
    expect(envelope.metadata).toMatchObject({
      direction: 'paper_vault_to_user_vault',
      executionMode: 'session',
      session: { keyHash: 'session-paper', expiresAt: 1_779_216_000 },
    });
  });
});

describe('Stage 3: orchestrator execution gate', () => {
  test('execute_enabled=false uses the simulation executor and still returns an envelope', async () => {
    const paper = new PaperExecutionProvider({
      pricer: () => 10,
      txHashFactory: () => 'paper-orchestrator',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });
    const { orchestrator, events } = buildOrchestrator({
      config: { execute_enabled: false },
      simulationExecutor: paper,
    });

    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    expect(result.execution?.provider).toBe('paper');
    expect(result.execution?.surface).toBe('simulation');
    expect(result.execution?.txHash).toBe('paper-orchestrator');
    expect(paper.ledger).toHaveLength(1);
    const started = events.find((event) => event.type === 'execution_started');
    expect(started?.type).toBe('execution_started');
    if (started?.type === 'execution_started') {
      expect(started.request.hints).toEqual({ executionMode: 'simulation' });
    }
  });

  test('execute_enabled=true uses the Veridex executor', async () => {
    const relayerCalls: VeridexRelayerSubmitRequest[] = [];
    const sdk: VeridexSDKLike = {
      async buildTransferPayload() {
        return '0x99';
      },
      async getNonce() {
        return 11n;
      },
    };
    const relayer: VeridexRelayerLike = {
      async submitSignedAction(request) {
        relayerCalls.push(request);
        return { success: true, txHash: '0xrelayed' };
      },
    };
    const executor = new VeridexExecutionProvider({
      sdk,
      sessionManager: {
        getActiveSession: async () => ({ keyHash: 'session-runtime', expiresAt: 1_779_216_000 }),
        async signAction(action) {
          return {
            action,
            signature: { sessionKeyHash: 'session-runtime', signature: '0xruntime-sig' },
            readyToSubmit: true,
          };
        },
      },
      relayer,
      usdcAddress: '0xmockusdc',
      targetChainId: 30,
      paperRecipientVault: '0xpaper',
      sellRecipientVault: '0xuser',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });
    const { orchestrator, events } = buildOrchestrator({
      config: { execute_enabled: true },
      executor,
      simulationExecutor: new PaperExecutionProvider(),
    });

    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    expect(relayerCalls).toHaveLength(1);
    expect(result.execution?.provider).toBe('veridex');
    expect(result.execution?.txHash).toBe('0xrelayed');
    expect(result.execution?.signedAction).toContain('session-runtime');
    const started = events.find((event) => event.type === 'execution_started');
    expect(started?.type).toBe('execution_started');
    if (started?.type === 'execution_started') {
      expect(started.request.hints).toEqual({ executionMode: 'real' });
    }
  });

  test('policy denial prevents execution even when executors are configured', async () => {
    const relayerCalls: VeridexTransferParams[] = [];
    const sdk: VeridexSDKLike = {
      async transferViaRelayer(params) {
        relayerCalls.push(params);
        return { transactionHash: '0xshould-not-send' };
      },
    };
    const executor = new VeridexExecutionProvider({
      sdk,
      usdcAddress: '0xmockusdc',
      targetChainId: 30,
      paperRecipientVault: '0xpaper',
      sellRecipientVault: '0xuser',
    });
    const paper = new PaperExecutionProvider();
    const policy = new PolicyEngine({
      limits: {
        daily_spend_cap_usd: 100,
        max_position_usd: 25,
        instrument_allowlist: ['MSFT'],
      },
    });
    const { orchestrator, events } = buildOrchestrator({
      config: { execute_enabled: true },
      executor,
      simulationExecutor: paper,
      policy,
    });

    const result = await orchestrator.run({ ticker: 'AAPL', trade_date: '2026-05-19' });

    expect(result.policy_decision?.decision).toBe('deny');
    expect(result.execution).toBeNull();
    expect(relayerCalls).toEqual([]);
    expect(paper.ledger).toHaveLength(0);
    const skipped = events.find((event) => event.type === 'execution_skipped');
    expect(skipped?.type).toBe('execution_skipped');
    if (skipped?.type === 'execution_skipped') {
      expect(skipped.reason).toBe('policy_denied');
    }
  });
});

describe('Stage 4: env-gated Base Sepolia integration', () => {
  liveBaseSepoliaTest('executes through a caller-provided live Veridex bootstrap', async () => {
    const bootstrapModule = process.env.TRADING_FABRIC_LIVE_EXECUTOR_MODULE;
    if (!bootstrapModule) {
      throw new Error(
        'Set TRADING_FABRIC_LIVE_EXECUTOR_MODULE to a module exporting createLiveVeridexExecutor()',
      );
    }
    const imported = await import(bootstrapModule);
    const bootstrap = asLiveBootstrap(imported);
    const executor = await bootstrap.createLiveVeridexExecutor({
      chain: 'base',
      network: 'testnet',
      sessionDurationSeconds: 86_400,
      sessionMaxValueUsd: 50,
    });

    const amountUsd = Number(process.env.TRADING_FABRIC_LIVE_AMOUNT_USD ?? '0.01');
    const envelope = await executor.execute({
      ...baseRequest,
      decisionId: `live-${Date.now()}`,
      runId: `live-run-${Date.now()}`,
      amountUsd,
    });

    expect(envelope.provider).toBe('veridex');
    expect(envelope.surface).toBe('testnet');
    expect(envelope.status).toBe('filled');
    expect(envelope.txHash).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(envelope.signedAction).toContain('session');
  });
});

interface LiveBootstrapModule {
  createLiveVeridexExecutor(input: {
    chain: 'base';
    network: 'testnet';
    sessionDurationSeconds: number;
    sessionMaxValueUsd: number;
  }): Promise<ExecutionProvider>;
}

function asLiveBootstrap(moduleExports: unknown): LiveBootstrapModule {
  if (
    moduleExports &&
    typeof moduleExports === 'object' &&
    'createLiveVeridexExecutor' in moduleExports &&
    typeof moduleExports.createLiveVeridexExecutor === 'function'
  ) {
    return moduleExports as LiveBootstrapModule;
  }
  throw new Error('Live bootstrap module must export createLiveVeridexExecutor()');
}