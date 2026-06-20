import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

type AckFactory = (payload: unknown) => unknown | Promise<unknown>;

interface FakeElement {
  id: string;
  fields: Record<string, string>;
  files: FakeFile[];
  listeners: Map<string, (event: FakeEvent) => unknown>;
  children: FakeElement[];
  className: string;
  innerHTML: string;
  parentElement: { scrollTop: number; scrollHeight: number };
  textContent: string;
  addEventListener(event: string, handler: (event: FakeEvent) => unknown): void;
  prepend(element: FakeElement): void;
}

interface FakeEvent {
  currentTarget: FakeElement;
  target?: {
    closest(selector: string): { dataset: Record<string, string> } | null;
  };
  preventDefault(): void;
}

interface PreviewHarness {
  emitted: Array<[string, unknown]>;
  fetches: Array<{ url: string; init?: RequestInit }>;
  confirms: string[];
  historyReplacements: string[];
  localStorage: FakeLocalStorage;
  socket: {
    trigger(event: string, payload?: unknown): Promise<void>;
  };
  element(id: string): FakeElement;
  click(elementId: string, selector: string, dataset: Record<string, string>): Promise<void>;
  runTimers(): Promise<void>;
  submit(formId: string): Promise<void>;
}

interface FakeFile {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

describe('web-next preview page interactions', () => {
  test('renders an AgentBean-style preview workspace shell', () => {
    const html = readFileSync(new URL('../preview/index.html', import.meta.url), 'utf8');

    expect(html).toContain('class="landing"');
    expect(html).toContain('AgentBean 产品首页');
    expect(html).toContain('让人类、本机 Agent 和远程设备上的 Agent 无缝协作');
    expect(html).toContain('href="#app-workspace"');
    expect(html).toContain('id="app-workspace"');
    expect(html).toContain('cover-ai-news.png');
    expect(html).toContain('class="brand"');
    expect(html).toContain('私有 Agent 团队');
    expect(html).toContain('class="team-switcher"');
    expect(html).toContain('当前团队');
    expect(html).toContain('class="nav-item active"># 聊天');
    expect(html).toContain('class="workspace"');
    expect(html).toContain('class="right-rail"');
    expect(html).toContain('aria-label="右侧工作区"');
    expect(html).toContain('添加自定义 Agent');
    expect(html).toContain('环境变量');
    expect(html).toContain('发送消息');
    expect(html).toContain('id="message-search-form"');
    expect(html).toContain('消息搜索');
    expect(html).toContain('id="task-create-form"');
    expect(html).toContain('创建任务');
    expect(html).toContain('.composer-thread-indicator:not([hidden])');
    expect(html).toContain('id="join-link-panel"');
    expect(html).toContain('邀请链接');
    expect(html).toContain('id="team-settings-form"');
    expect(html).toContain('重命名团队');
  });

  test('restores saved session through auth:whoami and resubscribes snapshots on connect', async () => {
    const harness = createPreviewHarness({
      'auth:whoami': () => ({
        ok: true,
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [] }),
      'task:list': () => ({
        ok: true,
        tasks: [{
          id: 'task-1',
          teamId: 'team-1',
          title: 'Restored task',
          status: 'todo',
          creatorId: 'user-1',
          tags: [],
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
    });
    harness.localStorage.setItem(
      'agentbean-next-preview-session',
      JSON.stringify({
        token: 'token-1',
        user: { id: 'stale-user' },
        team: { id: 'stale-team' },
        channel: { id: 'channel-1', name: 'all' },
      }),
    );

    await harness.socket.trigger('connect');

    expect(harness.emitted).toEqual([
      ['auth:whoami', { token: 'token-1' }],
      ['device:list', { userId: 'user-1', teamId: 'team-1' }],
      ['agents:subscribe', { userId: 'user-1', teamId: 'team-1' }],
      ['channels:subscribe', { userId: 'user-1', teamId: 'team-1' }],
      ['task:list', { userId: 'user-1', teamId: 'team-1' }],
      ['join:list', { userId: 'user-1', teamId: 'team-1' }],
    ]);
    expect(JSON.parse(harness.localStorage.getItem('agentbean-next-preview-session') ?? '{}')).toMatchObject({
      token: 'token-1',
      user: { id: 'user-1' },
      team: { id: 'team-1' },
    });
    expect(harness.element('task-results').innerHTML).toContain('Restored task');
  });

  test('auto-enters the default preview team when no saved session exists', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
    });

    await harness.socket.trigger('connect');

    expect(harness.emitted).toEqual([
      ['auth:register', { username: 'shaw', password: 'secret', teamName: 'AgentBean' }],
      ['device:list', { userId: 'user-1', teamId: 'team-1' }],
      ['agents:subscribe', { userId: 'user-1', teamId: 'team-1' }],
      ['channels:subscribe', { userId: 'user-1', teamId: 'team-1' }],
      ['task:list', { userId: 'user-1', teamId: 'team-1' }],
      ['join:list', { userId: 'user-1', teamId: 'team-1' }],
    ]);
    expect(JSON.parse(harness.localStorage.getItem('agentbean-next-preview-session') ?? '{}')).toMatchObject({
      token: 'token-1',
      user: { id: 'user-1' },
      team: { id: 'team-1' },
      channel: { id: 'channel-1' },
    });
    expect(harness.element('team-display-name').textContent).toBe('AgentBean');
  });

  test('creates a channel through the preview form and selects it for messages', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const createdChannel = { id: 'channel-2', name: 'ops', title: 'Ops', visibility: 'private' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'channel:create': () => ({ ok: true, channel: createdChannel }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    await harness.submit('channel-create-form');

    expect(harness.emitted).toContainEqual([
      'channel:create',
      {
        userId: 'user-1',
        teamId: 'team-1',
        name: 'ops',
        title: 'Ops',
        visibility: 'private',
      },
    ]);
    expect(harness.element('message-form:channelId').innerHTML).toContain('value="channel-2"');
    expect(harness.element('message-form:channelId').innerHTML).toContain('Ops');
    expect(JSON.parse(harness.localStorage.getItem('agentbean-next-preview-session') ?? '{}')).toMatchObject({
      channel: { id: 'channel-2' },
    });
  });

  test('keeps runtime options scoped to the selected preview device', async () => {
    const harness = createPreviewHarness({});

    await harness.socket.trigger('devices:snapshot', [
      { id: 'device-1', name: 'MacBook' },
      { id: 'device-2', name: 'Mac mini' },
    ]);
    await harness.socket.trigger('device:runtimes', {
      deviceId: 'device-1',
      runtimes: [{ id: 'runtime-1', name: 'Codex CLI' }],
    });
    expect(harness.element('agent-create-form:runtimeId').innerHTML).toContain('runtime-1');
    expect(harness.element('agent-create-form:runtimeId').innerHTML).toContain('Codex CLI');

    await harness.socket.trigger('device:runtimes', {
      deviceId: 'device-2',
      runtimes: [{ id: 'runtime-2', name: 'Claude Code' }],
    });
    expect(harness.element('agent-create-form:runtimeId').innerHTML).toContain('runtime-1');
    expect(harness.element('agent-create-form:runtimeId').innerHTML).not.toContain('runtime-2');
  });

  test('selects a runtime-bearing preview device when the current device has no runtimes', async () => {
    const harness = createPreviewHarness({});

    await harness.socket.trigger('devices:snapshot', [
      { id: 'stale-device', name: 'Old Mac' },
      { id: 'device-2', name: 'Current Mac' },
    ]);
    await harness.socket.trigger('device:runtimes', {
      deviceId: 'device-2',
      runtimes: [
        { id: 'runtime-gemini', name: 'Gemini CLI', adapterKind: 'gemini' },
        { id: 'runtime-2', name: 'Codex CLI', adapterKind: 'codex' },
      ],
    });

    const runtimeOptions = harness.element('agent-create-form:runtimeId').innerHTML;
    expect(runtimeOptions).toContain('runtime-2');
    expect(runtimeOptions).toContain('Codex CLI');
    expect(runtimeOptions.indexOf('runtime-2')).toBeLessThan(runtimeOptions.indexOf('runtime-gemini'));
  });

  test('folds duplicate preview device rows and keeps the runtime-bearing row', async () => {
    const harness = createPreviewHarness({});

    await harness.socket.trigger('devices:snapshot', [
      { id: 'stale-device', name: 'shaw-mac.local', status: 'online' },
      { id: 'current-device', name: 'shaw-mac.local', status: 'online' },
    ]);
    await harness.socket.trigger('device:runtimes', {
      deviceId: 'current-device',
      runtimes: [{ id: 'runtime-codex', name: 'Codex CLI', adapterKind: 'codex' }],
    });

    const devicesHtml = harness.element('devices').innerHTML;
    expect(devicesHtml).not.toContain('stale-device');
    expect(devicesHtml).toContain('current-device');
    expect(harness.element('agent-create-form:deviceId').innerHTML).toContain('current-device');
    expect(harness.element('agent-create-form:deviceId').innerHTML).not.toContain('stale-device');
  });

  test('renders message artifacts with preview and download links scoped by session token', async () => {
    const harness = createPreviewHarness({});
    harness.localStorage.setItem(
      'agentbean-next-preview-session',
      JSON.stringify({
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        team: { id: 'team-1', name: 'AgentBean' },
        channel: { id: 'channel-1', name: 'all' },
      }),
    );

    await harness.socket.trigger('channel:message', {
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      senderKind: 'agent',
      body: 'see attached',
      artifacts: [
        {
          id: 'artifact-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          workspaceRunId: 'run-1',
          filename: 'reply.md',
          mimeType: 'text/markdown',
          sizeBytes: 42,
          relativePath: 'outputs/reply.md',
          pathKind: 'workspace',
        },
        {
          id: 'artifact-3',
          teamId: 'team-1',
          channelId: 'channel-1',
          workspaceRunId: 'run-1',
          filename: 'run.log',
          mimeType: 'text/plain',
          sizeBytes: 90,
          relativePath: 'outputs/logs/run.log',
          pathKind: 'workspace',
        },
        {
          id: 'artifact-2',
          teamId: 'team-1',
          channelId: 'channel-1',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
          pathKind: 'upload',
        },
      ],
      workspaceRun: {
        id: 'run-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        deviceId: 'device-1',
        cwd: '/Users/shaw/AgentBean',
        exitCode: 0,
        startedAt: 1_000,
        completedAt: 3_500,
        status: 'succeeded',
        artifactIds: ['artifact-1'],
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const html = harness.element('messages').innerHTML;
    expect(html).toContain('Workspace 输出');
    expect(html).toContain('消息附件');
    expect(html).toContain('outputs/');
    expect(html).toContain('outputs/logs/');
    expect(html).toContain('reply.md');
    expect(html).toContain('run.log');
    expect(html).toContain('notes.txt');
    expect(html).toContain('Workspace run run-1');
    expect(html).toContain('data-workspace-run-id="run-1"');
    expect(html).toContain('查看详情');
    expect(html).toContain('/Users/shaw/AgentBean');
    expect(html).toContain('exit 0');
    expect(html).toContain('device-1');
    expect(html).toContain('2.5s');
    expect(html).toContain('2 artifacts');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-1/preview?token=token-1');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-1/download?token=token-1');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-3/preview?token=token-1');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-2/preview?token=token-1');

    await harness.click('messages', '[data-workspace-run-id]', { workspaceRunId: 'run-1' });

    const detailHtml = harness.element('workspace-run-detail').innerHTML;
    expect(detailHtml).toContain('run-1');
    expect(detailHtml).toContain('succeeded');
    expect(detailHtml).toContain('/Users/shaw/AgentBean');
    expect(detailHtml).toContain('2 artifacts');
    expect(detailHtml).toContain('Workspace 输出');
    expect(detailHtml).toContain('outputs/');
    expect(detailHtml).toContain('outputs/logs/');
    expect(detailHtml).toContain('reply.md');
    expect(detailHtml).toContain('run.log');
    expect(detailHtml).not.toContain('notes.txt');
    expect(harness.historyReplacements).toContain('/preview?workspaceRunId=run-1');
  });

  test('preserves workspace run artifactIds counts when artifact metadata is not hydrated', async () => {
    const harness = createPreviewHarness({});

    await harness.socket.trigger('channel:message', {
      id: 'message-artifact-ids-only',
      teamId: 'team-1',
      channelId: 'channel-1',
      senderKind: 'agent',
      body: 'legacy report',
      artifacts: [],
      workspaceRun: {
        id: 'run-artifact-ids-only',
        teamId: 'team-1',
        channelId: 'channel-1',
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        deviceId: 'device-1',
        cwd: '/Users/shaw/AgentBean',
        exitCode: 0,
        startedAt: 1_000,
        completedAt: 2_000,
        status: 'succeeded',
        artifactIds: ['artifact-legacy-1', 'artifact-legacy-2'],
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const html = harness.element('messages').innerHTML;
    expect(html).toContain('Workspace run run-artifact-ids-only');
    expect(html).toContain('2 artifacts');

    await harness.click('messages', '[data-workspace-run-id]', { workspaceRunId: 'run-artifact-ids-only' });

    const detailHtml = harness.element('workspace-run-detail').innerHTML;
    expect(detailHtml).toContain('run-artifact-ids-only');
    expect(detailHtml).toContain('2 artifacts');
    expect(detailHtml).not.toContain('这个 workspace run 暂无输出文件。');
    expect(detailHtml).toContain('输出文件元数据尚未加载');
  });

  test('renders upload-only message artifacts as attachments without a workspace run', async () => {
    const harness = createPreviewHarness({});
    harness.localStorage.setItem(
      'agentbean-next-preview-session',
      JSON.stringify({
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        team: { id: 'team-1', name: 'AgentBean' },
        channel: { id: 'channel-1', name: 'all' },
      }),
    );

    await harness.socket.trigger('channel:message', {
      id: 'message-upload-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      senderKind: 'human',
      body: 'see upload',
      artifacts: [
        {
          id: 'artifact-upload-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
          pathKind: 'upload',
        },
      ],
    });

    const html = harness.element('messages').innerHTML;
    expect(html).toContain('消息附件');
    expect(html).not.toContain('Workspace 输出');
    expect(html).not.toContain('message-artifact-folder');
    expect(html).toContain('notes.txt');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-upload-1/preview?token=token-1');
  });

  test('loads workspace run detail from a shareable preview URL', async () => {
    const harness = createPreviewHarness(
      {
        'auth:whoami': () => ({
          ok: true,
          user: { id: 'user-1', username: 'shaw' },
          currentTeam: { id: 'team-1', name: 'AgentBean' },
        }),
        'device:list': () => ({ ok: true, devices: [] }),
        'agents:subscribe': () => ({ ok: true, agents: [] }),
        'channels:subscribe': () => ({ ok: true, channels: [] }),
      },
      { href: 'http://agentbean-next.local/preview?workspaceRunId=run-api-1' },
    );
    harness.localStorage.setItem(
      'agentbean-next-preview-session',
      JSON.stringify({
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        team: { id: 'team-1', name: 'AgentBean' },
        channel: { id: 'channel-1', name: 'all' },
      }),
    );

    await harness.socket.trigger('connect');

    expect(harness.fetches.map((request) => request.url)).toContain(
      '/api/teams/team-1/workspace-runs/run-api-1?token=token-1',
    );
    const detailHtml = harness.element('workspace-run-detail').innerHTML;
    expect(detailHtml).toContain('run-api-1');
    expect(detailHtml).toContain('outputs/');
    expect(detailHtml).toContain('api-result.md');
  });

  test('uploads selected composer files before sending artifact-backed messages', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'message:send': (payload) => ({
        ok: true,
        message: {
          id: 'message-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          senderKind: 'human',
          senderId: 'user-1',
          body: (payload as { body: string }).body,
          artifacts: [
            {
              id: 'artifact-1',
              teamId: 'team-1',
              channelId: 'channel-1',
              filename: 'brief.md',
              mimeType: 'text/markdown',
              sizeBytes: 11,
            },
          ],
          createdAt: 1,
        },
      }),
    });
    harness.element('message-artifact-files').files = [
      createFakeFile('brief.md', 'text/markdown', 'hello file\n'),
    ];

    await harness.submit('auth-form');
    await harness.submit('message-form');

    expect(harness.fetches).toHaveLength(1);
    expect(harness.fetches[0]?.url).toBe('/api/teams/team-1/artifacts/upload');
    expect(harness.fetches[0]?.init?.headers).toBeUndefined();
    expect(harness.fetches[0]?.init?.body).toBeInstanceOf(FakeFormData);
    expect((harness.fetches[0]?.init?.body as FakeFormData).entries()).toEqual([
      ['token', 'token-1'],
      ['channelId', 'channel-1'],
      ['file', { name: 'brief.md', type: 'text/markdown' }],
    ]);
    expect(harness.emitted).toContainEqual([
      'message:send',
      {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: '@Codex hello',
        artifactIds: ['artifact-1'],
      },
    ]);
    expect(harness.element('messages').innerHTML).toContain('brief.md');
  });

  test('searches messages through the preview form and renders results', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'message:search': () => ({
        ok: true,
        messages: [
          {
            id: 'message-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            senderKind: 'human',
            senderId: 'user-1',
            body: 'roadmap search result',
            createdAt: 1,
          },
        ],
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    harness.element('message-search-form').fields.query = 'roadmap';
    await harness.submit('message-search-form');

    expect(harness.emitted).toContainEqual([
      'message:search',
      {
        userId: 'user-1',
        teamId: 'team-1',
        query: 'roadmap',
        limit: 20,
      },
    ]);
    expect(harness.element('message-search-results').innerHTML).toContain('roadmap search result');
    expect(harness.element('message-search-results').innerHTML).toContain('All');
  });

  test('creates and updates tasks through the preview task form', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'task:create': () => ({
        ok: true,
        task: {
          id: 'task-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          title: 'Ship task',
          status: 'todo',
          creatorId: 'user-1',
          tags: [],
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      'task:update': () => ({
        ok: true,
        task: {
          id: 'task-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          title: 'Ship task',
          status: 'done',
          creatorId: 'user-1',
          tags: [],
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    harness.element('task-create-form').fields.title = 'Ship task';
    await harness.submit('task-create-form');

    expect(harness.emitted).toContainEqual([
      'task:create',
      {
        userId: 'user-1',
        teamId: 'team-1',
        title: 'Ship task',
        channelId: 'channel-1',
      },
    ]);
    expect(harness.element('task-results').innerHTML).toContain('Ship task');
    await harness.click('task-results', 'button[data-task-id]', { taskId: 'task-1', status: 'done' });
    expect(harness.emitted).toContainEqual([
      'task:update',
      {
        userId: 'user-1',
        teamId: 'team-1',
        taskId: 'task-1',
        status: 'done',
      },
    ]);
    expect(harness.element('task-results').innerHTML).toContain('done');
  });

  test('lists and revokes join links through the invite panel', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'join:list': () => ({
        ok: true,
        links: [
          { id: 'join-1', code: 'ABC123', teamId: 'team-1', createdBy: 'user-1', createdAt: 1, maxUses: 1, usesCount: 0 },
        ],
      }),
      'join:revoke': () => ({
        ok: true,
        link: { id: 'join-1', code: 'ABC123', teamId: 'team-1', createdBy: 'user-1', createdAt: 1, maxUses: 1, usesCount: 0, revokedAt: 2 },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    expect(harness.emitted).toContainEqual(['join:list', { userId: 'user-1', teamId: 'team-1' }]);
    expect(harness.element('join-link-results').innerHTML).toContain('ABC123');

    await harness.click('join-link-results', 'button[data-join-code]', { joinCode: 'ABC123' });
    expect(harness.emitted).toContainEqual([
      'join:revoke',
      { userId: 'user-1', teamId: 'team-1', code: 'ABC123' },
    ]);
  });

  test('sends a thread reply and nests it under the root message', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'message:send': (payload) => ({
        ok: true,
        message: {
          id: 'msg-reply-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          threadId: (payload as { threadId?: string }).threadId,
          senderKind: 'human',
          senderId: 'user-1',
          body: 'thread reply body',
          createdAt: 2_000,
        },
        dispatches: [],
        route: { kind: 'none' },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.socket.trigger('channel:message', {
      id: 'msg-root-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'msg-root-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'root body',
      createdAt: 1_000,
    });

    const rootHtml = harness.element('messages').innerHTML;
    expect(rootHtml).toContain('root body');
    expect(rootHtml).toContain('data-thread-id="msg-root-1"');

    await harness.click('messages', 'button[data-thread-id]', { threadId: 'msg-root-1' });
    expect(harness.element('message-reply-indicator').hidden).toBe(false);

    harness.element('message-form').fields.body = 'thread reply body';
    await harness.submit('message-form');

    expect(harness.emitted).toContainEqual([
      'message:send',
      expect.objectContaining({ threadId: 'msg-root-1', body: 'thread reply body' }),
    ]);
    const html = harness.element('messages').innerHTML;
    expect(html).toContain('讨论串');
    expect(html).toContain('thread reply body');
    expect(html).toContain('<div class="thread-replies">');
    expect(html.indexOf('root body')).toBeLessThan(html.indexOf('thread reply body'));
    expect(harness.element('message-reply-indicator').hidden).toBe(true);
  });

  test('drops a stale thread reply target when the composer channel changes', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const otherChannel = { id: 'channel-2', name: 'ops', title: 'Ops', visibility: 'private' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel, otherChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'message:send': (payload) => ({
        ok: true,
        message: {
          id: 'msg-channel-2',
          teamId: 'team-1',
          channelId: (payload as { channelId: string }).channelId,
          senderKind: 'human',
          senderId: 'user-1',
          body: (payload as { body: string }).body,
          createdAt: 2_000,
        },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel, otherChannel]);
    await harness.socket.trigger('channel:message', {
      id: 'msg-root-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'msg-root-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'channel one root',
      createdAt: 1_000,
    });

    await harness.click('messages', 'button[data-thread-id]', { threadId: 'msg-root-1' });
    harness.element('message-form').fields.channelId = 'channel-2';
    harness.element('message-form').fields.body = 'send to channel two';
    await harness.submit('message-form');

    expect(harness.emitted).toContainEqual([
      'message:send',
      expect.not.objectContaining({ threadId: 'msg-root-1' }),
    ]);
    expect(harness.emitted).toContainEqual([
      'message:send',
      expect.objectContaining({ channelId: 'channel-2', body: 'send to channel two' }),
    ]);
    expect(harness.element('message-reply-indicator').hidden).toBe(true);
  });

  test('deduplicates root messages before nesting thread replies', async () => {
    const harness = createPreviewHarness({});

    await harness.socket.trigger('channel:message', {
      id: 'root-duplicate',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'root-duplicate',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'root duplicate body',
      createdAt: 1_000,
    });
    await harness.socket.trigger('channel:message', {
      id: 'root-duplicate',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'root-duplicate',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'root duplicate body',
      createdAt: 1_000,
    });
    await harness.socket.trigger('channel:message', {
      id: 'reply-once',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'root-duplicate',
      senderKind: 'agent',
      senderId: 'agent-1',
      body: 'reply rendered once',
      createdAt: 2_000,
    });

    const html = harness.element('messages').innerHTML;
    expect(html.match(/root duplicate body/g)).toHaveLength(1);
    expect(html.match(/reply rendered once/g)).toHaveLength(1);
    expect(html).toContain('<div class="thread-replies">');
  });

  test('nests an agent reply that inherits the root threadId via channel:message', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.socket.trigger('channel:message', {
      id: 'root-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'root-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'root hello',
      createdAt: 1_000,
    });
    await harness.socket.trigger('channel:message', {
      id: 'agent-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'root-1',
      senderKind: 'agent',
      senderId: 'agent-1',
      body: 'agent nested reply',
      createdAt: 2_000,
    });

    const html = harness.element('messages').innerHTML;
    expect(html).toContain('root hello');
    expect(html).toContain('agent nested reply');
    expect(html).toContain('thread-reply');
    expect(html).toContain('讨论串');
  });

  test('renames the current team through the settings form', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'team:update': (payload) => ({
        ok: true,
        team: { id: 'team-1', name: (payload as { name?: string }).name || 'AgentBean', path: 'agentbean' },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    expect(harness.element('team-display-name').textContent).toBe('AgentBean');

    harness.element('team-settings-form').fields.name = 'Ops Team';
    await harness.submit('team-settings-form');

    expect(harness.emitted).toContainEqual([
      'team:update',
      { userId: 'user-1', teamId: 'team-1', name: 'Ops Team' },
    ]);
    expect(harness.element('team-display-name').textContent).toBe('Ops Team');
  });

  test('archives and deletes a channel through accessible channel controls', async () => {
    const html = readFileSync(new URL('../preview/index.html', import.meta.url), 'utf8');
    expect(html).toContain('.channel-row:focus-within .channel-actions');
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const createdChannel = { id: 'channel-2', name: 'ops', title: 'Ops', visibility: 'private' };
    const harness = createPreviewHarness(
      {
        'auth:register': () => ({
          ok: true,
          token: 'token-1',
          user: { id: 'user-1', username: 'shaw' },
          currentTeam: { id: 'team-1', name: 'AgentBean' },
          defaultChannel,
        }),
        'device:list': () => ({ ok: true, devices: [] }),
        'agents:subscribe': () => ({ ok: true, agents: [] }),
        'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
        'task:list': () => ({ ok: true, tasks: [] }),
        'join:list': () => ({ ok: true, links: [] }),
        'channel:create': () => ({ ok: true, channel: createdChannel }),
        'channel:archive': () => ({ ok: true, channel: createdChannel }),
        'channel:delete': () => ({ ok: true, channel: createdChannel }),
      },
      { confirmResponses: [false, true] },
    );

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.submit('channel-create-form');
    expect(harness.element('channels').innerHTML).toContain('Ops');

    await harness.click('channels', 'button[data-channel-archive]', { channelArchive: 'channel-2' });
    expect(harness.emitted).toContainEqual(['channel:archive', { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' }]);
    expect(harness.element('channels').innerHTML).not.toContain('Ops');

    await harness.submit('channel-create-form');
    expect(harness.element('channels').innerHTML).toContain('Ops');

    await harness.click('channels', 'button[data-channel-delete]', { channelDelete: 'channel-2' });
    expect(harness.confirms[0]).toContain('永久移除');
    expect(harness.emitted).not.toContainEqual(['channel:delete', { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' }]);
    expect(harness.element('channels').innerHTML).toContain('Ops');

    await harness.click('channels', 'button[data-channel-delete]', { channelDelete: 'channel-2' });
    expect(harness.emitted).toContainEqual(['channel:delete', { userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' }]);
    expect(harness.element('channels').innerHTML).not.toContain('Ops');
  });

  test('reacts to and saves a message through the message actions', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'message:react': () => ({ ok: true, messageId: 'message-1' }),
      'message:save': () => ({ ok: true, messageId: 'message-1' }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    await harness.socket.trigger('channel:message', {
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'react to me',
      createdAt: 1000,
    });

    await harness.click('messages', 'button[data-message-react]', { messageReact: 'message-1' });
    expect(harness.emitted).toContainEqual([
      'message:react',
      { userId: 'user-1', teamId: 'team-1', messageId: 'message-1', emoji: '👍', on: true },
    ]);
    expect(harness.element('messages').innerHTML).toContain('👍 1');

    await harness.click('messages', 'button[data-message-react]', { messageReact: 'message-1' });
    expect(harness.emitted).toContainEqual([
      'message:react',
      { userId: 'user-1', teamId: 'team-1', messageId: 'message-1', emoji: '👍', on: false },
    ]);
    expect(harness.element('messages').innerHTML).toContain('👍 0');

    await harness.click('messages', 'button[data-message-save]', { messageSave: 'message-1' });
    expect(harness.emitted).toContainEqual([
      'message:save',
      { userId: 'user-1', teamId: 'team-1', messageId: 'message-1', on: true },
    ]);
    expect(harness.element('messages').innerHTML).toContain('已收藏');

    await harness.click('messages', 'button[data-message-save]', { messageSave: 'message-1' });
    expect(harness.emitted).toContainEqual([
      'message:save',
      { userId: 'user-1', teamId: 'team-1', messageId: 'message-1', on: false },
    ]);
    expect(harness.element('messages').innerHTML).toContain('☆ 收藏');
  });

  test('deletes a task through the preview task controls', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'task:create': () => ({
        ok: true,
        task: {
          id: 'task-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          title: 'Ship task',
          status: 'todo',
          creatorId: 'user-1',
          tags: [],
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      'task:delete': () => ({ ok: true, task: { id: 'task-1', teamId: 'team-1', title: 'Ship task', status: 'todo' } }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    harness.element('task-create-form').fields.title = 'Ship task';
    await harness.submit('task-create-form');
    expect(harness.element('task-results').innerHTML).toContain('Ship task');

    await harness.click('task-results', 'button[data-task-delete]', { taskDelete: 'task-1' });

    expect(harness.emitted).toContainEqual(['task:delete', { userId: 'user-1', teamId: 'team-1', taskId: 'task-1' }]);
    expect(harness.element('task-results').innerHTML).not.toContain('Ship task');
  });

  test('loads device detail with system info when a device is auto-selected', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online', name: 'Mac' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'device:get': () => ({
        ok: true,
        device: {
          ...device,
          systemInfo: { hostname: 'mbp', platform: 'darwin', arch: 'arm64' },
          runtimes: [],
          agents: [{ id: 'agent-1', name: 'Codex' }],
        },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.socket.trigger('devices:snapshot', [device]);

    expect(harness.emitted).toContainEqual(['device:get', { userId: 'user-1', deviceId: 'device-1' }]);
    const detailHtml = harness.element('device-detail').innerHTML;
    expect(detailHtml).toContain('信息');
    expect(detailHtml).toContain('硬件信息');
    expect(detailHtml).toContain('运行时');
    expect(detailHtml).toContain('AgentOS 托管型 Agent');
    expect(detailHtml).toContain('自定义 Agent');
    expect(detailHtml).toContain('mbp');
    expect(detailHtml).toContain('Codex');
  });

  test('renders migrated device management details in the preview shell', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = {
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      ownerName: 'Shaw',
      status: 'offline',
      name: 'MacBook Pro',
      lastSeenAt: 1_718_888_000_000,
      daemonVersionInfo: { current: '0.2.0', latest: '0.2.1', updateAvailable: true, status: 'update-available' },
      connectCommand: 'npx @agentbean/daemon@latest --invite ABCD --server-url https://api.agentbean.dev',
    };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'device:get': () => ({
        ok: true,
        device: {
          ...device,
          systemInfo: {
            hostname: 'mbp.local',
            osVersion: 'macOS 15.5',
            arch: 'arm64',
            cpuModel: 'Apple M3 Max',
            totalMemoryGB: 36,
            nodeVersion: 'v24.16.0',
          },
        },
      }),
      'device:agents:list': () => ({
        ok: true,
        runtimes: [
          { id: 'runtime-codex', name: 'Codex CLI', adapterKind: 'codex', command: 'codex', installed: true },
        ],
        agents: [
          { id: 'agentos-1', name: 'Hermes-Agent', category: 'agentos-hosted', status: 'online', adapterKind: 'hermes' },
          { id: 'custom-1', name: 'Codex Local', category: 'custom', status: 'offline', adapterKind: 'codex', cwd: '/Users/shaw/AgentBean' },
        ],
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('devices:snapshot', [device]);

    expect(harness.emitted).toContainEqual(['device:agents:list', { userId: 'user-1', teamId: 'team-1', deviceId: 'device-1' }]);
    const listHtml = harness.element('devices').innerHTML;
    expect(listHtml).toContain('Shaw');
    expect(listHtml).toContain('MacBook Pro');
    expect(listHtml).toContain('可升级');

    const detailHtml = harness.element('device-detail').innerHTML;
    expect(detailHtml).toContain('MacBook Pro');
    expect(detailHtml).toContain('Shaw');
    expect(detailHtml).toContain('macOS 15.5');
    expect(detailHtml).toContain('Apple M3 Max');
    expect(detailHtml).toContain('v0.2.0（有更新版本）');
    expect(detailHtml).toContain('npx @agentbean/daemon@latest');
    expect(detailHtml).toContain('Codex CLI');
    expect(detailHtml).toContain('Hermes-Agent');
    expect(detailHtml).toContain('Codex Local');
    expect(detailHtml).toContain('/Users/shaw/AgentBean');
    expect(detailHtml).toContain('删除设备');
    expect(harness.element('agent-create-form:runtimeId').innerHTML).toContain('Codex CLI');
  });

  test('allows team admins to manage devices owned by another member', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = { id: 'device-1', teamId: 'team-1', ownerId: 'user-2', ownerName: 'Teammate', status: 'online', name: 'Shared Mac' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw', role: 'user' },
        currentTeam: { id: 'team-1', name: 'AgentBean', currentUserRole: 'admin' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'device:get': () => ({ ok: true, device }),
      'device:agents:list': () => ({ ok: true, agents: [], runtimes: [] }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('devices:snapshot', [device]);

    const detailHtml = harness.element('device-detail').innerHTML;
    expect(detailHtml).toContain('data-device-scan="device-1"');
    expect(detailHtml).toContain('data-device-delete="device-1"');
  });

  test('delays device scan refresh instead of immediately re-caching stale agents', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online', name: 'MacBook Pro' };
    const oldAgent = { id: 'old-agent', name: 'Old Agent', category: 'custom', status: 'offline', deviceId: 'device-1' };
    const oldRuntime = { id: 'runtime-old', name: 'Old Runtime', adapterKind: 'custom', command: 'old', installed: true };
    const newAgent = { id: 'new-agent', name: 'New Agent', category: 'custom', status: 'online', deviceId: 'device-1' };
    const newRuntime = { id: 'runtime-codex', name: 'Codex CLI', adapterKind: 'codex', command: 'codex', installed: true };
    let agentListCalls = 0;
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [oldAgent] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'device:get': () => ({
        ok: true,
        device: { ...device, agents: [oldAgent], runtimes: [oldRuntime] },
      }),
      'device:agents:list': () => {
        agentListCalls += 1;
        return agentListCalls <= 2
          ? { ok: true, agents: [oldAgent], runtimes: [oldRuntime] }
          : { ok: true, agents: [newAgent], runtimes: [newRuntime] };
      },
      'device:scan': () => ({ ok: true }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('devices:snapshot', [device]);
    expect(harness.element('device-detail').innerHTML).toContain('Old Agent');

    await harness.click('device-detail', 'button[data-device-scan]', { deviceScan: 'device-1' });

    expect(harness.emitted.filter(([event]) => event === 'device:agents:list')).toHaveLength(1);
    expect(harness.element('device-detail').innerHTML).not.toContain('Old Agent');
    expect(harness.element('agent-create-form:runtimeId').innerHTML).not.toContain('Old Runtime');
    expect(harness.element('device-detail').innerHTML).not.toContain('New Agent');

    await harness.socket.trigger('agents:snapshot', [oldAgent]);
    expect(harness.element('device-detail').innerHTML).not.toContain('Old Agent');

    await harness.runTimers();

    expect(harness.emitted.filter(([event]) => event === 'device:agents:list')).toHaveLength(2);
    expect(harness.element('device-detail').innerHTML).not.toContain('Old Agent');
    expect(harness.element('agent-create-form:runtimeId').innerHTML).not.toContain('Old Runtime');
    expect(harness.element('device-detail').innerHTML).not.toContain('New Agent');

    await harness.runTimers();

    expect(harness.emitted.filter(([event]) => event === 'device:agents:list')).toHaveLength(3);
    expect(harness.element('device-detail').innerHTML).toContain('New Agent');
    expect(harness.element('agent-create-form:runtimeId').innerHTML).toContain('Codex CLI');
  });

  test('clears the selected preview device after deleting it', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'offline', name: 'MacBook Pro' };
    const harness = createPreviewHarness(
      {
        'auth:register': () => ({
          ok: true,
          token: 'token-1',
          user: { id: 'user-1', username: 'shaw' },
          currentTeam: { id: 'team-1', name: 'AgentBean' },
          defaultChannel,
        }),
        'device:list': () => ({ ok: true, devices: [] }),
        'agents:subscribe': () => ({ ok: true, agents: [] }),
        'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
        'task:list': () => ({ ok: true, tasks: [] }),
        'join:list': () => ({ ok: true, links: [] }),
        'device:get': () => ({ ok: true, device }),
        'device:agents:list': () => ({ ok: true, agents: [], runtimes: [] }),
        'device:delete': () => ({ ok: true }),
      },
      { href: 'http://agentbean-next.local/te-s-t/devices/device-1' },
    );

    await harness.submit('auth-form');
    await harness.socket.trigger('devices:snapshot', [device]);
    expect(harness.element('device-detail').innerHTML).toContain('MacBook Pro');

    await harness.click('device-detail', 'button[data-device-delete]', { deviceDelete: 'device-1' });

    expect(harness.confirms[0]).toContain('永久移除');
    expect(harness.emitted).toContainEqual(['device:delete', { userId: 'user-1', id: 'device-1', deviceId: 'device-1' }]);
    expect(harness.element('devices').innerHTML).toContain('暂无设备');
    expect(harness.element('device-detail').innerHTML).toContain('选择设备查看详情');
    expect(harness.element('device-detail').innerHTML).not.toContain('加载设备详情');
    expect(harness.historyReplacements).toContain('/te-s-t/devices');
  });

  test('renders a terminal device detail error when device:get fails', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'offline', name: 'Mac' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'device:get': () => ({ ok: false, error: 'NOT_FOUND' }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('devices:snapshot', [device]);

    const detailHtml = harness.element('device-detail').innerHTML;
    expect(detailHtml).toContain('设备详情加载失败');
    expect(detailHtml).toContain('NOT_FOUND');
    expect(detailHtml).not.toContain('加载设备详情…');
  });

  test('refreshes device detail bound agents from the latest agent snapshot', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const device = { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online', name: 'Mac' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'device:get': () => ({
        ok: true,
        device: {
          ...device,
          systemInfo: { hostname: 'mbp', platform: 'darwin', arch: 'arm64' },
          runtimes: [],
          agents: [{ id: 'agent-old', name: 'Old Agent', deviceId: 'device-1' }],
        },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('devices:snapshot', [device]);
    expect(harness.element('device-detail').innerHTML).toContain('Old Agent');

    await harness.socket.trigger('agents:snapshot', [
      { id: 'agent-new', name: 'New Agent', deviceId: 'device-1', status: 'online' },
    ]);

    const detailHtml = harness.element('device-detail').innerHTML;
    expect(detailHtml).toContain('New Agent');
    expect(detailHtml).not.toContain('Old Agent');
  });

  test('reorders tasks through the up/down controls', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const task1 = { id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: 'First', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 };
    const task2 = { id: 'task-2', teamId: 'team-1', channelId: 'channel-1', title: 'Second', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 2, createdAt: 2, updatedAt: 2 };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [task1, task2] }),
      'join:list': () => ({ ok: true, links: [] }),
      'task:reorder': (payload) => ({ ok: true, task: { ...task2, sortOrder: (payload as { sortOrder?: number }).sortOrder ?? 0 } }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    const initialHtml = harness.element('task-results').innerHTML;
    expect(initialHtml.indexOf('First')).toBeLessThan(initialHtml.indexOf('Second'));

    await harness.click('task-results', 'button[data-task-move]', { taskMove: 'task-2', direction: 'up' });
    expect(harness.emitted).toContainEqual([
      'task:reorder',
      expect.objectContaining({ userId: 'user-1', teamId: 'team-1', taskId: 'task-2' }),
    ]);

    const reorderedHtml = harness.element('task-results').innerHTML;
    expect(reorderedHtml.indexOf('Second')).toBeLessThan(reorderedHtml.indexOf('First'));
  });

  test('keeps newly-created tasks in persisted task order', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const task1 = { id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: 'First', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 100, createdAt: 1, updatedAt: 1 };
    const task2 = { id: 'task-2', teamId: 'team-1', channelId: 'channel-1', title: 'Second', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 200, createdAt: 2, updatedAt: 2 };
    const task3 = { id: 'task-3', teamId: 'team-1', channelId: 'channel-1', title: 'Created', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 300, createdAt: 3, updatedAt: 3 };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [task1, task2] }),
      'join:list': () => ({ ok: true, links: [] }),
      'task:create': () => ({ ok: true, task: task3 }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    harness.element('task-create-form').fields.title = 'Created';
    await harness.submit('task-create-form');

    const html = harness.element('task-results').innerHTML;
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Second'));
    expect(html.indexOf('Second')).toBeLessThan(html.indexOf('Created'));
  });

  test('renumbers tasks when adjacent sort orders have no gap', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const task1 = { id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: 'First', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 3, updatedAt: 3 };
    const task2 = { id: 'task-2', teamId: 'team-1', channelId: 'channel-1', title: 'Second', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 2, updatedAt: 2 };
    const task3 = { id: 'task-3', teamId: 'team-1', channelId: 'channel-1', title: 'Third', status: 'todo', creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 };
    const tasksById = new Map([task1, task2, task3].map((task) => [task.id, task]));
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [task1, task2, task3] }),
      'join:list': () => ({ ok: true, links: [] }),
      'task:reorder': (payload) => {
        const update = payload as { taskId: string; sortOrder: number };
        const task = tasksById.get(update.taskId);
        return task ? { ok: true, task: { ...task, sortOrder: update.sortOrder } } : { ok: false, error: 'NOT_FOUND' };
      },
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    await harness.click('task-results', 'button[data-task-move]', { taskMove: 'task-3', direction: 'up' });

    expect(harness.emitted).toContainEqual(['task:reorder', { userId: 'user-1', teamId: 'team-1', taskId: 'task-1', sortOrder: 1000 }]);
    expect(harness.emitted).toContainEqual(['task:reorder', { userId: 'user-1', teamId: 'team-1', taskId: 'task-3', sortOrder: 2000 }]);
    expect(harness.emitted).toContainEqual(['task:reorder', { userId: 'user-1', teamId: 'team-1', taskId: 'task-2', sortOrder: 3000 }]);

    const html = harness.element('task-results').innerHTML;
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Third'));
    expect(html.indexOf('Third')).toBeLessThan(html.indexOf('Second'));
  });

  test('lists saved messages through the saved-messages panel', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'message:list-saved': () => ({
        ok: true,
        messages: [{
          id: 'message-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          threadId: 'message-1',
          senderKind: 'human',
          senderId: 'user-1',
          body: 'saved note',
          createdAt: 1000,
          saved: true,
        }],
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.click('saved-messages-refresh', 'button', {});
    expect(harness.emitted).toContainEqual(['message:list-saved', { userId: 'user-1', teamId: 'team-1' }]);
    expect(harness.element('saved-messages-results').innerHTML).toContain('saved note');
  });

  test('manages member roles through the members panel', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'members:list': () => ({
        ok: true,
        humans: [
          { id: 'member-1', teamId: 'team-1', userId: 'user-1', username: 'shaw', role: 'owner', joinedAt: 1 },
          { id: 'member-2', teamId: 'team-1', userId: 'user-2', username: 'lin', role: 'member', joinedAt: 2 },
          ...Array.from({ length: 11 }, (_, index) => ({
            id: `member-${index + 3}`,
            teamId: 'team-1',
            userId: `user-${index + 3}`,
            username: `member-${index + 3}`,
            role: 'member',
            joinedAt: index + 3,
          })),
        ],
      }),
      'member:update-role': (payload) => ({
        ok: true,
        member: { id: 'member-2', teamId: 'team-1', userId: 'user-2', username: 'lin', role: (payload as { role?: string }).role || 'admin' },
      }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.click('members-refresh', 'button', {});
    expect(harness.emitted).toContainEqual(['members:list', { userId: 'user-1', teamId: 'team-1' }]);
    expect(harness.element('members-results').innerHTML).toContain('lin');
    expect(harness.element('members-results').innerHTML).toContain('member-13');

    await harness.click('members-results', 'button[data-member-role]', { memberRole: 'user-2', role: 'admin' });
    expect(harness.emitted).toContainEqual([
      'member:update-role',
      { userId: 'user-1', teamId: 'team-1', targetUserId: 'user-2', role: 'admin' },
    ]);
    expect(harness.element('members-results').innerHTML).toContain('管理员');
  });

  test('confirms ownership transfers before emitting', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
      'members:list': () => ({
        ok: true,
        humans: [
          { id: 'member-1', teamId: 'team-1', userId: 'user-1', username: 'shaw', role: 'owner', joinedAt: 1 },
          { id: 'member-2', teamId: 'team-1', userId: 'user-2', username: 'lin', role: 'admin', joinedAt: 2 },
        ],
      }),
      'member:transfer-owner': () => ({ ok: true }),
    }, { confirmResponses: [false, true] });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);
    await harness.click('members-refresh', 'button', {});

    await harness.click('members-results', 'button[data-member-transfer]', { memberTransfer: 'user-2' });
    expect(harness.confirms[0]).toContain('lin');
    expect(harness.emitted.some(([event]) => event === 'member:transfer-owner')).toBe(false);

    await harness.click('members-results', 'button[data-member-transfer]', { memberTransfer: 'user-2' });
    expect(harness.emitted).toContainEqual([
      'member:transfer-owner',
      { userId: 'user-1', teamId: 'team-1', targetUserId: 'user-2' },
    ]);
  });

  test('lists team workspace runs through the team-runs panel', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.click('team-runs-refresh', 'button', {});
    expect(harness.fetches.some((entry) => entry.url.includes('/workspace-runs?token='))).toBe(true);
    expect(harness.element('team-runs-results').innerHTML).toContain('npm test');
    expect(harness.element('team-runs-results').innerHTML).toContain('查看详情');
  });

  test('paginates team workspace runs with a load-more control', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.click('team-runs-refresh', 'button', {});
    expect(harness.element('team-runs-results').innerHTML).toContain('npm test');
    expect(harness.element('team-runs-results').innerHTML).toContain('加载更多');

    await harness.click('team-runs-results', 'button[data-team-runs-more]', {});
    expect(harness.element('team-runs-results').innerHTML).toContain('npm run build');
    expect(harness.element('team-runs-results').innerHTML).not.toContain('加载更多');
    expect(harness.fetches.some((entry) => entry.url.includes('cursor=cursor-1'))).toBe(true);
  });

  test('ignores concurrent team workspace run load-more clicks', async () => {
    const defaultChannel = { id: 'channel-1', name: 'all', title: 'All', visibility: 'public' };
    const harness = createPreviewHarness({
      'auth:register': () => ({
        ok: true,
        token: 'token-1',
        user: { id: 'user-1', username: 'shaw' },
        currentTeam: { id: 'team-1', name: 'AgentBean' },
        defaultChannel,
      }),
      'device:list': () => ({ ok: true, devices: [] }),
      'agents:subscribe': () => ({ ok: true, agents: [] }),
      'channels:subscribe': () => ({ ok: true, channels: [defaultChannel] }),
      'task:list': () => ({ ok: true, tasks: [] }),
      'join:list': () => ({ ok: true, links: [] }),
    });

    await harness.submit('auth-form');
    await harness.socket.trigger('channels:snapshot', [defaultChannel]);

    await harness.click('team-runs-refresh', 'button', {});
    await Promise.all([
      harness.click('team-runs-results', 'button[data-team-runs-more]', {}),
      harness.click('team-runs-results', 'button[data-team-runs-more]', {}),
    ]);

    const cursorFetches = harness.fetches.filter((entry) => entry.url.includes('cursor=cursor-1'));
    expect(cursorFetches).toHaveLength(1);
    expect(harness.element('team-runs-results').innerHTML.match(/npm run build/g)).toHaveLength(1);
  });
});

function createPreviewHarness(
  acks: Record<string, AckFactory>,
  options: { confirmResponses?: boolean[]; href?: string } = {},
): PreviewHarness {
  const elements = new Map<string, FakeElement>();
  const confirmResponses = [...(options.confirmResponses ?? [true])];
  const confirms: string[] = [];
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const historyReplacements: string[] = [];
  const timers = new Map<number, () => unknown>();
  let nextTimerId = 1;
  const localStorage = new FakeLocalStorage();
  const socketHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const emitted: Array<[string, unknown]> = [];

  const formFields: Record<string, Record<string, string>> = {
    'auth-form': { username: 'shaw', password: 'secret', teamName: 'AgentBean' },
    'channel-create-form': { name: 'ops', title: 'Ops', visibility: 'private' },
    'agent-create-form': { deviceId: '', runtimeId: '', name: 'Codex', envKey: 'OPENAI_API_KEY', envValue: '' },
    'message-form': { channelId: '', body: '@Codex hello' },
    'task-create-form': { title: 'Ship task' },
    'message-search-form': { query: 'roadmap' },
    'team-settings-form': { name: '' },
  };
  for (const [id, fields] of Object.entries(formFields)) {
    elements.set(id, createElement(id, fields));
    for (const fieldName of Object.keys(fields)) {
      elements.set(`${id}:${fieldName}`, createElement(`${id}:${fieldName}`));
    }
  }
  for (const id of [
    'active-channel-meta',
    'active-channel-title',
    'connection-status',
    'channels',
    'devices',
    'runtimes',
    'agents',
    'messages',
    'task-results',
    'message-search-results',
    'join-link-panel',
    'join-link-create',
    'join-link-refresh',
    'join-link-results',
    'workspace-run-detail',
    'events',
    'session-summary',
    'team-display-name',
    'team-submit',
    'message-artifact-files',
    'message-reply-indicator',
    'message-reply-cancel',
    'device-detail',
    'saved-messages-panel',
    'saved-messages-refresh',
    'saved-messages-results',
    'members-panel',
    'members-refresh',
    'members-results',
    'team-runs-panel',
    'team-runs-refresh',
    'team-runs-results',
  ]) {
    elements.set(id, createElement(id));
  }
  const body = { dataset: {} as Record<string, string> };
  const windowLocation = new URL(options.href ?? 'http://agentbean-next.local/preview');
  const window = {
    location: windowLocation,
    confirm(message: string): boolean {
      confirms.push(message);
      return confirmResponses.length > 0 ? Boolean(confirmResponses.shift()) : true;
    },
    history: {
      replaceState(_state: unknown, _title: string, url: string): void {
        historyReplacements.push(url);
        windowLocation.href = new URL(url, windowLocation.href).href;
      },
    },
  };

  const socket = {
    on(event: string, handler: (payload: unknown) => unknown): void {
      const handlers = socketHandlers.get(event) ?? [];
      handlers.push(handler);
      socketHandlers.set(event, handlers);
    },
    async emitWithAck(event: string, payload: unknown): Promise<unknown> {
      emitted.push([event, payload]);
      const ack = acks[event];
      return ack ? ack(payload) : { ok: true };
    },
    async trigger(event: string, payload?: unknown): Promise<void> {
      for (const handler of socketHandlers.get(event) ?? []) {
        await handler(payload);
      }
    },
  };

  const context = vm.createContext({
    FormData: FakeFormData,
    clearTimeout: (timerId: number) => {
      timers.delete(timerId);
    },
    fetch: async (url: string, init?: RequestInit) => {
      fetches.push({ url, init });
      if (url.includes('/workspace-runs') && !url.includes('/workspace-runs/')) {
        const hasCursor = url.includes('cursor=');
        return {
          async json() {
            return {
              ok: true,
              runs: hasCursor
                ? [
                    {
                      workspaceRun: {
                        id: 'run-list-2',
                        teamId: 'team-1',
                        channelId: 'channel-1',
                        dispatchId: 'dispatch-2',
                        agentId: 'agent-1',
                        deviceId: 'device-1',
                        command: 'npm run build',
                        cwd: '/repo',
                        exitCode: 1,
                        status: 'failed',
                        artifactIds: [],
                        createdAt: 2,
                        updatedAt: 2,
                      },
                      artifacts: [],
                    },
                  ]
                : [
                    {
                      workspaceRun: {
                        id: 'run-list-1',
                        teamId: 'team-1',
                        channelId: 'channel-1',
                        dispatchId: 'dispatch-1',
                        agentId: 'agent-1',
                        deviceId: 'device-1',
                        command: 'npm test',
                        cwd: '/repo',
                        exitCode: 0,
                        status: 'succeeded',
                        artifactIds: ['artifact-list-1'],
                        createdAt: 1,
                        updatedAt: 1,
                      },
                      artifacts: [
                        { id: 'artifact-list-1', teamId: 'team-1', channelId: 'channel-1', workspaceRunId: 'run-list-1', filename: 'out.txt', mimeType: 'text/plain', sizeBytes: 5, relativePath: 'out.txt', pathKind: 'workspace' },
                      ],
                    },
                  ],
              nextCursor: hasCursor ? null : 'cursor-1',
            };
          },
        };
      }
      if (url.includes('/workspace-runs/')) {
        return {
          async json() {
            return {
              ok: true,
              workspaceRun: {
                id: 'run-api-1',
                teamId: 'team-1',
                channelId: 'channel-1',
                dispatchId: 'dispatch-1',
                agentId: 'agent-1',
                deviceId: 'device-1',
                cwd: '/Users/shaw/AgentBean',
                exitCode: 0,
                startedAt: 1_000,
                completedAt: 2_000,
                status: 'succeeded',
                artifactIds: ['artifact-api-1'],
                createdAt: 1,
                updatedAt: 1,
              },
              artifacts: [
                {
                  id: 'artifact-api-1',
                  teamId: 'team-1',
                  channelId: 'channel-1',
                  workspaceRunId: 'run-api-1',
                  filename: 'api-result.md',
                  mimeType: 'text/markdown',
                  sizeBytes: 31,
                  relativePath: 'outputs/api-result.md',
                  pathKind: 'workspace',
                },
              ],
            };
          },
        };
      }
      return {
        async json() {
          return {
            ok: true,
            artifact: {
              id: 'artifact-1',
              teamId: 'team-1',
              channelId: 'channel-1',
              filename: 'brief.md',
              mimeType: 'text/markdown',
              sizeBytes: 11,
              previewUrl: '/api/teams/team-1/artifacts/artifact-1/preview',
              downloadUrl: '/api/teams/team-1/artifacts/artifact-1/download',
            },
          };
        },
      };
    },
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    URL,
    document: {
      body,
      createElement: (tagName: string) => createElement(tagName),
      getElementById: (id: string) => requiredElement(elements, id),
      querySelector: (selector: string) => {
        const match = selector.match(/^#([^ ]+) \[name="([^"]+)"\]$/);
        if (!match?.[1] || !match[2]) {
          throw new Error(`Unsupported selector: ${selector}`);
        }
        return requiredElement(elements, `${match[1]}:${match[2]}`);
      },
    },
    io: () => socket,
    localStorage,
    setTimeout: (handler: () => unknown) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, handler);
      return timerId;
    },
    window,
  });
  vm.runInContext(readPreviewScript(), context);

  return {
    confirms,
    emitted,
    fetches,
    historyReplacements,
    localStorage,
    socket: {
      trigger: socket.trigger,
    },
    element(id) {
      return requiredElement(elements, id);
    },
    async click(elementId, selector, dataset) {
      const element = requiredElement(elements, elementId);
      const handler = element.listeners.get('click');
      if (!handler) {
        throw new Error(`No click handler for ${elementId}`);
      }
      await handler({
        currentTarget: element,
        target: {
          closest(candidate) {
            return candidate === selector ? { dataset } : null;
          },
        },
        preventDefault() {
          // Click handlers in the preview only update local UI state.
        },
      });
    },
    async runTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, timer] of pending) {
        await timer();
      }
    },
    async submit(formId) {
      const form = requiredElement(elements, formId);
      const handler = form.listeners.get('submit');
      if (!handler) {
        throw new Error(`No submit handler for ${formId}`);
      }
      await handler({
        currentTarget: form,
        preventDefault() {
          // The preview handlers call preventDefault before emitting socket commands.
        },
      });
    },
  };
}

function readPreviewScript(): string {
  const html = readFileSync(new URL('../preview/index.html', import.meta.url), 'utf8');
  const match = html.match(/<script>\n([\s\S]*)\n    <\/script>/);
  if (!match?.[1]) {
    throw new Error('Preview inline script not found');
  }
  return match[1];
}

function createElement(id: string, fields: Record<string, string> = {}): FakeElement {
  return {
    id,
    fields,
    files: [],
    listeners: new Map(),
    children: [],
    className: '',
    innerHTML: '',
    parentElement: { scrollTop: 0, scrollHeight: 0 },
    textContent: '',
    addEventListener(event, handler) {
      this.listeners.set(event, handler);
    },
    prepend(element) {
      this.children.unshift(element);
    },
  };
}

function createFakeFile(name: string, type: string, content: string): FakeFile {
  return {
    name,
    type,
    async arrayBuffer() {
      const buffer = Buffer.from(content, 'utf8');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function requiredElement(elements: Map<string, FakeElement>, id: string): FakeElement {
  const element = elements.get(id);
  if (!element) {
    throw new Error(`Missing fake element: ${id}`);
  }
  return element;
}

class FakeLocalStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeFormData {
  private readonly values: Array<[string, string | FakeFile]> = [];

  constructor(form?: FakeElement) {
    if (form) {
      this.values.push(...Object.entries(form.fields));
    }
  }

  append(name: string, value: string | FakeFile): void {
    this.values.push([name, value]);
  }

  entries(): Array<[string, string | { name: string; type: string }]> {
    return this.values.map(([name, value]) => [
      name,
      typeof value === 'string' ? value : { name: value.name, type: value.type },
    ]);
  }

  *[Symbol.iterator](): IterableIterator<[string, string]> {
    for (const [name, value] of this.values) {
      if (typeof value === 'string') {
        yield [name, value];
      }
    }
  }
}
