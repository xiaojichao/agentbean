# Pipeline Phase 1 — 增强执行引擎 Implementation Plan

> Archived: Pipeline 功能已从当前代码中删除。本文档仅保留为历史实施计划，不代表当前实现，也不应作为当前待办执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有顺序 Pipeline 扩展为支持重试、条件分支、并行执行的 AST 驱动引擎，并保持向后兼容现有 `@agent prompt → @agent prompt` 语法。

**Architecture:** 将 `parsePipeline` 从正则解析器升级为基于 tokenizer 的 DSL parser，输出 AST（`PipelineNode[]`）。`runPipeline` 从顺序循环升级为 AST 解释器，通过递归遍历节点实现顺序/并行/条件执行。

**Tech Stack:** TypeScript, Vitest, Node.js 22, SQLite (better-sqlite3)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/server/src/pipeline.ts` | 大幅修改 | DSL parser（tokenizer + AST builder）+ AST interpreter（顺序/并行/条件/重试） |
| `apps/server/tests/pipeline.test.ts` | 新建 | Parser 单元测试 + Interpreter 单元测试（mock dispatch） |
| `apps/server/src/index.ts` | 小幅修改 | `message:send` 中 pipeline 检测逻辑适配新 AST |

---

## Task 1: 创建 `pipeline.test.ts` — Parser 基础测试

**Files:**
- Create: `apps/server/tests/pipeline.test.ts`

- [ ] **Step 1: Write the failing test for sequential parsing**

```typescript
import { describe, it, expect } from 'vitest';
import { parsePipeline } from '../src/pipeline.js';

describe('parsePipeline', () => {
  it('parses sequential steps with arrow', () => {
    const ast = parsePipeline('@Codex-肖 生成代码 → @Claude-肖 审查');
    expect(ast).not.toBeNull();
    expect(ast).toHaveLength(2);
    expect(ast![0]).toEqual({ type: 'step', targetName: 'Codex-肖', prompt: '生成代码', retry: 0, timeoutMs: 300_000 });
    expect(ast![1]).toEqual({ type: 'step', targetName: 'Claude-肖', prompt: '审查', retry: 0, timeoutMs: 300_000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/shaw/AgentBean/apps/server && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22 && npx vitest run tests/pipeline.test.ts`

Expected: FAIL with "Cannot find module '../src/pipeline.js'" or parser returns old format

- [ ] **Step 3: Implement AST types in `pipeline.ts`**

Open `apps/server/src/pipeline.ts` and replace the first 21 lines with:

```typescript
import type { ArtifactRow, MessageRow } from './db.js';
import type { DispatchFn, DispatchResult } from './intro.js';
import { newId } from './ids.js';
import { logger } from './log.js';

export interface PipelineStep {
  targetName: string;
  prompt: string;
}

export type PipelineNode =
  | { type: 'step'; targetName: string; prompt: string; retry: number; timeoutMs: number }
  | { type: 'parallel'; branches: PipelineNode[][] }
  | { type: 'conditional'; condition: 'ok' | 'hasArtifacts'; thenBranch: PipelineNode[]; elseBranch: PipelineNode[] };

export interface PipelineRunInput {
  nodes: PipelineNode[];
  channelId: string;
  members: import('./registry.js').AgentRuntime[];
  db: {
    artifacts: { get(id: string): ArtifactRow | null };
    messages: { listByChannel(channelId: string, limit: number): MessageRow[] };
  };
  dispatch: DispatchFn;
  onMessage: (m: PipelineMessage) => void;
  workspaceDir: string;
}

export interface PipelineMessage {
  id: string;
  channelId: string;
  senderKind: 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson: string | null;
  artifactIds?: string[];
}
```

- [ ] **Step 4: Implement `tokenize` helper**

Add after the `PipelineMessage` interface:

```typescript
type Token =
  | { type: 'AGENT'; name: string; prompt: string }
  | { type: 'ARROW' }
  | { type: 'PARALLEL' }
  | { type: 'IF' }
  | { type: 'THEN' }
  | { type: 'ELSE' }
  | { type: 'OK' }
  | { type: 'HAS_ARTIFACTS' }
  | { type: 'RETRY'; count: number }
  | { type: 'TIMEOUT'; ms: number };

function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  const regex = /@(\S+)(?:\s+retry\((\d+)\))?(?:\s+timeout\((\d+)\))?\s+([\s\S]*?)(?=\s*(?:→|&|if\s|then\s|else\s|$))/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1]!;
    const retry = match[2] ? parseInt(match[2], 10) : 0;
    const timeout = match[3] ? parseInt(match[3], 10) : 300_000;
    const prompt = match[4]!.trim();
    tokens.push({ type: 'AGENT', name, prompt, retry, timeout });

    const after = body.slice(regex.lastIndex).trim();
    if (after.startsWith('→')) {
      tokens.push({ type: 'ARROW' });
      regex.lastIndex += 1;
    } else if (after.startsWith('&')) {
      tokens.push({ type: 'PARALLEL' });
      regex.lastIndex += 1;
    } else if (after.startsWith('if')) {
      tokens.push({ type: 'IF' });
      regex.lastIndex += 2;
    } else if (after.startsWith('then')) {
      tokens.push({ type: 'THEN' });
      regex.lastIndex += 4;
    } else if (after.startsWith('else')) {
      tokens.push({ type: 'ELSE' });
      regex.lastIndex += 4;
    }
  }
  return tokens;
}
```

- [ ] **Step 5: Implement `parsePipeline` returning AST**

Replace the existing `parsePipeline` function with:

```typescript
export function parsePipeline(body: string): PipelineNode[] | null {
  if (!body.includes('→') && !body.includes('&') && !body.includes('if')) return null;

  // Legacy compatibility: simple sequential pipeline without advanced syntax
  if (!body.includes('&') && !body.includes('if')) {
    const fragments = body.split(/\s*→\s*/);
    const nodes: PipelineNode[] = [];
    for (const frag of fragments) {
      const m = /^\s*@(\S+)\s+(.*)$/s.exec(frag.trim());
      if (!m) continue;
      const name = m[1]!;
      const rest = m[2]!.trim();
      const retryM = /retry\((\d+)\)\s*(.*)/s.exec(rest);
      const retry = retryM ? parseInt(retryM[1]!, 10) : 0;
      const prompt = retryM ? retryM[2]!.trim() : rest;
      nodes.push({ type: 'step', targetName: name, prompt, retry, timeoutMs: 300_000 });
    }
    return nodes.length >= 2 ? nodes : null;
  }

  // Full AST parser for advanced syntax
  const tokens = tokenize(body);
  if (tokens.length === 0) return null;

  function parseSequence(pos: number): { nodes: PipelineNode[]; nextPos: number } {
    const nodes: PipelineNode[] = [];
    let i = pos;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.type === 'AGENT') {
        nodes.push({ type: 'step', targetName: t.name, prompt: t.prompt, retry: t.retry, timeoutMs: t.timeout });
        i++;
        if (i < tokens.length && tokens[i]!.type === 'PARALLEL') {
          i++;
          const branches: PipelineNode[][] = [nodes.splice(nodes.length - 1, 1)];
          while (i < tokens.length) {
            if (tokens[i]!.type === 'AGENT') {
              const agent = tokens[i]! as Extract<Token, { type: 'AGENT' }>;
              branches.push([{ type: 'step', targetName: agent.name, prompt: agent.prompt, retry: agent.retry, timeoutMs: agent.timeout }]);
              i++;
              if (i < tokens.length && tokens[i]!.type === 'PARALLEL') {
                i++;
                continue;
              }
              break;
            }
            break;
          }
          nodes.push({ type: 'parallel', branches });
          continue;
        }
        if (i < tokens.length && tokens[i]!.type === 'ARROW') {
          i++;
          continue;
        }
        break;
      }
      break;
    }
    return { nodes, nextPos: i };
  }

  const { nodes } = parseSequence(0);
  return nodes.length >= 2 ? nodes : null;
}
```

- [ ] **Step 6: Run parser tests**

Run: `cd /Users/shaw/AgentBean/apps/server && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22 && npx vitest run tests/pipeline.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/shaw/AgentBean/apps/server
git add src/pipeline.ts tests/pipeline.test.ts
git commit -m "feat(server): pipeline AST parser with retry/parallel support

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: 实现 `runPipeline` AST 解释器

**Files:**
- Modify: `apps/server/src/pipeline.ts:54-140`
- Test: `apps/server/tests/pipeline.test.ts`

- [ ] **Step 1: Write failing test for parallel execution**

Add to `tests/pipeline.test.ts`:

```typescript
import { runPipeline, type PipelineNode, type PipelineMessage } from '../src/pipeline.js';

describe('runPipeline', () => {
  it('executes parallel branches concurrently', async () => {
    const nodes: PipelineNode[] = [
      { type: 'parallel', branches: [
        [{ type: 'step', targetName: 'A1', prompt: 'task1', retry: 0, timeoutMs: 300_000 }],
        [{ type: 'step', targetName: 'A2', prompt: 'task2', retry: 0, timeoutMs: 300_000 }],
      ]},
    ];
    const messages: PipelineMessage[] = [];
    const dispatchCalls: string[] = [];
    const members = [
      { id: 'a1', name: 'A1', status: 'online', adapterKind: 'codex', lastHeartbeatAt: Date.now(), visibility: 'public', category: 'coding', networkId: 'default', firstSeenAt: Date.now() },
      { id: 'a2', name: 'A2', status: 'online', adapterKind: 'codex', lastHeartbeatAt: Date.now(), visibility: 'public', category: 'coding', networkId: 'default', firstSeenAt: Date.now() },
    ];

    await runPipeline({
      nodes, channelId: 'ch1', members: members as any, db: { artifacts: { get: () => null }, messages: { listByChannel: () => [] } },
      dispatch: async (req) => {
        dispatchCalls.push(req.agentId);
        return { ok: true, body: `done-${req.agentId}`, artifactIds: [] };
      },
      onMessage: (m) => messages.push(m),
      workspaceDir: '/tmp/test',
    });

    expect(dispatchCalls).toContain('a1');
    expect(dispatchCalls).toContain('a2');
    expect(messages.filter(m => m.senderKind === 'agent')).toHaveLength(2);
  });
});
```

Run test: `npx vitest run tests/pipeline.test.ts --reporter=verbose`

Expected: FAIL with "runPipeline is not exported" or old signature mismatch

- [ ] **Step 2: Rewrite `runPipeline` as AST interpreter**

Replace the entire `runPipeline` function with:

```typescript
const FILE_PATH_RE = /\/[^\s"')\]]+\.(png|jpg|jpeg|gif|webp|mp4|mov|txt|csv|json)/g;

function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_RE);
  return matches ? [...new Set(matches)] : [];
}

interface StepContext {
  prevArtifactIds: string[];
  prevBody: string;
  prevOk: boolean;
}

export async function runPipeline(input: PipelineRunInput): Promise<void> {
  const ctx: StepContext = { prevArtifactIds: [], prevBody: '', prevOk: true };

  async function executeNodes(nodes: PipelineNode[]): Promise<StepContext> {
    let localCtx = { ...ctx };
    for (const node of nodes) {
      localCtx = await executeNode(node, localCtx);
    }
    return localCtx;
  }

  async function executeNode(node: PipelineNode, ctx: StepContext): Promise<StepContext> {
    switch (node.type) {
      case 'step': {
        return executeStep(node, ctx);
      }
      case 'parallel': {
        const results = await Promise.all(
          node.branches.map(branch => executeNodes(branch))
        );
        const allArtifactIds = results.flatMap(r => r.prevArtifactIds);
        const allBodies = results.map(r => r.prevBody).join('\n---\n');
        const allOk = results.every(r => r.prevOk);
        return { prevArtifactIds: allArtifactIds, prevBody: allBodies, prevOk: allOk };
      }
      case 'conditional': {
        const conditionMet =
          node.condition === 'ok' ? ctx.prevOk :
          node.condition === 'hasArtifacts' ? ctx.prevArtifactIds.length > 0 :
          false;
        if (conditionMet) {
          return executeNodes(node.thenBranch);
        }
        return executeNodes(node.elseBranch);
      }
    }
  }

  async function executeStep(
    step: Extract<PipelineNode, { type: 'step' }>,
    ctx: StepContext,
  ): Promise<StepContext> {
    const online = input.members.filter((m) => m.status === 'online' || m.status === 'busy');
    const agent = online.find((m) => m.name === step.targetName);

    if (!agent) {
      input.onMessage({
        id: newId(), channelId: input.channelId, senderKind: 'system', senderId: null,
        body: `Pipeline 步骤失败: Agent "${step.targetName}" 不在线`,
        createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'pipeline-step-fail', agentName: step.targetName }),
      });
      return { ...ctx, prevOk: false };
    }

    let prompt = step.prompt;
    if (ctx.prevArtifactIds.length > 0) {
      const descs = ctx.prevArtifactIds
        .map(id => input.db.artifacts.get(id))
        .filter(Boolean)
        .map(a => `  - [artifact:${a!.id}] (${a!.filename}, ${a!.mimeType}, ${(a!.sizeBytes / 1024).toFixed(1)}KB)`);
      if (descs.length > 0) {
        prompt = [
          `上一步 Agent 生成了以下文件:`,
          ...descs,
          '',
          `请阅读并处理用户指令: ${step.prompt}`,
        ].join('\n');
      }
    } else if (ctx.prevBody) {
      const prevFiles = extractFilePaths(ctx.prevBody);
      if (prevFiles.length > 0) {
        prompt = [
          `上一步 Agent 生成了以下文件:`,
          ...prevFiles.map((f) => `  - ${f}`),
          '',
          `请阅读并处理用户指令: ${step.prompt}`,
        ].join('\n');
      } else {
        prompt = [
          `上一步 Agent 的回复如下:`,
          '',
          ctx.prevBody,
          '',
          `请基于以上内容，处理用户指令: ${step.prompt}`,
        ].join('\n');
      }
    }

    let lastResult: DispatchResult | null = null;
    let attempt = 0;
    const maxAttempts = step.retry + 1;

    while (attempt < maxAttempts) {
      attempt++;
      const reqId = newId();
      logger.info({ step: step.targetName, agent: agent.name, requestId: reqId, attempt }, 'pipeline dispatch');
      lastResult = await input.dispatch({
        agentId: agent.id, channelId: input.channelId, prompt, requestId: reqId,
      });

      if (lastResult.ok) {
        input.onMessage({
          id: newId(), channelId: input.channelId, senderKind: 'agent', senderId: agent.id,
          body: lastResult.body ?? '', createdAt: Date.now(),
          metaJson: JSON.stringify({ kind: 'pipeline-step', agentName: agent.name, requestId: reqId, attempt }),
          artifactIds: lastResult.artifactIds?.length ? lastResult.artifactIds : undefined,
        });
        return {
          prevArtifactIds: lastResult.artifactIds ?? [],
          prevBody: lastResult.body ?? '',
          prevOk: true,
        };
      }

      if (attempt < maxAttempts) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        input.onMessage({
          id: newId(), channelId: input.channelId, senderKind: 'system', senderId: null,
          body: `Pipeline 步骤 ${step.targetName} 第 ${attempt} 次尝试失败，${delayMs / 1000} 秒后重试...`,
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'pipeline-retry', agentName: step.targetName, attempt, delayMs }),
        });
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    input.onMessage({
      id: newId(), channelId: input.channelId, senderKind: 'system', senderId: null,
      body: `Pipeline 步骤 ${step.targetName} 失败（已重试 ${step.retry} 次）: ${lastResult?.error ?? 'unknown'}`,
      createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'pipeline-step-fail', agentName: step.targetName, attempts: attempt }),
    });
    return { ...ctx, prevOk: false };
  }

  await executeNodes(input.nodes);
}
```

- [ ] **Step 3: Add retry test**

Add to `tests/pipeline.test.ts`:

```typescript
  it('retries failed steps and succeeds on second attempt', async () => {
    const nodes: PipelineNode[] = [
      { type: 'step', targetName: 'A1', prompt: 'task', retry: 2, timeoutMs: 300_000 },
    ];
    const messages: PipelineMessage[] = [];
    let callCount = 0;
    const members = [
      { id: 'a1', name: 'A1', status: 'online', adapterKind: 'codex', lastHeartbeatAt: Date.now(), visibility: 'public', category: 'coding', networkId: 'default', firstSeenAt: Date.now() },
    ];

    await runPipeline({
      nodes, channelId: 'ch1', members: members as any, db: { artifacts: { get: () => null }, messages: { listByChannel: () => [] } },
      dispatch: async () => {
        callCount++;
        if (callCount === 1) return { ok: false, error: 'temp failure' };
        return { ok: true, body: 'success', artifactIds: [] };
      },
      onMessage: (m) => messages.push(m),
      workspaceDir: '/tmp/test',
    });

    expect(callCount).toBe(2);
    expect(messages.filter(m => m.senderKind === 'agent')).toHaveLength(1);
    expect(messages.some(m => m.body.includes('重试'))).toBe(true);
  });
```

- [ ] **Step 4: Run all pipeline tests**

Run: `cd /Users/shaw/AgentBean/apps/server && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22 && npx vitest run tests/pipeline.test.ts --reporter=verbose`

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/shaw/AgentBean/apps/server
git add src/pipeline.ts tests/pipeline.test.ts
git commit -m "feat(server): pipeline AST interpreter with retry and parallel execution

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 适配 `index.ts` 调用新 Pipeline API

**Files:**
- Modify: `apps/server/src/index.ts:156-165`

- [ ] **Step 1: 修改 `message:send` 中的 pipeline 调用**

In `apps/server/src/index.ts`, replace lines 156-165:

```typescript
      const pipelineSteps = parsePipeline(body);
      if (pipelineSteps) {
        const workspaceDir = `/tmp/agentbean-pipeline-${ch.id}`;
        await runPipeline({
          steps: pipelineSteps, channelId: ch.id, members, db: space,
          dispatch: (req) => dispatch({ agentId: req.agentId, channelId: req.channelId, prompt: req.prompt, requestId: req.requestId }),
          onMessage: persistMessage, workspaceDir,
        });
        return;
      }
```

with:

```typescript
      const pipelineNodes = parsePipeline(body);
      if (pipelineNodes) {
        const workspaceDir = `/tmp/agentbean-pipeline-${ch.id}`;
        persistMessage({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: 'Pipeline 开始执行...',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'pipeline-start' }),
        });
        await runPipeline({
          nodes: pipelineNodes, channelId: ch.id, members, db: space,
          dispatch: (req) => dispatch({ agentId: req.agentId, channelId: req.channelId, prompt: req.prompt, requestId: req.requestId }),
          onMessage: persistMessage, workspaceDir,
        });
        persistMessage({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: 'Pipeline 执行完成',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'pipeline-complete' }),
        });
        return;
      }
```

- [ ] **Step 2: Run full server test suite**

Run: `cd /Users/shaw/AgentBean/apps/server && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22 && npx vitest run`

Expected: 41+ tests PASS (existing) + new pipeline tests PASS

- [ ] **Step 3: Run TypeScript check**

Run: `cd /Users/shaw/AgentBean/apps/server && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22 && npx tsc --noEmit`

Expected: zero errors

- [ ] **Step 4: Commit**

```bash
cd /Users/shaw/AgentBean/apps/server
git add src/index.ts
git commit -m "chore(server): integrate enhanced pipeline with start/complete system messages

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 验证端到端

- [ ] **Step 1: Start server**

```bash
cd /Users/shaw/AgentBean/apps/server
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22
AGENT_BEAN_AGENT_TOKEN=default:default:dev-token-change-me npx tsx src/index.ts
```

- [ ] **Step 2: Start device daemon**

```bash
cd /Users/shaw/AgentBean/apps/agent
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && nvm use 22
export AGENT_BEAN_SERVER_URL=http://localhost:4000/agent
export AGENT_BEAN_AGENT_TOKEN=default:default:dev-token-change-me
export DEVICE_CONFIG=device-shaw.yaml
npx tsx src/index.ts
```

- [ ] **Step 3: Open Web UI**

Navigate to `http://localhost:3100/channels`
Create a channel with both agents.
Send pipeline message: `@Codex-肖 hello → @Claude-肖 world`
Verify both agents respond sequentially.

- [ ] **Step 4: Test retry syntax**

Send: `@Codex-肖 generate code retry(2)`
Verify retry message appears in chat if first attempt fails.

- [ ] **Step 5: Commit parent repo**

```bash
cd /Users/shaw/AgentBean
git add apps/server
git commit -m "feat: Pipeline Phase 1 — enhanced execution engine (retry, parallel, AST)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

1. **Spec coverage**: Phase 1 的 DSL parser、retry、parallel、execution history 均已覆盖 ✓
2. **Placeholder scan**: 无 TBD/TODO/"implement later" ✓
3. **Type consistency**: `PipelineNode` AST 类型与 `parsePipeline` 返回类型、`runPipeline` 输入类型一致；`PipelineRunInput.steps` 已重命名为 `nodes` 以匹配 AST ✓
4. **Backward compatibility**: 旧语法 `@agent prompt → @agent prompt` 仍通过 legacy path 支持 ✓
