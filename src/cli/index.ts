#!/usr/bin/env node
/**
 * `trading-fabric` CLI entry. Phase 0 ships `--version` and a `run` stub.
 * Subcommands (`replay`, `approve`, `memory`, `policy`, `eval`) land in
 * Phase 10. Keep this file thin — it should only orchestrate I/O; all
 * business logic lives in the library.
 */

import { Command } from 'commander';

import { createTradingFabric, VERSION } from '../index.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('trading-fabric')
    .description(
      'Multi-agent trading framework on @veridex/agents — full TradingAgents ' +
        'parity with native Veridex execution, policy, approvals, memory, and audit.',
    )
    .version(VERSION);

  program
    .command('run')
    .description('Run the full analyst → trader → portfolio-manager pipeline')
    .argument('<ticker>', 'Ticker symbol (e.g. SPY, BTC-USD)')
    .option('-d, --date <date>', 'Trade date as YYYY-MM-DD (default: today)')
    .option(
      '-a, --analysts <list>',
      'Comma-separated analysts: market,social,news,fundamentals',
    )
    .option('--asset <type>', 'Asset class: stock | crypto', 'stock')
    .option('--provider <name>', 'LLM provider override')
    .option('--no-tui', 'Disable the Ink TUI; print JSON to stdout')
    .option('--execute', 'Enable real testnet execution via @veridex/sdk')
    .action(async (ticker: string, options) => {
      const fabric = createTradingFabric({
        config: {
          ...(options.provider ? { llm_provider: options.provider } : {}),
          ...(options.execute === true ? { execute_enabled: true } : {}),
        },
      });

      const analysts = options.analysts
        ? options.analysts
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined;

      const result = await fabric.run({
        ticker: ticker.toUpperCase(),
        trade_date: options.date,
        asset_type: options.asset === 'crypto' ? 'crypto' : 'stock',
        analysts,
      });

      // Phase 0: no TUI yet — always print JSON.
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  return program;
}

// Only auto-run when invoked as a script (so tests can import buildProgram).
const isMain =
  typeof require !== 'undefined' && require.main === module
    ? true
    : import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  buildProgram().parseAsync(process.argv).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
