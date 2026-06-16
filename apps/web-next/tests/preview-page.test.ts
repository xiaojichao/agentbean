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
  historyReplacements: string[];
  localStorage: FakeLocalStorage;
  socket: {
    trigger(event: string, payload?: unknown): Promise<void>;
  };
  element(id: string): FakeElement;
  click(elementId: string, selector: string, dataset: Record<string, string>): Promise<void>;
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
});

function createPreviewHarness(
  acks: Record<string, AckFactory>,
  options: { href?: string } = {},
): PreviewHarness {
  const elements = new Map<string, FakeElement>();
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const historyReplacements: string[] = [];
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
    'workspace-run-detail',
    'events',
    'session-summary',
    'team-display-name',
    'team-submit',
    'message-artifact-files',
  ]) {
    elements.set(id, createElement(id));
  }
  const body = { dataset: {} as Record<string, string> };
  const windowLocation = new URL(options.href ?? 'http://agentbean-next.local/preview');
  const window = {
    location: windowLocation,
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
    fetch: async (url: string, init?: RequestInit) => {
      fetches.push({ url, init });
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
    window,
  });
  vm.runInContext(readPreviewScript(), context);

  return {
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
