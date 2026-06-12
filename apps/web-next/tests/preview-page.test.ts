import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

type AckFactory = (payload: unknown) => unknown | Promise<unknown>;

interface FakeElement {
  id: string;
  fields: Record<string, string>;
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
  preventDefault(): void;
}

interface PreviewHarness {
  emitted: Array<[string, unknown]>;
  localStorage: FakeLocalStorage;
  socket: {
    trigger(event: string, payload?: unknown): Promise<void>;
  };
  element(id: string): FakeElement;
  submit(formId: string): Promise<void>;
}

describe('web-next preview page interactions', () => {
  test('renders an AgentBean-style preview workspace shell', () => {
    const html = readFileSync(new URL('../preview/index.html', import.meta.url), 'utf8');

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
    ]);
    expect(JSON.parse(harness.localStorage.getItem('agentbean-next-preview-session') ?? '{}')).toMatchObject({
      token: 'token-1',
      user: { id: 'user-1' },
      team: { id: 'team-1' },
    });
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
          filename: 'reply.md',
          mimeType: 'text/markdown',
          sizeBytes: 42,
        },
      ],
      workspaceRun: {
        id: 'run-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        status: 'succeeded',
        artifactIds: ['artifact-1'],
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const html = harness.element('messages').innerHTML;
    expect(html).toContain('reply.md');
    expect(html).toContain('Workspace run run-1');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-1/preview?token=token-1');
    expect(html).toContain('/api/teams/team-1/artifacts/artifact-1/download?token=token-1');
  });
});

function createPreviewHarness(acks: Record<string, AckFactory>): PreviewHarness {
  const elements = new Map<string, FakeElement>();
  const localStorage = new FakeLocalStorage();
  const socketHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const emitted: Array<[string, unknown]> = [];

  const formFields: Record<string, Record<string, string>> = {
    'auth-form': { username: 'shaw', password: 'secret', teamName: 'AgentBean' },
    'channel-create-form': { name: 'ops', title: 'Ops', visibility: 'private' },
    'agent-create-form': { deviceId: '', runtimeId: '', name: 'Codex', envKey: 'OPENAI_API_KEY', envValue: '' },
    'message-form': { channelId: '', body: '@Codex hello' },
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
    'events',
    'session-summary',
    'team-display-name',
    'team-submit',
  ]) {
    elements.set(id, createElement(id));
  }
  const body = { dataset: {} as Record<string, string> };

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
  });
  vm.runInContext(readPreviewScript(), context);

  return {
    emitted,
    localStorage,
    socket: {
      trigger: socket.trigger,
    },
    element(id) {
      return requiredElement(elements, id);
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
  constructor(private readonly form: FakeElement) {}

  *[Symbol.iterator](): IterableIterator<[string, string]> {
    yield* Object.entries(this.form.fields);
  }
}
