# Threat model

`trading-fabric` sits at the boundary between untrusted market content, model-generated reasoning, policy decisions, and optional execution. The security posture is built around explicit contracts and fail-closed execution.

## Assets

- API keys for model and data providers
- Veridex session-key capabilities
- Approval records and decision notes
- Run artifacts and event traces
- Memory entries containing trading rationale and outcomes
- Paper ledger and real execution envelopes

## Trust boundaries

```text
external data/news/social feeds -> dataflows/tools -> agent context
user/CLI input                  -> config/run input -> orchestrator
model output                    -> Zod parser -> policy/execution proposal
policy escalation               -> approval inbox -> operator decision
executor                        -> paper ledger or Veridex/Sera surface
```

Data and model outputs are never treated as authority. The only authority to execute is the policy/approval/executor chain.

## Threats and mitigations

| Threat | Risk | Current mitigation |
|---|---|---|
| Indirect prompt injection in news/social data | Malicious text tries to override agent instructions | News and social content remain dataflow outputs; policy gates enforce max position and spend regardless of model text |
| Tool poisoning | Tool metadata or schemas try to steer the model | Tools are local Zod contracts, exported from code, and not dynamically imported from remote servers |
| Schema bypass | Model returns malformed portfolio decision | Structured outputs are parsed through Zod before policy/execution proposal construction |
| Confused deputy | Agent tries to execute beyond user intent | Execution is disabled by default; paper ledger is the default executor; real execution requires explicit config and executor wiring |
| Oversized trade | Model recommends too large a position | `max-position` denies above cap; `daily-spend-cap` escalates over cap |
| Unauthorized instrument | Model recommends unsupported ticker | `instrument-allowlist` can deny instruments not explicitly allowed |
| Approval tampering | Pending approval file is modified outside the CLI | Approval records are explicit JSON files; operators should place the approval directory on a trusted local filesystem and retain artifacts for audit |
| Secret leakage in logs | Keys appear in artifacts or memory | Config reads keys from env/provider surfaces; docs and examples avoid logging env values |
| Replay drift | A passing live run cannot be reproduced | Run artifacts persist input, result, and event stream; evals use `ReplayProvider` by default |

## Policy fail-closed behavior

If the policy engine returns `deny`, execution stops. If it returns `escalate` and no approval queue is configured, the orchestrator collapses the escalation to denial. This prevents a missing human-in-the-loop transport from becoming an implicit allow.

## Execution posture

Default execution is paper-only:

```text
PortfolioDecision -> Proposal -> PolicyEngine -> PaperExecutionProvider
```

Real execution requires all of the following:

- `execute_enabled=true`
- an executor configured by the caller or CLI environment
- policy verdict is `allow`, or escalation is approved
- session-key signer/relayer surfaces are available

The Veridex path signs bounded actions through session-key interfaces. The Sera path separates quote/intent submission from signing through an `IntentSigner` interface so signing can come from a Veridex session key instead of a raw local key.

## Docker posture

`docker-compose.yml` uses pinned images, no published host ports for the app container, dropped Linux capabilities, `no-new-privileges`, and a healthcheck on the optional Ollama service. The app service writes only to mounted project and data volumes.

## Operational recommendations

1. Keep `.env` local and untracked.
2. Run `trading-fabric policy validate <file>` in CI for every policy change.
3. Keep approval inbox storage on a trusted disk.
4. Archive run artifacts and paper ledgers alongside release artifacts.
5. Use replay/eval gates before enabling real execution.
6. Rotate provider keys and Veridex sessions after any suspected artifact leak.

## Known gaps

- Approval files are not yet cryptographically signed.
- Replay artifacts are JSON, not append-only signed audit logs.
- Remote MCP/A2A tool ingestion is intentionally not enabled in this package yet.
- Docker image provenance depends on the operator pinning and mirroring base images in production.
