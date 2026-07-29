import type { ID, MessageTracerCommandName, MessageTracerCommandResponseV1 } from '../../../../packages/contracts/src/index.js';
import type {
  AckReadCandidateCommandHandler,
  CheckInboxCommandHandler,
  SendMessageCommandHandler,
} from './message-tracer-handlers.js';

/**
 * #921 切片 C-wire：Message tracer 命令 dispatcher（ADR-0067 封闭 command registry 的路由层）。
 * 按 commandName 路由到对应 handler；authority（actorId/teamId）由 Server 从 session 推导注入，
 * 不来自 envelope（#900 §1/§18 禁止客户端自报告 authority）。未登记 command 抛错（封闭 registry）。
 */

export interface MessageTracerCommandAuthority {
  /** 发送/请求者身份（Server 推导；send 即 senderId，check/ack 即 recipientId）。 */
  readonly actorId: ID;
  readonly teamId: ID;
}

export interface MessageTracerDispatchInput {
  readonly commandName: MessageTracerCommandName;
  /** 客户端提交的 envelope（exact-key 校验由各 handler 做）。 */
  readonly envelope: unknown;
  /** command payload。 */
  readonly payload: unknown;
  readonly authority: MessageTracerCommandAuthority;
}

export interface MessageTracerCommandDispatcher {
  dispatch(input: MessageTracerDispatchInput): Promise<MessageTracerCommandResponseV1>;
}

export function createMessageTracerCommandDispatcher(handlers: {
  readonly send: SendMessageCommandHandler;
  readonly checkInbox: CheckInboxCommandHandler;
  readonly ack: AckReadCandidateCommandHandler;
}): MessageTracerCommandDispatcher {
  return {
    async dispatch(input) {
      const { commandName, envelope, payload, authority } = input;
      switch (commandName) {
        case 'send-message':
          return handlers.send({ envelope, payload, senderId: authority.actorId, teamId: authority.teamId });
        case 'check-inbox':
          return handlers.checkInbox({ envelope, payload, requesterId: authority.actorId, teamId: authority.teamId });
        case 'ack-read-candidate':
          return handlers.ack({ envelope, payload, requesterId: authority.actorId, teamId: authority.teamId });
        default: {
          // 封闭 registry：未登记 command 拒绝（ADR-0067）。穷尽性检查：新增 command 须在此补 case。
          const unhandled: never = commandName;
          throw new Error(`MESSAGE_TRACER_UNKNOWN_COMMAND: ${unhandled}`);
        }
      }
    },
  };
}
