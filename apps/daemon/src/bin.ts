#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './index.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('fatal:', err.message);
    process.exit(1);
  });
}
