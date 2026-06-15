import { AGENT_EVENTS, type AgentCategory, type DispatchCustomAgentDto, type DispatchHistoryMessageDto } from '../../../packages/contracts/src/index.js';

export { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from './scanner.js';
export type { BuiltinScannerOptions } from './scanner.js';
export { createCommandExecutor } from './executor.js';
export type { CommandExecutorOptions } from './executor.js';

export interface DaemonProtocolSocket {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => Promise<void>): void;
  off?(event: string, handler: (payload: unknown) => Promise<void>): void;
  onReconnect?(handler: () => Promise<void>): void;
}

export interface DaemonWorkspaceRunResult {
  cwd?: string;
  command?: string;
  logExcerpt?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface DaemonDispatchResult {
  body: string;
  workspaceRun?: DaemonWorkspaceRunResult;
}

export type StubExecutor = (request: DispatchRequestPayload) => Promise<string | DaemonDispatchResult>;

export interface DaemonDeviceConfig {
  teamId: string;
  ownerId: string;
  token?: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
}

export interface DaemonRuntimeReport {
  adapterKind: string;
  name: string;
  command?: string;
  cwd?: string;
  version?: string;
  installed?: boolean;
}

export interface DaemonAgentReport {
  name: string;
  adapterKind: string;
  category: AgentCategory;
  gatewayInstanceKey?: string;
}

export interface DaemonScanSnapshot {
  runtimes: DaemonRuntimeReport[];
  agents: DaemonAgentReport[];
}

export type DaemonScanProvider = () => Promise<DaemonScanSnapshot>;

export interface DispatchRequestPayload {
  id: string;
  teamId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  agentId: string;
  deviceId?: string;
  requestId: string;
  prompt: string;
  history?: DispatchHistoryMessageDto[];
  customAgent?: DispatchCustomAgentDto | null;
}

export interface CreateDaemonProtocolClientInput {
  socket: DaemonProtocolSocket;
  executor: StubExecutor;
  device: DaemonDeviceConfig;
  runtimes: DaemonRuntimeReport[];
  agents: DaemonAgentReport[];
  scan?: DaemonScanProvider;
}

export interface DaemonProtocolClient {
  start(): Promise<void>;
}

export function createDaemonProtocolClient(input: CreateDaemonProtocolClientInput): DaemonProtocolClient {
  const { socket, executor, device, runtimes, agents, scan } = input;

  return {
    async start() {
      let currentDeviceId = await announceDeviceSnapshot(socket, device, runtimes, agents);
      const cancelledDispatchIds = new Set<string>();
      socket.onReconnect?.(async () => {
        currentDeviceId = await announceDeviceSnapshot(socket, device, runtimes, agents);
      });

      socket.on(AGENT_EVENTS.device.scanRequested, async (payload) => {
        const request = readScanRequest(payload);
        if (request.deviceId !== currentDeviceId) {
          return;
        }
        const snapshot = scan ? await scan() : { runtimes, agents };
        await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snapshot.runtimes, snapshot.agents);
      });

      socket.on(AGENT_EVENTS.dispatch.cancel, async (payload) => {
        cancelledDispatchIds.add(readDispatchCancel(payload).dispatchId);
      });

      socket.on(AGENT_EVENTS.dispatch.request, async (payload) => {
        const request = payload as DispatchRequestPayload;
        if (cancelledDispatchIds.has(request.id)) {
          return;
        }
        try {
          const result = normalizeDispatchResult(await executor(request));
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          await socket.emitWithAck(AGENT_EVENTS.dispatch.result, {
            dispatchId: request.id,
            agentId: request.agentId,
            body: result.body,
            ...(result.workspaceRun ? { workspaceRun: result.workspaceRun } : {}),
          });
        } catch (error) {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          await socket.emitWithAck(AGENT_EVENTS.dispatch.error, {
            dispatchId: request.id,
            agentId: request.agentId,
            error: readErrorMessage(error),
          });
        }
      });
    },
  };
}

function normalizeDispatchResult(result: string | DaemonDispatchResult): DaemonDispatchResult {
  if (typeof result === 'string') {
    return { body: result };
  }
  return result;
}

async function announceDeviceSnapshot(
  socket: DaemonProtocolSocket,
  device: DaemonDeviceConfig,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
): Promise<string> {
  const helloAck = await socket.emitWithAck(AGENT_EVENTS.device.hello, device);
  const deviceId = readAckDeviceId(helloAck);

  await reportDeviceSnapshot(socket, device.teamId, deviceId, runtimes, agents);
  return deviceId;
}

async function reportDeviceSnapshot(
  socket: DaemonProtocolSocket,
  teamId: string,
  deviceId: string,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
): Promise<void> {
  await socket.emitWithAck(AGENT_EVENTS.device.runtimes, {
    teamId,
    deviceId,
    runtimes,
  });
  await socket.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
    teamId,
    deviceId,
    agents,
  });
}

function readScanRequest(payload: unknown): { requestId: string; deviceId: string } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('device:scan-requested payload missing request');
  }
  const request = payload as { requestId?: unknown; deviceId?: unknown };
  if (typeof request.requestId !== 'string' || typeof request.deviceId !== 'string') {
    throw new Error('device:scan-requested payload missing request id or device id');
  }
  return { requestId: request.requestId, deviceId: request.deviceId };
}

function readAckDeviceId(ack: unknown): string {
  if (!ack || typeof ack !== 'object') {
    throw new Error('device:hello ack missing device');
  }
  const device = (ack as { device?: { id?: unknown } }).device;
  if (!device || typeof device.id !== 'string') {
    throw new Error('device:hello ack missing device id');
  }
  return device.id;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'Dispatch executor failed';
}

function readDispatchCancel(payload: unknown): { dispatchId: string } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('dispatch:cancel payload missing dispatch id');
  }
  const dispatchId = (payload as { dispatchId?: unknown }).dispatchId;
  if (typeof dispatchId !== 'string') {
    throw new Error('dispatch:cancel payload missing dispatch id');
  }
  return { dispatchId };
}
