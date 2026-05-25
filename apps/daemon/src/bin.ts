#!/usr/bin/env node
import { main } from './index.js';

main().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
