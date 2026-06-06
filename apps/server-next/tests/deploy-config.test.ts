import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('AgentBean Next root Railway deployment config', () => {
  test('declares explicit build, start, and healthcheck commands for root deploys', () => {
    const config = JSON.parse(readFileSync(new URL('../../../railway.json', import.meta.url), 'utf8'));

    expect(config).toMatchObject({
      build: {
        builder: 'RAILPACK',
        buildCommand: 'npm run build',
      },
      deploy: {
        startCommand: 'npm start',
        healthcheckPath: '/healthz',
        healthcheckTimeout: 100,
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 10,
      },
    });
  });
});
