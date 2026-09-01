import { describe, expect, test } from 'vitest';
import { dispatchObjective, isDispatchAgentMessage, pendingDispatchStatusText } from '../lib/dispatch-activity';

describe('dispatch activity copy', () => {
  test('根据任务提示生成带 Agent 名称的已接收状态', () => {
    expect(pendingDispatchStatusText({
      status: 'accepted',
      body: '@OpenSNS 将你所具备的技能总结一下，输出为Markdown文件。',
      agentName: 'OpenSNS',
    })).toBe('OpenSNS 已接收，正在处理：「将你所具备的技能总结一下，输出为Markdown文件。」');
  });

  test('排队阶段说明正在发送，并从首个 mention 回退 Agent 名称', () => {
    expect(pendingDispatchStatusText({
      status: 'queued',
      body: '@Hermes-Agent 总结附件',
    })).toBe('正在发送给 Hermes-Agent：「总结附件」');
  });

  test('折叠多行空白并截断过长目标', () => {
    const objective = dispatchObjective(`@Agent  ${'长'.repeat(80)}\n\n输出文件`);
    expect(objective).toBe(`${'长'.repeat(72)}…`);
  });

  test('只把同一 dispatch 的真实 Agent 动态识别为状态替代项', () => {
    const message = {
      id: 'update-1',
      channelId: 'channel-1',
      senderKind: 'agent' as const,
      senderId: 'agent-1',
      body: '我会先盘点技能，再整理为 Markdown 文件。',
      createdAt: 2,
      meta: { kind: 'dispatch-agent-message', dispatchId: 'dispatch-1' },
    };
    expect(isDispatchAgentMessage(message, 'dispatch-1')).toBe(true);
    expect(isDispatchAgentMessage(message, 'dispatch-2')).toBe(false);
    expect(isDispatchAgentMessage({ ...message, senderKind: 'system' }, 'dispatch-1')).toBe(false);
  });
});
