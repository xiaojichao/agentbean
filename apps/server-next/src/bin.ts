import { runServerNextDevServer } from './dev-server';

runServerNextDevServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
