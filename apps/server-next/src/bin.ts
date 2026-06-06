import { runServerNextDevServer } from './dev-server.js';

runServerNextDevServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
