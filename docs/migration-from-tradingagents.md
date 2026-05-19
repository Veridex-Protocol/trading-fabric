# Migration from TradingAgents

This guide maps the Python TradingAgents workflow to `@veridex/trading-fabric`.

## Mental model

TradingAgents centers on `TradingAgentsGraph.propagate(...)`. `trading-fabric` centers on `createTradingFabric().run(...)`.

```text
TradingAgents main.py
  TradingAgentsGraph(debug=True, config=...)
  graph.propagate(company_name, trade_date)

trading-fabric
  const fabric = createTradingFabric({ config })
  await fabric.run({ ticker, trade_date, asset_type })
```

The agent order is intentionally familiar. The runtime contract is different: `trading-fabric` makes state, events, policy, approval, replay, and execution explicit.

## Concept mapping

| TradingAgents | trading-fabric |
|---|---|
| `tradingagents/default_config.py` | `src/config/index.ts` and `TRADING_FABRIC_*` env vars |
| `TradingAgentsGraph` | `Orchestrator` behind `createTradingFabric()` |
| LangGraph `MessagesState` | typed run input/result plus `OrchestrationEvent[]` |
| Pydantic schemas | Zod schemas in `src/schemas` |
| Analyst tool nodes | Zod tool contracts in `src/tools` |
| Research/risk debates | explicit debate arrays in run result |
| Portfolio Manager final message | `PortfolioDecision` plus policy proposal |
| `memory.md` | `TradingMemoryLog` JSONL store |
| Rich CLI | Ink TUI over event reducer |
| smoke script | `eval run structured-output` with replay fixtures |
| no execution adapter | paper ledger or Veridex session-key executor |

## Command mapping

Reference:

```bash
python -m cli.main
python scripts/smoke_structured_output.py
```

TypeScript package:

```bash
bun run build
node dist/cli/index.js run AAPL --provider openai
node dist/cli/index.js eval run structured-output
node dist/cli/index.js eval run all
```

## Staged migration plan

1. Start with deterministic evals.

   ```bash
   cd trading-fabric
   bun run eval
   ```

2. Run a single-ticker paper decision with JSON output.

   ```bash
   node dist/cli/index.js run SPY --date 2025-06-05 --no-tui
   ```

3. Compare the generated `portfolio_decision` with a known TradingAgents output for the same ticker/date.

4. Enable the TUI once the run shape is accepted.

   ```bash
   node dist/cli/index.js run SPY --date 2025-06-05
   ```

5. Add policy limits and validate them.

   ```bash
   node dist/cli/index.js policy validate ./policy.json
   ```

6. Turn on approval routing for escalations. Keep execution disabled.

7. Enable real testnet execution only after replay artifacts, policy evals, and approval paths are green.

## Porting custom tools

TradingAgents tools usually return strings for the model. In `trading-fabric`, keep the string output but add typed boundaries around inputs and outputs:

```ts
import { tool } from '@veridex/agents';
import { z } from 'zod';

export const getCustomSignal = tool({
  name: 'get_custom_signal',
  description: 'Read-only custom market signal.',
  inputSchema: z.object({ ticker: z.string() }),
  outputSchema: z.string(),
  safetyClass: 'read',
  execute: async ({ ticker }) => `Signal for ${ticker}: neutral`,
});
```

Then pass the tool into `createTradingFabric({ tools: [...] })` or include it in a custom agent factory.

## Porting custom prompts

Agent prompts live in `src/agents/instructions.ts`. Keep the role boundaries intact:

- analysts can call read-only data tools
- researchers consume analyst reports
- managers produce structured Zod outputs
- policy/execution must not be delegated to the model

## Replacing live smoke scripts

The reference `smoke_structured_output.py` calls the Research Manager, Trader, and Portfolio Manager directly against a live provider. `trading-fabric` keeps the same three-stage smoke but runs it through `@veridex/agents` with deterministic replay fixtures by default.

```bash
node dist/cli/index.js eval run structured-output --json
```

Use `--live --provider openai` when intentionally refreshing fixtures or checking provider behavior.

## Acceptance checklist

- `bun run lint` passes.
- `bun run test` passes with live tests skipped by default.
- `bun run build` emits CJS, ESM, and DTS files.
- `bun run eval` exits zero.
- A run artifact appears under `~/.trading-fabric/results/runs` when `persistRuns` or CLI `run` is used.
- Policy validation passes for your production policy file.
- Approval decisions can be resolved from the CLI before any real executor is enabled.
