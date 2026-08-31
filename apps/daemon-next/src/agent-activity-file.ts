import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_ACTIVITY_FILE_BYTES = 64 * 1024;
const MAX_ACTIVITY_BODY_CHARS = 1200;
const ACTIVITY_KEYS = new Set(['schemaVersion', 'kind', 'body']);

export interface AgentActivityMessage {
  readonly sequence: 1;
  readonly kind: 'plan' | 'progress';
  readonly body: string;
}

export interface AgentActivityFile {
  readonly path: string;
  close(): Promise<void>;
}

export function appendAgentActivityContext(prompt: string): string {
  return [
    prompt,
    '## AgentBean 用户可见执行动态（可选）',
    '如果当前请求需要明显等待，请在开始实际工作后尽早写一条简短动态。使用文件写入工具，向环境变量 `AGENTBEAN_ACTIVITY_FILE` 指向的文件追加且仅追加一行 JSONL：',
    '{"schemaVersion":1,"kind":"plan","body":"用用户当前语言说明你准备怎样完成这项具体请求"}',
    '正文必须结合当前请求说明下一步，避免“我来处理”“请稍候”等泛化套话；不得包含本机路径、密钥、运行时记忆或其他隐私。每次执行最多写一次。短任务可以跳过。此动态不替代最终答复。',
  ].join('\n\n');
}

export function createAgentActivityFile(input: {
  readonly onMessage: (message: AgentActivityMessage) => Promise<void> | void;
  readonly pollIntervalMs?: number;
}): AgentActivityFile {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-activity-'));
  const path = join(directory, 'updates.jsonl');
  writeFileSync(path, '', { encoding: 'utf8', mode: 0o600 });

  let processedChars = 0;
  let delivered = false;
  let closed = false;
  let drainPromise: Promise<void> = Promise.resolve();

  const parseLine = (line: string): AgentActivityMessage | null => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !ACTIVITY_KEYS.has(key))
      || record.schemaVersion !== 1
      || (record.kind !== 'plan' && record.kind !== 'progress')
      || typeof record.body !== 'string') return null;
    const body = record.body.trim();
    if (!body || body.length > MAX_ACTIVITY_BODY_CHARS) return null;
    return { sequence: 1, kind: record.kind, body };
  };

  const drain = async () => {
    if (delivered) return;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    if (Buffer.byteLength(text) > MAX_ACTIVITY_FILE_BYTES) {
      delivered = true;
      return;
    }
    // watchFile 期间只消费完整行；进程退出后的 close() 也接受末尾无换行的完整 JSON。
    const completeEnd = closed ? text.length : text.lastIndexOf('\n');
    if (completeEnd < processedChars) return;
    const complete = text.slice(processedChars, completeEnd);
    processedChars = completeEnd < text.length ? completeEnd + 1 : completeEnd;
    for (const line of complete.split('\n')) {
      const message = parseLine(line.trim());
      if (!message) continue;
      delivered = true;
      try {
        await input.onMessage(message);
      } catch {
        // 可选动态失败不能覆盖 Agent 的最终结果。
      }
      return;
    }
  };

  const scheduleDrain = () => {
    drainPromise = drainPromise.then(drain, drain);
  };
  watchFile(path, { interval: input.pollIntervalMs ?? 100, persistent: false }, scheduleDrain);

  return {
    path,
    async close() {
      if (closed) return;
      closed = true;
      unwatchFile(path, scheduleDrain);
      scheduleDrain();
      await drainPromise;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
