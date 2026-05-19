import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/agents/index.ts',
    'src/tools/index.ts',
    'src/dataflows/index.ts',
    'src/llm/index.ts',
    'src/schemas/index.ts',
    'src/config/index.ts',
    'src/execution/index.ts',
    'src/tui/index.ts',
    'src/cli/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: ({ format }) => (format === 'esm' ? { js: '' } : { js: '' }),
});
