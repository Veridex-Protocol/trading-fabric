# @veridex/trading-fabric

Multi-agent trading framework on `@veridex/agents` — a TypeScript-first rebuild of [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) that targets **full feature parity** while making Veridex's primitives the headline differentiator:

| Capability | TradingAgents (Python) | trading-fabric (TS) |
|---|---|---|
| Orchestration | LangGraph `StateGraph` | `@veridex/agents` Orchestrator + TaskGraph |
| Structured outputs | Pydantic + provider-native | Zod + provider-native |
| Memory | Markdown log + manual reflections | Tiered `MemoryManager` (working/episodic/semantic/procedural) |
| Risk gates | Hard-coded Python conditionals | Declarative `PolicyEngine` rules |
| Manager approval | None (auto-execute) | `ApprovalManager` suspend/resume + checkpoint |
| Execution | Console output | Real on-chain USDC via `@veridex/sdk` session keys (testnet) |
| Observability | stdout logs | Signed `EventBus` traces + audit bundles |
| Replay | None | `ReplayProvider` from `@veridex/agents/testing` |
| Stateful evals | None | `@veridex/agents/evals` golden-trace gating |

## Status

**Phase 0** — package skeleton, configuration surface, structured-output schemas, CLI stub.

Subsequent phases (data layer, LLM providers, tools, agents, orchestration, memory, policy, approvals, execution, TUI, CLI, evals, docs) land incrementally per [`/memories/session/plan.md`](../memory/session/plan.md).

## Quick start (Phase 0)

```bash
bun install
bun run --filter @veridex/trading-fabric build
bun run --filter @veridex/trading-fabric test
bunx trading-fabric --version
```

## Configuration

All knobs from `tradingagents/default_config.py` are available via the `TradingFabricConfig` interface or `TRADING_FABRIC_*` environment variables. See [`src/config/index.ts`](src/config/index.ts).

## License

MIT.
