import { describe, expect, test } from 'vitest';

import {
  runStructuredOutputSmoke,
  runTradingEvalSuite,
} from '../src/evals/index.js';

describe('Phase 11 eval suites', () => {
  test('structured-output smoke mirrors the TradingAgents smoke path with replay fixtures', async () => {
    const smoke = await runStructuredOutputSmoke();

    expect(smoke.passed).toBe(true);
    expect(smoke.rendered.researchPlan).toContain('**Recommendation**:');
    expect(smoke.rendered.traderProposal).toContain('FINAL TRANSACTION PROPOSAL:');
    expect(smoke.rendered.portfolioDecision).toContain('**Investment Thesis**:');
    expect(smoke.comparison.reference).toContain('smoke_structured_output.py');
    expect(smoke.comparison.tradingFabric).toContain('@veridex/agents');
  });

  test('all suite aggregates policy, stateful memory, and structured-output cases', async () => {
    const report = await runTradingEvalSuite({ suite: 'all' });

    expect(report.passed).toBe(true);
    expect(report.total).toBeGreaterThanOrEqual(3);
    expect(report.cases.map((entry) => entry.suite)).toContain('policy');
    expect(report.cases.map((entry) => entry.suite)).toContain('stateful');
    expect(report.cases.map((entry) => entry.suite)).toContain('structured-output');
    expect(report.stateful?.failed).toBe(0);
    expect(report.stateful?.passed).toBe(report.stateful?.total);
  });
});
