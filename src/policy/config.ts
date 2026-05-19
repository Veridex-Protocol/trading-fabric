import { z } from 'zod';

import type { TradingFabricConfig } from '../config';
import { PolicyEngine } from './engine';
import type { PolicyLimits, Proposal, PolicyContext } from './types';

const PolicyConfigFileSchema = z
  .object({
    limits: z
      .object({
        daily_spend_cap_usd: z.number().nonnegative().optional(),
        max_position_usd: z.number().nonnegative().optional(),
        instrument_allowlist: z.array(z.string()).optional(),
        cooldown_after_loss_hours: z.number().nonnegative().optional(),
        cooldown_loss_threshold: z.number().optional(),
      })
      .optional(),
    rules: z.array(z.object({ id: z.string(), enabled: z.boolean().optional() })).optional(),
  })
  .passthrough();

export type PolicyConfigFile = z.infer<typeof PolicyConfigFileSchema>;

export interface PolicyValidationResult {
  ok: boolean;
  limits: PolicyLimits;
  checks: Array<{
    id: string;
    proposal: Proposal;
    decision: string;
    passed: boolean;
    reason: string | null;
  }>;
}

export function parsePolicyConfigText(text: string): PolicyConfigFile {
  const trimmed = text.trim();
  const parsed = trimmed.startsWith('{') ? JSON.parse(trimmed) : parseSimplePolicyYaml(trimmed);
  return PolicyConfigFileSchema.parse(parsed);
}

export function policyLimitsFromConfigFile(
  base: TradingFabricConfig,
  file: PolicyConfigFile = {},
): PolicyLimits {
  return {
    daily_spend_cap_usd: file.limits?.daily_spend_cap_usd ?? base.daily_spend_cap_usd,
    max_position_usd: file.limits?.max_position_usd ?? base.max_position_usd,
    instrument_allowlist: file.limits?.instrument_allowlist ?? base.instrument_allowlist,
    cooldown_after_loss_hours: file.limits?.cooldown_after_loss_hours,
    cooldown_loss_threshold: file.limits?.cooldown_loss_threshold,
  };
}

export function validatePolicyConfig(
  base: TradingFabricConfig,
  file: PolicyConfigFile = {},
): PolicyValidationResult {
  const limits = policyLimitsFromConfigFile(base, file);
  const engine = new PolicyEngine({ limits });
  const ctx: PolicyContext = {
    dailySpendUsd: Math.max(0, limits.daily_spend_cap_usd - 1),
    lastTradeAt: null,
    lastAlphaReturn: null,
    now: () => new Date('2026-05-19T12:00:00Z'),
  };
  const proposals: Array<{ id: string; proposal: Proposal; expect: 'allow' | 'deny' | 'escalate' }> = [
    {
      id: 'hold-bypasses-side-effect-rules',
      expect: 'allow',
      proposal: makeProposal({ action: 'Hold', rating: 'Hold', amountUsd: 0 }),
    },
    {
      id: 'max-position-denies-oversize',
      expect: 'deny',
      proposal: makeProposal({ amountUsd: limits.max_position_usd + 1 }),
    },
    {
      id: 'daily-spend-escalates-over-cap',
      expect: 'escalate',
      proposal: makeProposal({ amountUsd: 2 }),
    },
  ];
  const checks = proposals.map(({ id, proposal, expect }) => {
    const decision = engine.evaluate(proposal, ctx);
    return {
      id,
      proposal,
      decision: decision.decision,
      passed: decision.decision === expect,
      reason: decision.primaryReason,
    };
  });
  return {
    ok: checks.every((check) => check.passed),
    limits,
    checks,
  };
}

function makeProposal(overrides: Partial<Proposal>): Proposal {
  return {
    decisionId: `policy-check-${overrides.action ?? 'Buy'}`,
    runId: 'policy-validate',
    ticker: 'AAPL',
    trade_date: '2026-05-19',
    rating: 'Buy',
    action: 'Buy',
    amountUsd: 1,
    ...overrides,
  };
}

function parseSimplePolicyYaml(text: string): PolicyConfigFile {
  const limits: Record<string, unknown> = {};
  let section: 'limits' | 'rules' | null = null;
  let listKey: string | null = null;

  for (const rawLine of text.split('\n')) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;
    const trimmed = withoutComment.trim();

    if (trimmed === 'limits:') {
      section = 'limits';
      listKey = null;
      continue;
    }
    if (trimmed === 'rules:') {
      section = 'rules';
      listKey = null;
      continue;
    }
    if (section !== 'limits') continue;

    if (trimmed.startsWith('- ') && listKey) {
      const existing = limits[listKey];
      const values = Array.isArray(existing) ? existing : [];
      values.push(parseScalar(trimmed.slice(2)));
      limits[listKey] = values;
      continue;
    }

    const match = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === '') {
      listKey = key;
      limits[key] = [];
      continue;
    }
    listKey = null;
    limits[key] = parseScalar(rawValue);
  }

  return { limits };
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => String(parseScalar(item)))
      .filter(Boolean);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value !== '') return numeric;
  return value.replace(/^['"]|['"]$/g, '');
}
