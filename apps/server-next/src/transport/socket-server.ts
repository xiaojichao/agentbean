import type { ServerNextUseCases } from '../application/usecases';
import { AGENT_EVENTS } from '../../../../packages/contracts/src/index';
import { registerAgentSocketHandlers, registerWebSocketHandlers, type SocketLike } from './socket-handlers';

export interface NamespaceLike {
  on(event: 'connection', handler: (socket: SocketLike) => void): void;
  emit?(event: string, payload: unknown): void;
}

export interface SocketServerLike {
  of(namespace: '/web' | '/agent'): NamespaceLike;
}

export function attachServerNextNamespaces(server: SocketServerLike, app: ServerNextUseCases): void {
  const agentNamespace = server.of('/agent');
  server.of('/web').on('connection', (socket) => {
    registerWebSocketHandlers(socket, app, {
      dispatch(request) {
        agentNamespace.emit?.(AGENT_EVENTS.dispatch.request, request);
      },
    });
  });
  agentNamespace.on('connection', (socket) => {
    registerAgentSocketHandlers(socket, app);
  });
}
