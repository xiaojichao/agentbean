# daemon-next 多 profile + YAML 配置 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon-next token 持久化 + 多 profile(--all-profiles)+ YAML 配置文件(`${VAR}` 插值),对齐原版。

**Architecture:** 纯 daemon 侧,server-next/contracts 零改动。新增 `profile-paths.ts`/`auth-store.ts`/`config.ts`(YAML+env);`cli.ts` parseDaemonNextCliConfig 合并 YAML(优先级 CLI>env>YAML>默认),runDaemonNextCli 加 token 持久化(invite→save / loadAuth)/--all-profiles。

**Tech Stack:** TypeScript(Node 22)、vitest、`js-yaml`(新增依赖,原版同款)。配置优先级 CLI args > env > YAML > 默认。

**对应 spec:** `docs/superpowers/specs/2026-06-19-daemon-profile-config-design.md`

**已验证:** 原版 auth-store(`~/.agentbean/teams/{profileId}/auth.json`)+ `profileIdForNetwork` slugify + `--all-profiles`(`index.ts:194`)+ YAML `js-yaml`/`deepInterpolate`;daemon-next cli `parseDaemonNextCliConfig`/`runDaemonNextCli` 现状;invite credentials 返回 `{teamId, ownerId, token}`。

**注意(#303 整合):** #303 新增 `scan-cache.ts` 的 `scanCachePath` 用 `teams/{profileId}/`;本 plan 的 `profile-paths.ts` 作单一来源,Task 1 后 scan-cache 改用 profile-paths(rebase #303 时)。cli.ts 改动段:本 plan 改 parseDaemonNextCliConfig + runDaemonNextCli 开头;#303 改 runDaemonNextCli 中段(scan 缓存)——冲突小。

---

## 文件结构

| 文件 | 责任 | 状态 |
|------|------|------|
| `apps/daemon-next/src/profile-paths.ts` | `profileRoot`/`authFile`/`sanitizeProfileId`(单一 profile 路径来源) | 🆕 |
| `apps/daemon-next/src/auth-store.ts` | `loadAuth`/`saveAuth`/`clearAuth`/`listAuthProfiles` | 🆕 |
| `apps/daemon-next/src/config.ts` | `loadYamlConfig` + `deepInterpolate`(`${VAR}`) | 🆕 |
| `apps/daemon-next/src/cli.ts` | parseDaemonNextCliConfig 合并 YAML;runDaemonNextCli token 持久化 + --all-profiles + loadAuth | ✏️ |
| `apps/daemon-next/package.json` | 加 `js-yaml` 依赖 | ✏️ |
| `apps/daemon-next/tests/*.test.ts` | 各模块 + cli 集成测试 | 🆕 |

---

## Task 1: profile-paths.ts + auth-store.ts

**Files:** Create `src/profile-paths.ts`、`src/auth-store.ts`;Test `tests/profile-paths.test.ts`、`tests/auth-store.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/profile-paths.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { authFile, profileRoot, sanitizeProfileId } from '../src/profile-paths';

describe('profile-paths', () => {
  it('sanitizes profileId (lowercase, non-alnum → -)', () => {
    expect(sanitizeProfileId('AgentBean Dev')).toBe('agentbean-dev');
    expect(sanitizeProfileId('../../x')).toBe('x');
    expect(sanitizeProfileId('')).toBe('default');
    expect(sanitizeProfileId(undefined)).toBe('default');
  });
  it('authFile nests under teams/{profileId}/auth.json', () => {
    expect(authFile('team-1', '/root')).toBe('/root/teams/team-1/auth.json');
  });
  it('profileRoot defaults to ~/.agentbean when no baseDir', () => {
    expect(profileRoot('default').endsWith('.agentbean/teams/default')).toBe(true);
  });
});
```

`tests/auth-store.test.ts`:
```typescript
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import type { AuthData } from '../src/auth-store';
import { loadAuth, saveAuth, clearAuth, listAuthProfiles } from '../src/auth-store';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'auth-')));
const data: AuthData = { token: 'tok-1', serverUrl: 'http://s', teamId: 'team-1', ownerId: 'owner-1' };

describe('auth-store', () => {
  it('save → load round-trip', () => {
    saveAuth(data, { profileId: 'team-1', baseDir: base });
    expect(loadAuth({ profileId: 'team-1', baseDir: base })).toEqual(data);
  });
  it('load returns null when missing or corrupt', () => {
    expect(loadAuth({ profileId: 'missing', baseDir: base })).toBeNull();
  });
  it('clear removes the auth file', () => {
    saveAuth(data, { profileId: 'team-1', baseDir: base });
    clearAuth({ profileId: 'team-1', baseDir: base });
    expect(loadAuth({ profileId: 'team-1', baseDir: base })).toBeNull();
  });
  it('listAuthProfiles enumerates saved profiles', () => {
    saveAuth(data, { profileId: 'team-1', baseDir: base });
    saveAuth({ ...data, token: 'tok-2', teamId: 'team-2' }, { profileId: 'team-2', baseDir: base });
    const profiles = listAuthProfiles({ baseDir: base });
    expect(profiles.map((p) => p.profileId).sort()).toEqual(['team-1', 'team-2']);
    expect(profiles.find((p) => p.profileId === 'team-2')?.token).toBe('tok-2');
  });
});
```

- [ ] **Step 2: 运行验证失败** — `cd apps/daemon-next && npx vitest run tests/profile-paths.test.ts tests/auth-store.test.ts`(模块不存在)

- [ ] **Step 3: 实现**

`src/profile-paths.ts`:
```typescript
import { join } from 'node:path';
import { homedir } from 'node:os';

export function sanitizeProfileId(profileId?: string): string {
  const raw = (profileId ?? '').trim();
  if (!raw) return 'default';
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'default';
}

export function profileRoot(profileId?: string, baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.agentbean'), 'teams', sanitizeProfileId(profileId));
}

export function authFile(profileId?: string, baseDir?: string): string {
  return join(profileRoot(profileId, baseDir), 'auth.json');
}
```

`src/auth-store.ts`:
```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { authFile, profileRoot } from './profile-paths.js';

export interface AuthData {
  token: string;
  serverUrl: string;
  teamId: string;
  ownerId: string;
}

export interface AuthProfile extends AuthData {
  profileId: string;
}

export function loadAuth(options: { profileId?: string; baseDir?: string } = {}): AuthData | null {
  try {
    const file = authFile(options.profileId, options.baseDir);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.teamId !== 'string' || typeof parsed.ownerId !== 'string') {
      return null;
    }
    return parsed as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData, options: { profileId?: string; baseDir?: string } = {}): void {
  try {
    const file = authFile(options.profileId, options.baseDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // best-effort persistence; never throw
  }
}

export function clearAuth(options: { profileId?: string; baseDir?: string } = {}): void {
  try {
    const file = authFile(options.profileId, options.baseDir);
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

export function listAuthProfiles(options: { baseDir?: string } = {}): AuthProfile[] {
  try {
    const teamsDir = join(options.baseDir ?? join(homedir(), '.agentbean'), 'teams');
    if (!existsSync(teamsDir)) return [];
    const profiles: AuthProfile[] = [];
    for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profileId = entry.name;
      const data = loadAuth({ profileId, baseDir: options.baseDir });
      if (data) profiles.push({ ...data, profileId });
    }
    return profiles;
  } catch {
    return [];
  }
}
```
(`homedir` import 在 auth-store.ts 顶部 `import { homedir } from 'node:os';`)

- [ ] **Step 4: 验证通过** — 两文件测试 PASS(3+4)。全量无回归。`npx tsc --noEmit` 无新错误。

- [ ] **Step 5: Commit** — `git add apps/daemon-next/src/{profile-paths,auth-store}.ts apps/daemon-next/tests/{profile-paths,auth-store}.test.ts && git commit -m "feat(daemon-next): add profile paths and auth store for token persistence"`

---

## Task 2: config.ts — YAML 加载 + env 插值

**Files:** Create `src/config.ts`;Modify `package.json`(加 js-yaml);Test `tests/config.test.ts`

- [ ] **Step 1: 加依赖 + 写测试**

`package.json` dependencies 加 `"js-yaml": "^4.1.0"`(根 node_modules 已有,版本对齐)。运行 `npm install`(workspace 会链接)。

`tests/config.test.ts`:
```typescript
import { writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deepInterpolate, loadYamlConfig } from '../src/config';

describe('deepInterpolate', () => {
  it('substitutes ${VAR} from process.env', () => {
    process.env.MY_VAR = 'hello';
    expect(deepInterpolate('${MY_VAR}')).toBe('hello');
    expect(deepInterpolate({ a: '${MY_VAR}', b: ['${MY_VAR}', 'lit'] })).toEqual({ a: 'hello', b: ['hello', 'lit'] });
    delete process.env.MY_VAR;
  });
  it('throws on missing env var', () => {
    delete process.env.NOPE_X;
    expect(() => deepInterpolate('${NOPE_X}')).toThrow(/missing env var/);
  });
});

describe('loadYamlConfig', () => {
  it('loads + interpolates a yaml file', () => {
    process.env.SRV = 'http://x';
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')));
    writeFileSync(join(dir, 'c.yaml'), 'serverUrl: ${SRV}\nteamId: t1\n');
    const cfg = loadYamlConfig(join(dir, 'c.yaml'));
    expect(cfg).toEqual({ serverUrl: 'http://x', teamId: 't1' });
    delete process.env.SRV;
  });
  it('returns null when file missing or corrupt', () => {
    expect(loadYamlConfig(join(tmpdir(), 'nope.yaml'))).toBeNull();
  });
});
```

- [ ] **Step 2: 验证失败** — `cd apps/daemon-next && npx vitest run tests/config.test.ts`

- [ ] **Step 3: 实现 config.ts**
```typescript
import { existsSync, readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export function interpolate(value: string): string {
  return value.replace(ENV_PATTERN, (_match, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config references missing env var: ${name}`);
    return v;
  });
}

export function deepInterpolate(node: unknown): unknown {
  if (typeof node === 'string') return interpolate(node);
  if (Array.isArray(node)) return node.map(deepInterpolate);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepInterpolate(v);
    return out;
  }
  return node;
}

export function loadYamlConfig(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const raw = parseYaml(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return deepInterpolate(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 验证通过** — config 测试 PASS。全量 + tsc 无回归。

- [ ] **Step 5: Commit** — `git add apps/daemon-next/src/config.ts apps/daemon-next/tests/config.test.ts apps/daemon-next/package.json && git commit -m "feat(daemon-next): add yaml config loader with env interpolation"`

---

## Task 3: cli.ts parseDaemonNextCliConfig 合并 YAML

**Files:** Modify `src/cli.ts`;Test `tests/cli.test.ts`(扩充)

- [ ] **Step 1: 扩充 cli.test.ts** — 加测试:YAML 提供默认,CLI/env 覆盖,优先级正确。用 tmpdir 写 yaml + 调 `parseDaemonNextCliConfig({ argv, env, configPath })`。
  - 关键断言:CLI args > env > YAML > 内置默认(如 `--server-url x` 覆盖 yaml 的 serverUrl;无 CLI 时用 yaml;无 yaml 用默认 `http://127.0.0.1:4000`)。

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 修改 cli.ts**
  - `DaemonNextCliConfig` 加 `configPath?: string`;`ParseDaemonNextCliConfigInput` 加 `configPath?: string`。
  - `parseDaemonNextCliConfig` 开头:`const yaml = input.configPath ? loadYamlConfig(input.configPath) : null;`(或默认路径 `~/.agentbean/daemon-next.yaml`)。
  - 合并:每个字段 `args[x] ?? env[Y] ?? yaml?.[z] ?? default`。如:
    ```typescript
    const serverUrl = trimTrailingSlash(
      args['server-url'] ?? env.AGENTBEAN_NEXT_SERVER_URL ?? (typeof yaml?.serverUrl === 'string' ? yaml.serverUrl : undefined) ?? 'http://127.0.0.1:4000',
    );
    ```
  - import `loadYamlConfig` from `./config.js`。

- [ ] **Step 4: 验证通过** — cli 测试 PASS。全量 + tsc 无回归。

- [ ] **Step 5: Commit** — `feat(daemon-next): merge yaml config into cli config (CLI > env > yaml > default)`

---

## Task 4: cli.ts runDaemonNextCli token 持久化(invite→save / loadAuth)

**Files:** Modify `src/cli.ts`;Test `tests/cli-auth.test.ts`

- [ ] **Step 1: 写测试** — mock `connectSocketIoClient`/`waitForDeviceInviteCredentials`/`createDaemonProtocolClient`(或用 spy),验证:
  - invite 模式:`waitForDeviceInviteCredentials` 返回 credentials → `saveAuth` 被调(用 tmpdir baseDir)。
  - 非 invite 且有 saved auth:`loadAuth` 命中 → 用 saved token/teamId/ownerId(不调 invite)。
  - 非 invite 无 saved:走 config teamId/ownerId(现状)。
  - 用环境变量 `AGENTBEAN_HOME`(或注入 baseDir)控制 auth 路径,避免污染真实 home。

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 修改 runDaemonNextCli**(开头,credentials 解析处):
```typescript
import { loadAuth, saveAuth } from './auth-store.js';
import { sanitizeProfileId } from './profile-paths.js';

// 在 connectSocketIoClient 之后、credentials 解析处:
let credentials = null;
if (config.inviteCode) {
  credentials = await waitForDeviceInviteCredentials(protocolSocket, { code: config.inviteCode, machineId, profileId: config.profileId, hostname: config.hostname, serverUrl: config.serverUrl });
  saveAuth({ token: credentials.token, serverUrl: config.serverUrl, teamId: credentials.teamId, ownerId: credentials.ownerId }, { profileId: sanitizeProfileId(credentials.teamId) });
} else {
  const saved = loadAuth({ profileId: config.profileId });
  if (saved && !config.teamId) {
    // 用 saved(免 invite/team-id/owner-id)
    config = { ...config, teamId: saved.teamId, ownerId: saved.ownerId, /* token 注入 device */ };
    savedToken = saved.token;
  }
}
const teamId = credentials?.teamId ?? config.teamId;
const ownerId = credentials?.ownerId ?? config.ownerId;
const token = credentials?.token ?? savedToken;
```
(`savedToken` let;device.token 用 token。具体按 cli.ts 现状结构整合。)

- [ ] **Step 4: 验证通过** — cli-auth 测试 PASS。全量 + tsc 无回归。

- [ ] **Step 5: Commit** — `feat(daemon-next): persist device token via auth-store (invite saves, start loads)`

---

## Task 5: cli.ts --all-profiles 多实例

**Files:** Modify `src/cli.ts`;Test `tests/cli-all-profiles.test.ts`

- [ ] **Step 1: 写测试** — mock `listAuthProfiles`(返回 2 profile)+ spy `runDaemonNextCli`(或 createDaemonProtocolClient)。`parseDaemonNextCliConfig({ argv: ['--all-profiles'] })` → `runDaemonNextCli` 调 `listAuthProfiles` + 并发为每 profile 启动(allProfiles=false)。断言:N 个实例启动、无 invite(用 saved)。

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 修改 cli.ts**
  - `DaemonNextCliConfig` 加 `allProfiles?: boolean`;`parseDaemonNextCliConfig` 解析 `args['all-profiles']`(boolean flag)。
  - `runDaemonNextCli` 开头:
    ```typescript
    if (config.allProfiles) {
      const profiles = listAuthProfiles();
      if (profiles.length === 0) {
        console.error('Error: no saved AgentBean team profiles found.');
        process.exit(1);
      }
      await Promise.all(profiles.map((p) => runDaemonNextCli({ ...config, profileId: p.profileId, teamId: p.teamId, ownerId: p.ownerId, allProfiles: false })));
      return;
    }
    ```
  - 注意 token 注入:--all-profiles 模式每 profile 的 token 来自 listAuthProfiles(profile.token),需传入 device.token。`DaemonNextCliConfig` 可能加 `token?: string`,或 runDaemonNextCli 内 loadAuth(profileId) 取 token。**推荐**:all-profiles 分支内对每 profile `loadAuth({profileId})` 取 token 注入(或 profile 自带 token)。

- [ ] **Step 4: 验证通过** — cli-all-profiles 测试 PASS。全量 + tsc 无回归。

- [ ] **Step 5: Commit** — `feat(daemon-next): add --all-profiles to run all saved team profiles concurrently`

---

## Task 6: 全量验证 + build + 文档

- [ ] **Step 1: daemon-next 全量测试** — `cd apps/daemon-next && npx vitest run` 全 PASS(baseline 62 + profile-paths 3 + auth-store 4 + config ~4 + cli ~3 + cli-auth + cli-all-profiles)。
- [ ] **Step 2: tsc + build** — `npx tsc --noEmit`(0 errors)+ `npm run build`(tsc -p)。
- [ ] **Step 3: known-gaps 文档** — `agentbean-next/docs/known-gaps.md` Daemon 缺口段补:多 profile + auth-store + YAML 配置已落地;参考 `apps/daemon-next/src/{profile-paths,auth-store,config}.ts`。
- [ ] **Step 4: 手动烟测(可选)** — invite → 确认 `~/.agentbean/teams/{slug}/auth.json` 写入 → 重启 daemon(不传 invite/team-id)→ 确认自动加载 → `--all-profiles`(存 2 profile)→ 确认 2 连接 → 写 yaml + `${VAR}` → 确认加载。
- [ ] **Step 5: Commit 文档** — `docs(agentbean-next): mark daemon multi-profile + yaml config as landed`

---

## 验证矩阵(self-review 对照 spec)

| spec 要求 | Task |
|-----------|------|
| token 持久化(invite→save/start→load) | Task 1(auth-store) + Task 4(cli 接入) |
| 多 profile(--all-profiles) | Task 1(listAuthProfiles) + Task 5 |
| YAML 配置 + env 插值 | Task 2 |
| 配置优先级 CLI>env>YAML>默认 | Task 3 |
| profileId = slugify(teamId) | Task 1(sanitizeProfileId) |
| server/contracts 零改动 | 全程不碰 |
| 错误不崩(auth 损坏→null、YAML 缺失→忽略) | Task 1/2 |
| 与 #303 cli 段不冲突 | 本 plan 改 parseConfig + runDaemon 开头;#303 改 runDaemon 中段 |

## 给新会话执行的提示

- 本 plan 在 worktree `feature/daemon-profile`(基于 main)。`docs/superpowers/specs/2026-06-19-daemon-profile-config-design.md` 是 spec。
- 执行用 subagent-driven-development(skill),每 task implementer + 两阶段 review。
- **Task 1 后**:若 #303(扫描缓存)已合并 main,让 scan-cache.ts 的 `scanCachePath` 改用本 task 的 `profile-paths.profileRoot`(单一来源,rebase 整合)。
- **Task 4/5** 的 cli.ts token 注入细节需读 cli.ts 现状(DaemonNextCliConfig 可能需加 `token?` 字段,或 runDaemonNextCli 内 loadAuth 取)——implementer 按现状整合,矛盾用 BLOCKED。
- 烟测需真实 server。
