import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@agentbean/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    },
  },
});
