import {
  PHASE_1_MANAGEMENT_TOOL_NAMES,
  createManagementRuntimeFactory,
  type ManagementModelAdapter,
  type ManagementRuntimeEvent,
} from './index.js';

declare const __AGENTBEAN_PI_VERSION__: string;

const PI_VERSION = __AGENTBEAN_PI_VERSION__;

async function runSmoke() {
  const events: ManagementRuntimeEvent[] = [];
  let modelCalls = 0;
  let toolCalls = 0;
  let activeAbortObserved = false;
  let observedToolNames: string[] = [];
  let markActive!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    markActive = resolve;
  });
  const model: ManagementModelAdapter = {
    id: 'phase-0-sea-deterministic',
    async respond(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        observedToolNames = request.tools.map((tool) => tool.name);
        return {
          content: [{
            type: 'toolCall',
            id: 'sea-tool-call-1',
            name: 'context.get_root_message',
            arguments: {},
          }],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
          finishReason: 'tool_use',
          responseModel: 'phase-1-sea-model',
        };
      }
      if (modelCalls === 3) {
        markActive();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            activeAbortObserved = true;
            resolve();
            return;
          }
          request.signal?.addEventListener('abort', () => {
            activeAbortObserved = true;
            resolve();
          }, { once: true });
        });
      }
      return {
        content: [{ type: 'text', text: `sea-response-${modelCalls}` }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        finishReason: 'stop',
        responseModel: 'phase-1-sea-model',
      };
    },
  };
  const session = await createManagementRuntimeFactory({
    model,
    toolExecutor: async (call) => {
      toolCalls += 1;
      if (call.name !== 'context.get_root_message') throw new Error('SEA_UNEXPECTED_TOOL');
      return { text: 'root message reference' };
    },
  }).createSession({
    systemPrompt: { id: 'phase-0-sea', version: 1, content: 'Run the AgentBean SEA management smoke.' },
    mode: 'managed',
    context: {
      schemaVersion: 1,
      scope: {
        kind: 'managed',
        managementRunId: 'sea-run-1',
        teamId: 'sea-team',
        channelId: 'sea-channel',
        rootMessageId: 'sea-message',
      },
      frozenTarget: { agentId: 'sea-agent', kind: 'custom' },
      visibleThread: { revision: 1, messages: [] },
    },
  });
  const unsubscribe = session.subscribe((event) => events.push(event));

  await session.prompt({ text: 'exercise one management tool' });
  await session.waitForIdle();
  const activePrompt = session.prompt({ text: 'exercise steer and follow-up' });
  await activeStarted;
  await session.steer({ text: 'steer while active' });
  await session.followUp({ text: 'follow up while active' });
  await session.abort('sea-smoke-active');
  await activePrompt;
  await session.waitForIdle();
  unsubscribe();
  await Promise.all([session.dispose(), session.dispose()]);

  const firstModelTools = observedToolNames.length === PHASE_1_MANAGEMENT_TOOL_NAMES.length
    && PHASE_1_MANAGEMENT_TOOL_NAMES.every((name) => observedToolNames.includes(name));
  const checks = [
    { id: 'runtime-session', ok: modelCalls >= 3 },
    { id: 'effective-tools', ok: firstModelTools },
    { id: 'tool-loop', ok: toolCalls === 1 && events.some((event) => event.type === 'tool') },
    { id: 'prompt-event', ok: events.some((event) => event.type === 'message' && event.role === 'assistant') },
    {
      id: 'steer',
      ok: events.some((event) => event.type === 'queue' && event.steeringCount > 0),
    },
    {
      id: 'followup',
      ok: events.some((event) => event.type === 'queue' && event.followUpCount > 0),
    },
    { id: 'active-abort-dispose', ok: activeAbortObserved },
  ];
  return { schemaVersion: 1, piVersion: PI_VERSION, checks };
}

async function main() {
  try {
    const result = await runSmoke();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.checks.some((check) => !check.ok)) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      piVersion: PI_VERSION,
      checks: [{ id: 'sea-smoke', ok: false, diagnosticCode: 'SEA_RUNTIME_SMOKE_FAILED' }],
    })}\n`);
    process.exitCode = 1;
  }
}

void main();
