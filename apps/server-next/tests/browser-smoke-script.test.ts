import { describe, expect, test } from 'vitest';

describe('AgentBean Next browser smoke script', () => {
  test('exercises task create, status update, and refresh restore in the browser', async () => {
    const { exerciseTaskBrowserSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const page = {
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async waitForText(selector: string, text: string) {
        calls.push(['waitForText', { selector, text }]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async reload() {
        calls.push(['reload', undefined]);
      },
    };

    const result = await exerciseTaskBrowserSmoke({
      page,
      suffix: 'task-smoke',
      timeoutMs: 1000,
    });

    expect(calls).toContainEqual([
      'setInputValue',
      { selector: '#task-create-form [name="title"]', value: 'Browser task task-smoke' },
    ]);
    expect(calls).toContainEqual(['click', '#task-create-form button[type="submit"]']);
    expect(calls).toContainEqual(['click', '#task-results button[data-status="done"]']);
    expect(calls).toContainEqual(['reload', undefined]);
    expect(calls).toContainEqual(['waitForText', { selector: '#task-results', text: 'Browser task task-smoke' }]);
    expect(calls).toContainEqual(['waitForText', { selector: '#task-results', text: 'done' }]);
    expect(result).toEqual({
      title: 'Browser task task-smoke',
      status: 'done',
    });
  });

  test('exercises artifact composer upload, preview, and download in the browser', async () => {
    const { exerciseArtifactBrowserSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const evaluateJsonResponses = [
      {
        filename: 'browser-smoke-artifact.md',
        previewHref: '/api/teams/team-1/artifacts/artifact-1/preview?token=token-1',
        downloadHref: '/api/teams/team-1/artifacts/artifact-1/download?token=token-1',
      },
      {
        preview: { status: 200, body: '# artifact browser smoke\n' },
        download: { status: 200, body: '# artifact browser smoke\n', disposition: 'attachment; filename="browser-smoke-artifact.md"' },
      },
    ];
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
        return evaluateJsonResponses.shift();
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
    const evaluateJsonCalls = calls.filter((call): call is ['evaluateJson', string] => call[0] === 'evaluateJson');
    expect(evaluateJsonCalls).toHaveLength(2);
    expect(evaluateJsonCalls[0][1]).toContain('.message-artifact');
    expect(evaluateJsonCalls[1][1]).toContain('fetch');
    expect(evaluateJsonResponses).toEqual([]);
    expect(result).toEqual({
      filename: 'browser-smoke-artifact.md',
      previewBody: '# artifact browser smoke\n',
      downloadBody: '# artifact browser smoke\n',
    });
  });

  test('reports a clear error when the artifact row is not rendered', async () => {
    const { exerciseArtifactBrowserSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const page = {
      async setFileInputFiles() {},
      async setInputValue() {},
      async click() {},
      async waitForText() {},
      async evaluateJson() {
        return null;
      },
    };

    await expect(exerciseArtifactBrowserSmoke({
      page,
      suffix: 'artifact-smoke',
      timeoutMs: 1000,
    })).rejects.toThrow('Browser artifact row was not rendered');
  });
});
