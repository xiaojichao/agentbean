import { describe, expect, test } from 'vitest';
import {
  collectAgentBeanNextRailwayPreflightChecks,
  normalizeVariables,
  normalizeVolumes,
  summarizeRailwayPreflight,
  volumeCoversPath,
} from '../../../scripts/check-agentbean-next-railway-preflight.mjs';

const completeEnv = {
  RAILWAY_TOKEN: 'token',
  RAILWAY_PROJECT_ID: 'project-id',
  RAILWAY_SERVICE_ID: 'service-id',
  RAILWAY_ENVIRONMENT: 'environment-id',
  AGENTBEAN_NEXT_DATA_DIR: '/data/agentbean-next',
};

describe('AgentBean Next Railway preflight', () => {
  test('passes when Railway runtime variables and a covering volume are present', () => {
    const calls: string[][] = [];
    const summary = summarizeRailwayPreflight(
      collectAgentBeanNextRailwayPreflightChecks({
        env: completeEnv,
        runCommand: (_command, args) => {
          calls.push(args);
          if (args[0] === 'variable') {
            return JSON.stringify([
              { name: 'AGENTBEAN_NEXT_DATA_DIR', value: '/data/agentbean-next' },
              { name: 'AGENTBEAN_NEXT_SESSION_SECRET', value: '********' },
            ]);
          }
          return JSON.stringify([{ id: 'volume-id', name: 'agentbean-next-data', mountPath: '/data' }]);
        },
      }),
    );

    expect(summary.ok).toBe(true);
    expect(calls[1]).toEqual([
      'volume',
      'list',
      '--service',
      'service-id',
      '--environment',
      'environment-id',
      '--json',
    ]);
  });

  test('fails without Railway runtime variables or a data-dir-covering volume', () => {
    const summary = summarizeRailwayPreflight(
      collectAgentBeanNextRailwayPreflightChecks({
        env: completeEnv,
        runCommand: (_command, args) => {
          if (args[0] === 'variable') {
            return JSON.stringify([{ name: 'AGENTBEAN_NEXT_DATA_DIR', value: '/tmp/agentbean-next' }]);
          }
          return JSON.stringify([{ id: 'volume-id', name: 'tmp-data', mountPath: '/tmp' }]);
        },
      }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual([
      'railway-variable-next-data-dir',
      'railway-variable-session-secret',
      'railway-volume-covers-data-dir',
    ]);
  });

  test('normalizes Railway JSON output shapes without leaking secret values', () => {
    const variables = normalizeVariables({
      variables: [
        { key: 'AGENTBEAN_NEXT_SESSION_SECRET', value: '<redacted>' },
        { key: 'AGENTBEAN_NEXT_DATA_DIR', value: '/data/agentbean-next' },
      ],
    });
    const volumes = normalizeVolumes({
      volumeInstances: [{ volumeId: 'volume-id', mount_path: '/data/' }],
    });

    expect(variables.get('AGENTBEAN_NEXT_SESSION_SECRET')).toMatchObject({
      name: 'AGENTBEAN_NEXT_SESSION_SECRET',
      valueVisible: false,
    });
    expect(variables.get('AGENTBEAN_NEXT_DATA_DIR')).toMatchObject({
      value: '/data/agentbean-next',
      valueVisible: true,
    });
    expect(volumes).toEqual([
      {
        id: 'volume-id',
        name: undefined,
        mountPath: '/data',
        serviceId: undefined,
        environmentId: undefined,
      },
    ]);
  });

  test('treats a volume mount as valid only when it contains the data directory', () => {
    expect(volumeCoversPath('/data', '/data/agentbean-next')).toBe(true);
    expect(volumeCoversPath('/data/agentbean-next', '/data/agentbean-next')).toBe(true);
    expect(volumeCoversPath('/data-other', '/data/agentbean-next')).toBe(false);
    expect(volumeCoversPath('/', '/data/agentbean-next')).toBe(false);
  });
});
