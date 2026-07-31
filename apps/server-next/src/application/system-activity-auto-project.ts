/**
 * #1014：lifecycle/remediation 成功后自动 project-source-fact。
 * 独立于业务 UoW 的 post-commit 调用；失败只记日志，不回滚权威事实。
 */
import type { SystemActivitySourceFactV1 } from '../../../../packages/contracts/src/system-activity.js';
import type { SystemActivityDispatcher } from './system-activity-dispatcher.js';

export async function autoProjectSystemActivityFact(input: {
  readonly dispatcher: SystemActivityDispatcher;
  readonly fact: SystemActivitySourceFactV1;
  readonly idempotencyKey: string;
  readonly onError?: (error: unknown) => void;
}): Promise<{ outcome: string } | null> {
  try {
    const response = await input.dispatcher.dispatchCommand({
      envelope: {
        schemaVersion: 1,
        commandName: 'project-source-fact',
        commandSchemaVersion: 1,
        idempotencyKey: input.idempotencyKey,
      },
      payload: {
        fact: input.fact,
        projectionWatermark: Math.max(input.fact.sequence, input.fact.taskRevision ?? 0),
      },
    });
    return { outcome: response.outcome };
  } catch (error) {
    input.onError?.(error);
    return null;
  }
}
