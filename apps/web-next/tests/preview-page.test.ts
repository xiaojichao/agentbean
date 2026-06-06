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
  for (const id of ['connection-status', 'channels', 'devices', 'runtimes', 'agents', 'messages', 'events']) {
    elements.set(id, createElement(id));
  }

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
