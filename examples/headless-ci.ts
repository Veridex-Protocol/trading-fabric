import { createTradingFabric } from '@veridex/trading-fabric';

const suite = (process.argv[2] ?? 'all') as 'structured-output' | 'policy' | 'stateful' | 'all';
const fabric = createTradingFabric({ env: {} });
const report = await fabric.runEval({ suite });

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
