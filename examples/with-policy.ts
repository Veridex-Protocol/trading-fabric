import { createTradingFabric } from '@veridex/trading-fabric';

const fabric = createTradingFabric({
  config: {
    execute_enabled: false,
    daily_spend_cap_usd: 20,
    max_position_usd: 25,
    instrument_allowlist: ['AAPL', 'SPY', 'BTC-USD'],
  },
  policyContext: () => ({
    dailySpendUsd: Number(process.env.TRADING_FABRIC_DAILY_SPEND_USED_USD ?? 0),
    lastTradeAt: process.env.TRADING_FABRIC_LAST_TRADE_AT
      ? new Date(process.env.TRADING_FABRIC_LAST_TRADE_AT)
      : null,
    lastAlphaReturn: process.env.TRADING_FABRIC_LAST_ALPHA_RETURN
      ? Number(process.env.TRADING_FABRIC_LAST_ALPHA_RETURN)
      : null,
    now: () => new Date(),
  }),
});

const result = await fabric.run({
  ticker: process.argv[2] ?? 'AAPL',
  trade_date: process.argv[3] ?? new Date().toISOString().slice(0, 10),
});

console.log(JSON.stringify({
  runId: result.runId,
  proposal: result.proposal,
  policy: result.policy_decision,
  approval: result.approval,
  execution: result.execution,
}, null, 2));
