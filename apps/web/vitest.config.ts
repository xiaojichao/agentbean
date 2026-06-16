import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.dirname(fileURLToPath(import.meta.url)),
    },
  },
  esbuild: {
    // The app's tsconfig uses the classic JSX runtime; inject React so test files
    // (and any imported .tsx) can use JSX without an explicit React import.
    jsxInject: `import React from 'react'`,
  },
});
