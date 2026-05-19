# @veridex/trading-fabric

A TypeScript-first multi-agent trading framework built on `@veridex/agents`. It rebuilds the TauricResearch TradingAgents flow with explicit Veridex primitives: typed agents, replayable orchestration events, deterministic evals, policy gates, file-backed human approvals, reflection memory, an Ink TUI, and Veridex session-key execution surfaces.

## 60-second pitch

TradingAgents proved that an analyst debate can be useful: market, social, news, and fundamentals agents produce reports; bull and bear researchers debate; a trader proposes an action; risk agents challenge it; a portfolio manager makes the final call.

`trading-fabric` keeps that product shape but removes the hidden state. Every stage emits typed events. Every final run can be replayed from an artifact. Policy is declarative instead of buried in Python branches. Approvals are explicit suspend/resume records. Execution defaults to a paper ledger and can be switched to Veridex testnet execution with session-key budgets.

## Install

From this workspace:

```bash
bun install --filter @veridex/trading-fabric
cd trading-fabric
bun run build
```

For a published package:

```bash
bun add @veridex/trading-fabric
```

## Quickstart

Run the deterministic eval suite first. It does not require model keys.

```bash
cd trading-fabric
bun run eval
```

Run a simulated trade with JSON output:

```bash
node dist/cli/index.mjs run SPY --date 2025-06-05 --no-tui
```

Run with the Ink TUI:

```bash
node dist/cli/index.mjs run AAPL --provider openai
```

Replay a saved run artifact:

```bash
node dist/cli/index.mjs replay ~/.trading-fabric/results/runs/<run-id>.json
```

Approve a pending escalated decision:

```bash
node dist/cli/index.mjs approve <approval-id> --reason "Within daily treasury budget"
```

Validate a policy file:

```bash
node dist/cli/index.mjs policy validate docs/examples/policy.tight.json
```

## Configuration

The main knobs are available through `TradingFabricConfig` and `TRADING_FABRIC_*` environment variables.

| Setting | Default | Notes |
|---|---:|---|
| `TRADING_FABRIC_LLM_PROVIDER` | `openai` | `openai`, `anthropic`, `google`, `xai`, `deepseek`, `qwen`, `qwen_cn`, `glm`, `glm_cn`, `minimax`, `minimax_cn`, `openrouter`, `ollama`, `azure` |
| `TRADING_FABRIC_DEEP_THINK_LLM` | `gpt-5.4` | Used by Research Manager, Portfolio Manager, and reflection |
| `TRADING_FABRIC_QUICK_THINK_LLM` | `gpt-5.4-mini` | Used by analysts, researchers, trader, and risk agents |
| `TRADING_FABRIC_DATA_DIR` | `~/.trading-fabric/data` | Approval inbox and local state root |
| `TRADING_FABRIC_RESULTS_DIR` | `~/.trading-fabric/results` | Run artifacts and paper ledger |
| `TRADING_FABRIC_DAILY_SPEND_CAP_USD` | `50` | Policy escalation threshold |
| `TRADING_FABRIC_MAX_POSITION_USD` | `25` | Per-trade hard denial threshold |
| `TRADING_FABRIC_EXECUTE` | `false` | `false` writes paper execution envelopes; `true` requires a real executor |

Copy `.env.example` for local runs. Do not commit real keys.

## Architecture

```text
CLI / API / TUI
    |
    v
createTradingFabric()
    |
    +-- createRuntimeComposition()
    |      +-- @veridex/agents RuntimeOptions
    |      +-- Dataflow tools
    |      +-- Trading agent definitions
    |      +-- TradingMemoryLog
    |      +-- PolicyEngine
    |      +-- FileApprovalQueue
    |      +-- PaperExecutionProvider / Veridex executor
    |
    v
Orchestrator event stream
    |
    +-- analysts -> bull/bear debate -> research manager
    +-- trader -> risk debate -> portfolio manager
    +-- policy -> approval -> execution
    |
    v
Replay artifact + TUI state + eval traces
```

See [docs/architecture.md](docs/architecture.md) for the package breakdown and data flow.

## TradingAgents comparison

Current measurements from this repo:

| Dimension | TradingAgents reference | trading-fabric |
|---|---:|---:|
| Source LOC | 5,869 Python LOC under `resources/TradingAgents/tradingagents` | 9,563 TS/TSX LOC under `trading-fabric/src` |
| Manifest deps | 21 Python project dependencies | 6 runtime deps, 1 optional peer, 6 dev deps |
| Orchestration | LangGraph state mutation | Explicit `Orchestrator` run state and event stream |
| Structured output | Pydantic parsing in live smoke scripts | Zod schemas, replay fixtures, CI evals |
| Memory | Markdown/reflection log | File-backed memory log, semantic reflection, benchmark outcomes |
| Policy | Inline logic | `PolicyEngine` rules plus CLI validation |
| Approval | Not first-class | File-backed approval queue and CLI decision surface |
| Execution | Prints final decision | Paper ledger by default; Veridex session-key execution adapter |
| Replay/evals | Live smoke script | `ReplayProvider`, run artifacts, stateful eval suite |
| Observability | Console logs | Orchestration events, TUI reducer, replay artifacts |
| Governance | Local script conventions | Policy docs, approval inbox, deterministic CI gate |

## CLI

```bash
trading-fabric run <ticker> [--date YYYY-MM-DD] [--provider openai] [--analysts market,social,news,fundamentals] [--asset stock|crypto] [--execute] [--no-tui]
trading-fabric replay <run-id-or-path> [--json] [--no-tui]
trading-fabric approve <approval-id> [--deny] [--reason "..."] [--dir <dir>] [--json]
trading-fabric memory show <ticker> [--memory-path <path>] [--json]
trading-fabric policy validate <file> [--json]
trading-fabric eval run structured-output|policy|stateful|all [--live] [--provider openai] [--json]
```

## Programmatic API

```ts
import { createTradingFabric } from '@veridex/trading-fabric';

const fabric = createTradingFabric({
  config: {
    llm_provider: 'openai',
    execute_enabled: false,
    max_position_usd: 25,
  },
});

const result = await fabric.run({
  ticker: 'SPY',
  trade_date: '2025-06-05',
  asset_type: 'stock',
});

console.log(result.portfolio_decision);
```

More examples live in [examples/programmatic.ts](examples/programmatic.ts), [examples/with-policy.ts](examples/with-policy.ts), and [examples/headless-ci.ts](examples/headless-ci.ts).

## Docker

The Compose profile is pinned and local-data only by default.

```bash
cd trading-fabric
cp .env.example .env
UID=$(id -u) GID=$(id -g) docker compose run --rm trading-fabric
```

With local Ollama:

```bash
UID=$(id -u) GID=$(id -g) docker compose --profile ollama up -d ollama
UID=$(id -u) GID=$(id -g) docker compose --profile ollama run --rm trading-fabric node dist/cli/index.mjs eval run all
```

## Documentation

- [docs/architecture.md](docs/architecture.md) - package architecture and runtime flow
- [docs/threat-model.md](docs/threat-model.md) - security model and mitigations
- [docs/policy-cookbook.md](docs/policy-cookbook.md) - policy configuration and approval recipes
- [docs/migration-from-tradingagents.md](docs/migration-from-tradingagents.md) - migration path from Python TradingAgents

## Verification

```bash
bun run lint
bun run test
bun run build
bun run eval
```

Expected baseline: all unit/integration/eval tests pass, with live Base Sepolia tests skipped unless explicitly enabled.

## License

MIT.
