import type {
  PiAuthorityCutoverCommandName,
  PiAuthorityCutoverCommandResponseV1,
  PiAuthorityCutoverQueryName,
  PiAuthorityCutoverQueryResponseV1,
} from '../../../../packages/contracts/src/pi-authority-cutover.js';
import {
  parsePiAuthorityCutoverCommandEnvelopeV1,
} from '../../../../packages/contracts/src/pi-authority-cutover.js';
import {
  handleAdvanceMigrationState,
  handleBindMessageAuthorityEpoch,
  handleClearEmergencyStop,
  handleEmergencyStopPi,
  handleEvaluateCutoverReadiness,
  handleExecutePiAuthorityCutover,
  handlePiAuthorityCutoverQuery,
  handleRecordLegacyWriteAttempt,
  handleSubmitLegacyDrainResult,
  type PiAuthorityCutoverHandlerDeps,
} from './pi-authority-cutover-handler.js';

/**
 * #931 PI authority cutover command/query 派发（封闭 registry）。
 * envelope.commandName / queryName 路由到对应 handler。
 */
export interface PiAuthorityCutoverDispatcher {
  dispatchCommand(input: {
    envelope: unknown;
    payload: unknown;
  }): Promise<PiAuthorityCutoverCommandResponseV1>;
  dispatchQuery(input: {
    queryName: PiAuthorityCutoverQueryName;
    payload: unknown;
  }): Promise<PiAuthorityCutoverQueryResponseV1>;
}

export function createPiAuthorityCutoverDispatcher(
  deps: PiAuthorityCutoverHandlerDeps,
): PiAuthorityCutoverDispatcher {
  return {
    async dispatchCommand({ envelope, payload }) {
      let commandName: PiAuthorityCutoverCommandName;
      try {
        commandName = parsePiAuthorityCutoverCommandEnvelopeV1(envelope).commandName;
      } catch {
        return {
          schemaVersion: 1,
          commandName: 'evaluate-cutover-readiness',
          outcome: 'rejected',
          retryDirective: 'user_action',
          stableCode: 'PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID',
          rejectReason: 'invalid_envelope',
        };
      }
      switch (commandName) {
        case 'evaluate-cutover-readiness':
          return handleEvaluateCutoverReadiness(deps, envelope, payload);
        case 'execute-pi-authority-cutover':
          return handleExecutePiAuthorityCutover(deps, envelope, payload);
        case 'submit-legacy-drain-result':
          return handleSubmitLegacyDrainResult(deps, envelope, payload);
        case 'emergency-stop-pi':
          return handleEmergencyStopPi(deps, envelope, payload);
        case 'clear-emergency-stop':
          return handleClearEmergencyStop(deps, envelope, payload);
        case 'advance-migration-state':
          return handleAdvanceMigrationState(deps, envelope, payload);
        case 'bind-message-authority-epoch':
          return handleBindMessageAuthorityEpoch(deps, envelope, payload);
        case 'record-legacy-write-attempt':
          return handleRecordLegacyWriteAttempt(deps, envelope, payload);
        default: {
          const _exhaustive: never = commandName;
          void _exhaustive;
          return {
            schemaVersion: 1,
            commandName: 'evaluate-cutover-readiness',
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: 'UNKNOWN_COMMAND',
            rejectReason: 'unknown_command',
          };
        }
      }
    },
    async dispatchQuery({ queryName, payload }) {
      return handlePiAuthorityCutoverQuery(deps, queryName, payload);
    },
  };
}
