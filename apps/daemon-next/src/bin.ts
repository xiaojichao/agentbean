import { runDaemonNextCli } from './cli';

runDaemonNextCli().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
