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
          '@agentbean/contracts@0.2.1': '0.2.1',
          '@agentbean/daemon-next@0.2.2': '0.2.2',
          '@agentbean/daemon@0.2.2': '0.2.2',
        },
        distTags: {
          '@agentbean/daemon': { latest: '0.2.2' },
        },
      }),
    });

    expect(summarizeCutoverAudit(checks)).toMatchObject({
      ok: true,
      failed: 0,
      total: 12,
    });
  });

  test('reports missing final flip configuration and unpublished npm packages', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      runCommand: createFakeRunCommand({
        variables: [],
        secrets: [{ name: 'RAILWAY_TOKEN' }, { name: 'NPM_TOKEN' }],
        npmVersions: {
          '@agentbean/daemon-next@0.2.2': '0.2.2',
        },
        distTags: {
          '@agentbean/daemon': { latest: '0.1.35' },
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
      'npm-canonical-daemon-latest-dist-tag',
    ]);
  });

  test('can pass ready-to-flip mode when only final deploy target is pending', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      runCommand: createFakeRunCommand({
        variables: [
          { name: 'AGENTBEAN_NEXT_DATA_DIR', value: '/data/agentbean-next' },
          { name: 'AGENTBEAN_NEXT_ENTRY_URL', value: 'https://agentbean.example.com' },
        ],
        secrets: [
          { name: 'RAILWAY_TOKEN' },
          { name: 'NPM_TOKEN' },
          { name: 'AGENTBEAN_NEXT_SESSION_SECRET' },
        ],
        npmVersions: {
          '@agentbean/contracts@0.2.1': '0.2.1',
          '@agentbean/daemon-next@0.2.2': '0.2.2',
          '@agentbean/daemon@0.2.2': '0.2.2',
        },
        distTags: {
          '@agentbean/daemon': { latest: '0.2.2' },
        },
      }),
    });

    expect(summarizeCutoverAudit(checks)).toMatchObject({
      ok: false,
      failed: 1,
      pendingFinalFlip: false,
    });
    expect(summarizeCutoverAudit(checks, { allowPendingFinalFlip: true })).toMatchObject({
      ok: true,
      failed: 0,
      pendingFinalFlip: true,
      total: 12,
    });
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

  test('can audit CI-provided production environment without GitHub CLI variable or secret listing', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      env: {
        AGENTBEAN_DEPLOY_TARGET: 'next',
        AGENTBEAN_NEXT_DATA_DIR: '/data/agentbean-next',
        AGENTBEAN_NEXT_AUDIT_ENTRY_URL: 'https://agentbean.example.com',
        AGENTBEAN_NEXT_ENTRY_URL: 'https://agentbean.example.com',
        RAILWAY_TOKEN: 'railway-token',
        NPM_TOKEN: 'npm-token',
        AGENTBEAN_NEXT_SESSION_SECRET: 'session-secret',
      },
      runCommand: (_command, args) => {
        if (args[0] === 'variable' || args[0] === 'secret') {
          throw new Error('GitHub CLI listing is not available in this CI job');
        }
        if (args[0] === 'view') {
          if (args[2] === 'dist-tags') {
            return `${JSON.stringify({ latest: '0.2.2' })}\n`;
          }
          const versions: Record<string, string> = {
            '@agentbean/contracts@0.2.1': '0.2.1',
            '@agentbean/daemon-next@0.2.2': '0.2.2',
            '@agentbean/daemon@0.2.2': '0.2.2',
          };
          const version = versions[args[1]];
          if (!version) {
            throw new Error(`missing npm version for ${args[1]}`);
          }
          return `${version}\n`;
        }
        throw new Error(`unexpected command args: ${args.join(' ')}`);
      },
    });

    expect(summarizeCutoverAudit(checks)).toMatchObject({
      ok: true,
      failed: 0,
      total: 12,
    });
  });

  test('does not treat workflow smoke URL override as repository entry URL evidence', () => {
    const checks = collectAgentBeanNextCutoverAudit({
      env: {
        AGENTBEAN_DEPLOY_TARGET: 'next',
        AGENTBEAN_NEXT_DATA_DIR: '/data/agentbean-next',
        AGENTBEAN_NEXT_ENTRY_URL: 'https://override.example.com',
        RAILWAY_TOKEN: 'railway-token',
        NPM_TOKEN: 'npm-token',
        AGENTBEAN_NEXT_SESSION_SECRET: 'session-secret',
      },
      runCommand: (_command, args) => {
        if (args[0] === 'variable' || args[0] === 'secret') {
          throw new Error('GitHub CLI listing is not available in this CI job');
        }
        if (args[0] === 'view') {
          if (args[2] === 'dist-tags') {
            return `${JSON.stringify({ latest: '0.2.2' })}\n`;
          }
          const versions: Record<string, string> = {
            '@agentbean/contracts@0.2.1': '0.2.1',
            '@agentbean/daemon-next@0.2.2': '0.2.2',
            '@agentbean/daemon@0.2.2': '0.2.2',
          };
          const version = versions[args[1]];
          if (!version) {
            throw new Error(`missing npm version for ${args[1]}`);
          }
          return `${version}\n`;
        }
        throw new Error(`unexpected command args: ${args.join(' ')}`);
      },
    });

    expect(checks.find((check) => check.id === 'github-variable-next-entry-url')).toMatchObject({
      ok: false,
    });
    expect(summarizeCutoverAudit(checks)).toMatchObject({
      ok: false,
    });
  });
});

function createFakeRunCommand({
  variables,
  secrets,
  npmVersions,
  distTags = {},
}: {
  variables: Array<{ name: string; value?: string }>;
  secrets: Array<{ name: string }>;
  npmVersions: Record<string, string>;
  distTags?: Record<string, Record<string, string>>;
}) {
  return (_command: string, args: string[]) => {
    if (args[0] === 'variable') {
      return `${JSON.stringify(variables)}\n`;
    }
    if (args[0] === 'secret') {
      return `${JSON.stringify(secrets)}\n`;
    }
    if (args[0] === 'view') {
      if (args[2] === 'dist-tags') {
        const tags = distTags[args[1]];
        if (!tags) {
          throw new Error(`missing npm dist-tags for ${args[1]}`);
        }
        return `${JSON.stringify(tags)}\n`;
      }
      const version = npmVersions[args[1]];
      if (!version) {
        throw new Error(`missing npm version for ${args[1]}`);
      }
      return `${version}\n`;
    }
    throw new Error(`unexpected command args: ${args.join(' ')}`);
  };
}
