import type {
  ManagementWorkerToolRequestV1,
  ManagementWorkerToolResultV1,
  Phase1ManagementWorkerToolName,
  Phase1ManagementWorkerToolOutputMapV1,
} from '../../../../../packages/contracts/src/index.js';
import type { createManagementKernel } from './management-kernel.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;
type ToolHandler<K extends Phase1ManagementWorkerToolName> = (
  input: Extract<ManagementWorkerToolRequestV1, { toolName: K }>,
) => Promise<Phase1ManagementWorkerToolOutputMapV1[K]>;
type ToolHandlers = { [K in Phase1ManagementWorkerToolName]?: ToolHandler<K> };

const readTools = new Set<Phase1ManagementWorkerToolName>([
  'context.get_root_message',
  'context.get_root_task',
  'context.get_visible_thread',
  'context.get_management_state',
  'agents.list_capabilities',
  'agents.get_status',
]);

export function createManagementToolExecutor(input: {
  readonly kernel: ManagementKernel;
  readonly handlers: ToolHandlers;
}) {
  return async (request: ManagementWorkerToolRequestV1): Promise<ManagementWorkerToolResultV1> => {
    const base = {
      schemaVersion: 1 as const,
      commandId: request.commandId,
      managementRunId: request.managementRunId,
      workerId: request.workerId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
    };
    try {
      if (!readTools.has(request.toolName)) {
        if (!('leaseToken' in request) || !('fencingToken' in request)) throw new Error('MISSING_WRITE_AUTHORITY');
        await input.kernel.authorizeWrite({
          managementRunId: request.managementRunId,
          workerId: request.workerId,
          leaseToken: request.leaseToken,
          fencingToken: request.fencingToken,
        });
      }
      const handler = input.handlers[request.toolName] as ((value: ManagementWorkerToolRequestV1) => Promise<unknown>) | undefined;
      if (!handler) {
        return { ...base, ok: false, errorCode: 'UNAVAILABLE', diagnosticCode: 'TOOL_NOT_WIRED', retryable: false };
      }
      const output = await handler(request);
      return { ...base, ok: true, output } as ManagementWorkerToolResultV1;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN';
      const unauthorized = code.startsWith('LEASE_') || code === 'MISSING_WRITE_AUTHORITY';
      const diagnosticCode = /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : 'TOOL_EXECUTION_FAILED';
      return {
        ...base,
        ok: false,
        errorCode: unauthorized ? 'NOT_AUTHORIZED' : diagnosticCode.includes('CONFLICT') ? 'CONFLICT' : 'INVALID_REQUEST',
        diagnosticCode,
        retryable: false,
      };
    }
  };
}
