# Agent Skills 区块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给智能体成员详情页加 Skills 区块，展示每个 custom agent 运行环境的全局+项目+system skills（对标 Raft），含手动刷新。

**Architecture:** 方案 B——daemon 扫描 custom agent 的 SKILL.md skills，经新建 `agent.reportCustomSkills` 事件上报（绕过 registerBatch 对 executor-hosted 的跳过），server 以 `skills_json` 存储，web 折叠展示。复用 `scanRequested` 通道下发 custom agent 列表（hello 后首推 + rescan + 手动刷新）。

**Tech Stack:** TypeScript / Node.js ESM / Vitest / Next.js App Router / React / Socket.IO / better-sqlite3 / js-yaml

## Global Constraints

- 生产代码只改 `packages/contracts`、`apps/daemon-next`、`apps/server-next`、`apps/web-next`（apps/server、apps/daemon、apps/web 是 legacy，禁改）。
- 中文 commit message，每个 task 末尾 commit；Co-Authored-By: Claude <noreply@anthropic.com>。
- 测试框架统一 Vitest（`vitest run`），文件命名 `*.test.ts`。
- skills 只对 `claude-code`、`codex` 两 adapter 扫描（配置表驱动，其它 adapter 留 undefined，架构预留）。
- codex 内置 system skills 用静态清单（初始 3 个：skill-creator / plugin-creator / imagegen）。
- codex 用户级 skills 目录是 `~/.agents/skills`（不是 `~/.codex`）。
- frontmatter 解析复用 daemon-next 已有的 `js-yaml` 依赖，不加新依赖。
- 不改 `registerDiscoveredAgents` 的 executor-hosted 跳过逻辑（custom agent skills 走新 `reportCustomSkills` 链路）。
- 扫描健壮：单 skill 解析失败跳过，单 agent 扫描失败不影响其它，绝不阻断 agent 上报。
- 所有 skill 数组上限 200，超出截断 + warn。

---

### Task 1: contracts — SkillDto 类型、AgentDto.skills、事件与 payload 契约

**Files:**
- Modify: `packages/contracts/src/agent.ts`（加 `SkillDto`、`AgentDto.skills`）
- Modify: `packages/contracts/src/socket.ts`（加 `agent.reportCustomSkills`、扩展 `ScanRequest`）
- Test: `packages/contracts/tests/agent-skills.test.ts`（Create）

**Interfaces:**
- Produces: `SkillDto`、`AgentDto.skills?: SkillDto[]`、`AGENT_EVENTS.agent.reportCustomSkills`、`ScanRequest.customAgents?`

- [ ] **Step 1: 写失败测试**

`packages/contracts/tests/agent-skills.test.ts`：
```ts
import { describe, expect, test } from 'vitest';
import { AGENT_EVENTS } from '../src/socket';
import type { SkillDto, AgentDto } from '../src/agent';

describe('agent skills contracts', () => {
  test('AGENT_EVENTS.agent.reportCustomSkills 定义为 agent:report-custom-skills', () => {
    expect(AGENT_EVENTS.agent.reportCustomSkills).toBe('agent:report-custom-skills');
  });

  test('SkillDto 含必要字段', () => {
    const skill: SkillDto = {
      name: 'analyze',
      description: 'deep analysis',
      scope: 'user',
      sourcePath: '/home/u/.claude/skills/analyze',
      adapterKind: 'claude-code',
    };
    expect(skill.scope === 'user' || skill.scope === 'project' || skill.scope === 'system').toBe(true);
  });

  test('AgentDto.skills 可选', () => {
    const agent = { id: 'a1', primaryTeamId: 't1', visibleTeamIds: [], name: 'x',
      adapterKind: 'claude-code', category: 'executor-hosted', source: 'custom', status: 'online' } as AgentDto;
    expect(agent.skills).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/contracts && npx vitest run tests/agent-skills.test.ts`
Expected: FAIL（`reportCustomSkills` undefined / `SkillDto` 未导出）

- [ ] **Step 3: 实现 contracts**

`packages/contracts/src/agent.ts` —— 在 `AgentDto` 定义之前加 `SkillDto`，在 `AgentDto` 内加 `skills`：
```ts
export interface SkillDto {
  name: string;
  description: string;
  scope: 'user' | 'project' | 'system';
  sourcePath: string;
  adapterKind: AdapterKind;
}

export interface AgentDto {
  id: ID;
  primaryTeamId: ID;
  visibleTeamIds: ID[];
  name: string;
  adapterKind: AdapterKind;
  category: AgentCategory;
  source: AgentSource;
  status: AgentStatus;
  ownerId?: ID;
  ownerName?: string | null;
  deviceId?: ID;
  command?: string;
  args?: string[];
  cwd?: string;
  gatewayInstanceKey?: string;
  envKeys?: string[];
  description?: string;
  skills?: SkillDto[];          // 新增
  lastSeenAt?: UnixMs;
  lastError?: string;
}
```

`packages/contracts/src/socket.ts` —— `agent` 段加 `reportCustomSkills`，并扩展 scan 请求类型：
```ts
export const AGENT_EVENTS = {
  deviceInvite: { wait: 'device-invite:wait', credentials: 'device-invite:credentials' },
  device: {
    hello: 'device:hello',
    runtimes: 'device:runtimes',
    scanRequested: 'device:scan-requested',
    selectDirectoryRequested: 'device:select-directory-requested',
  },
  agent: {
    registerBatch: 'agent:register-batch',
    reportCustomSkills: 'agent:report-custom-skills',   // 新增
  },
  dispatch: { request: 'dispatch:request', cancel: 'dispatch:cancel', accepted: 'dispatch:accepted', result: 'dispatch:result', error: 'dispatch:error' },
} as const;

export interface ScanRequestCustomAgent {
  id: string;
  adapterKind: string;
  cwd?: string;
}

export interface ScanRequest {
  requestId: string;
  deviceId: string;
  customAgents?: ScanRequestCustomAgent[];   // 新增：server 下发给 daemon 扫 skills 的 custom agent 列表
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/contracts && npx vitest run tests/agent-skills.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent.ts packages/contracts/src/socket.ts packages/contracts/tests/agent-skills.test.ts
git commit -m "contracts: 新增 SkillDto / AgentDto.skills / reportCustomSkills 事件" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: server — migration 0010 + repositories skills_json 存取

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0010_agent_skills.sql`
- Modify: `apps/server-next/src/application/repositories.ts`（`AgentRecord` 加 skills、`AgentRepository` 加 `updateSkills`）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（`upsert`/`mapAgent` 加 skills_json、新增 `updateSkills`）
- Test: `apps/server-next/tests/sqlite-repositories-skills.test.ts`（Create）

**Interfaces:**
- Consumes: Task 1 的 `SkillDto`、`AgentDto.skills`
- Produces: `agents.skills_json` 列、`repositories.agents.updateSkills({agentId, skills, timestamp})`

- [ ] **Step 1: 写失败测试**

`apps/server-next/tests/sqlite-repositories-skills.test.ts`：
```ts
import { describe, expect, test } from 'vitest';
import { openMigratedDatabases, createSqliteRepositories, createServerNextUseCases, createIds } from './helpers';

describe('agents skills_json 持久化', () => {
  test('upsert 写入 skills_json，mapAgent 读回一致', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({ repositories, clock: { now: () => 500 },
        ids: { nextId: createIds(['user-1', 'team-1', 'device-1', 'agent-1']) } });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });

      // 直接 upsert 一个带 skills 的 custom agent
      await repositories.agents.upsert({
        id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'],
        name: 'mindmap-ppt', adapterKind: 'claude-code', category: 'executor-hosted',
        source: 'custom', status: 'online', deviceId: 'device-1', lastSeenAt: 500,
        skills: [{ name: 'analyze', description: 'deep analysis', scope: 'user',
          sourcePath: '/h/.claude/skills/analyze', adapterKind: 'claude-code' }],
      } as any);

      const got = await repositories.agents.getById('agent-1');
      expect(got?.skills).toEqual([{ name: 'analyze', description: 'deep analysis', scope: 'user',
        sourcePath: '/h/.claude/skills/analyze', adapterKind: 'claude-code' }]);
    } finally { close(); }
  });

  test('updateSkills 单独更新 skills_json', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({ repositories, clock: { now: () => 500 },
        ids: { nextId: createIds(['user-1', 'team-1', 'device-1', 'agent-1']) } });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
      await repositories.agents.upsert({
        id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'],
        name: 'a', adapterKind: 'claude-code', category: 'executor-hosted',
        source: 'custom', status: 'online', deviceId: 'device-1', lastSeenAt: 500,
      } as any);

      await repositories.agents.updateSkills({
        agentId: 'agent-1',
        skills: [{ name: 's1', description: 'd', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' }],
        timestamp: 600,
      });

      const got = await repositories.agents.getById('agent-1');
      expect(got?.skills?.length).toBe(1);
      expect(got?.skills?.[0].name).toBe('s1');
    } finally { close(); }
  });

  test('脏 skills_json 不崩 mapAgent，回退 undefined', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      globalDb.exec(`INSERT INTO agents (id, primary_team_id, name, normalized_name, adapter_kind, category, source, status, last_seen_at, created_at, updated_at, skills_json) VALUES ('x','t','n','n','claude-code','executor-hosted','custom','online',0,0,0,'{not json')`);
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const got = await repositories.agents.getById('x');
      expect(got?.skills).toBeUndefined();
    } finally { close(); }
  });
});
```

> 注：若 `tests/helpers.ts` 不存在，改为从现有 `tests/sqlite-repositories.test.ts` 顶部复制 `openMigratedDatabases`/`createSqliteRepositories`/`createServerNextUseCases`/`createIds` 的真实导入（见该文件 import 段）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories-skills.test.ts`
Expected: FAIL（无 skills_json 列 / updateSkills 未定义）

- [ ] **Step 3: 实现 migration**

`apps/server-next/src/infra/sqlite/migrations/global/0010_agent_skills.sql`：
```sql
ALTER TABLE agents ADD COLUMN skills_json TEXT;
```

- [ ] **Step 4: 实现 repository 存取**

`apps/server-next/src/application/repositories.ts` —— `AgentRecord` 与接口：
```ts
export type AgentRecord = AgentDto & { deletedAt?: UnixMs };
export type AgentUpsertRecord = AgentRecord & { env?: Record<string, string> };

export interface AgentRepository {
  // ...现有方法保持不变...
  updateSkills(input: { agentId: ID; skills: SkillDto[]; timestamp: UnixMs }): Promise<AgentRecord | null>;
}
```
（顶部确保 `import type { SkillDto } from '../../../../packages/contracts/src/agent.js';` 或现有 contracts 导入路径）

`apps/server-next/src/infra/sqlite/repositories.ts`：

(a) `upsert` 的 INSERT 列加 `skills_json`、VALUES 加一个 `?`、参数加：
```ts
// 在 ON CONFLICT 的 UPDATE SET 段，紧跟 cwd = excluded.cwd, 之后加：
        skills_json = excluded.skills_json,
```
`.run(...)` 参数列表里，紧跟 `agent.cwd ?? null,` 加：
```ts
      agent.skills ? JSON.stringify(agent.skills) : null,
```
（注意 INSERT 列清单也要加 `skills_json`，VALUES 占位符对应 +1）

(b) `mapAgent` 返回对象里，紧跟 `cwd: sqliteNullableText(row, 'cwd'),` 加：
```ts
    skills: parseJsonArraySafe(sqliteNullableText(row, 'skills_json')) ?? undefined,
```
其中 `parseJsonArraySafe` 在文件顶部工具函数区新增（容错解析）：
```ts
function parseJsonArraySafe(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
```
（若已有 `parseJsonArray`，新加一个容错版，避免抛错）

(c) 新增 `updateSkills` 方法（紧挨 `updateStatus` 之后）：
```ts
async updateSkills(input) {
  globalDb
    .prepare('UPDATE agents SET skills_json = ?, updated_at = ? WHERE id = ?')
    .run(input.skills ? JSON.stringify(input.skills) : null, input.timestamp, input.agentId);
  const row = globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId);
  return row ? mapAgent(globalDb, row) : null;
},
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories-skills.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/infra/sqlite/migrations/global/0010_agent_skills.sql apps/server-next/src/application/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/tests/sqlite-repositories-skills.test.ts
git commit -m "server: agents 表新增 skills_json 列与 updateSkills 方法" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: daemon — scanCustomAgentSkills 扫描核心

**Files:**
- Create: `apps/daemon-next/src/skill-scanner.ts`
- Test: `apps/daemon-next/tests/skill-scanner.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SkillDto`、`AdapterKind`
- Produces: `scanCustomAgentSkills(customAgent: { id, adapterKind, cwd? }, home: string): SkillDto[]`

- [ ] **Step 1: 写失败测试**

`apps/daemon-next/tests/skill-scanner.test.ts`：
```ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanCustomAgentSkills } from '../src/skill-scanner';

function writeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody\n`);
}

describe('scanCustomAgentSkills', () => {
  test('claude-code 扫全局 + 项目 skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'proj-'));
    writeSkill(join(home, '.claude/skills'), 'global-skill', 'global desc');
    writeSkill(join(projectCwd, '.claude/skills'), 'project-skill', 'project desc');

    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code', cwd: projectCwd }, home);

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['global-skill', 'project-skill']);
    const proj = skills.find((s) => s.name === 'project-skill')!;
    expect(proj.scope).toBe('project');
    const glob = skills.find((s) => s.name === 'global-skill')!;
    expect(glob.scope).toBe('user');
  });

  test('codex 扫 ~/.agents/skills + 项目 + 内置 system', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'proj-'));
    writeSkill(join(home, '.agents/skills'), 'codex-user', 'codex user skill');
    writeSkill(join(projectCwd, '.agents/skills'), 'codex-proj', 'codex proj skill');

    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'codex', cwd: projectCwd }, home);
    const names = skills.map((s) => s.name);
    expect(names).toContain('codex-user');
    expect(names).toContain('codex-proj');
    expect(names).toContain('skill-creator');      // 内置 system
    const sys = skills.find((s) => s.name === 'skill-creator')!;
    expect(sys.scope).toBe('system');
  });

  test('目录不存在 → 空数组（不抛错）', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code', cwd: '/nonexistent-cwd' }, home);
    // claude-code 无 system，全局/项目都不存在 → 空
    expect(skills).toEqual([]);
  });

  test('SKILL.md 缺 name frontmatter → 跳过该 skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const skillDir = join(home, '.claude/skills', 'bad');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: no name here\n---\nbody`);
    writeSkill(join(home, '.claude/skills'), 'good', 'has name');

    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code' }, home);
    expect(skills.map((s) => s.name)).toEqual(['good']);
  });

  test('不支持的 adapterKind → 空数组', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'hermes', cwd: '/x' }, home);
    expect(skills).toEqual([]);
  });

  test('description 截断到 200 字符', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const longDesc = 'x'.repeat(500);
    writeSkill(join(home, '.claude/skills'), 'big', longDesc);
    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code' }, home);
    expect(skills[0].description.length).toBe(200);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/daemon-next && npx vitest run tests/skill-scanner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 skill-scanner.ts**

`apps/daemon-next/src/skill-scanner.ts`：
```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { AdapterKind, SkillDto } from '../../../../packages/contracts/src/index.js';

const MAX_DESCRIPTION = 200;
const MAX_SKILLS = 200;

// codex 二进制内置 system skills（磁盘扫不到，静态清单）
const CODEX_SYSTEM_SKILLS: SkillDto[] = [
  { name: 'skill-creator', description: 'Create new Codex skills', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
  { name: 'plugin-creator', description: 'Create Codex plugins bundling skills + MCP', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
  { name: 'imagegen', description: 'Generate images via Codex', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
];

// 配置表驱动：每个 adapter 的全局/项目 skills 目录。其它 adapter 留 undefined（架构预留）。
const SKILL_SCAN_CONFIGS: Partial<Record<AdapterKind, { userDir: string; projectDir: string; system: SkillDto[] }>> = {
  'claude-code': { userDir: '.claude/skills', projectDir: '.claude/skills', system: [] },
  'codex': { userDir: '.agents/skills', projectDir: '.agents/skills', system: CODEX_SYSTEM_SKILLS },
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** 解析 SKILL.md frontmatter，提取 name + description。失败返回 null。 */
function parseSkillFrontmatter(skillMdPath: string, scope: SkillDto['scope'], adapterKind: AdapterKind, sourcePath: string): SkillDto | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const front = parseYaml(match[1]) as { name?: unknown; description?: unknown } | null;
    if (!front || typeof front !== 'object') return null;
    const name = typeof front.name === 'string' ? front.name.trim() : '';
    if (!name) return null;
    const description = typeof front.description === 'string' ? truncate(front.description, MAX_DESCRIPTION) : '';
    return { name, description, scope, sourcePath, adapterKind };
  } catch {
    return null;
  }
}

function scanDir(dir: string, scope: SkillDto['scope'], adapterKind: AdapterKind): SkillDto[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillDto[] = [];
  for (const entry of entries) {
    const sub = join(dir, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = parseSkillFrontmatter(join(sub, 'SKILL.md'), scope, adapterKind, sub);
    if (skill) out.push(skill);
  }
  return out;
}

export function scanCustomAgentSkills(customAgent: { id: string; adapterKind: AdapterKind; cwd?: string }, home: string): SkillDto[] {
  const config = SKILL_SCAN_CONFIGS[customAgent.adapterKind];
  if (!config) return [];
  const user = scanDir(join(home, config.userDir), 'user', customAgent.adapterKind);
  const project = customAgent.cwd ? scanDir(join(customAgent.cwd, config.projectDir), 'project', customAgent.adapterKind) : [];
  const merged = [...config.system, ...user, ...project];
  return merged.length > MAX_SKILLS ? merged.slice(0, MAX_SKILLS) : merged;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/daemon-next && npx vitest run tests/skill-scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/skill-scanner.ts apps/daemon-next/tests/skill-scanner.test.ts
git commit -m "daemon: 新增 scanCustomAgentSkills 扫描 claude-code/codex skills" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: daemon — scanRequested handler 扩展 + reportCustomSkills 上报

**Files:**
- Modify: `apps/daemon-next/src/index.ts`（scanRequested handler 收 customAgents + 新增 `reportCustomSkills` 上报）
- Test: `apps/daemon-next/tests/skill-report.test.ts`（Create）

**Interfaces:**
- Consumes: Task 1 `AGENT_EVENTS.agent.reportCustomSkills`、`ScanRequest.customAgents`；Task 3 `scanCustomAgentSkills`
- Produces: daemon 收到 scanRequested 后扫描 custom agent skills 并 emitWithAck 上报

- [ ] **Step 1: 写失败测试**

`apps/daemon-next/tests/skill-report.test.ts`（用 mock socket 验证收到 customAgents 后上报 reportCustomSkills）：
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/socket.js';

function writeSkill(dir: string, name: string) {
  const d = join(dir, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody`);
}

describe('scanRequested customAgents → reportCustomSkills', () => {
  test('收到 customAgents 后扫描并上报 skills', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    writeSkill(join(home, '.claude/skills'), 'analyze');
    const emitted: { event: string; payload: unknown }[] = [];
    const handlers: Record<string, (p: unknown, ack?: (r: unknown) => void) => void> = {};
    const socket = {
      on: (ev: string, h: (p: unknown, ack?: (r: unknown) => void) => void) => { handlers[ev] = h; },
      emitWithAck: vi.fn(async (event: string, payload: unknown) => {
        emitted.push({ event, payload }); return { ok: true };
      }),
    };

    // 直接调内部扫描+上报函数（见 Step 3 导出的 reportCustomAgentSkills）
    const { reportCustomAgentSkills } = await import('../src/index.js');
    await reportCustomAgentSkills(socket as any, {
      teamId: 't1', deviceId: 'd1',
      customAgents: [{ id: 'a1', adapterKind: 'claude-code', cwd: undefined }],
    }, home);

    expect(emitted[0].event).toBe(AGENT_EVENTS.agent.reportCustomSkills);
    const payload = emitted[0].payload as { items: { agentId: string; skills: { name: string }[] }[] };
    expect(payload.items[0].agentId).toBe('a1');
    expect(payload.items[0].skills.map((s) => s.name)).toContain('analyze');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/daemon-next && npx vitest run tests/skill-report.test.ts`
Expected: FAIL（`reportCustomAgentSkills` 未导出）

- [ ] **Step 3: 实现上报函数并接入 handler**

`apps/daemon-next/src/index.ts`：

顶部 import：
```ts
import { scanCustomAgentSkills } from './skill-scanner.js';
```

新增导出函数（放在 `reportDeviceSnapshot` 附近）：
```ts
export async function reportCustomAgentSkills(
  socket: DaemonProtocolSocket,
  input: { teamId: string; deviceId: string; customAgents: { id: string; adapterKind: any; cwd?: string }[] },
  home: string,
): Promise<void> {
  const items = customAgentItems(input, home);
  try {
    await socket.emitWithAck(AGENT_EVENTS.agent.reportCustomSkills, {
      teamId: input.teamId, deviceId: input.deviceId, items,
    });
  } catch (error) {
    console.warn(`daemon emit ${AGENT_EVENTS.agent.reportCustomSkills} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function customAgentItems(input: { customAgents: { id: string; adapterKind: any; cwd?: string }[] }, home: string) {
  const items: { agentId: string; skills: ReturnType<typeof scanCustomAgentSkills> }[] = [];
  for (const ca of input.customAgents) {
    try {
      items.push({ agentId: ca.id, skills: scanCustomAgentSkills(ca, home) });
    } catch (error) {
      console.warn(`scan skills for agent ${ca.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      items.push({ agentId: ca.id, skills: [] });
    }
  }
  return items;
}
```

扩展 scanRequested handler（行 172 附近），在 `reportDeviceSnapshot` 之后加：
```ts
socket.on(AGENT_EVENTS.device.scanRequested, async (payload) => {
  const request = readScanRequest(payload);
  if (request.deviceId !== currentDeviceId) return;
  const snapshot = scan ? await scan() : latestSnapshot;
  latestSnapshot = snapshot;
  await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snapshot.runtimes, snapshot.agents);
  // 新增：扫描 custom agent skills 并上报
  if (request.customAgents && request.customAgents.length > 0) {
    await reportCustomAgentSkills(socket, { teamId: device.teamId, deviceId: currentDeviceId, customAgents: request.customAgents }, deviceHomeDir());
  }
  await input.onScanChanged?.(snapshot);
});
```
（`deviceHomeDir()` 用现有的 home 解析；若作用域内已有 `home`/`homedir()` 变量则直接用，确保与 scanner 一致——通常是 `options.homeDir ?? homedir()`，在 createDaemonProtocolClient 顶部已解析为变量后传入 scanner，此处复用同一变量。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/daemon-next && npx vitest run tests/skill-report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/tests/skill-report.test.ts
git commit -m "daemon: scanRequested 收 customAgents 后上报 reportCustomSkills" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: server — reportCustomSkills handler + scanRequested 下发 customAgents + hello 首推

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`（新增 `reportCustomSkills` usecase；`requestDeviceScan` 填充 customAgents）
- Modify: `apps/server-next/src/transport/socket-handlers.ts`（bind `reportCustomSkills`；hello 成功后首推 scanRequested）
- Test: `apps/server-next/tests/skill-sync.test.ts`（Create）

**Interfaces:**
- Consumes: Task 1 事件；Task 2 `updateSkills`
- Produces: server 收 reportCustomSkills → 按 agentId 更新 skills_json；scanRequested 下发带 customAgents；hello 后首推

- [ ] **Step 1: 写失败测试**

`apps/server-next/tests/skill-sync.test.ts`：
```ts
import { describe, expect, test } from 'vitest';
import { openMigratedDatabases, createSqliteRepositories, createServerNextUseCases, createIds } from './helpers';

async function bootstrap() {
  const { globalDb, teamDb, close } = openMigratedDatabases();
  const repositories = createSqliteRepositories({ globalDb, teamDb });
  const app = createServerNextUseCases({ repositories, clock: { now: () => 1000 },
    ids: { nextId: createIds(['user-1', 'team-1', 'device-1', 'agent-1']) } });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
  // 直接造一个 custom agent
  await repositories.agents.upsert({
    id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'],
    name: 'mindmap', adapterKind: 'claude-code', category: 'executor-hosted',
    source: 'custom', status: 'online', deviceId: 'device-1', lastSeenAt: 1000, cwd: '/proj',
  } as any);
  return { app, repositories, close };
}

describe('reportCustomSkills usecase', () => {
  test('按 agentId 更新 skills_json', async () => {
    const { app, repositories, close } = await bootstrap();
    try {
      const result = await app.reportCustomSkills({
        teamId: 'team-1', deviceId: 'device-1',
        items: [{ agentId: 'agent-1', skills: [{ name: 's', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' }] }],
      } as any);
      expect((result as any).ok).toBe(true);
      const got = await repositories.agents.getById('agent-1');
      expect(got?.skills?.[0].name).toBe('s');
    } finally { close(); }
  });

  test('未知 agentId 跳过，不报错', async () => {
    const { app, close } = await bootstrap();
    try {
      const result = await app.reportCustomSkills({
        teamId: 'team-1', deviceId: 'device-1',
        items: [{ agentId: 'nope', skills: [] }],
      } as any);
      expect((result as any).ok).toBe(true);
    } finally { close(); }
  });
});

describe('requestDeviceScan 下发 customAgents', () => {
  test('request 含该 device 的 custom agent 列表', async () => {
    const { app, close } = await bootstrap();
    try {
      const result = await app.requestDeviceScan({ teamId: 'team-1', userId: 'user-1', deviceId: 'device-1' } as any);
      const request = (result as any).value?.request ?? (result as any).request;
      expect(request.customAgents).toEqual([{ id: 'agent-1', adapterKind: 'claude-code', cwd: '/proj' }]);
    } finally { close(); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server-next && npx vitest run tests/skill-sync.test.ts`
Expected: FAIL（`reportCustomSkills` 未定义 / customAgents 未填充）

- [ ] **Step 3: 实现 reportCustomSkills usecase + 扩展 requestDeviceScan**

`apps/server-next/src/application/usecases.ts`：

(a) 接口声明区（行 77-99 附近的 usecase 接口）加：
```ts
reportCustomSkills(input: { teamId: ID; deviceId: ID; items: { agentId: ID; skills: SkillDto[] }[] }): Promise<Ack<{ updated: number }>>;
```

(b) 新增 usecase 实现（紧挨 `reportDeviceRuntimes` 之后）：
```ts
async reportCustomSkills(skillsInput) {
  const device = await repositories.devices.getById(skillsInput.deviceId);
  if (!device || device.teamId !== skillsInput.teamId) {
    return makeFailure('NOT_FOUND', 'Device not found');
  }
  const now = clock.now();
  let updated = 0;
  for (const item of skillsInput.items) {
    const existing = await repositories.agents.getById(item.agentId);
    if (!existing || existing.deviceId !== device.id) continue;   // 仅更新本设备的 custom agent
    await repositories.agents.updateSkills({ agentId: item.agentId, skills: item.skills, timestamp: now });
    updated += 1;
  }
  return makeSuccess({ updated });
},
```

(c) 扩展 `requestDeviceScan`（行 1570-1588），在构造 request 前查 custom agents：
```ts
async requestDeviceScan(scanInput) {
  const device = await repositories.devices.getById(scanInput.deviceId);
  if (!device) return makeFailure('NOT_FOUND', 'Device not found');
  if (!(await repositories.teams.isMember(device.teamId, scanInput.userId))) return makeFailure('FORBIDDEN', 'User is not a team member');
  if (device.status !== 'online') return makeFailure('DEVICE_OFFLINE', 'Device is not online');

  // 新增：附带该 device 的 custom agent（executor-hosted + source=custom），供 daemon 扫 skills
  const deviceAgents = await repositories.agents.listByDevice(device.id);
  const customAgents = deviceAgents
    .filter((a) => a.category === 'executor-hosted' && a.source === 'custom')
    .map((a) => ({ id: a.id, adapterKind: a.adapterKind, cwd: a.cwd }));

  return makeSuccess({
    request: { requestId: ids.nextId(), deviceId: device.id, customAgents },
  });
},
```
> 注：`ScanRequest` 已在 Task 1 加 `customAgents?`。`requestDeviceScan` 返回的 `request` 现在带 customAgents，由 `deviceScan(request)` 整体 emit 给 daemon。

- [ ] **Step 4: bind reportCustomSkills + hello 后首推**

`apps/server-next/src/transport/socket-handlers.ts`：

(a) 在 `agent.registerBatch` bind 旁（行 332 附近）加：
```ts
bind(socket, AGENT_EVENTS.agent.reportCustomSkills, app, 'reportCustomSkills', afterAgentMutation);
```

(b) hello 后首推：找到 `device.hello` 的 `socket.on(...)`（行 316-328），在 `await afterDeviceMutation(payload, result);` 之后加首推逻辑：
```ts
socket.on(AGENT_EVENTS.device.hello, async (payload, ack) => {
  try {
    const useCredentials = payload && typeof payload === 'object' && typeof (payload as { token?: unknown }).token === 'string';
    const result = useCredentials
      ? await app.deviceHelloFromCredentials(payload as Parameters<ServerNextUseCases['deviceHelloFromCredentials']>[0])
      : await app.deviceHello(payload as Parameters<ServerNextUseCases['deviceHello']>[0]);
    ack?.(result);
    await afterDeviceMutation(payload, result);

    // 新增：hello 成功后首推一次 scanRequested（带 customAgents），触发 daemon 扫 custom skills
    if (result.ok && options.deviceScan) {
      const deviceResult = result as { value?: { device?: { id?: string } } };
      const deviceId = deviceResult.value?.device?.id;
      if (deviceId) {
        const scan = await app.requestDeviceScan({ teamId: (payload as { teamId?: string }).teamId ?? '', userId: '', deviceId } as any);
        if (scan.ok && scan.value?.request) {
          options.deviceScan(scan.value.request);
        }
      }
    }
  } catch (error) {
    ack?.(socketErrorAck(error, AGENT_EVENTS.device.hello));
  }
});
```
> 注：hello payload 的 teamId/userId 校验在 usecase 内已做；首推失败不影响 hello ack（已返回）。`requestDeviceScan` 内的 `isMember` 校验对 device 连接可放宽——若报 FORBIDDEN，改为新增一个内部方法 `buildDeviceScanRequest({deviceId})` 跳过 userId 校验（device 自身触发）。若测试因此失败，在 usecases 加 `buildDeviceScanRequest` 仅按 deviceId 查 customAgents 构造 request，hello 首推与 web 触发都改调它。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server-next && npx vitest run tests/skill-sync.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/src/transport/socket-handlers.ts apps/server-next/tests/skill-sync.test.ts
git commit -m "server: reportCustomSkills handler + scanRequested 下发 customAgents + hello 首推" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: web — AgentSkillsSection 组件 + 集成 + 刷新

**Files:**
- Create: `apps/web-next/components/agent-skills-section.tsx`
- Modify: `apps/web-next/lib/schema.ts`（`AgentSnapshot` 加 `skills?`）
- Modify: `apps/web-next/components/member-detail.tsx`（插入 `<AgentSkillsSection>`）
- Test: `apps/web-next/tests/agent-skills-section.test.ts`（Create）

**Interfaces:**
- Consumes: Task 1 `AgentDto.skills`、`SkillDto`；现有 `deviceEvents().scan`、`<Section>`
- Produces: 详情页 Skills 区块（数量徽章 + 分组 + 前 5 + 查看全部 + 刷新）

- [ ] **Step 1: 写失败测试**

`apps/web-next/tests/agent-skills-section.test.ts`：
```ts
import { describe, expect, test } from 'vitest';
import { groupSkills, countSkillsByScope } from '../components/agent-skills-section';

const skills = [
  { name: 'a', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' },
  { name: 'b', description: 'd', scope: 'project', sourcePath: '/p', adapterKind: 'claude-code' },
  { name: 'c', description: 'd', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
] as any;

describe('AgentSkillsSection 纯逻辑', () => {
  test('groupSkills 按 scope 分组', () => {
    const g = groupSkills(skills);
    expect(g.user.map((s) => s.name)).toEqual(['a']);
    expect(g.project.map((s) => s.name)).toEqual(['b']);
    expect(g.system.map((s) => s.name)).toEqual(['c']);
  });

  test('countSkillsByScope 计数', () => {
    expect(countSkillsByScope(skills)).toEqual({ system: 1, user: 1, project: 1 });
  });

  test('空 skills → 各组空', () => {
    expect(groupSkills([] as any)).toEqual({ system: [], user: [], project: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web-next && npx vitest run tests/agent-skills-section.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 schema + 组件**

`apps/web-next/lib/schema.ts` —— `AgentSnapshot` 类型加 `skills?`（与 AgentDto.skills 对齐）：
```ts
// 在 AgentSnapshot 接口内加（若 AgentSnapshot = AgentDto & {...} 则 skills 自动继承，确认即可）：
skills?: SkillDto[];
```
> 若 `AgentSnapshot` 是 `AgentDto & {...}` 形式，则 skills 已通过 AgentDto 继承，无需改 schema——确认 import 链即可。

`apps/web-next/components/agent-skills-section.tsx`：
```tsx
import { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { AgentSnapshot, SkillDto } from '@/lib/schema';
import { deviceEvents } from '@/lib/socket';

export function groupSkills(skills: SkillDto[] | undefined) {
  const base = { system: [] as SkillDto[], user: [] as SkillDto[], project: [] as SkillDto[] };
  if (!skills) return base;
  for (const s of skills) {
    if (s.scope === 'system') base.system.push(s);
    else if (s.scope === 'user') base.user.push(s);
    else base.project.push(s);
  }
  return base;
}

export function countSkillsByScope(skills: SkillDto[] | undefined) {
  const g = groupSkills(skills);
  return { system: g.system.length, user: g.user.length, project: g.project.length };
}

const PREVIEW = 5;
const SCOPE_LABEL: Record<keyof ReturnType<typeof groupSkills>, string> = {
  system: '内置', user: '全局', project: '项目',
};

function SkillRow({ skill }: { skill: SkillDto }) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <span className="text-sm font-medium text-neutral-800">{skill.name}</span>
      {skill.description && <span className="text-xs text-neutral-500 line-clamp-2">{skill.description}</span>}
    </div>
  );
}

export function AgentSkillsSection({ agent }: { agent: AgentSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const skills = agent.skills;
  if (!skills || skills.length === 0) return null;

  const grouped = groupSkills(skills);
  const total = skills.length;

  const onRefresh = async () => {
    if (!agent.deviceId) return;
    setRefreshing(true);
    try { await deviceEvents().scan(agent.deviceId); } finally { setRefreshing(false); }
  };

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-neutral-500">
        <span className="flex items-center gap-2"><Sparkles size={15} />技能 ({total})</span>
        {agent.deviceId && (
          <button onClick={onRefresh} disabled={refreshing}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />刷新
          </button>
        )}
      </h2>
      <div className="flex flex-col gap-3">
        {(['system', 'user', 'project'] as const).map((scope) => {
          const list = grouped[scope];
          if (list.length === 0) return null;
          const shown = expanded ? list : list.slice(0, PREVIEW);
          return (
            <div key={scope}>
              <div className="mb-1 text-xs text-neutral-400">{SCOPE_LABEL[scope]} ({list.length})</div>
              {shown.map((s) => <SkillRow key={`${scope}-${s.name}`} skill={s} />)}
            </div>
          );
        })}
      </div>
      {total > PREVIEW && (
        <button onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-blue-600 hover:underline">
          {expanded ? '收起' : `查看全部 (${total})`}
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 4: 集成到 member-detail.tsx**

`apps/web-next/components/member-detail.tsx`：

(a) 顶部 import：
```tsx
import { AgentSkillsSection } from './agent-skills-section';
```

(b) 在 AgentProfile 的 JSX 里，"创建的智能体" `<Section>` 之后、"操作" `<Section>` 之前插入：
```tsx
<AgentSkillsSection agent={agent} />
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web-next && npx vitest run tests/agent-skills-section.test.ts`
Expected: PASS

- [ ] **Step 6: 全量回归 + Commit**

```bash
cd apps/web-next && npx vitest run
git add apps/web-next/components/agent-skills-section.tsx apps/web-next/components/member-detail.tsx apps/web-next/lib/schema.ts apps/web-next/tests/agent-skills-section.test.ts
git commit -m "web: AgentSkillsSection 组件（分组+前5预览+查看全部+刷新）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 端到端验证（手动）

**Files:** 无代码改动，仅验证。

- [ ] **Step 1: 全仓测试**

Run: `pnpm -r test` （或各包 `npx vitest run`）
Expected: 全 PASS

- [ ] **Step 2: 起本地三服务，造一个 claude-code custom agent**

用 [[agentbean-restart]] 的三服务重启命令起 server-next / web-next / daemon-next。在 web 创建一个 claude-code custom agent（指向一个含 `~/.claude/skills` 或项目 `.claude/skills` 的真实目录）。

- [ ] **Step 3: 验收成功标准**

对照 PRD 成功标准逐条验证：
1. 该 custom agent 详情页出现"技能 (N)"区块，列出全局 skills。
2. 在其 cwd 下 `mkdir -p .claude/skills/xxx && 写 SKILL.md`，点"刷新"，项目 skill 出现。
3. codex custom agent 详情页含 3 个内置 system skill。
4. 无 skills 的 agent（如 hermes）不显示该区块。
5. 单个 skill 故意写坏 frontmatter，其它 skill 仍展示、agent 上报正常。

- [ ] **Step 4: Commit 验收记录（可选）**

```bash
git commit --allow-empty -m "验证: Agent Skills 区块端到端验收通过" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review 备注

- **Spec coverage**：PRD 6 目标 → Task 1(contracts) / Task 2(存储) / Task 3+4(daemon 扫描+上报) / Task 5(server handler+下发+首推) / Task 6(web 展示+刷新) / Task 7(e2e 验收) 全覆盖。非目标（其它 adapter / 可编辑 / 详情页 / 跨 agent 查询）未建 task，符合预期。
- **Type 一致性**：`SkillDto`、`AgentDto.skills`、`reportCustomSkills`、`ScanRequest.customAgents`、`updateSkills` 在各 task 间命名一致。
- **已知实现风险点**（writing-plans 已标注，执行时注意）：
  - Task 4 的 `deviceHomeDir()` 需复用 createDaemonProtocolClient 顶部已解析的 home 变量，避免与 scanner 不一致。
  - Task 5 hello 首推的 `requestDeviceScan` 受 `isMember` 校验限制——若 device 连接场景报 FORBIDDEN，按 Step 4 注释新增 `buildDeviceScanRequest` 内部方法绕过 userId 校验。
  - Task 5 `mapAgent` 若已有 `parseJsonArray` 抛错，须用新加的容错 `parseJsonArraySafe`。
