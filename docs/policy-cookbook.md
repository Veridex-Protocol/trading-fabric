# Policy cookbook

The policy layer converts a portfolio-manager decision into an execution verdict. It is independent of the model provider and can be tested without a live run.

## Default rules

`PolicyEngine` evaluates these rules in order and reduces the result as: any `deny` wins, then any `escalate`, otherwise `allow`.

| Rule | Decision | Purpose |
|---|---|---|
| `instrument-allowlist` | deny | Deny non-allowlisted tickers when an allowlist is configured |
| `max-position` | deny | Deny trades above `max_position_usd` |
| `daily-spend-cap` | escalate | Require approval when daily spend plus proposal exceeds `daily_spend_cap_usd` |
| `cooldown-after-loss` | escalate | Require approval after recent negative-alpha outcomes |

`Hold` proposals bypass side-effect rules and allow with zero amount.

## Validate a policy file

JSON:

```json
{
  "limits": {
    "daily_spend_cap_usd": 50,
    "max_position_usd": 25,
    "instrument_allowlist": ["AAPL", "SPY", "BTC-USD"]
  }
}
```

Simple YAML:

```yaml
limits:
  daily_spend_cap_usd: 50
  max_position_usd: 25
  instrument_allowlist:
    - AAPL
    - SPY
    - BTC-USD
```

Validate:

```bash
node dist/cli/index.mjs policy validate ./policy.json
node dist/cli/index.mjs policy validate ./policy.yaml --json
```

Validation dry-runs three proposals:

- `Hold` should allow
- oversize position should deny
- daily cap breach should escalate

## Tight paper-trading policy

Use this for local demos where you want every meaningful buy/sell to require review:

```json
{
  "limits": {
    "daily_spend_cap_usd": 5,
    "max_position_usd": 25,
    "instrument_allowlist": ["SPY", "AAPL"]
  }
}
```

## Allowlist-only mode

Set a normal spend cap but restrict instruments:

```json
{
  "limits": {
    "daily_spend_cap_usd": 100,
    "max_position_usd": 25,
    "instrument_allowlist": ["SPY", "QQQ", "BTC-USD", "ETH-USD"]
  }
}
```

Any non-allowlisted non-hold proposal is denied before approval can be requested.

## CLI approval flow

Escalated decisions are written to:

```text
<trading_fabric_data_dir>/approvals/<approval-id>.json
```

Approve:

```bash
node dist/cli/index.mjs approve <approval-id> --reason "Approved within daily budget"
```

Deny:

```bash
node dist/cli/index.mjs approve <approval-id> --deny --reason "Concentration risk too high"
```

Use a custom inbox:

```bash
node dist/cli/index.mjs approve <approval-id> --dir ./approvals --json
```

## Programmatic policy context

`createTradingFabric()` accepts `policyContext` so embedding applications can provide current spend, recent alpha, and clock values:

```ts
import { createTradingFabric } from '@veridex/trading-fabric';

const fabric = createTradingFabric({
  config: {
    daily_spend_cap_usd: 50,
    max_position_usd: 25,
    instrument_allowlist: ['AAPL', 'SPY'],
  },
  policyContext: () => ({
    dailySpendUsd: 42,
    lastTradeAt: new Date(Date.now() - 60 * 60 * 1000),
    lastAlphaReturn: -0.08,
    now: () => new Date(),
  }),
});
```

This will escalate most buy/sell proposals until a human decides.

## CI recipe

```bash
bun run build
node dist/cli/index.mjs policy validate ./policy.json --json
node dist/cli/index.mjs eval run policy --json
```

The policy eval suite exercises the same engine used by real runs.
