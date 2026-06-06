import { runDaemonNextCli } from './cli.js';

runDaemonNextCli().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
