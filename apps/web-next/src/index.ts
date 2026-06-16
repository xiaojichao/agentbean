import { WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import type {
  AgentDto,
  ChannelAgentMemberCommandDto,
  ChannelDto,
  ChannelHumanMemberCommandDto,
  CreateAgentCommandDto,
  CreateChannelCommandDto,
  DeviceDto,
  DispatchDto,
  ListChannelMembersCommandDto,
  MessageDto,
  RuntimeDto,
  UpdateChannelCommandDto,
  CreateJoinLinkCommandDto,
  ListJoinLinksCommandDto,
  RevokeJoinLinkCommandDto,
  CreateDeviceInviteCommandDto,
  CompleteDeviceInviteCommandDto,
  ValidateJoinLinkCommandDto,
  DeleteAgentCommandDto,
  PublishAgentCommandDto,
  UnpublishAgentCommandDto,
  UpdateAgentConfigCommandDto,
} from '../../../packages/contracts/src/index.js';

export interface WebSocketTransport {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
}

export interface RegisterInput {
  username: string;
  password: string;
  teamName: string;
  joinCode?: string;
}

export interface LoginInput {
  username: string;
  password: string;
  joinCode?: string;
}

export interface ListTeamsInput {
  userId?: string;
}

export interface CreateTeamInput {
  userId?: string;
  name: string;
}

export interface SwitchTeamInput {
  userId?: string;
  teamId: string;
}

export interface SendMessageInput {
  userId?: string;
  teamId: string;
  channelId: string;
  body: string;
  artifactIds?: string[];
  clientMessageId?: string;
}

export interface SubscribeInput {
  userId?: string;
  teamId: string;
}

export interface CancelDispatchInput {
  userId?: string;
  dispatchId: string;
}

type SessionDeviceCommandInput = { userId?: string; deviceId: string };
type SessionCreateChannelInput = Omit<CreateChannelCommandDto, 'userId'> & { userId?: string };
type SessionUpdateChannelInput = Omit<UpdateChannelCommandDto, 'userId'> & { userId?: string };
type SessionChannelHumanMemberInput = Omit<ChannelHumanMemberCommandDto, 'userId'> & { userId?: string };
type SessionChannelAgentMemberInput = Omit<ChannelAgentMemberCommandDto, 'userId'> & { userId?: string };
type SessionListChannelMembersInput = Omit<ListChannelMembersCommandDto, 'userId'> & { userId?: string };
type SessionCreateAgentInput = Omit<CreateAgentCommandDto, 'userId'> & { userId?: string };
type SessionPublishAgentInput = Omit<PublishAgentCommandDto, 'userId'> & { userId?: string };
type SessionUnpublishAgentInput = Omit<UnpublishAgentCommandDto, 'userId'> & { userId?: string };
type SessionUpdateAgentConfigInput = Omit<UpdateAgentConfigCommandDto, 'userId'> & { userId?: string };
type SessionDeleteAgentInput = Omit<DeleteAgentCommandDto, 'userId'> & { userId?: string };
type SessionCreateJoinLinkInput = Omit<CreateJoinLinkCommandDto, 'userId'> & { userId?: string };
type SessionListJoinLinksInput = Omit<ListJoinLinksCommandDto, 'userId'> & { userId?: string };
type SessionRevokeJoinLinkInput = Omit<RevokeJoinLinkCommandDto, 'userId'> & { userId?: string };
type SessionCreateDeviceInviteInput = Omit<CreateDeviceInviteCommandDto, 'userId'> & { userId?: string };
type SessionCompleteDeviceInviteInput = Omit<CompleteDeviceInviteCommandDto, 'userId'> & { userId?: string };

export interface WebSocketClient {
  register(input: RegisterInput): Promise<unknown>;
  login(input: LoginInput): Promise<unknown>;
  whoami(input: { token: string }): Promise<unknown>;
  listTeams(input: ListTeamsInput): Promise<unknown>;
  createTeam(input: CreateTeamInput): Promise<unknown>;
  switchTeam(input: SwitchTeamInput): Promise<unknown>;
  createJoinLink(input: SessionCreateJoinLinkInput): Promise<unknown>;
  validateJoinLink(input: ValidateJoinLinkCommandDto): Promise<unknown>;
  listJoinLinks(input: SessionListJoinLinksInput): Promise<unknown>;
  revokeJoinLink(input: SessionRevokeJoinLinkInput): Promise<unknown>;
  createDeviceInvite(input: SessionCreateDeviceInviteInput): Promise<unknown>;
  completeDeviceInvite(input: SessionCompleteDeviceInviteInput): Promise<unknown>;
  listDevices(input: SubscribeInput, onSnapshot?: (devices: DeviceDto[]) => void): Promise<unknown>;
  getDevice(input: SessionDeviceCommandInput): Promise<unknown>;
  scanDevice(input: SessionDeviceCommandInput): Promise<unknown>;
  subscribeAgents(input: SubscribeInput, onSnapshot: (agents: AgentDto[]) => void): Promise<unknown>;
  subscribeChannels(input: SubscribeInput, onSnapshot: (channels: ChannelDto[]) => void): Promise<unknown>;
  onDeviceRuntimes(handler: (payload: { deviceId: string; runtimes: RuntimeDto[] }) => void): void;
  onChannelMessage(handler: (message: MessageDto) => void): void;
  onDispatchStatus(handler: (dispatch: DispatchDto) => void): void;
  createChannel(input: SessionCreateChannelInput): Promise<unknown>;
  updateChannel(input: SessionUpdateChannelInput): Promise<unknown>;
  addChannelHumanMember(input: SessionChannelHumanMemberInput): Promise<unknown>;
  removeChannelHumanMember(input: SessionChannelHumanMemberInput): Promise<unknown>;
  addChannelAgentMember(input: SessionChannelAgentMemberInput): Promise<unknown>;
  removeChannelAgentMember(input: SessionChannelAgentMemberInput): Promise<unknown>;
  listChannelMembers(input: SessionListChannelMembersInput): Promise<unknown>;
  createAgent(input: SessionCreateAgentInput): Promise<unknown>;
  publishAgent(input: SessionPublishAgentInput): Promise<unknown>;
  unpublishAgent(input: SessionUnpublishAgentInput): Promise<unknown>;
  updateAgentConfig(input: SessionUpdateAgentConfigInput): Promise<unknown>;
  deleteAgent(input: SessionDeleteAgentInput): Promise<unknown>;
  sendMessage(input: SendMessageInput): Promise<unknown>;
  cancelDispatch(input: CancelDispatchInput): Promise<unknown>;
}

export interface SessionSnapshot {
  token?: string;
  currentTeamId?: string;
  [key: string]: unknown;
}

export interface SessionStore {
  save(snapshot: SessionSnapshot): void;
  load(): { token?: string; currentTeamId?: string };
}

export function createWebSocketClient(transport: WebSocketTransport): WebSocketClient {
  let agentSubscription: SubscribeInput | undefined;
  let channelSubscription: SubscribeInput | undefined;
  let deviceSubscription: SubscribeInput | undefined;
  let onAgentSnapshot: ((agents: AgentDto[]) => void) | undefined;
  let onChannelSnapshot: ((channels: ChannelDto[]) => void) | undefined;
  let onDeviceSnapshot: ((devices: DeviceDto[]) => void) | undefined;

  transport.on('connect', () => {
    if (agentSubscription) {
      void transport.emitWithAck(WEB_EVENTS.agent.subscribe, agentSubscription);
    }
    if (channelSubscription) {
      void transport.emitWithAck(WEB_EVENTS.channel.subscribe, channelSubscription);
    }
    if (deviceSubscription) {
      void transport.emitWithAck(WEB_EVENTS.device.list, deviceSubscription);
    }
  });
  transport.on(WEB_EVENTS.agent.snapshot, (payload) => {
    onAgentSnapshot?.(payload as AgentDto[]);
  });
  transport.on(WEB_EVENTS.channel.snapshot, (payload) => {
    onChannelSnapshot?.(payload as ChannelDto[]);
  });
  transport.on(WEB_EVENTS.device.snapshot, (payload) => {
    onDeviceSnapshot?.(payload as DeviceDto[]);
  });

  return {
    register(input) {
      return transport.emitWithAck(WEB_EVENTS.auth.register, input);
    },
    login(input) {
      return transport.emitWithAck(WEB_EVENTS.auth.login, input);
    },
    whoami(input) {
      return transport.emitWithAck(WEB_EVENTS.auth.whoami, input);
    },
    listTeams(input) {
      return transport.emitWithAck(WEB_EVENTS.team.list, input);
    },
    createTeam(input) {
      return transport.emitWithAck(WEB_EVENTS.team.create, input);
    },
    switchTeam(input) {
      return transport.emitWithAck(WEB_EVENTS.team.switch, input);
    },
    createJoinLink(input) {
      return transport.emitWithAck(WEB_EVENTS.join.create, input);
    },
    validateJoinLink(input) {
      return transport.emitWithAck(WEB_EVENTS.join.validate, input);
    },
    listJoinLinks(input) {
      return transport.emitWithAck(WEB_EVENTS.join.list, input);
    },
    revokeJoinLink(input) {
      return transport.emitWithAck(WEB_EVENTS.join.revoke, input);
    },
    createDeviceInvite(input) {
      return transport.emitWithAck(WEB_EVENTS.deviceInvite.create, input);
    },
    completeDeviceInvite(input) {
      return transport.emitWithAck(WEB_EVENTS.deviceInvite.complete, input);
    },
    listDevices(input, onSnapshot) {
      deviceSubscription = input;
      onDeviceSnapshot = onSnapshot;
      return transport.emitWithAck(WEB_EVENTS.device.list, input);
    },
    getDevice(input) {
      return transport.emitWithAck(WEB_EVENTS.device.get, input);
    },
    scanDevice(input) {
      return transport.emitWithAck(WEB_EVENTS.device.scan, input);
    },
    subscribeAgents(input, onSnapshot) {
      agentSubscription = input;
      onAgentSnapshot = onSnapshot;
      return transport.emitWithAck(WEB_EVENTS.agent.subscribe, input);
    },
    subscribeChannels(input, onSnapshot) {
      channelSubscription = input;
      onChannelSnapshot = onSnapshot;
      return transport.emitWithAck(WEB_EVENTS.channel.subscribe, input);
    },
    onChannelMessage(handler) {
      transport.on(WEB_EVENTS.channel.message, (payload) => {
        handler(payload as MessageDto);
      });
    },
    onDispatchStatus(handler) {
      transport.on(WEB_EVENTS.message.dispatchStatus, (payload) => {
        handler(payload as DispatchDto);
      });
    },
    onDeviceRuntimes(handler) {
      transport.on(WEB_EVENTS.device.runtimes, (payload) => {
        handler(payload as { deviceId: string; runtimes: RuntimeDto[] });
      });
    },
    createChannel(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.create, input);
    },
    updateChannel(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.update, input);
    },
    addChannelHumanMember(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.addMember, input);
    },
    removeChannelHumanMember(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.removeMember, input);
    },
    addChannelAgentMember(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.addAgent, input);
    },
    removeChannelAgentMember(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.removeAgent, input);
    },
    listChannelMembers(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.members, input);
    },
    createAgent(input) {
      return transport.emitWithAck(WEB_EVENTS.agent.create, input);
    },
    publishAgent(input) {
      return transport.emitWithAck(WEB_EVENTS.agent.publish, input);
    },
    unpublishAgent(input) {
      return transport.emitWithAck(WEB_EVENTS.agent.unpublish, input);
    },
    updateAgentConfig(input) {
      return transport.emitWithAck(WEB_EVENTS.agent.updateConfig, input);
    },
    deleteAgent(input) {
      return transport.emitWithAck(WEB_EVENTS.agent.delete, input);
    },
    sendMessage(input) {
      return transport.emitWithAck(WEB_EVENTS.message.send, input);
    },
    cancelDispatch(input) {
      return transport.emitWithAck(WEB_EVENTS.dispatch.cancel, input);
    },
  };
}

export function createSessionStore(): SessionStore {
  let state: { token?: string; currentTeamId?: string } = {};
  return {
    save(snapshot) {
      state = {
        token: snapshot.token,
        currentTeamId: snapshot.currentTeamId,
      };
    },
    load() {
      return { ...state };
    },
  };
}

export function applyAgentSnapshot<T>(_current: T[], snapshot: T[]): T[] {
  return [...snapshot];
}

export function applyChannelSnapshot<T>(_current: T[], snapshot: T[]): T[] {
  return [...snapshot];
}

export function appendConversationMessage<T>(current: T[], message: T): T[] {
  return [...current, message];
}

export function applyDispatchStatus<T extends { id: string }>(current: T[], dispatch: T): T[] {
  const index = current.findIndex((candidate) => candidate.id === dispatch.id);
  if (index < 0) {
    return [...current, dispatch];
  }

  return current.map((candidate, candidateIndex) => (candidateIndex === index ? dispatch : candidate));
}
