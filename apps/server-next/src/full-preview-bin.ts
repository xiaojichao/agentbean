import { runAgentBeanNextPreview } from './full-preview.js';

runAgentBeanNextPreview()
  .then((handle) => {
    const close = async () => {
      await handle.close();
      process.exit(0);
    };
    process.once('SIGINT', () => {
      void close();
    });
    process.once('SIGTERM', () => {
      void close();
    });
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
