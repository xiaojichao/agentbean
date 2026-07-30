import type {
  SystemActivityCommandName,
  SystemActivityCommandResponseV1,
  SystemActivityQueryName,
  SystemActivityQueryResponseV1,
} from '../../../../packages/contracts/src/system-activity.js';
import {
  parseSystemActivityCommandEnvelopeV1,
} from '../../../../packages/contracts/src/system-activity.js';
import {
  handleAckChangeFeedCursor,
  handleMarkAttentionSeen,
  handleProjectSourceFact,
  handleRetrimAudience,
  handleSystemActivityQuery,
  type SystemActivityHandlerDeps,
} from './system-activity-handler.js';

/**
 * #929 System activity command/query 派发（封闭 registry）。
 * envelope.commandName / queryName 路由到对应 handler。
 */
export interface SystemActivityDispatcher {
  dispatchCommand(input: {
    envelope: unknown;
    payload: unknown;
  }): Promise<SystemActivityCommandResponseV1>;
  dispatchQuery(input: {
    queryName: SystemActivityQueryName;
    payload: unknown;
  }): Promise<SystemActivityQueryResponseV1>;
}

export function createSystemActivityDispatcher(
  deps: SystemActivityHandlerDeps,
): SystemActivityDispatcher {
  return {
    async dispatchCommand({ envelope, payload }) {
      let commandName: SystemActivityCommandName;
      try {
        commandName = parseSystemActivityCommandEnvelopeV1(envelope).commandName;
      } catch {
        return {
          schemaVersion: 1,
          commandName: 'project-source-fact',
          outcome: 'rejected',
          retryDirective: 'user_action',
          stableCode: 'SYSTEM_ACTIVITY_PAYLOAD_INVALID',
          rejectReason: 'invalid_envelope',
        };
      }
      switch (commandName) {
        case 'project-source-fact':
          return handleProjectSourceFact(deps, envelope, payload);
        case 'mark-attention-seen':
          return handleMarkAttentionSeen(deps, envelope, payload);
        case 'ack-change-feed-cursor':
          return handleAckChangeFeedCursor(deps, envelope, payload);
        case 'retrim-audience':
          return handleRetrimAudience(deps, envelope, payload);
        default: {
          const _exhaustive: never = commandName;
          void _exhaustive;
          return {
            schemaVersion: 1,
            commandName: 'project-source-fact',
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: 'UNKNOWN_COMMAND',
            rejectReason: 'unknown_command',
          };
        }
      }
    },
    async dispatchQuery({ queryName, payload }) {
      return handleSystemActivityQuery(deps, queryName, payload);
    },
  };
}
