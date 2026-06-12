import { describe, expect, test } from 'vitest';

describe('AgentBean Next browser smoke script', () => {
  test('exercises artifact composer upload, preview, and download in the browser', async () => {
    const { exerciseArtifactBrowserSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const page = {
      async setFileInputFiles(selector: string, files: Array<{ name: string; type: string; content: string }>) {
        calls.push(['setFileInputFiles', { selector, files }]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async waitForText(selector: string, text: string) {
        calls.push(['waitForText', { selector, text }]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        if (expression.includes('artifact-preview-download-smoke')) {
          return {
            preview: { status: 200, body: '# artifact browser smoke\n' },
            download: { status: 200, body: '# artifact browser smoke\n', disposition: 'attachment; filename="browser-smoke-artifact.md"' },
          };
        }
        return {
          filename: 'browser-smoke-artifact.md',
          previewHref: '/api/teams/team-1/artifacts/artifact-1/preview?token=token-1',
          downloadHref: '/api/teams/team-1/artifacts/artifact-1/download?token=token-1',
        };
      },
    };

    const result = await exerciseArtifactBrowserSmoke({
      page,
      suffix: 'artifact-smoke',
      timeoutMs: 1000,
    });

    expect(calls).toContainEqual([
      'setFileInputFiles',
      {
        selector: '#message-artifact-files',
        files: [{
          name: 'browser-smoke-artifact.md',
          type: 'text/markdown',
          content: '# artifact browser smoke\n',
        }],
      },
    ]);
    expect(calls).toContainEqual(['waitForText', { selector: '#messages', text: 'browser-smoke-artifact.md' }]);
    expect(result).toEqual({
      filename: 'browser-smoke-artifact.md',
      previewBody: '# artifact browser smoke\n',
      downloadBody: '# artifact browser smoke\n',
    });
  });
});
