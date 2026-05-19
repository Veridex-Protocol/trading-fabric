import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Phase 12 docs and packaging', () => {
  test('documents the public docs, examples, docker, and eval surfaces', () => {
    const readme = read('README.md');

    expect(readme).toContain('60-second pitch');
    expect(readme).toContain('TradingAgents comparison');
    expect(readme).toContain('trading-fabric eval run structured-output|policy|stateful|all');
    expect(readme).toContain('docs/architecture.md');
    expect(readme).toContain('examples/programmatic.ts');
    expect(readme).toContain('docker compose');
  });

  test('ships the Phase 12 doc and example files referenced by README', () => {
    const expected = [
      'docs/README.md',
      'docs/architecture.md',
      'docs/threat-model.md',
      'docs/policy-cookbook.md',
      'docs/migration-from-tradingagents.md',
      'docs/examples/policy.tight.json',
      'examples/programmatic.ts',
      'examples/with-policy.ts',
      'examples/headless-ci.ts',
      '.env.example',
      'docker-compose.yml',
    ];

    for (const relativePath of expected) {
      expect(existsSync(path.join(root, relativePath)), relativePath).toBe(true);
    }
  });

  test('keeps package metadata aligned with docs and eval CLI', () => {
    const pkg = JSON.parse(read('package.json')) as {
      files: string[];
      scripts: Record<string, string>;
    };

    expect(pkg.files).toContain('docs');
    expect(pkg.files).toContain('examples');
    expect(pkg.files).toContain('docker-compose.yml');
    expect(pkg.files).toContain('.env.example');
    expect(pkg.scripts.eval).toBe('bun run build && node dist/cli/index.js eval run all');
  });

  test('uses pinned compose images and avoids host port exposure by default', () => {
    const compose = read('docker-compose.yml');

    expect(compose).toContain('oven/bun:1.2.21');
    expect(compose).toContain('ollama/ollama:0.6.8');
    expect(compose).not.toMatch(/:latest\b/);
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('healthcheck:');
  });
});
