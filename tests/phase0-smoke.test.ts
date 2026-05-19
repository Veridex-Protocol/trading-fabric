import { describe, expect, it } from 'vitest';

import {
  createTradingFabric,
  DEFAULT_CONFIG,
  resolveConfig,
  VERSION,
} from '../src/index.js';
import {
  PortfolioDecision,
  ResearchPlan,
  TraderProposal,
  renderPortfolioDecision,
  renderResearchPlan,
  renderTraderProposal,
} from '../src/schemas/index.js';

describe('trading-fabric phase 0 smoke', () => {
  it('exports a semver version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves config with defaults when no overrides given', () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.llm_provider).toBe(DEFAULT_CONFIG.llm_provider);
    expect(cfg.selected_analysts).toEqual([
      'market',
      'social',
      'news',
      'fundamentals',
    ]);
    expect(cfg.daily_spend_cap_usd).toBe(50);
    expect(cfg.max_position_usd).toBe(25);
    expect(cfg.execute_enabled).toBe(false);
  });

  it('applies env overrides', () => {
    const cfg = resolveConfig(
      {},
      {
        TRADING_FABRIC_LLM_PROVIDER: 'anthropic',
        TRADING_FABRIC_MAX_DEBATE_ROUNDS: '3',
        TRADING_FABRIC_EXECUTE: 'true',
        TRADING_FABRIC_MAX_POSITION_USD: '100',
      } as NodeJS.ProcessEnv,
    );
    expect(cfg.llm_provider).toBe('anthropic');
    expect(cfg.max_debate_rounds).toBe(3);
    expect(cfg.execute_enabled).toBe(true);
    expect(cfg.max_position_usd).toBe(100);
  });

  it('user overrides win over env', () => {
    const cfg = resolveConfig(
      { llm_provider: 'openai' },
      { TRADING_FABRIC_LLM_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv,
    );
    expect(cfg.llm_provider).toBe('openai');
  });

  it('createTradingFabric returns a runnable stub', async () => {
    const fabric = createTradingFabric({
      config: { selected_analysts: [] },
      env: {},
    });
    const result = await fabric.run({ ticker: 'SPY', trade_date: '2025-06-05' });
    expect(result.ticker).toBe('SPY');
    expect(result.trade_date).toBe('2025-06-05');
    expect(result.asset_type).toBe('stock');
    expect(result.reports).toEqual([]);
    expect(result.execution).toBeNull();
  });
});

describe('trading-fabric schemas', () => {
  it('ResearchPlan parses + renders to markdown', () => {
    const plan = ResearchPlan.parse({
      recommendation: 'Buy',
      rationale: 'Bull case won on earnings momentum and guidance.',
      strategic_actions: 'Open a 5% position; trim half at +10%.',
    });
    const md = renderResearchPlan(plan);
    expect(md).toContain('**Recommendation**: Buy');
    expect(md).toContain('**Rationale**:');
    expect(md).toContain('**Strategic Actions**:');
  });

  it('TraderProposal renders FINAL TRANSACTION PROPOSAL trailer', () => {
    const proposal = TraderProposal.parse({
      action: 'Sell',
      reasoning: 'Macro deterioration and breakdown of support.',
      entry_price: null,
      stop_loss: 412.5,
      position_sizing: '3% of portfolio',
    });
    const md = renderTraderProposal(proposal);
    expect(md).toContain('**Action**: Sell');
    expect(md).toContain('**Stop Loss**: 412.5');
    expect(md).toContain('**Position Sizing**: 3% of portfolio');
    expect(md).not.toContain('**Entry Price**');
    expect(md.trim().endsWith('FINAL TRANSACTION PROPOSAL: **SELL**')).toBe(true);
  });

  it('PortfolioDecision renders with optional fields elided', () => {
    const decision = PortfolioDecision.parse({
      rating: 'Overweight',
      executive_summary: 'Take a 7% position with a 6-month horizon.',
      investment_thesis: 'Three of four analysts converged on accelerating fundamentals.',
      price_target: 500,
      time_horizon: '6 months',
    });
    const md = renderPortfolioDecision(decision);
    expect(md).toContain('**Rating**: Overweight');
    expect(md).toContain('**Price Target**: 500');
    expect(md).toContain('**Time Horizon**: 6 months');
  });

  it('PortfolioDecision rejects unknown rating', () => {
    expect(() =>
      PortfolioDecision.parse({
        rating: 'StrongBuy',
        executive_summary: 'x',
        investment_thesis: 'y',
      }),
    ).toThrow();
  });
});
