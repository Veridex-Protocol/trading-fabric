import { createTradingFabric } from '@veridex/trading-fabric';

const ticker = process.argv[2] ?? 'SPY';
const tradeDate = process.argv[3] ?? new Date().toISOString().slice(0, 10);

const fabric = createTradingFabric({
  config: {
    llm_provider: 'openai',
    execute_enabled: false,
    max_position_usd: 25,
    daily_spend_cap_usd: 50,
  },
});

const result = await fabric.run({
  ticker,
  trade_date: tradeDate,
  asset_type: ticker.includes('-') ? 'crypto' : 'stock',
});

console.log(JSON.stringify({
  runId: result.runId,
  ticker: result.ticker,
  tradeDate: result.trade_date,
  decision: result.portfolio_decision,
  policy: result.policy_decision?.decision ?? null,
  execution: result.execution?.status ?? null,
}, null, 2));
