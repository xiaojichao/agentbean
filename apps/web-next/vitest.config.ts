import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': root,
      '@agentbean/contracts': path.resolve(root, '../../packages/contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
