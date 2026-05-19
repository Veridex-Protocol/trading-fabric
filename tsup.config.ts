import { defineConfig } from 'tsup';

const libraryEntries = [
  'src/index.ts',
  'src/agents/index.ts',
  'src/tools/index.ts',
  'src/dataflows/index.ts',
  'src/llm/index.ts',
  'src/schemas/index.ts',
  'src/config/index.ts',
  'src/execution/index.ts',
  'src/runtime.ts',
  'src/replay/index.ts',
  'src/evals/index.ts',
  'src/tui/index.ts',
];

export default defineConfig([
  {
    entry: libraryEntries,
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    banner: ({ format }) => (format === 'esm' ? { js: '' } : { js: '' }),
  },
  {
    entry: ['src/cli/index.ts'],
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    banner: { js: '' },
  },
]);
