import { WEB_EVENTS } from '../../../packages/contracts/src/index';
import type { CreateChannelCommandDto, UpdateChannelCommandDto } from '../../../packages/contracts/src/index';

export interface WebSocketTransport {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
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

export interface WebSocketClient {
  register(input: RegisterInput): Promise<unknown>;
  login(input: LoginInput): Promise<unknown>;
  listTeams(input: ListTeamsInput): Promise<unknown>;
  createChannel(input: CreateChannelCommandDto): Promise<unknown>;
  updateChannel(input: UpdateChannelCommandDto): Promise<unknown>;
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
    createChannel(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.create, input);
    },
    updateChannel(input) {
      return transport.emitWithAck(WEB_EVENTS.channel.update, input);
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
