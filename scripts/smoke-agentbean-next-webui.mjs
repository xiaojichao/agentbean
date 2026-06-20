#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import {
  formatBrowserSmokeText,
  runAgentBeanNextWebUiBrowserSmoke,
} from './smoke-agentbean-next-browser.mjs';

function parseArgs(argv) {
  const urlIndex = argv.indexOf('--url');
  const chromeIndex = argv.indexOf('--chrome-bin');
  const artifactsIndex = argv.indexOf('--artifacts-dir');
  const timeoutIndex = argv.indexOf('--timeout-ms');
  return {
    json: argv.includes('--json'),
    headed: argv.includes('--headed'),
    skipBuild: argv.includes('--skip-build'),
    url: urlIndex >= 0 ? argv[urlIndex + 1] : undefined,
    chromeBin: chromeIndex >= 0 ? argv[chromeIndex + 1] : undefined,
    artifactsDir: artifactsIndex >= 0 ? argv[artifactsIndex + 1] : undefined,
    timeoutMs: timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : undefined,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runAgentBeanNextWebUiBrowserSmoke({
    baseUrl: args.url ?? process.env.AGENTBEAN_NEXT_WEBUI_URL,
    chromeBin: args.chromeBin,
    artifactsDir: args.artifactsDir,
    headed: args.headed,
    skipBuild: args.skipBuild,
    ...(Number.isFinite(args.timeoutMs) ? { timeoutMs: args.timeoutMs } : {}),
  });
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatBrowserSmokeText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
