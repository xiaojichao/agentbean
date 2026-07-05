import { AGENT_EVENTS, WEB_EVENTS, makeFailure, type DispatchRequestDto } from '../../../../packages/contracts/src/index.js';
import type { ServerNextUseCases } from '../application/usecases.js';

export interface AuthenticatedUserIdentity {
  hasToken: boolean;
  userId: string | null;
  currentTeamId: string | null;
  /** web 连接上报的本机设备 id（socket.auth.currentDeviceId），用于 device DTO 的 isLocal 判定。 */
  currentDeviceId: string | null;
}

export interface AuthenticatedUserProvider {
  (): Promise<AuthenticatedUserIdentity>;
  setCurrentTeamId?(teamId: string | null): void;
}

export interface SocketLike {
  on(event: string, handler: SocketHandler): void;
  emit?(event: string, payload: unknown): void;
  emitWithAck?(event: string, payload: unknown): Promise<unknown>;
  timeout?(timeoutMs: number): { emitWithAck?(event: string, payload: unknown): Promise<unknown> };
  disconnect?(): void;
}

export type SocketAck = (result: unknown) => void;
export type SocketHandler = (payload: unknown, ack?: SocketAck) => Promise<void>;

type UseCaseName = keyof ServerNextUseCases;
type BindOptions = Pick<WebSocketHandlerOptions, 'authenticatedUser'> & {
  currentTeamFromSession?: boolean;
  requireAuthenticatedUser?: boolean;
};
type DeviceRenameSocketInput = {
  userId: string;
  deviceId: string;
  name: string;
  teamId?: string;
  currentDeviceId?: string | null;
  hostname?: string;
};
const INTERNAL_SOCKET_ERROR_MESSAGE = 'Internal server error';

// deviceScan 下发 request 的统一契约（hello 首推与 web-path 共用）。
export interface DeviceScanEmitRequest {
  requestId: string;
  deviceId: string;
  customAgents?: Array<{ id: string; adapterKind: string; cwd?: string }>;
}

export interface WebSocketHandlerOptions {
  authenticatedUser?: AuthenticatedUserProvider;
  dispatch?(request: DispatchRequestDto & { id: string }): void;
  dispatchCancel?(request: DispatchRequestDto & { id: string }): void;
  dispatchStatus?(dispatch: unknown): void;
  deviceScan?(request: DeviceScanEmitRequest): void;
  deviceSelectDirectory?(request: { deviceId: string }): Promise<{ ok: boolean; path?: string; error?: string }>;
  afterMessageSend?(payload: unknown, result: unknown): Promise<void> | void;
  afterMessagePin?(payload: unknown, result: unknown): Promise<void> | void;
  afterDeviceInviteComplete?(payload: unknown, result: unknown): Promise<void> | void;
  afterDeviceMutation?(payload: unknown, result: unknown): Promise<void> | void;
  /** 设备删除成功后触发：用于向在线 daemon 下发 device:removed 并断开其 socket。 */
  afterDeviceDelete?(payload: unknown, result: unknown): Promise<void> | void;
  afterChannelMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterAgentMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterTeamMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterTaskMutation?(payload: unknown, result: unknown): Promise<void> | void;
}

export interface AgentSocketHandlerOptions {
  afterDeviceInviteWait?(payload: unknown, result: unknown): Promise<void> | void;
  afterDeviceMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterAgentMutation?(payload: unknown, result: unknown): Promise<void> | void;
  // hello 成功后首推 scanRequested（带 customAgents）给该 device，触发 daemon 扫 custom skills。
  // 复用 web 端 requestDeviceScan 的下发通道（按 deviceId emit 到对应 device socket）。
  deviceScan?(request: DeviceScanEmitRequest): void;
}

export function registerWebSocketHandlers(
  socket: SocketLike,
  app: ServerNextUseCases,
  options: WebSocketHandlerOptions = {},
): void {
  bind(socket, WEB_EVENTS.auth.register, app, 'registerUser');
  bind(socket, WEB_EVENTS.auth.login, app, 'loginUser');
  bind(socket, WEB_EVENTS.auth.whoami, app, 'whoami');
  bind(socket, WEB_EVENTS.auth.changePassword, app, 'changePassword', undefined, {
    authenticatedUser: options.authenticatedUser,
    requireAuthenticatedUser: true,
  });
  bind(socket, WEB_EVENTS.team.list, app, 'listTeams', undefined, { authenticatedUser: options.authenticatedUser });
  const afterTeamMutation = (payload: unknown, result: unknown) =>
    options.afterTeamMutation?.(payload, result);
  bind(socket, WEB_EVENTS.team.create, app, 'createTeam', async (payload, result) => {
    updateAuthenticatedCurrentTeam(options.authenticatedUser, result, 'team');
    await afterTeamMutation(payload, result);
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.team.switch, app, 'switchTeam', (_payload, result) => {
    updateAuthenticatedCurrentTeam(options.authenticatedUser, result, 'currentTeam');
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.team.update, app, 'updateTeam', afterTeamMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.team.delete, app, 'deleteTeam', async (payload, result) => {
    updateAuthenticatedCurrentTeam(options.authenticatedUser, result, 'fallbackTeam');
    await afterTeamMutation(payload, result);
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.join.create, app, 'createJoinLink', undefined, { authenticatedUser: options.authenticatedUser, currentTeamFromSession: true });
  bind(socket, WEB_EVENTS.join.validate, app, 'validateJoinLink');
  bind(socket, WEB_EVENTS.join.list, app, 'listJoinLinks', undefined, { authenticatedUser: options.authenticatedUser, currentTeamFromSession: true });
  bind(socket, WEB_EVENTS.join.revoke, app, 'revokeJoinLink', undefined, { authenticatedUser: options.authenticatedUser, currentTeamFromSession: true });
  bind(socket, WEB_EVENTS.deviceInvite.create, app, 'createDeviceInvite', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.deviceInvite.complete, app, 'completeDeviceInvite', (payload, result) =>
    options.afterDeviceInviteComplete?.(payload, result), { authenticatedUser: options.authenticatedUser },
  );
  bind(socket, WEB_EVENTS.device.list, app, 'listDevices', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.device.agentsList, app, 'listDeviceAgents', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.device.get, app, 'getDevice', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.device.scan, app, 'requestDeviceScan', (_payload, result) => {
    if (!options.deviceScan || !isDeviceScanAck(result)) {
      return;
    }
    options.deviceScan(result.request);
  }, { authenticatedUser: options.authenticatedUser });
  const afterDeviceMutation = (payload: unknown, result: unknown) =>
    options.afterDeviceMutation?.(payload, result);
  socket.on(WEB_EVENTS.device.rename, async (payload, ack) => {
    try {
      const input = normalizeDeviceRenameInput(await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser }));
      const result = await app.renameDevice(input);
      ack?.(result);
      await afterDeviceMutation(input, result);
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.device.rename));
    }
  });
  bind(socket, WEB_EVENTS.device.delete, app, 'deleteDevice', async (payload, result) => {
    await afterDeviceMutation(payload, result);
    await options.afterDeviceDelete?.(payload, result);
  }, { authenticatedUser: options.authenticatedUser });
  socket.on(WEB_EVENTS.device.selectDirectory, async (payload, ack) => {
    try {
      const input = await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser });
      const deviceId = (input as { deviceId?: string } | null)?.deviceId;
      if (!deviceId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'deviceId is required'));
        return;
      }
      const userId = (input as { userId?: string } | null)?.userId;
      if (!userId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'userId is required'));
        return;
      }
      const deviceAccess = await app.getDevice({ userId, deviceId });
      if (!isSuccessResult(deviceAccess)) {
        ack?.(deviceAccess);
        return;
      }
      if (!options.deviceSelectDirectory) {
        ack?.(makeFailure('INTERNAL_ERROR', 'deviceSelectDirectory not configured'));
        return;
      }
      const result = await options.deviceSelectDirectory({ deviceId });
      ack?.(result);
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.device.selectDirectory));
    }
  });
  bind(socket, WEB_EVENTS.channel.create, app, 'createChannel', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.update, app, 'updateChannel', undefined, { authenticatedUser: options.authenticatedUser });
  const afterChannelMutation = (payload: unknown, result: unknown) =>
    options.afterChannelMutation?.(payload, result);
  bind(socket, WEB_EVENTS.channel.addMember, app, 'addChannelHumanMember', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.removeMember, app, 'removeChannelHumanMember', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.leave, app, 'leaveChannel', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.addAgent, app, 'addChannelAgentMember', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.removeAgent, app, 'removeChannelAgentMember', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.members, app, 'listChannelMembers', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.archive, app, 'archiveChannel', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.channel.delete, app, 'deleteChannel', afterChannelMutation, { authenticatedUser: options.authenticatedUser });
  socket.on(WEB_EVENTS.channel.join, async (payload, ack) => {
    try {
      const input = asChannelJoinInput(await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser }));
      if (!input) {
        ack?.(makeFailure('VALIDATION_ERROR', 'Invalid channel join payload'));
        return;
      }
      const channels = await app.listChannels({ userId: input.userId, teamId: input.teamId });
      if (channels.ok) {
        const channel = channels.channels.find((candidate) => candidate.id === input.channelId);
        if (channel) {
          const messages = await app.listChannelMessages({ channelId: input.channelId, limit: input.limit });
          if (!messages.ok) {
            ack?.(messages);
            return;
          }
          socket.emit?.(WEB_EVENTS.channel.history, { channelId: input.channelId, messages: messages.messages });
          ack?.({ ok: true, channel, messages: messages.messages });
          return;
        }
      }
      // Channel not found in regular channels — try DM
      const dmResult = await app.snapshotDirectMessage({ userId: input.userId, teamId: input.teamId, channelId: input.channelId, limit: input.limit });
      if (!dmResult.ok) {
        ack?.(dmResult);
        return;
      }
      socket.emit?.(WEB_EVENTS.channel.history, { channelId: input.channelId, messages: dmResult.messages });
      ack?.({ ok: true, channel: dmResult.dm.channel, messages: dmResult.messages });
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.channel.join));
    }
  });
  bind(socket, WEB_EVENTS.agent.create, app, 'createCustomAgent', (payload, result) =>
    options.afterAgentMutation?.(payload, result), { authenticatedUser: options.authenticatedUser },
  );
  // 切换 Agent 在 primary team 上的可见性：payload 字段为 teamId（不是 publish 的 targetTeamId）
  socket.on(WEB_EVENTS.agent.setVisibility, async (payload, ack) => {
    try {
      const input = await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser });
      const result = await app.setAgentTeamVisibility(input as Parameters<ServerNextUseCases['setAgentTeamVisibility']>[0]);
      ack?.(result);
      await options.afterAgentMutation?.(withChannelTeamIds(input, [payloadString(input, 'teamId')]), result);
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.agent.setVisibility));
    }
  });
  bind(socket, WEB_EVENTS.agent.updateConfig, app, 'updateAgentConfig', (payload, result) =>
    options.afterAgentMutation?.(payload, result), { authenticatedUser: options.authenticatedUser },
  );
  socket.on(WEB_EVENTS.agent.delete, async (payload, ack) => {
    try {
      const input = await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser });
      const affectedTeamIds = await visibleAgentTeamIds(app, input);
      const result = await app.deleteAgent(input as Parameters<ServerNextUseCases['deleteAgent']>[0]);
      ack?.(result);
      await options.afterAgentMutation?.(withAffectedAgentTeamIds(input, affectedTeamIds), result);
    } catch (error) {
      ack?.(socketErrorAck(error));
    }
  });
  bind(socket, WEB_EVENTS.agent.metrics, app, 'summarizeAgentMetrics', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.admin.listTeams, app, 'listAdminTeams', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.admin.listNetworks, app, 'listAdminNetworks', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.admin.listUsers, app, 'listAdminUsers', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.admin.listDevices, app, 'listAdminDevices', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.admin.listAgents, app, 'listAdminAgents', undefined, { authenticatedUser: options.authenticatedUser });
  socket.on(WEB_EVENTS.admin.deleteTeam, async (payload, ack) => {
    try {
      const userId = await requireAuthenticatedSocketUser(options.authenticatedUser);
      const teamId = payloadString(payload, 'teamId');
      if (!teamId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'teamId is required'));
        return;
      }
      ack?.(await app.deleteAdminTeam({ userId, teamId }));
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.admin.deleteTeam));
    }
  });
  socket.on(WEB_EVENTS.admin.deleteNetwork, async (payload, ack) => {
    try {
      const userId = await requireAuthenticatedSocketUser(options.authenticatedUser);
      const teamId = payloadString(payload, 'networkId') ?? payloadString(payload, 'teamId');
      if (!teamId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'networkId is required'));
        return;
      }
      ack?.(await app.deleteAdminTeam({ userId, teamId }));
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.admin.deleteNetwork));
    }
  });
  socket.on(WEB_EVENTS.admin.deleteUser, async (payload, ack) => {
    try {
      const adminUserId = await requireAuthenticatedSocketUser(options.authenticatedUser);
      const targetUserId = payloadString(payload, 'userId') ?? payloadString(payload, 'targetUserId');
      if (!targetUserId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'userId is required'));
        return;
      }
      ack?.(await app.deleteAdminUser({ adminUserId, targetUserId }));
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.admin.deleteUser));
    }
  });
  bind(socket, WEB_EVENTS.admin.deleteAgent, app, 'deleteAdminAgent', undefined, { authenticatedUser: options.authenticatedUser });
  socket.on(WEB_EVENTS.admin.transferDeviceOwner, async (payload, ack) => {
    try {
      const adminUserId = await requireAuthenticatedSocketUser(options.authenticatedUser);
      const deviceId = payloadString(payload, 'deviceId');
      const targetUserId = payloadString(payload, 'userId') ?? payloadString(payload, 'targetUserId');
      if (!deviceId || !targetUserId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'deviceId and userId are required'));
        return;
      }
      ack?.(await app.transferDeviceOwnerAsAdmin({ adminUserId, deviceId, targetUserId }));
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.admin.transferDeviceOwner));
    }
  });
  bind(socket, WEB_EVENTS.message.send, app, 'sendMessage', async (_payload, result) => {
    await options.afterMessageSend?.(_payload, result);
    if (isSendMessageAck(result) && result.task) {
      await options.afterTaskMutation?.(_payload, result);
    }
    // afterAgentMutation（全量 refreshAgentSubscribers 扇出）仅在确实产生 dispatch
    //（即写入了 busy）时触发；普通聊天消息不得引发 agent 状态推送（性能回归）。
    if (isSendMessageAck(result) && result.dispatches.length > 0) {
      await options.afterAgentMutation?.(_payload, result);
    }
    if (!options.dispatch || !isSendMessageAck(result)) {
      return;
    }
    for (const dispatch of result.dispatches) {
      const request = await app.getDispatchRequest({ dispatchId: dispatch.id });
      if (request.ok) {
        options.dispatch(request.request);
      }
    }
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.search, app, 'searchMessages', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.context, app, 'getMessageContext', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.react, app, 'reactMessage', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.save, app, 'saveMessage', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.listSaved, app, 'listSavedMessages', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.pin, app, 'pinMessage', (payload, result) => options.afterMessagePin?.(payload, result), { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.listPinned, app, 'listPinnedMessages', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.delete, app, 'deleteMessage', async (payload, result) => {
    await options.afterMessageSend?.(payload, result);
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.message.convertToTask, app, 'convertMessageToTask', async (payload, result) => {
    await options.afterTaskMutation?.(payload, result);
    await options.afterMessageSend?.(payload, result);
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.member.updateRole, app, 'updateMemberRole', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.member.remove, app, 'removeMember', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.member.transferOwner, app, 'transferOwner', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.member.list, app, 'listMembers', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.member.updateHuman, app, 'updateMemberHuman', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.dispatch.cancel, app, 'cancelDispatch', async (_payload, result) => {
    if (!isDispatchAck(result)) {
      return;
    }
    await options.afterAgentMutation?.(_payload, result);
    options.dispatchStatus?.(result.dispatch);
    if (!options.dispatchCancel) {
      return;
    }
    const request = await app.getDispatchRequest({ dispatchId: result.dispatch.id });
    if (request.ok) {
      options.dispatchCancel(request.request);
    }
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.dispatch.cancelChannel, app, 'cancelChannelDispatches', async (_payload, result) => {
    if (!isDispatchListAck(result)) {
      return;
    }
    await options.afterAgentMutation?.(_payload, result);
    for (const dispatch of result.dispatches) {
      options.dispatchStatus?.(dispatch);
      if (!options.dispatchCancel) {
        continue;
      }
      const request = await app.getDispatchRequest({ dispatchId: dispatch.id });
      if (request.ok) {
        options.dispatchCancel(request.request);
      }
    }
  }, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.task.list, app, 'listTasks', undefined, { authenticatedUser: options.authenticatedUser });
  const afterTaskMutation = (payload: unknown, result: unknown) =>
    options.afterTaskMutation?.(payload, result);
  bind(socket, WEB_EVENTS.task.create, app, 'createTask', afterTaskMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.task.update, app, 'updateTask', afterTaskMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.task.delete, app, 'deleteTask', afterTaskMutation, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.task.reorder, app, 'reorderTask', afterTaskMutation, { authenticatedUser: options.authenticatedUser });
}

export function registerAgentSocketHandlers(
  socket: SocketLike,
  app: ServerNextUseCases,
  options: AgentSocketHandlerOptions = {},
): void {
  bind(socket, AGENT_EVENTS.deviceInvite.wait, app, 'waitForDeviceInvite', (payload, result) =>
    options.afterDeviceInviteWait?.(payload, result),
  );
  const afterDeviceMutation = (payload: unknown, result: unknown) =>
    options.afterDeviceMutation?.(payload, result);
  socket.on(AGENT_EVENTS.device.hello, async (payload, ack) => {
    try {
      const useCredentials =
        payload && typeof payload === 'object' && typeof (payload as { token?: unknown }).token === 'string';
      const result = useCredentials
        ? await app.deviceHelloFromCredentials(payload as Parameters<ServerNextUseCases['deviceHelloFromCredentials']>[0])
        : await app.deviceHello(payload as Parameters<ServerNextUseCases['deviceHello']>[0]);
      ack?.(result);
      await afterDeviceMutation(payload, result);

      // hello 成功后首推一次 scanRequested（带 customAgents），触发 daemon 扫 custom skills。
      // device 连接无 web userId，走 buildDeviceScanRequest（跳过 isMember 校验）。
      // 仅当 device 有 custom agent 时才首推，避免无谓 scanRequested 风暴。
      // 首推失败不影响 hello ack（已返回），仅记录日志。
      if (isSuccessResult(result) && options.deviceScan) {
        const deviceId = (result as { device?: { id?: string } }).device?.id;
        if (deviceId) {
          try {
            const scan = await app.buildDeviceScanRequest({ deviceId });
            if (isSuccessResult(scan) && !(scan as { skipped?: boolean }).skipped) {
              const request = (scan as { request?: { requestId: string; deviceId: string; customAgents?: Array<{ id: string; adapterKind: string; cwd?: string }> } }).request;
              if (request) {
                options.deviceScan(request);
              }
            }
          } catch (scanError) {
            console.warn('[server-next] hello 首推 scanRequested 失败（non-blocking）:', scanError);
          }
        }
      }
    } catch (error) {
      ack?.(socketErrorAck(error, AGENT_EVENTS.device.hello));
    }
  });
  bind(socket, AGENT_EVENTS.device.runtimes, app, 'reportDeviceRuntimes', afterDeviceMutation);
  const afterAgentMutation = (payload: unknown, result: unknown) =>
    options.afterAgentMutation?.(payload, result);
  bind(socket, AGENT_EVENTS.agent.registerBatch, app, 'registerDiscoveredAgents', afterAgentMutation);
  bind(socket, AGENT_EVENTS.agent.reportCustomSkills, app, 'reportCustomSkills', afterAgentMutation);
  bind(socket, AGENT_EVENTS.dispatch.result, app, 'receiveDispatchResult', afterAgentMutation);
  bind(socket, AGENT_EVENTS.dispatch.error, app, 'receiveDispatchError', afterAgentMutation);
}

function bind(
  socket: SocketLike,
  event: string,
  app: ServerNextUseCases,
  methodName: UseCaseName,
  afterResult?: (payload: unknown, result: unknown) => Promise<void> | void,
  options: BindOptions = {},
): void {
  socket.on(event, async (payload, ack) => {
    try {
      const method = app[methodName] as (input: unknown) => Promise<unknown>;
      const input = await withAuthenticatedUserId(payload, options);
      const result = await method(input);
      ack?.(result);
      await afterResult?.(input, result);
    } catch (error) {
      ack?.(socketErrorAck(error, event));
    }
  });
}

async function visibleAgentTeamIds(app: ServerNextUseCases, payload: unknown): Promise<string[]> {
  const teamId = payloadString(payload, 'teamId');
  const agentId = payloadString(payload, 'agentId');
  if (!teamId || !agentId) {
    return [];
  }
  const result = await app.listVisibleAgents({ teamId });
  if (!result.ok) {
    return [];
  }
  return result.agents.find((agent) => agent.id === agentId)?.visibleTeamIds ?? [];
}

function withChannelTeamIds(payload: unknown, teamIds: Array<string | undefined>): unknown {
  return withStringArrayPayload(payload, 'channelTeamIds', teamIds);
}

function withAffectedAgentTeamIds(payload: unknown, teamIds: string[]): unknown {
  const withAffected = withStringArrayPayload(payload, 'affectedTeamIds', teamIds);
  return withStringArrayPayload(withAffected, 'channelTeamIds', teamIds);
}

function withStringArrayPayload(payload: unknown, key: string, values: Array<string | undefined>): unknown {
  const strings = uniqueStrings(values);
  if (strings.length === 0 || !payload || typeof payload !== 'object') {
    return payload;
  }
  return { ...payload, [key]: strings };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function socketErrorAck(error: unknown, event?: string) {
  if (error instanceof UnauthenticatedSocketError) {
    return makeFailure('UNAUTHENTICATED', 'Invalid session token');
  }
  // 记录完整异常堆栈，避免 INTERNAL_ERROR 的真实原因被吞掉
  // （曾因 join_links 表缺失仅回 INTERNAL_ERROR、无任何日志，导致问题难以定位）
  console.error(
    `[server-next] socket handler${event ? ` "${event}"` : ''} threw:`,
    error instanceof Error ? error.stack ?? error.message : error,
  );
  return makeFailure('INTERNAL_ERROR', INTERNAL_SOCKET_ERROR_MESSAGE);
}

async function requireAuthenticatedSocketUser(
  authenticatedUser: AuthenticatedUserProvider | undefined,
): Promise<string> {
  if (!authenticatedUser) {
    throw new UnauthenticatedSocketError();
  }
  const auth = await authenticatedUser();
  if (!auth.hasToken || !auth.userId) {
    throw new UnauthenticatedSocketError();
  }
  return auth.userId;
}

function updateAuthenticatedCurrentTeam(
  authenticatedUser: AuthenticatedUserProvider | undefined,
  result: unknown,
  key: 'team' | 'currentTeam' | 'fallbackTeam',
): void {
  if (!isSuccessResult(result)) {
    return;
  }
  const team = (result as Record<string, unknown>)[key];
  if (team === null) {
    authenticatedUser?.setCurrentTeamId?.(null);
    return;
  }
  if (team && typeof team === 'object') {
    const id = (team as { id?: unknown }).id;
    if (typeof id === 'string') {
      authenticatedUser?.setCurrentTeamId?.(id);
    }
  }
}

function isSuccessResult(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}

async function withAuthenticatedUserId(
  payload: unknown,
  options: BindOptions = {},
): Promise<unknown> {
  const { authenticatedUser } = options;
  if (options.requireAuthenticatedUser) {
    if (!authenticatedUser) {
      throw new UnauthenticatedSocketError();
    }
    const auth = await authenticatedUser();
    if (!auth.hasToken || !auth.userId) {
      throw new UnauthenticatedSocketError();
    }
    const enriched: Record<string, unknown> = payload && typeof payload === 'object'
      ? { ...payload, userId: auth.userId }
      : { userId: auth.userId };
    if (auth.currentTeamId && (options.currentTeamFromSession || enriched.teamId === undefined)) {
      enriched.teamId = auth.currentTeamId;
    }
    enriched.currentDeviceId = auth.currentDeviceId ?? null;
    return enriched;
  }
  if (!payload || typeof payload !== 'object' || !authenticatedUser) {
    return payload;
  }
  const auth = await authenticatedUser();
  if (!auth.hasToken) {
    return payload;
  }
  if (!auth.userId) {
    throw new UnauthenticatedSocketError();
  }
  const enriched: Record<string, unknown> = { ...payload, userId: auth.userId };
  if (auth.currentTeamId && (options.currentTeamFromSession || enriched.teamId === undefined)) {
    enriched.teamId = auth.currentTeamId;
  }
  enriched.currentDeviceId = auth.currentDeviceId ?? null;
  return enriched;
}

function normalizeDeviceRenameInput(payload: unknown): DeviceRenameSocketInput {
  if (!payload || typeof payload !== 'object') {
    return payload as never;
  }
  const record = payload as Record<string, unknown>;
  const legacyHostname = typeof record.hostname === 'string' ? record.hostname : undefined;
  if (typeof record.name === 'string' || legacyHostname === undefined) {
    return record as DeviceRenameSocketInput;
  }
  return { ...record, name: legacyHostname } as DeviceRenameSocketInput;
}

export class UnauthenticatedSocketError extends Error {
  constructor() {
    super('Invalid session token');
  }
}

function asChannelJoinInput(payload: unknown): { userId: string; teamId: string; channelId: string; limit: number } | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { userId?: unknown; teamId?: unknown; channelId?: unknown; limit?: unknown };
  if (
    typeof candidate.userId !== 'string' ||
    typeof candidate.teamId !== 'string' ||
    typeof candidate.channelId !== 'string'
  ) {
    return null;
  }
  const limit = typeof candidate.limit === 'number' && Number.isInteger(candidate.limit)
    ? candidate.limit
    : 50;
  return {
    userId: candidate.userId,
    teamId: candidate.teamId,
    channelId: candidate.channelId,
    limit: Math.min(Math.max(limit, 1), 200),
  };
}

function isDeviceScanAck(result: unknown): result is {
  ok: true;
  request: {
    requestId: string;
    deviceId: string;
  };
} {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const request = (result as { ok?: unknown; request?: { requestId?: unknown; deviceId?: unknown } }).request;
  return (
    (result as { ok?: unknown }).ok === true &&
    typeof request?.requestId === 'string' &&
    typeof request?.deviceId === 'string'
  );
}

function isSendMessageAck(result: unknown): result is {
  ok: true;
  message: { body: string };
  task?: unknown;
  dispatches: Array<{
    id: string;
    teamId: string;
    channelId: string;
    messageId: string;
    agentId: string;
    requestId: string;
  }>;
} {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const candidate = result as { ok?: unknown; message?: { body?: unknown }; dispatches?: unknown };
  return (
    candidate.ok === true &&
    typeof candidate.message?.body === 'string' &&
    Array.isArray(candidate.dispatches)
  );
}

function isDispatchAck(result: unknown): result is { ok: true; dispatch: { id: string } } {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const candidate = result as { ok?: unknown; dispatch?: { id?: unknown } };
  return candidate.ok === true && typeof candidate.dispatch?.id === 'string';
}

function isDispatchListAck(result: unknown): result is { ok: true; dispatches: Array<{ id: string }> } {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const candidate = result as { ok?: unknown; dispatches?: unknown };
  return candidate.ok === true &&
    Array.isArray(candidate.dispatches) &&
    candidate.dispatches.every((dispatch) => Boolean(dispatch && typeof dispatch === 'object' && typeof (dispatch as { id?: unknown }).id === 'string'));
}
