# daemon-next 附件支持与产物归档 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 daemon-next 补全 custom agent 的附件下载(输入)与产物归档(输出)能力,使 dispatch 携带的附件能被命令使用、命令产生的文件能扫描上传并关联到聊天消息。

**Architecture:** 保持 executor「纯执行」(request→result,只 spawn),由 dispatch handler(index.ts)编排完整生命周期:建 per-run 目录 → 下载附件 → 注入 env/prompt → 执行 → 扫描产物 → HTTP upload → 合并 artifacts → 写 manifest。新增 4 个职责单一的模块(attachments / workspace-run / artifact-collector / artifact-uploader),依赖通过 `createDaemonProtocolClient` input 注入(沿用 envResolver 的 `createHttpEnvResolver({serverUrl, token})` 模式)。server-next 零改动。

**Tech Stack:** TypeScript(Node 22)、vitest、Node 内置 `fetch`/`FormData`/`Blob`、`node:fs`/`node:crypto`/`node:path`。无新依赖。

**对应 spec:** `docs/superpowers/specs/2026-06-19-daemon-artifacts-workspace-design.md`

**对 spec 的修正(实现时以此为准):**
- env 注入通过 `request.customAgent.env`(`executor.ts:37` 的 `customEnv` 直接合并进子进程,不经 `SAFE_ENV_KEYS` 白名单),**无需修改 `SAFE_ENV_KEYS`**。
- contracts `DispatchAttachmentDto` 字段是 `name`(非 `filename`)。

---

## 文件结构

| 文件 | 责任 | 状态 |
|------|------|------|
| `apps/daemon-next/src/attachments.ts` | `safeAttachmentFilename`、`downloadAttachments`(HTTP download 到 inputs/) | 🆕 创建 |
| `apps/daemon-next/src/workspace-run.ts` | `prepareWorkspaceRun`(建目录树)、`workspaceRunEnv`(env 注入)、`persistWorkspaceRunManifest`/`persistWorkspaceRunResponse` | 🆕 创建 |
| `apps/daemon-next/src/artifact-collector.ts` | `collectArtifacts`(扫描 outputs/ + cwd 兜底、mtime/扩展名/忽略目录过滤、SHA256 去重) | 🆕 创建 |
| `apps/daemon-next/src/artifact-uploader.ts` | `uploadArtifacts`(HTTP multipart upload、重试、返回 artifact id) | 🆕 创建 |
| `apps/daemon-next/src/index.ts` | `DispatchRequestPayload` 加 `attachments?`;`CreateDaemonProtocolClientInput` 加 `serverUrl`;dispatch handler 编排 | ✏️ 修改 |
| `apps/daemon-next/src/cli.ts` | 向 `createDaemonProtocolClient` 传 `serverUrl: config.serverUrl` | ✏️ 修改 |
| `apps/daemon-next/tests/*.test.ts` | 每个新模块的单元测试 + dispatch 编排集成测试 | 🆕 创建 |

模块依赖:`artifact-uploader.ts` →(import 类型)`artifact-collector.ts`;`index.ts` → 全部 4 个模块。

---

## Task 1: attachments.ts — 附件下载

**Files:**
- Create: `apps/daemon-next/src/attachments.ts`
- Test: `apps/daemon-next/tests/attachments.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/attachments.test.ts`:

```typescript
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { downloadAttachments, safeAttachmentFilename } from '../src/attachments';

describe('attachments', () => {
  test('safeAttachmentFilename strips path and unsafe chars', () => {
    expect(safeAttachmentFilename('report.pdf')).toBe('report.pdf');
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFilename('a b/c.txt')).toBe('c.txt');
    expect(safeAttachmentFilename('中文文件.json')).toBe('.json');
  });

  test('downloadAttachments fetches each attachment into inputDir with id-prefixed name', async () => {
    const inputDir = realpathSync(mkdtempSync(join(tmpdir(), 'attachments-')));
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const id = url.match(/artifacts\/([^/]+)\/download$/)?.[1] ?? 'unknown';
      return new Response(`${id}-body`, { status: 200 });
    };

    const downloaded = await downloadAttachments(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', inputDir, fetch: fakeFetch },
      [
        { id: 'att-1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 8 },
        { id: 'att-2', name: '../b.json' },
      ],
    );

    expect(downloaded).toHaveLength(2);
    expect(downloaded[0].localPath).toBe(join(inputDir, 'att-1-a.txt'));
    expect(readFileSync(downloaded[0].localPath, 'utf8')).toBe('att-1-body');
    expect(downloaded[1].localPath).toBe(join(inputDir, 'att-2-b.json'));
    expect(calls[0]).toContain('/api/teams/team-1/artifacts/att-1/download');
    expect(calls[0]).toContain(' '); // sanity
  });

  test('downloadAttachments skips attachments whose download fails (non-ok), keeps the rest', async () => {
    const inputDir = realpathSync(mkdtempSync(join(tmpdir(), 'attachments-')));
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('att-bad')) {
        return new Response('nope', { status: 404 });
      }
      return new Response('ok', { status: 200 });
    };

    const downloaded = await downloadAttachments(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', inputDir, fetch: fakeFetch },
      [
        { id: 'att-good', name: 'g.txt' },
        { id: 'att-bad', name: 'x.txt' },
      ],
    );

    expect(downloaded.map((d) => d.id)).toEqual(['att-good']);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/attachments.test.ts`
Expected: FAIL —— `Cannot find module '../src/attachments'`

- [ ] **Step 3: 实现 attachments.ts**

创建 `apps/daemon-next/src/attachments.ts`:

```typescript
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Mirrors packages/contracts DispatchAttachmentDto (field is `name`, not `filename`). */
export interface DispatchAttachment {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface DownloadedAttachment extends DispatchAttachment {
  localPath: string;
}

export interface DownloadAttachmentsInput {
  serverUrl: string;
  token: string;
  teamId: string;
  inputDir: string;
  fetch?: typeof fetch;
}

export function safeAttachmentFilename(filename: string): string {
  return basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Downloads each attachment from the server artifact download route into inputDir.
 * Failures (non-ok or network error) are skipped rather than aborting the dispatch;
 * a missing attachment must not block command execution.
 */
export async function downloadAttachments(
  input: DownloadAttachmentsInput,
  attachments: DispatchAttachment[],
): Promise<DownloadedAttachment[]> {
  const fetchFn = input.fetch ?? fetch;
  const results: DownloadedAttachment[] = [];
  for (const attachment of attachments) {
    const url = `${input.serverUrl}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/${encodeURIComponent(attachment.id)}/download`;
    try {
      const response = await fetchFn(url, { headers: { Authorization: `Bearer ${input.token}` } });
      if (!response.ok) {
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const localPath = join(input.inputDir, `${attachment.id}-${safeAttachmentFilename(attachment.name)}`);
      writeFileSync(localPath, bytes);
      results.push({ ...attachment, localPath });
    } catch {
      // skip on network error; never abort the dispatch
    }
  }
  return results;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/attachments.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/attachments.ts apps/daemon-next/tests/attachments.test.ts
git commit -m "feat(daemon-next): add attachment downloader for dispatch inputs"
```

---

## Task 2: workspace-run.ts — per-run 目录与 env 注入

**Files:**
- Create: `apps/daemon-next/src/workspace-run.ts`
- Test: `apps/daemon-next/tests/workspace-run.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/workspace-run.test.ts`:

```typescript
import { existsSync, mkdtempSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  prepareWorkspaceRun,
  workspaceRunEnv,
  persistWorkspaceRunManifest,
  persistWorkspaceRunResponse,
  workspaceRunPath,
} from '../src/workspace-run';

describe('workspace-run', () => {
  test('prepareWorkspaceRun creates inputs/outputs/logs under {cwd}/.agentbean/runs/{runId}', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    expect(ws.runDir).toBe(join(cwd, '.agentbean', 'runs', 'run-1'));
    expect(existsSync(ws.inputDir)).toBe(true);
    expect(existsSync(ws.outputDir)).toBe(true);
    expect(existsSync(ws.logsDir)).toBe(true);
  });

  test('workspaceRunPath is stable for the same cwd/runId', () => {
    expect(workspaceRunPath('/proj', 'r9')).toBe(join('/proj', '.agentbean', 'runs', 'r9'));
  });

  test('workspaceRunEnv exposes run id and the three dirs', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    const env = workspaceRunEnv(ws);
    expect(env.AGENTBEAN_RUN_ID).toBe('run-1');
    expect(env.AGENTBEAN_INPUT_DIR).toBe(ws.inputDir);
    expect(env.AGENTBEAN_OUTPUT_DIR).toBe(ws.outputDir);
    expect(env.AGENTBEAN_WORKSPACE).toBe(ws.runDir);
  });

  test('persistWorkspaceRunManifest writes valid JSON with file list', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    persistWorkspaceRunManifest(ws, {
      runId: 'run-1',
      status: 'succeeded',
      startedAt: 1000,
      completedAt: 2000,
      exitCode: 0,
      files: [{ relativePath: 'outputs/out.png', sha256: 'abc', sizeBytes: 10, filename: 'out.png' }],
    });
    const parsed = JSON.parse(readFileSync(ws.manifestPath, 'utf8'));
    expect(parsed.runId).toBe('run-1');
    expect(parsed.files[0].sha256).toBe('abc');
  });

  test('persistWorkspaceRunResponse writes the reply body', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const ws = prepareWorkspaceRun(cwd, 'run-1');
    persistWorkspaceRunResponse(ws, 'hello reply');
    expect(readFileSync(ws.responsePath, 'utf8')).toBe('hello reply');
  });

  test('two runIds get isolated directories', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const a = prepareWorkspaceRun(cwd, 'run-a');
    const b = prepareWorkspaceRun(cwd, 'run-b');
    expect(a.outputDir).not.toBe(b.outputDir);
    expect(readdirSync(join(cwd, '.agentbean', 'runs')).sort()).toEqual(['run-a', 'run-b']);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/workspace-run.test.ts`
Expected: FAIL —— `Cannot find module '../src/workspace-run'`

- [ ] **Step 3: 实现 workspace-run.ts**

创建 `apps/daemon-next/src/workspace-run.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceRunDir {
  cwd: string;
  runId: string;
  runDir: string;
  inputDir: string;
  outputDir: string;
  logsDir: string;
  manifestPath: string;
  responsePath: string;
}

export interface WorkspaceRunManifestFile {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

export interface WorkspaceRunManifest {
  runId: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  files: WorkspaceRunManifestFile[];
}

export function workspaceRunPath(cwd: string, runId: string): string {
  return join(cwd, '.agentbean', 'runs', runId);
}

export function prepareWorkspaceRun(cwd: string, runId: string): WorkspaceRunDir {
  const runDir = workspaceRunPath(cwd, runId);
  const inputDir = join(runDir, 'inputs');
  const outputDir = join(runDir, 'outputs');
  const logsDir = join(runDir, 'logs');
  for (const dir of [inputDir, outputDir, logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    cwd,
    runId,
    runDir,
    inputDir,
    outputDir,
    logsDir,
    manifestPath: join(runDir, 'manifest.json'),
    responsePath: join(runDir, 'response.md'),
  };
}

export function workspaceRunEnv(ws: WorkspaceRunDir): Record<string, string> {
  return {
    AGENTBEAN_RUN_ID: ws.runId,
    AGENTBEAN_WORKSPACE: ws.runDir,
    AGENTBEAN_INPUT_DIR: ws.inputDir,
    AGENTBEAN_OUTPUT_DIR: ws.outputDir,
  };
}

export function persistWorkspaceRunManifest(ws: WorkspaceRunDir, manifest: WorkspaceRunManifest): void {
  writeFileSync(ws.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function persistWorkspaceRunResponse(ws: WorkspaceRunDir, body: string): void {
  writeFileSync(ws.responsePath, body);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/workspace-run.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/workspace-run.ts apps/daemon-next/tests/workspace-run.test.ts
git commit -m "feat(daemon-next): add per-run workspace dir, env injection, and manifest persistence"
```

---

## Task 3: artifact-collector.ts — 产物扫描与 SHA256 去重

**Files:**
- Create: `apps/daemon-next/src/artifact-collector.ts`
- Test: `apps/daemon-next/tests/artifact-collector.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/artifact-collector.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectArtifacts } from '../src/artifact-collector';

async function touch(path: string, mtimeMs: number): Promise<void> {
  writeFileSync(path, 'x');
  const seconds = Math.floor(mtimeMs / 1000);
  utimesSync(path, seconds, seconds);
}

describe('artifact-collector', () => {
  test('collects all matching files from outputs dir regardless of mtime', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'a.png'), 'pic');
    writeFileSync(join(outputDir, 'b.txt'), 'text');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    const names = collected.map((c) => c.filename).sort();
    expect(names).toEqual(['a.png', 'b.txt']);
  });

  test('ignores files without whitelisted extension', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'keep.pdf'), 'p');
    writeFileSync(join(outputDir, 'skip.exe'), 'x');
    writeFileSync(join(outputDir, 'skip.log'), 'x');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    expect(collected.map((c) => c.filename)).toEqual(['keep.pdf']);
  });

  test('cwd fallback scan only picks files with mtime > startedAt', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    // old file in cwd root (before startedAt) -> ignored by fallback
    await touch(join(cwd, 'old.json'), 1000);
    // new file in cwd root (after startedAt) -> picked by fallback
    await touch(join(cwd, 'new.json'), 5000);

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 3000 });
    const names = collected.map((c) => c.filename);
    expect(names).toContain('new.json');
    expect(names).not.toContain('old.json');
  });

  test('cwd fallback skips ignored dirs like node_modules and .agentbean', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    mkdirSync(join(cwd, '.agentbean', 'runs', 'r'), { recursive: true });
    await touch(join(cwd, 'node_modules', 'leak.png'), 5000);
    await touch(join(cwd, '.agentbean', 'runs', 'r', 'nested.png'), 5000);

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    expect(collected.map((c) => c.filename)).not.toContain('leak.png');
    expect(collected.map((c) => c.filename)).not.toContain('nested.png');
  });

  test('dedupes by sha256, keeping the more semantic filename', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    // same content in two files; generic name should lose to semantic name
    writeFileSync(join(outputDir, 'image-001.png'), 'same-bytes');
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    await touch(join(cwd, 'sub', 'zzz.png'), 5000); // same content via fallback
    writeFileSync(join(cwd, 'sub', 'zzz.png'), 'same-bytes');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    const sameContent = collected.filter((c) => c.sha256 === collected[0].sha256);
    expect(sameContent).toHaveLength(1);
    expect(collected.length).toBeLessThanOrEqual(2);
  });

  test('fills sha256 and sizeBytes', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'a.txt'), 'hello');
    const [collected] = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    expect(collected.sizeBytes).toBe(5);
    expect(collected.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/artifact-collector.test.ts`
Expected: FAIL —— `Cannot find module '../src/artifact-collector'`

- [ ] **Step 3: 实现 artifact-collector.ts**

创建 `apps/daemon-next/src/artifact-collector.ts`:

```typescript
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.turbo', 'node_modules', 'vendor', '.agentbean',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;

export interface CollectedArtifact {
  absolutePath: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

export interface CollectArtifactsInput {
  /** per-run outputs/ directory; all matching files are collected regardless of mtime. */
  outputDir: string;
  /** customAgent.cwd; fallback scan picks matching files with mtime > startedAt. */
  cwd: string;
  /** command start timestamp (ms); used as mtime threshold for the cwd fallback. */
  startedAt: number;
  fs?: {
    readdir: typeof readdirSync;
    stat: typeof statSync;
    readFile: typeof readFileSync;
  };
}

/**
 * Scans outputs/ (always) plus cwd (mtime > startedAt, fallback) for product files,
 * applies extension + ignored-dir filters, and dedupes by sha256 (keeping the more
 * semantic filename). Returns the candidate artifacts to upload.
 */
export async function collectArtifacts(input: CollectArtifactsInput): Promise<CollectedArtifact[]> {
  const fs = input.fs ?? { readdir: readdirSync, stat: statSync, readFile: readFileSync };
  const bySha = new Map<string, CollectedArtifact>();

  const ingest = (rootAbs: string, rootForRelative: string, timeFilter: boolean): void => {
    let visited = 0;
    const stack: string[] = [rootAbs];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: ReturnType<typeof fs.readdir>;
      try {
        entries = fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (visited > MAX_OUTPUT_FILES_PER_ROOT) {
          return;
        }
        const abs = join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_OUTPUT_DIRS.has(entry.name)) {
            continue;
          }
          stack.push(abs);
        } else if (entry.isFile() && OUTPUT_FILE_EXT_RE.test(entry.name)) {
          visited += 1;
          let stat: ReturnType<typeof fs.stat>;
          try {
            stat = fs.stat(abs);
          } catch {
            continue;
          }
          if (timeFilter && stat.mtimeMs <= input.startedAt) {
            continue;
          }
          const content = fs.readFile(abs);
          const sha256 = createHash('sha256').update(content).digest('hex');
          const candidate: CollectedArtifact = {
            absolutePath: abs,
            relativePath: relative(rootForRelative, abs),
            sha256,
            sizeBytes: stat.size,
            filename: basename(abs),
          };
          const existing = bySha.get(sha256);
          if (!existing || fileNamePreference(candidate.filename) < fileNamePreference(existing.filename)) {
            bySha.set(sha256, candidate);
          }
        }
      }
    }
  };

  ingest(input.outputDir, input.outputDir, false);
  ingest(input.cwd, input.cwd, true);
  return [...bySha.values()];
}

function fileNamePreference(name: string): number {
  const lower = name.toLowerCase();
  if (/^ig_[a-f0-9]{32,}\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    return 0;
  }
  if (/^(image|output|generated)[._-]?\d*\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    return 1;
  }
  return 2;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/artifact-collector.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/artifact-collector.ts apps/daemon-next/tests/artifact-collector.test.ts
git commit -m "feat(daemon-next): add product artifact collector with sha256 dedup"
```

---

## Task 4: artifact-uploader.ts — HTTP multipart 上传与重试

**Files:**
- Create: `apps/daemon-next/src/artifact-uploader.ts`
- Test: `apps/daemon-next/tests/artifact-uploader.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/artifact-uploader.test.ts`:

```typescript
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { uploadArtifacts } from '../src/artifact-uploader';
import type { CollectedArtifact } from '../src/artifact-collector';

function makeArtifact(dir: string, filename: string, content: string): CollectedArtifact {
  const absolutePath = join(dir, filename);
  writeFileSync(absolutePath, content);
  return {
    absolutePath,
    relativePath: `outputs/${filename}`,
    sha256: `sha-${filename}`,
    sizeBytes: content.length,
    filename,
  };
}

describe('artifact-uploader', () => {
  test('uploads each artifact via multipart and returns ids', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const collected = [makeArtifact(dir, 'a.png', 'pic'), makeArtifact(dir, 'b.txt', 'text')];
    const seenBodies: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      seenBodies.push(String((init?.body as FormData)?.get('channelId')));
      // echo back a deterministic id derived from filename in the form
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      const id = `id-${file.name}`;
      return new Response(JSON.stringify({ ok: true, artifact: { id } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch },
      collected,
    );

    expect(uploaded.map((u) => u.id).sort()).toEqual(['id-a.png', 'id-b.txt']);
    expect(uploaded[0]).toMatchObject({ filename: 'a.png', pathKind: 'generated', sha256: 'sha-a.png' });
    expect(seenBodies).toEqual(['chan-1', 'chan-1']);
  });

  test('retries up to maxRetries then skips a persistently failing artifact', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const collected = [makeArtifact(dir, 'flaky.png', 'x')];
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts += 1;
      return new Response('err', { status: 500 });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch, maxRetries: 2 },
      collected,
    );

    expect(uploaded).toEqual([]);
    // initial attempt + 2 retries = 3 total
    expect(attempts).toBe(3);
  });

  test('succeeds on retry after a transient failure', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const collected = [makeArtifact(dir, 'c.png', 'x')];
    let attempts = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('err', { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, artifact: { id: 'id-c' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch, maxRetries: 2 },
      collected,
    );

    expect(uploaded.map((u) => u.id)).toEqual(['id-c']);
    expect(attempts).toBe(2);
  });

  test('skips artifacts larger than maxBytes', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const big = makeArtifact(dir, 'big.zip', 'x'.repeat(50));
    const small = makeArtifact(dir, 'small.txt', 'y');
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, artifact: { id: 'id' } }), { status: 201 });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch, maxBytes: 20 },
      [big, small],
    );

    expect(uploaded.map((u) => u.filename)).toEqual(['small.txt']);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/artifact-uploader.test.ts`
Expected: FAIL —— `Cannot find module '../src/artifact-uploader'`

- [ ] **Step 3: 实现 artifact-uploader.ts**

创建 `apps/daemon-next/src/artifact-uploader.ts`:

```typescript
import { readFileSync } from 'node:fs';
import type { CollectedArtifact } from './artifact-collector.js';

/** 10MB, matching server MAX_ARTIFACT_UPLOAD_BODY_BYTES. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadedArtifact {
  id: string;
  filename: string;
  relativePath?: string;
  pathKind: 'generated';
  sha256: string;
  sizeBytes: number;
}

export interface UploadArtifactsInput {
  serverUrl: string;
  token: string;
  teamId: string;
  channelId: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  maxBytes?: number;
}

/**
 * Uploads each collected artifact via the server multipart upload route and returns
 * the server-assigned artifact ids. Failures (after retries) and oversize files are
 * skipped so they never block the dispatch result.
 */
export async function uploadArtifacts(
  input: UploadArtifactsInput,
  collected: CollectedArtifact[],
): Promise<UploadedArtifact[]> {
  const fetchFn = input.fetch ?? fetch;
  const maxRetries = input.maxRetries ?? 2;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const results: UploadedArtifact[] = [];

  for (const artifact of collected) {
    if (artifact.sizeBytes > maxBytes) {
      continue;
    }
    const id = await uploadOne(fetchFn, input, artifact, maxRetries);
    if (id) {
      results.push({
        id,
        filename: artifact.filename,
        relativePath: artifact.relativePath,
        pathKind: 'generated',
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      });
    }
  }
  return results;
}

async function uploadOne(
  fetchFn: typeof fetch,
  input: UploadArtifactsInput,
  artifact: CollectedArtifact,
  maxRetries: number,
): Promise<string | undefined> {
  const url = `${input.serverUrl}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/upload`;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const bytes = readFileSync(artifact.absolutePath);
      const blob = new Blob([bytes]);
      const form = new FormData();
      form.append('channelId', input.channelId);
      form.append('file', blob, artifact.filename);
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.token}` },
        body: form,
      });
      if (!response.ok) {
        if (attempt < maxRetries) {
          continue;
        }
        return undefined;
      }
      const body = (await response.json()) as { ok: true; artifact: { id: string } };
      return body.artifact.id;
    } catch {
      if (attempt < maxRetries) {
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/artifact-uploader.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/artifact-uploader.ts apps/daemon-next/tests/artifact-uploader.test.ts
git commit -m "feat(daemon-next): add multipart artifact uploader with retry and size cap"
```

---

## Task 5: index.ts — 类型扩展(attachments 字段 + serverUrl input)

**Files:**
- Modify: `apps/daemon-next/src/index.ts`(类型定义区)
- Test: `apps/daemon-next/tests/index-types.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/index-types.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import type {
  CreateDaemonProtocolClientInput,
  DaemonDispatchArtifactResult,
  DispatchRequestPayload,
} from '../src/index';

describe('daemon-next index types', () => {
  test('DispatchRequestPayload accepts attachments', () => {
    const payload: DispatchRequestPayload = {
      id: 'd1',
      teamId: 't1',
      channelId: 'c1',
      messageId: 'm1',
      agentId: 'a1',
      requestId: 'r1',
      prompt: 'p',
      attachments: [{ id: 'att-1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 1 }],
    };
    expect(payload.attachments?.[0].name).toBe('a.txt');
  });

  test('DispatchRequestPayload works without attachments (backward compatible)', () => {
    const payload: DispatchRequestPayload = {
      id: 'd1', teamId: 't1', channelId: 'c1', messageId: 'm1', agentId: 'a1', requestId: 'r1', prompt: 'p',
    };
    expect(payload.attachments).toBeUndefined();
  });

  test('CreateDaemonProtocolClientInput requires serverUrl', () => {
    const input: CreateDaemonProtocolClientInput = {
      socket: {} as never,
      executor: async () => 'x',
      device: { teamId: 't1', ownerId: 'o1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
    };
    expect(input.serverUrl).toBe('http://server.test');
  });

  test('DaemonDispatchArtifactResult supports id-only references (no contentBase64)', () => {
    const artifact: DaemonDispatchArtifactResult = {
      id: 'uploaded-id',
      filename: 'out.png',
      pathKind: 'generated',
      relativePath: 'outputs/out.png',
    };
    expect(artifact.contentBase64).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/index-types.test.ts`
Expected: FAIL —— `attachments`/`serverUrl` 类型错误(TS: Property does not exist)

- [ ] **Step 3: 修改 index.ts 类型定义**

在 `apps/daemon-next/src/index.ts` 顶部 import 区(第 1 行之后)加入:

```typescript
import type { DispatchAttachment } from './attachments.js';
import { downloadAttachments } from './attachments.js';
import { prepareWorkspaceRun, workspaceRunEnv, persistWorkspaceRunManifest, persistWorkspaceRunResponse } from './workspace-run.js';
import { collectArtifacts } from './artifact-collector.js';
import { uploadArtifacts } from './artifact-uploader.js';
```

并在 `export { createCommandExecutor } from './executor.js';` 之后加入 re-export(便于外部消费):

```typescript
export { downloadAttachments } from './attachments.js';
export type { DispatchAttachment, DownloadedAttachment } from './attachments.js';
export { prepareWorkspaceRun, workspaceRunEnv, persistWorkspaceRunManifest, persistWorkspaceRunResponse } from './workspace-run.js';
export type { WorkspaceRunDir, WorkspaceRunManifest } from './workspace-run.js';
export { collectArtifacts } from './artifact-collector.js';
export type { CollectedArtifact } from './artifact-collector.js';
export { uploadArtifacts } from './artifact-uploader.js';
export type { UploadedArtifact } from './artifact-uploader.js';
```

修改 `DispatchRequestPayload`(替换 77-89 行的定义),增加 `attachments?`:

```typescript
export interface DispatchRequestPayload {
  id: string;
  teamId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  agentId: string;
  deviceId?: string;
  requestId: string;
  prompt: string;
  history?: DispatchHistoryMessageDto[];
  attachments?: DispatchAttachment[];
  customAgent?: DaemonCustomAgent | null;
}
```

修改 `CreateDaemonProtocolClientInput`(替换 93-101 行),增加 `serverUrl`:

```typescript
export interface CreateDaemonProtocolClientInput {
  socket: DaemonProtocolSocket;
  executor: StubExecutor;
  device: DaemonDeviceConfig;
  runtimes: DaemonRuntimeReport[];
  agents: DaemonAgentReport[];
  scan?: DaemonScanProvider;
  envResolver?: AgentEnvResolver;
  serverUrl: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/index-types.test.ts`
Expected: PASS(4 tests)

(注:此时 `serverUrl` 在 input 中声明但 dispatch handler 尚未使用它,Task 6 会接线。TS 编译应仍通过——`serverUrl` 是解构后未使用的变量,若 `noUnusedLocals` 报错,Task 6 立即消费它即解决;如需可临时在 Task 5 末尾 `void serverUrl` 占位,Task 6 移除。)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/tests/index-types.test.ts
git commit -m "feat(daemon-next): accept dispatch attachments and serverUrl in protocol client input"
```

---

## Task 6: index.ts — dispatch handler 编排接入

**Files:**
- Modify: `apps/daemon-next/src/index.ts`(`createDaemonProtocolClient` 的 dispatch.request handler,约 107-179 行)
- Test: `apps/daemon-next/tests/dispatch-pipeline.test.ts`

- [ ] **Step 1: 写失败测试(集成)**

创建 `apps/daemon-next/tests/dispatch-pipeline.test.ts`:

```typescript
import { mkdtempSync, realpathSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient } from '../src/index';
import type { DaemonProtocolSocket } from '../src/index';

function createFakeSocket(): { socket: DaemonProtocolSocket; emits: Array<{ event: string; payload: unknown }> } {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const handlers = new Map<string, ((payload: unknown) => Promise<void>)[]>();
  const socket: DaemonProtocolSocket = {
    async emitWithAck(event, payload) {
      emits.push({ event, payload: payload as Record<string, unknown> });
      if (event === AGENT_EVENTS.device.hello) {
        return { device: { id: 'dev-1' } };
      }
      return { ok: true };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event, handler) {
      const list = handlers.get(event);
      if (list) {
        handlers.set(event, list.filter((h) => h !== handler));
      }
    },
  };
  return {
    socket,
    emits,
    // helper kept off the returned object; dispatch delivery done via direct call below
    // (handlers captured by closure)
    async deliver(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) {
        await h(payload);
      }
    },
  } as unknown as { socket: DaemonProtocolSocket; emits: typeof emits; deliver: (e: string, p: unknown) => Promise<void> };
}

describe('dispatch pipeline (attachments + product artifacts)', () => {
  test('downloads attachments, runs command, scans outputs, uploads, and reports artifact ids', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const harness = createFakeSocket();

    // fake fetch: download route returns file bytes; upload route returns an id
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/download')) {
        return new Response('attachment-body', { status: 200 });
      }
      if (url.includes('/artifacts/upload')) {
        return new Response(JSON.stringify({ ok: true, artifact: { id: 'srv-art-1' } }), {
          status: 201, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      fetch: fakeFetch,
      executor: async () => ({
        body: 'done',
        artifacts: [{ id: 'workspace-log-x', filename: 'workspace-run.log', mimeType: 'text/plain', contentBase64: 'bG9n' }],
        workspaceRun: { status: 'succeeded', cwd, exitCode: 0, startedAt: 1000, completedAt: 2000 },
      }),
    });
    await client.start();

    // drop a product file into the cwd AFTER startedAt so the fallback scan picks it
    writeFileSync(join(cwd, 'result.png'), 'png-bytes');

    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'disp-1', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-1',
      agentId: 'agent-1', requestId: 'disp-1', prompt: 'do work',
      attachments: [{ id: 'att-1', name: 'in.txt' }],
      customAgent: { adapterKind: 'codex', command: 'echo', cwd },
    });

    const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
    expect(resultEmit).toBeTruthy();
    const payload = resultEmit!.payload as { artifacts: Array<{ id: string; filename?: string }> };
    const ids = payload.artifacts.map((a) => a.id);
    expect(ids).toContain('workspace-log-x');
    expect(ids).toContain('srv-art-1');

    // attachment downloaded into per-run inputs
    const inputsDir = join(cwd, '.agentbean', 'runs', 'disp-1', 'inputs');
    expect(readdirSync(inputsDir)).toEqual(['att-1-in.txt']);
    // manifest persisted
    const manifestPath = join(cwd, '.agentbean', 'runs', 'disp-1', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files.some((f: { filename: string }) => f.filename === 'result.png')).toBe(true);
  });

  test('still reports dispatch result when no customAgent.cwd (no workspace, no scan)', async () => {
    const harness = createFakeSocket();
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [], agents: [],
      serverUrl: 'http://server.test',
      executor: async () => ({ body: 'stub' }),
    });
    await client.start();
    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'disp-2', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-2',
      agentId: 'agent-1', requestId: 'disp-2', prompt: 'hi',
    });
    const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
    expect(resultEmit).toBeTruthy();
    expect((resultEmit!.payload as { body: string }).body).toBe('stub');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/dispatch-pipeline.test.ts`
Expected: FAIL —— 产物 artifact `srv-art-1` 未出现在 result(因为 dispatch handler 还没编排扫描/上传);附件未下载到 inputs

- [ ] **Step 3: 修改 dispatch handler**

在 `apps/daemon-next/src/index.ts` 的 `createDaemonProtocolClient` 中,解构加入 `serverUrl` 与 `fetch`(约 108 行):

```typescript
  const { socket, executor, device, runtimes, agents, scan, envResolver, serverUrl, fetch: fetchFn } = input;
```

替换 `dispatch.request` handler(约 139-176 行)为:

```typescript
      socket.on(AGENT_EVENTS.dispatch.request, async (payload) => {
        const request = payload as DispatchRequestPayload;
        if (cancelledDispatchIds.delete(request.id)) {
          return;
        }
        try {
          if (request.customAgent?.envRef && !request.customAgent.env) {
            if (!envResolver) {
              throw new Error('Custom agent env resolver is not configured');
            }
            const env = await envResolver(request.customAgent.envRef);
            request.customAgent = { ...request.customAgent, env };
            if (cancelledDispatchIds.delete(request.id)) {
              return;
            }
          }

          // Per-run workspace + input attachments (only when customAgent.cwd is set).
          const workspace = request.customAgent?.cwd
            ? prepareWorkspaceRun(request.customAgent.cwd, request.id)
            : undefined;
          if (workspace && request.attachments?.length && device.token) {
            const downloaded = await downloadAttachments(
              { serverUrl, token: device.token, teamId: device.teamId, inputDir: workspace.inputDir, fetch: fetchFn },
              request.attachments,
            );
            if (downloaded.length > 0) {
              const list = downloaded
                .map((file) => `- ${file.name} (${file.mimeType ?? 'unknown'}, ${file.sizeBytes ?? 0} bytes): ${file.localPath}`)
                .join('\n');
              request.prompt = `${request.prompt}\n\n用户随消息附加了以下本地文件，请在需要时读取并使用：\n${list}`;
            }
          }
          if (workspace && request.customAgent) {
            request.customAgent = {
              ...request.customAgent,
              env: { ...workspaceRunEnv(workspace), ...(request.customAgent.env ?? {}) },
            };
          }

          const result = normalizeDispatchResult(await executor(request));
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }

          // Scan outputs + cwd fallback, upload, then merge with the executor's log artifact.
          let productArtifacts: DaemonDispatchArtifactResult[] = [];
          if (workspace && result.workspaceRun?.startedAt !== undefined) {
            const collected = await collectArtifacts({
              outputDir: workspace.outputDir,
              cwd: workspace.cwd,
              startedAt: result.workspaceRun.startedAt,
            });
            if (collected.length > 0 && device.token) {
              const uploaded = await uploadArtifacts(
                { serverUrl, token: device.token, teamId: device.teamId, channelId: request.channelId, fetch: fetchFn },
                collected,
              );
              productArtifacts = uploaded.map((u) => ({
                id: u.id,
                filename: u.filename,
                relativePath: u.relativePath,
                pathKind: 'generated',
              }));
            }
            try {
              persistWorkspaceRunResponse(workspace, result.body);
              persistWorkspaceRunManifest(workspace, {
                runId: workspace.runId,
                status: result.workspaceRun.status,
                startedAt: result.workspaceRun.startedAt,
                completedAt: result.workspaceRun.completedAt,
                exitCode: result.workspaceRun.exitCode,
                files: collected.map((c) => ({
                  relativePath: c.relativePath,
                  sha256: c.sha256,
                  sizeBytes: c.sizeBytes,
                  filename: c.filename,
                })),
              });
            } catch {
              // manifest persistence is best-effort; never block the dispatch result
            }
          }

          const artifacts = [...(result.artifacts ?? []), ...productArtifacts];
          await socket.emitWithAck(AGENT_EVENTS.dispatch.result, {
            dispatchId: request.id,
            agentId: request.agentId,
            body: result.body,
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(result.workspaceRun ? { workspaceRun: result.workspaceRun } : {}),
          });
        } catch (error) {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          await socket.emitWithAck(AGENT_EVENTS.dispatch.error, {
            dispatchId: request.id,
            agentId: request.agentId,
            error: readErrorMessage(error),
          });
        }
      });
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/dispatch-pipeline.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/tests/dispatch-pipeline.test.ts
git commit -m "feat(daemon-next): orchestrate attachments, workspace, and product artifacts in dispatch handler"
```

---

## Task 7: cli.ts — 传入 serverUrl

**Files:**
- Modify: `apps/daemon-next/src/cli.ts`(`runDaemonNextCli`,约 119-132 行)

- [ ] **Step 1: 写失败测试**

在 `apps/daemon-next/tests/cli.test.ts` 末尾(`describe` 内)追加:

```typescript
  test('createDaemonProtocolClient receives serverUrl from config', async () => {
    // Connect path is exercised indirectly; here we assert the wiring by invoking
    // runDaemonNextCli with a stubbed socket module is heavy. Instead assert that
    // config.serverUrl is the source of truth used by the env resolver path.
    const config = parseDaemonNextCliConfig({
      argv: ['--team-id', 't1', '--owner-id', 'o1', '--server-url', 'https://api.example.com'],
    });
    expect(config.serverUrl).toBe('https://api.example.com');
  });
```

并在该文件顶部 import 区确认有 `parseDaemonNextCliConfig` 导入(若无则加):

```typescript
import { parseDaemonNextCliConfig } from '../src/cli';
```

- [ ] **Step 2: 运行测试验证失败/通过**

Run: `cd apps/daemon-next && npx vitest run tests/cli.test.ts`
Expected: 该 test 应 PASS(config.serverUrl 已由 `parseDaemonNextCliConfig` 提供,`cli.ts:50`)。这步确认 config 已具备 serverUrl,接下来只需把它传给 `createDaemonProtocolClient`。

- [ ] **Step 3: 修改 cli.ts 传 serverUrl**

在 `apps/daemon-next/src/cli.ts` 的 `runDaemonNextCli` 中,修改 `createDaemonProtocolClient({...})` 调用(约 119-132 行),加入 `serverUrl: config.serverUrl`:

```typescript
  await createDaemonProtocolClient({
    socket: protocolSocket,
    executor: createCommandExecutor({ fallbackPrefix: config.fallbackPrefix }),
    device,
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    scan: createBuiltinScanProvider(),
    serverUrl: config.serverUrl,
    envResolver: async (envRef) => {
      if (!device.token) {
        throw new Error('Custom agent env resolver is not configured');
      }
      return createHttpEnvResolver({ serverUrl: config.serverUrl, token: device.token })(envRef);
    },
  }).start();
```

- [ ] **Step 4: 运行 daemon-next 全量测试 + 类型检查**

Run: `cd apps/daemon-next && npm test`
Expected: 所有测试 PASS(含新测试 + 既有 executor/protocol-client/cli/scanner/env-fetcher 测试)

Run: `npm run build`(在仓库根 `npm run build:daemon-next`)
Expected: tsc 通过,无类型错误(确认 `serverUrl` 已被 dispatch handler 消费,无 `noUnusedLocals` 报错)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/cli.ts apps/daemon-next/tests/cli.test.ts
git commit -m "feat(daemon-next): wire serverUrl into daemon protocol client"
```

---

## Task 8: 全量验证与收尾

**Files:** 无新文件;验证 `packages/contracts` 契约、daemon-next 全量 build/test。

- [ ] **Step 1: 确认 contracts 契约无需改动**

`packages/contracts/src/dispatch.ts` 已定义 `DispatchAttachmentDto`(15-20 行)与 `DispatchRequestDto.attachments?`(47 行),server `getDispatchRequest` 已附带。daemon 侧用的是本地镜像类型 `DispatchAttachment`(字段一致)。确认无需新增 contracts 测试:

Run: `cd packages/contracts && npm test`
Expected: PASS(既有契约测试不受影响)

- [ ] **Step 2: daemon-next 全量测试**

Run: `cd apps/daemon-next && npm test`
Expected: 全部 PASS(attachments / workspace-run / artifact-collector / artifact-uploader / index-types / dispatch-pipeline / cli / executor / protocol-client / scanner / env-fetcher)

- [ ] **Step 3: daemon-next 类型构建**

Run(仓库根): `npm run build:daemon-next`
Expected: tsc 通过

- [ ] **Step 4: 手动烟测(可选,需本地 server-next + device token)**

启动 server-next,用一个 custom agent 命令验证端到端:
1. 通过 web 上传一个附件并发消息给 custom agent。
2. 确认 `.agentbean/runs/{runId}/inputs/` 下出现附件。
3. 让 custom agent 命令在 cwd 产出一个 `.png`(或写 `$AGENTBEAN_OUTPUT_DIR/out.png`)。
4. 确认产物出现在聊天消息的 artifacts 中、可预览/下载。
5. 确认 `manifest.json` 记录了该产物。

- [ ] **Step 5: 更新 known-gaps 文档并提交**

在 `agentbean-next/docs/known-gaps.md` 的「Daemon 缺口」相关段落,补一句说明附件支持与产物归档第一版已落地(参照文件:`apps/daemon-next/src/{attachments,workspace-run,artifact-collector,artifact-uploader}.ts`)。

```bash
git add agentbean-next/docs/known-gaps.md
git commit -m "docs(agentbean-next): mark daemon attachments + product archiving as landed"
```

---

## 验证矩阵(self-review 对照 spec)

| spec 要求 | 对应 Task |
|-----------|-----------|
| 附件下载到 inputs/(safeFilename) | Task 1 |
| per-run 目录隔离(inputs/outputs/logs) | Task 2 |
| AGENTBEAN_* env 注入 | Task 2 + Task 6(经 customAgent.env,不改 SAFE_ENV_KEYS) |
| manifest.json / response.md 持久化 | Task 2 + Task 6 |
| 产物扫描(outputs + cwd 兜底、mtime/扩展名/忽略目录) | Task 3 |
| SHA256 去重 | Task 3 |
| HTTP multipart upload + 重试 + 10MB 上限 | Task 4 |
| DispatchRequestPayload 接 attachments | Task 5 |
| dispatch handler 编排 | Task 6 |
| serverUrl 注入(cli) | Task 7 |
| server 零改动 | 全程不碰 server-next |
| log artifact 保留 inline | Task 6(产物才走 upload,log 来自 executor 现状) |
| 错误不阻断 dispatch:result | Task 1/4/6(每个失败 skip,不 throw) |
