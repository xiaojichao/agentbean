import { WEB_EVENTS } from '../../../packages/contracts/src/index';
import type {
  AgentDto,
  ChannelAgentMemberCommandDto,
  ChannelDto,
  ChannelHumanMemberCommandDto,
  CreateChannelCommandDto,
  DispatchDto,
  ListChannelMembersCommandDto,
  MessageDto,
  UpdateChannelCommandDto,
} from '../../../packages/contracts/src/index';

export interface WebSocketTransport {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
}

export interface RegisterInput {
  username: string;
  password: string;
  teamName: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface ListTeamsInput {
  userId: string;
}

export interface SendMessageInput {
  userId: string;
  teamId: string;
  channelId: string;
  body: string;
  clientMessageId?: string;
}

export interface SubscribeInput {
  userId: string;
  teamId: string;
}

export interface WebSocketClient {
  register(input: RegisterInput): Promise<unknown>;
  login(input: LoginInput): Promise<unknown>;
  listTeams(input: ListTeamsInput): Promise<unknown>;
  subscribeAgents(input: SubscribeInput, onSnapshot: (agents: AgentDto[]) => void): Promise<unknown>;
  subscribeChannels(input: SubscribeInput, onSnapshot: (channels: ChannelDto[]) => void): Promise<unknown>;
  onChannelMessage(handler: (message: MessageDto) => void): void;
  onDispatchStatus(handler: (dispatch: DispatchDto) => void): void;
  createChannel(input: CreateChannelCommandDto): Promise<unknown>;
  updateChannel(input: UpdateChannelCommandDto): Promise<unknown>;
  addChannelHumanMember(input: ChannelHumanMemberCommandDto): Promise<unknown>;
  removeChannelHumanMember(input: ChannelHumanMemberCommandDto): Promise<unknown>;
  addChannelAgentMember(input: ChannelAgentMemberCommandDto): Promise<unknown>;
  removeChannelAgentMember(input: ChannelAgentMemberCommandDto): Promise<unknown>;
  listChannelMembers(input: ListChannelMembersCommandDto): Promise<unknown>;
  sendMessage(input: SendMessageInput): Promise<unknown>;
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
  let onAgentSnapshot: ((agents: AgentDto[]) => void) | undefined;
  let onChannelSnapshot: ((channels: ChannelDto[]) => void) | undefined;

  transport.on('connect', () => {
    if (agentSubscription) {
      void transport.emitWithAck(WEB_EVENTS.agent.subscribe, agentSubscription);
    }
    if (channelSubscription) {
      void transport.emitWithAck(WEB_EVENTS.channel.subscribe, channelSubscription);
    }
  });
  transport.on(WEB_EVENTS.agent.snapshot, (payload) => {
    onAgentSnapshot?.(payload as AgentDto[]);
  });
  transport.on(WEB_EVENTS.channel.snapshot, (payload) => {
    onChannelSnapshot?.(payload as ChannelDto[]);
  });

  return {
    register(input) {
      return transport.emitWithAck(WEB_EVENTS.auth.register, input);
    },
    login(input) {
      return transport.emitWithAck(WEB_EVENTS.auth.login, input);
    },
    listTeams(input) {
      return transport.emitWithAck(WEB_EVENTS.team.list, input);
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
    sendMessage(input) {
      return transport.emitWithAck(WEB_EVENTS.message.send, input);
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
