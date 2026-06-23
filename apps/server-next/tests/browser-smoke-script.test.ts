import { describe, expect, test } from 'vitest';

describe('AgentBean Next browser smoke script', () => {
  test('exercises App Router page routes in the browser', async () => {
    const { exerciseWebUiRouteSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
    };

    const routes = await exerciseWebUiRouteSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      timeoutMs: 1000,
      routes: ['/', '/login', '/agentbean/chat'],
    });

    expect(routes).toEqual(['/', '/login', '/agentbean/chat']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/login']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/agentbean/chat']);
    expect(calls.filter((call) => call[0] === 'waitForFunction')).toHaveLength(6);
  });

  test('seeds WebUI auth storage for authenticated App Router pages', async () => {
    const { seedWebUiAuthStorage } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, string]> = [];
    const page = {
      async addScriptOnNewDocument(source: string) {
        calls.push(['addScriptOnNewDocument', source]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        return true;
      },
    };

    const result = await seedWebUiAuthStorage({
      page,
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
    });

    expect(result).toEqual({ networkPath: 'team-one' });
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toContain('agentbean.token');
    expect(calls[0][1]).toContain('token-1');
    expect(calls[0][1]).toContain('agentbean.networkPath');
    expect(calls[0][1]).toContain('team-one');
  });

  test('exercises authenticated WebUI routes under the session team path', async () => {
    const { exerciseWebUiAuthenticatedRouteSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
    };

    const routes = await exerciseWebUiAuthenticatedRouteSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      timeoutMs: 1000,
      routes: [
        { path: '/team-one/chat', label: '聊天' },
        { path: '/team-one/tasks', label: '任务' },
      ],
    });

    expect(routes).toEqual(['/team-one/chat', '/team-one/tasks']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/chat']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/tasks']);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls).toHaveLength(8);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('agentbean.token'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('/team-one/chat'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('聊天'))).toBe(true);
  });

  test('exercises WebUI chat send and refresh restore', async () => {
    const { exerciseWebUiChatBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async reload() {
        calls.push(['reload', undefined]);
      },
    };

    const result = await exerciseWebUiChatBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      suffix: 'chat-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({ body: 'WebUI smoke chat chat-smoke' });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/chat']);
    expect(calls).toContainEqual([
      'setInputValue',
      { selector: '[data-smoke="chat-message-input"]', value: 'WebUI smoke chat chat-smoke' },
    ]);
    expect(calls).toContainEqual(['click', '[data-smoke="chat-message-send"]']);
    expect(calls).toContainEqual(['reload', undefined]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('chat-message-input'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('WebUI smoke chat chat-smoke'))).toBe(true);
  });

  test('exercises WebUI channel create and archive flow', async () => {
    const { exerciseWebUiChannelsBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const socketCalls: Array<[string, unknown]> = [];
    const daemonCalls: Array<[string, unknown]> = [];
    let channelMembersCount = 0;
    let memberChannelListCount = 0;
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        if (expression.includes('window.location.pathname.match')) {
          return 'channel-1';
        }
        return 'channel-1';
      },
    };
    const ioFactory = (url: string) => {
      let onConnect: (() => void) | undefined;
      const isAgent = url.endsWith('/agent');
      return {
        on(event: string, handler: () => void) {
          if (event === 'connect') onConnect = handler;
        },
        off() {},
        connect() {
          onConnect?.();
        },
        disconnect() {
          if (isAgent) daemonCalls.push(['disconnect', undefined]);
        },
        async emitWithAck(event: string, payload: unknown) {
          if (isAgent) {
            daemonCalls.push([event, payload]);
            if (event === 'device:hello') return { ok: true, device: { id: 'device-1' } };
            if (event === 'device:runtimes') return { ok: true, runtimes: [{ id: 'runtime-1' }] };
            return { ok: true };
          }
          socketCalls.push([event, payload]);
          if (event === 'join:create') return { ok: true, link: { code: 'join-1' } };
          if (event === 'auth:register') return { ok: true, token: 'member-token-1', user: { id: 'user-2' } };
          if (event === 'agent:create') return { ok: true, agent: { id: 'agent-1' } };
          if (event === 'channel:members') {
            channelMembersCount += 1;
            return channelMembersCount >= 3
              ? { ok: true, humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'] }
              : { ok: true, humanMemberIds: ['user-1', 'user-2'], agentMemberIds: channelMembersCount >= 2 ? ['agent-1'] : [] };
          }
          if (event === 'channels:subscribe') {
            memberChannelListCount += 1;
            return memberChannelListCount === 1
              ? { ok: true, channels: [{ id: 'channel-1' }] }
              : { ok: true, channels: [] };
          }
          return { ok: true };
        },
      };
    };

    const result = await exerciseWebUiChannelsBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      ioFactory,
      suffix: 'channels-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      channelId: 'channel-1',
      channelName: 'webui-channel-channels-smoke',
      memberUserId: 'user-2',
      agentId: 'agent-1',
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/channels']);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-create-open"]']);
    expect(calls).toContainEqual(['setInputValue', { selector: '[data-smoke="channel-create-name"]', value: 'webui-channel-channels-smoke' }]);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-create-visibility-private"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-create-submit"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-members-open"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-members-add-toggle"]']);
    expect(calls).toContainEqual(['setInputValue', { selector: '[data-smoke="chat-message-input"]', value: '@' }]);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-edit-open"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-archive-open"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="channel-confirm-archive"]']);
    expect(socketCalls).toContainEqual(['join:create', { maxUses: 1 }]);
    expect(socketCalls).toContainEqual(['auth:register', expect.objectContaining({ joinCode: 'join-1' })]);
    expect(socketCalls).toContainEqual(['agent:create', expect.objectContaining({ teamId: 'team-1', deviceId: 'device-1', runtimeId: 'runtime-1' })]);
    expect(socketCalls).toContainEqual(['channel:members', { teamId: 'team-1', channelId: 'channel-1' }]);
    expect(socketCalls).toContainEqual(['channels:subscribe', { teamId: 'team-1' }]);
    expect(daemonCalls).toContainEqual(['device:hello', expect.objectContaining({ teamId: 'team-1', ownerId: 'user-1' })]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('channel-create-dialog'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('channel-members-dialog'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('channel-member-item'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('mention-candidate'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('channel-edit-dialog'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('channel-list-item'))).toBe(true);
    const evaluateJsonCalls = calls.filter((call): call is ['evaluateJson', string] => call[0] === 'evaluateJson');
    expect(evaluateJsonCalls.some((call) => call[1].includes('channel-member-add-candidate'))).toBe(true);
    expect(evaluateJsonCalls.some((call) => call[1].includes('channel-member-remove'))).toBe(true);
  });

  test('exercises WebUI team create, switch, delete, and restore flow', async () => {
    const { exerciseWebUiNetworksBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const evaluateJsonResponses = [
      { id: 'team-2', name: 'WebUI Team networks-smoke', path: 'team-two' },
      true,
    ];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        return evaluateJsonResponses.shift();
      },
    };

    const result = await exerciseWebUiNetworksBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      suffix: 'networks-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      teamId: 'team-2',
      teamPath: 'team-two',
      teamName: 'WebUI Team networks-smoke',
      restoredTeamPath: 'team-one',
      deleted: true,
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/networks']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-two/settings']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/networks']);
    expect(calls).toContainEqual(['setInputValue', { selector: '[data-smoke="team-create-name"]', value: 'WebUI Team networks-smoke' }]);
    expect(calls).toContainEqual(['setInputValue', { selector: '[data-smoke="team-create-description"]', value: 'Created by WebUI smoke networks-smoke' }]);
    expect(calls).toContainEqual(['click', '[data-smoke="team-create-submit"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="settings-tab-server"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="settings-team-delete-open"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="settings-team-delete-confirm"]']);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('team-create-form'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('team-list-item'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('team-current-badge'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('settings-team-delete-open'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('settings-team-delete-dialog'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].description.includes('leave temporary team'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].description.includes('disappear from networks list'))).toBe(true);
    const evaluateJsonCalls = calls.filter((call): call is ['evaluateJson', string] => call[0] === 'evaluateJson');
    expect(evaluateJsonCalls).toHaveLength(2);
    expect(evaluateJsonCalls.filter((call) => call[1].includes('team-switch'))).toHaveLength(1);
  });

  test('exercises WebUI task create, status update, and refresh restore', async () => {
    const { exerciseWebUiTaskBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        return true;
      },
      async reload() {
        calls.push(['reload', undefined]);
      },
    };

    const result = await exerciseWebUiTaskBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      suffix: 'task-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      title: 'WebUI smoke task task-smoke',
      status: 'in_progress',
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/tasks']);
    expect(calls).toContainEqual(['click', '[data-smoke="tasks-create-open"]']);
    expect(calls).toContainEqual([
      'setInputValue',
      { selector: '[data-smoke="tasks-create-title"]', value: 'WebUI smoke task task-smoke' },
    ]);
    expect(calls).toContainEqual(['click', '[data-smoke="tasks-create-submit"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="task-status-option-in_progress"]']);
    expect(calls).toContainEqual(['reload', undefined]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('tasks-create-form'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('WebUI smoke task task-smoke'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('in_progress'))).toBe(true);
  });

  test('exercises WebUI workspace run detail with full log artifact and source message link', async () => {
    const { exerciseWebUiRunsBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const webSocketCalls: Array<[string, unknown]> = [];
    const daemonCalls: Array<[string, unknown]> = [];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        return true;
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async reload() {
        calls.push(['reload', undefined]);
      },
    };
    const webSocket = {
      async emitWithAck(event: string, payload: unknown) {
        webSocketCalls.push([event, payload]);
        if (event === 'agent:create') return { ok: true, agent: { id: 'agent-1' } };
        if (event === 'message:send') return { ok: true, dispatches: [{ id: 'dispatch-1' }] };
        return { ok: true };
      },
    };
    const ioFactory = () => {
      let onConnect: (() => void) | undefined;
      return {
        on(event: string, handler: () => void) {
          if (event === 'connect') onConnect = handler;
        },
        off() {},
        connect() {
          onConnect?.();
        },
        disconnect() {
          daemonCalls.push(['disconnect', undefined]);
        },
        async emitWithAck(event: string, payload: unknown) {
          daemonCalls.push([event, payload]);
          if (event === 'device:hello') return { ok: true, device: { id: 'device-1' } };
          if (event === 'device:runtimes') return { ok: true, runtimes: [{ id: 'runtime-1' }] };
          return { ok: true };
        },
      };
    };

    const result = await exerciseWebUiRunsBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      webSocket,
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
        channel: { id: 'channel-1', name: 'general' },
      },
      ioFactory,
      suffix: 'runs-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      id: 'webui-run-runs-smoke',
      command: 'agentbean-webui-smoke workspace runs-smoke',
      dispatchId: 'dispatch-1',
      logArtifactId: 'webui-log-runs-smoke',
      summaryArtifactId: 'webui-summary-runs-smoke',
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/runs']);
    expect(calls).toContainEqual(['reload', undefined]);
    expect(calls.filter((call) => call[0] === 'click' && call[1] === '[data-smoke="workspace-run-full-log-load"]')).toHaveLength(2);
    expect(calls).toContainEqual([
      'setInputValue',
      { selector: '[data-smoke="workspace-run-full-log-search"]', value: 'finished' },
    ]);
    expect(calls).toContainEqual(['click', '[data-smoke="workspace-run-full-log-search-submit"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="workspace-run-source-message-link"]']);
    expect(webSocketCalls).toContainEqual(['message:send', expect.objectContaining({ teamId: 'team-1', channelId: 'channel-1' })]);
    expect(daemonCalls).toContainEqual(['device:hello', expect.objectContaining({ teamId: 'team-1', ownerId: 'user-1' })]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('workspace-run-card'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('workspace-run-detail'))).toBe(true);
    expect(waitForFunctionCalls.filter((call) => call[1].expression.includes('workspace-run-full-log'))).toHaveLength(5);
    expect(waitForFunctionCalls.filter((call) => call[1].expression.includes('workspace-run-source-message-link'))).toHaveLength(2);
    expect(waitForFunctionCalls.filter((call) => call[1].expression.includes('workspace-run-artifact-tree'))).toHaveLength(2);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('logs/workspace-run.log'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('outputs/summary.md'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('workspace-run-full-log-viewer'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('workspace-run-full-log-search'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('chat-message'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('data-message-selected'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('finished WebUI workspace run smoke'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('token='))).toBe(true);
  });

  test('exercises WebUI settings team rename plus join link create and revoke', async () => {
    const { exerciseWebUiSettingsBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const evaluateJsonResponses = ['join-code-1', true];
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
      },
      async fillInputAsUser(selector: string, value: string) {
        calls.push(['fillInputAsUser', { selector, value }]);
      },
      async setInputValue(selector: string, value: string) {
        calls.push(['setInputValue', { selector, value }]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        return evaluateJsonResponses.shift();
      },
      async reload() {
        calls.push(['reload', undefined]);
      },
    };

    const result = await exerciseWebUiSettingsBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      suffix: 'settings-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      teamName: 'WebUI Settings settings-smoke',
      joinCode: 'join-code-1',
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/settings']);
    expect(calls).toContainEqual(['click', '[data-smoke="settings-tab-server"]']);
    expect(calls).toContainEqual([
      'setInputValue',
      { selector: '[data-smoke="settings-team-name-input"]', value: 'WebUI Settings settings-smoke' },
    ]);
    expect(calls).toContainEqual(['click', '[data-smoke="settings-team-name-save"]']);
    expect(calls).toContainEqual(['setInputValue', { selector: '[data-smoke="settings-join-max-uses"]', value: '2' }]);
    expect(calls).toContainEqual(['click', '[data-smoke="settings-join-create"]']);
    expect(calls).toContainEqual(['reload', undefined]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('settings-team-name-input'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('settings-join-link'))).toBe(true);
    const evaluateJsonCalls = calls.filter((call): call is ['evaluateJson', string] => call[0] === 'evaluateJson');
    expect(evaluateJsonCalls.some((call) => call[1].includes('settings-join-revoke'))).toBe(true);
  });

  test('exercises WebUI agents create, publish toggle, and metrics route', async () => {
    const { exerciseWebUiAgentsBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const webSocketCalls: Array<[string, unknown]> = [];
    const daemonCalls: Array<[string, unknown]> = [];
    const webSocket = {
      async emitWithAck(event: string, payload: unknown) {
        webSocketCalls.push([event, payload]);
        if (event === 'agents:subscribe') return { ok: true, agents: [] };
        if (event === 'agent:create') return { ok: true, agent: { id: 'agent-1' } };
        if (event === 'team:create') return { ok: true, team: { id: 'team-2', name: 'Target Team', path: 'target-team' } };
        if (event === 'team:switch') return { ok: true, currentTeam: { id: 'team-1', name: 'Team One', path: 'team-one' } };
        if (event === 'channels:subscribe') return { ok: true, channels: [] };
        if (event === 'message:send') return { ok: true, dispatches: [{ id: 'dispatch-1' }] };
        return { ok: true };
      },
    };
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async evaluateJson(expression: string) {
        calls.push(['evaluateJson', expression]);
        return true;
      },
    };
    const ioFactory = () => {
      let onConnect: (() => void) | undefined;
      return {
        on(event: string, handler: () => void) {
          if (event === 'connect') onConnect = handler;
        },
        off() {},
        connect() {
          onConnect?.();
        },
        disconnect() {
          daemonCalls.push(['disconnect', undefined]);
        },
        async emitWithAck(event: string, payload: unknown) {
          daemonCalls.push([event, payload]);
          if (event === 'device:hello') return { ok: true, device: { id: 'device-1' } };
          if (event === 'device:runtimes') return { ok: true, runtimes: [{ id: 'runtime-1' }] };
          return { ok: true };
        },
      };
    };

    const result = await exerciseWebUiAgentsBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      webSocket,
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
        channel: { id: 'channel-1', name: 'general' },
      },
      ioFactory,
      suffix: 'agents-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      agentId: 'agent-1',
      agentName: 'WebUIAgentgentssmoke',
      targetTeamId: 'team-2',
      targetTeamName: 'WebUI Agent Target agents-smoke',
      dispatchId: 'dispatch-1',
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/agents']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/agents/agent-1']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/agents/metrics']);
    expect(webSocketCalls).toContainEqual(['agents:subscribe', { userId: 'user-1', teamId: 'team-1' }]);
    expect(webSocketCalls).toContainEqual([
      'agent:create',
      expect.objectContaining({ userId: 'user-1', teamId: 'team-1', deviceId: 'device-1', runtimeId: 'runtime-1' }),
    ]);
    expect(webSocketCalls).toContainEqual(['team:create', expect.objectContaining({ userId: 'user-1', name: 'WebUI Agent Target agents-smoke' })]);
    expect(webSocketCalls).toContainEqual(['team:switch', { userId: 'user-1', teamId: 'team-1' }]);
    expect(webSocketCalls).toContainEqual(['message:send', expect.objectContaining({ teamId: 'team-1', channelId: 'channel-1' })]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('agent-list-item'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('agent-detail'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('agent-publish-toggle'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('agent-metrics-panel'))).toBe(true);
    const evaluateJsonCalls = calls.filter((call): call is ['evaluateJson', string] => call[0] === 'evaluateJson');
    expect(evaluateJsonCalls).toHaveLength(2);
    expect(evaluateJsonCalls.every((call) => call[1].includes('agent-publish-toggle'))).toBe(true);
    expect(daemonCalls).toContainEqual(['device:hello', expect.objectContaining({ teamId: 'team-1', ownerId: 'user-1' })]);
    expect(daemonCalls).toContainEqual(['device:runtimes', expect.objectContaining({ teamId: 'team-1', deviceId: 'device-1' })]);
  });

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

  test('exercises thread reply click, indicator, and nested render in the browser', async () => {
    const { exerciseThreadBrowserSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
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
      async evaluateJson() {
        return 'root-thread-1';
      },
    };

    const result = await exerciseThreadBrowserSmoke({
      page,
      suffix: 'thread-smoke',
      timeoutMs: 1000,
    });

    expect(calls).toContainEqual(['click', '#messages button[data-thread-id]']);
    expect(calls).toContainEqual([
      'setInputValue',
      { selector: '#message-form [name="body"]', value: 'browser-smoke:thread-reply:thread-smoke' },
    ]);
    expect(calls).toContainEqual(['click', '#message-form button[type="submit"]']);
    expect(calls).toContainEqual(['waitForText', { selector: '#messages', text: 'browser-smoke:thread-reply:thread-smoke' }]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('data-thread-id'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('message-reply-indicator'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('.thread-reply'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('browser-smoke:thread-reply:thread-smoke'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('root-thread-1'))).toBe(true);
    expect(result).toEqual({
      rootThreadId: 'root-thread-1',
      threadReplyBody: 'browser-smoke:thread-reply:thread-smoke',
    });
  });

  test('exercises WebUI devices detail projection, scan, rename, and delete flow', async () => {
    const { exerciseWebUiDevicesBusinessSmoke } = await import('../../../scripts/smoke-agentbean-next-browser.mjs');
    const calls: Array<[string, unknown]> = [];
    const webSocketCalls: Array<[string, unknown]> = [];
    const daemonCalls: Array<[string, unknown]> = [];
    const daemonHandlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
    const webSocket = {
      async emitWithAck(event: string, payload: unknown) {
        webSocketCalls.push([event, payload]);
        if (event === 'agent:create') return { ok: true, agent: { id: 'custom-agent-1' } };
        return { ok: true };
      },
    };
    const page = {
      async navigate(url: string) {
        calls.push(['navigate', url]);
      },
      async waitForFunction(expression: string, description: string) {
        calls.push(['waitForFunction', { expression, description }]);
      },
      async fillInputAsUser(selector: string, value: string) {
        calls.push(['fillInputAsUser', { selector, value }]);
      },
      async click(selector: string) {
        calls.push(['click', selector]);
        if (selector === '[data-smoke="device-runtime-scan"]') {
          await daemonHandlers.get('device:scan-requested')?.({ deviceId: 'device-1', requestId: 'scan-1' });
        }
      },
      async reload() {
        calls.push(['reload', undefined]);
      },
    };
    const ioFactory = () => {
      return {
        on(event: string, handler: (payload?: unknown) => void | Promise<void>) {
          daemonHandlers.set(event, handler);
        },
        off() {},
        connect() {
          daemonHandlers.get('connect')?.();
        },
        disconnect() {
          daemonCalls.push(['disconnect', undefined]);
        },
        async emitWithAck(event: string, payload: unknown) {
          daemonCalls.push([event, payload]);
          if (event === 'device:hello') return { ok: true, device: { id: 'device-1' } };
          if (event === 'device:runtimes') return { ok: true, runtimes: [{ id: 'runtime-1' }] };
          if (event === 'agent:register-batch') return { ok: true, agents: [{ id: 'scanned-agent-1' }] };
          return { ok: true };
        },
      };
    };

    const result = await exerciseWebUiDevicesBusinessSmoke({
      page,
      baseUrl: 'http://127.0.0.1:4100/',
      webSocket,
      session: {
        token: 'token-1',
        user: { id: 'user-1', username: 'alice' },
        team: { id: 'team-1', name: 'Team One', path: 'team-one' },
      },
      ioFactory,
      suffix: 'devices-smoke',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      deviceId: 'device-1',
      name: 'webui-device-devices-smoke',
      customAgentId: 'custom-agent-1',
      scannedAgentId: 'scanned-agent-1',
    });
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/devices']);
    expect(calls).toContainEqual(['navigate', 'http://127.0.0.1:4100/team-one/devices/device-1']);
    expect(calls).toContainEqual(['click', '[data-smoke="device-runtime-scan"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="device-rename-open"]']);
    expect(calls).toContainEqual(['fillInputAsUser', { selector: '[data-smoke="device-rename-input"]', value: 'webui-device-devices-smoke' }]);
    expect(calls).toContainEqual(['click', '[data-smoke="device-rename-save"]']);
    expect(calls).toContainEqual(['reload', undefined]);
    expect(calls).toContainEqual(['click', '[data-smoke="device-delete-open"]']);
    expect(calls).toContainEqual(['click', '[data-smoke="device-delete-confirm"]']);
    expect(webSocketCalls).toContainEqual([
      'agent:create',
      expect.objectContaining({ userId: 'user-1', teamId: 'team-1', deviceId: 'device-1', runtimeId: 'runtime-1' }),
    ]);
    expect(daemonCalls).toContainEqual(['device:hello', expect.objectContaining({ teamId: 'team-1', ownerId: 'user-1' })]);
    expect(daemonCalls).toContainEqual(['device:runtimes', expect.objectContaining({ teamId: 'team-1', deviceId: 'device-1' })]);
    expect(daemonCalls).toContainEqual([
      'agent:register-batch',
      expect.objectContaining({
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [expect.objectContaining({ name: 'webui-agentos-devices-smoke', category: 'agentos-hosted' })],
      }),
    ]);
    const waitForFunctionCalls = calls.filter(
      (call): call is ['waitForFunction', { expression: string; description: string }] => call[0] === 'waitForFunction',
    );
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('device-runtime-item'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('device-agent-item'))).toBe(true);
    expect(waitForFunctionCalls.some((call) => call[1].expression.includes('device-list-item'))).toBe(true);
  });
});
