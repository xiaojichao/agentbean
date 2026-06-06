import { describe, expect, test } from 'vitest';
import {
  collectAgentBeanNextCutoverAudit,
  summarizeCutoverAudit,
} from '../../../scripts/audit-agentbean-next-cutover.mjs';

describe('AgentBean Next cutover audit', () => {
  test('passes when GitHub configuration and npm registry versions are ready', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      runCommand: createFakeRunCommand({
        variables: [
          { name: 'AGENTBEAN_DEPLOY_TARGET', value: 'next' },
          { name: 'AGENTBEAN_NEXT_DATA_DIR', value: '/data/agentbean-next' },
          { name: 'AGENTBEAN_NEXT_ENTRY_URL', value: 'https://agentbean.example.com' },
        ],
        secrets: [
          { name: 'RAILWAY_TOKEN' },
          { name: 'NPM_TOKEN' },
          { name: 'AGENTBEAN_NEXT_SESSION_SECRET' },
        ],
        npmVersions: {
          '@agentbean/contracts@0.2.0': '0.2.0',
          '@agentbean/daemon-next@0.2.0': '0.2.0',
          '@agentbean/daemon@0.2.0': '0.2.0',
        },
      }),
    });

    expect(summarizeCutoverAudit(checks)).toMatchObject({
      ok: true,
      failed: 0,
      total: 11,
    });
  });

  test('reports missing final flip configuration and unpublished npm packages', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      runCommand: createFakeRunCommand({
        variables: [],
        secrets: [{ name: 'RAILWAY_TOKEN' }, { name: 'NPM_TOKEN' }],
        npmVersions: {
          '@agentbean/daemon-next@0.2.0': '0.2.0',
        },
      }),
    });

    const summary = summarizeCutoverAudit(checks);
    expect(summary.ok).toBe(false);
    expect(checks.filter((check) => !check.ok).map((check) => check.id)).toEqual([
      'github-variable-deploy-target-next',
      'github-variable-next-data-dir',
      'github-variable-next-entry-url',
      'github-secret-next-session-secret',
      'npm-contracts-next-version',
      'npm-canonical-daemon-next-version',
    ]);
  });

  test('reports GitHub command failures instead of crashing', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      runCommand: (_command, args) => {
        if (args[0] === 'variable') {
          const error = new Error('TLS handshake timeout') as Error & { stderr: string };
          error.stderr = 'failed to get variables: TLS handshake timeout';
          throw error;
        }
        if (args[0] === 'secret') {
          return `${JSON.stringify([{ name: 'RAILWAY_TOKEN' }, { name: 'NPM_TOKEN' }])}\n`;
        }
        if (args[0] === 'view') {
          throw new Error(`missing npm version for ${args[1]}`);
        }
        throw new Error(`unexpected command args: ${args.join(' ')}`);
      },
    });

    expect(checks.find((check) => check.id === 'github-variables-readable')).toMatchObject({
      ok: false,
      message: 'GitHub repository variables could not be read: failed to get variables: TLS handshake timeout',
    });
  });
});

function createFakeRunCommand({
  variables,
  secrets,
  npmVersions,
}: {
  variables: Array<{ name: string; value?: string }>;
  secrets: Array<{ name: string }>;
  npmVersions: Record<string, string>;
}) {
  return (_command: string, args: string[]) => {
    if (args[0] === 'variable') {
      return `${JSON.stringify(variables)}\n`;
    }
    if (args[0] === 'secret') {
      return `${JSON.stringify(secrets)}\n`;
    }
    if (args[0] === 'view') {
      const version = npmVersions[args[1]];
      if (!version) {
        throw new Error(`missing npm version for ${args[1]}`);
      }
      return `${version}\n`;
    }
    throw new Error(`unexpected command args: ${args.join(' ')}`);
  };
}
