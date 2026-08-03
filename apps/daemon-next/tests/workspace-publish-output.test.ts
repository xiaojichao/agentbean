/**
 * #1044：`outputs/<publishIdentity>` 本机待发布批次。
 * - publish manifest 记录 baseline/相对路径/hash/长度/上传进度/Server 返回身份，不含外部绝对路径
 * - 重复 stage 幂等保留进度;plan 漂移拒绝
 * - 网络中断/daemon 重启后从 staged copy 断点续传(不依赖原 run 目录)
 * - discovery 只认当前 Device 的 pending 批次
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createWorkspacePublishOutputStore,
  discoverWorkspacePublishOutputs,
  markWorkspacePublishOutputReported,
  readWorkspacePublishOutputManifest,
  stageRunOutputsToPublishOutput,
} from '../src/workspace-publish-output';
import { persistDeviceProjectionManifest } from '../src/workspace-run';
import { resumeLocalWorkspacePublish } from '../src/workspace-publish-recovery';
import type { CollectedArtifact } from '../src/artifact-collector';
import type { StagingRemoteClient } from '../src/workspace-publish-recovery';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function seedHome(deviceId = 'device-1'): string {
  const home = tempDir('publish-output-home-');
  persistDeviceProjectionManifest(home, { schemaVersion: 1, deviceId, teamId: 'team-1', updatedAt: 1 });
  return home;
}

function makeCollected(runDir: string, relativePath: string, content: string): CollectedArtifact {
  const absolutePath = join(runDir, ...relativePath.split('/'));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { flag: 'w' });
  return {
    absolutePath,
    relativePath,
    sha256: sha256(content),
    sizeBytes: Buffer.byteLength(content),
    filename: relativePath.split('/').pop()!,
    sourceRoot: { id: 'root-1', kind: 'run_output', label: 'run outputs' },
    role: 'run_output',
  };
}

function stageInput(home: string, collected: CollectedArtifact[], overrides: Record<string, unknown> = {}) {
  return {
    agentBeanHome: home,
    deviceId: 'device-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    publishIdentity: 'pub-test-1',
    baselineRevisionId: 'rev-1',
    now: 100,
    agentId: 'agent-1',
    taskId: 'task-1',
    taskAttempt: 2,
    workspaceRunId: 'run-1',
    collected,
    ...overrides,
  };
}

describe('workspace publish output (#1044)', () => {
  test('stage 复制确认输出并写 manifest:baseline/hash/长度/进度齐全,不含外部绝对路径', () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    writeFileSync(join(runDir, 'placeholder.tmp'), 'x');
    const collected = [
      makeCollected(runDir, 'answer.md', 'final answer'),
      makeCollected(runDir, 'docs/spec.md', 'spec body'),
    ];
    rmSync(join(runDir, 'placeholder.tmp'));

    const staged = stageRunOutputsToPublishOutput(stageInput(home, collected));
    expect(staged.outputDir).toBe(join(
      home, 'workspaces', 'team-1', 'channels', 'channel-1', 'outputs', 'pub-test-1',
    ));
    expect(readFileSync(join(staged.outputDir, 'answer.md'), 'utf8')).toBe('final answer');
    expect(readFileSync(join(staged.outputDir, 'docs', 'spec.md'), 'utf8')).toBe('spec body');

    const manifest = readWorkspacePublishOutputManifest(staged.outputDir);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      publishIdentity: 'pub-test-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      deviceId: 'device-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 2,
      workspaceRunId: 'run-1',
      baselineRevisionId: 'rev-1',
      status: 'pending',
    });
    expect(manifest?.files).toEqual([
      expect.objectContaining({
        relativePath: 'answer.md', sha256: sha256('final answer'),
        sizeBytes: Buffer.byteLength('final answer'), uploadedBytes: 0, complete: false,
      }),
      expect.objectContaining({ relativePath: 'docs/spec.md', uploadedBytes: 0, complete: false }),
    ]);
    // 外部绝对路径不进入 publish manifest(跨 Device 合同只认相对路径 + 稳定身份)。
    expect(JSON.stringify(manifest)).not.toContain(runDir);
    expect(JSON.stringify(manifest)).not.toContain('absolutePath');
  });

  test('根级 manifest.json 是用户交付物，不会被控制 manifest 覆盖', () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    const staged = stageRunOutputsToPublishOutput(stageInput(home, [
      makeCollected(runDir, 'manifest.json', '{"user":"artifact"}'),
    ]));

    expect(readFileSync(join(staged.outputDir, 'manifest.json'), 'utf8')).toBe('{"user":"artifact"}');
    expect(readWorkspacePublishOutputManifest(staged.outputDir)?.files)
      .toEqual([expect.objectContaining({ relativePath: 'manifest.json' })]);
  });

  test('拒绝篡改 manifest 的路径逃逸', () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    const staged = stageRunOutputsToPublishOutput(stageInput(home, [makeCollected(runDir, 'safe.md', 'safe')]));
    const control = join(staged.outputDir, '.agentbean-publish', 'manifest.json');
    const valid = JSON.parse(readFileSync(control, 'utf8')) as { files: Array<Record<string, unknown>> };
    valid.files[0]!.relativePath = '../../outside.md';
    writeFileSync(control, JSON.stringify(valid));
    expect(readWorkspacePublishOutputManifest(staged.outputDir)).toBeUndefined();
  });

  test('重复 stage 幂等保留上传进度;plan 漂移直接拒绝', () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    const collected = [makeCollected(runDir, 'answer.md', 'final answer')];
    stageRunOutputsToPublishOutput(stageInput(home, collected));

    const store = createWorkspacePublishOutputStore({ agentBeanHome: home, deviceId: 'device-1' });
    store.markProgress('pub-test-1', 'answer.md', 6, false, 110);

    const again = stageRunOutputsToPublishOutput(stageInput(home, collected, { now: 120 }));
    expect(again.manifest.files[0]).toMatchObject({ uploadedBytes: 6, complete: false });
    expect(again.manifest.createdAt).toBe(100);

    const drifted = [makeCollected(runDir, 'answer.md', 'tampered body')];
    expect(() => stageRunOutputsToPublishOutput(stageInput(home, drifted)))
      .toThrow('WORKSPACE_PUBLISH_OUTPUT_PLAN_MISMATCH');
  });

  test('staged copy 缺失时重复 stage 补齐且不动既有进度', () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    const collected = [
      makeCollected(runDir, 'a.md', 'aaa'),
      makeCollected(runDir, 'b.md', 'bbb'),
    ];
    const staged = stageRunOutputsToPublishOutput(stageInput(home, collected));
    const store = createWorkspacePublishOutputStore({ agentBeanHome: home, deviceId: 'device-1' });
    store.markProgress('pub-test-1', 'a.md', 3, true, 110);
    rmSync(join(staged.outputDir, 'b.md'));

    const again = stageRunOutputsToPublishOutput(stageInput(home, collected, { now: 130 }));
    expect(existsSync(join(again.outputDir, 'b.md'))).toBe(true);
    expect(again.manifest.files.find((f) => f.relativePath === 'a.md')).toMatchObject({ uploadedBytes: 3, complete: true });
  });

  test('discovery 只认当前 Device 的 pending 批次;team/channel 隔离', () => {
    const home = seedHome('device-current');
    const runDir = tempDir('publish-output-run-');
    const mine = [makeCollected(runDir, 'mine.md', 'mine')];
    stageRunOutputsToPublishOutput(stageInput(home, mine, { deviceId: 'device-current' }));
    // 其他 Device 的批次(同一目录树,deviceId 不同)
    stageRunOutputsToPublishOutput(stageInput(home, [makeCollected(runDir, 'theirs.md', 'theirs')], {
      deviceId: 'device-other', publishIdentity: 'pub-other-device',
    }));
    // 其他 channel 的批次
    stageRunOutputsToPublishOutput(stageInput(home, [makeCollected(runDir, 'other.md', 'other')], {
      deviceId: 'device-current', channelId: 'channel-2', publishIdentity: 'pub-other-channel',
    }));
    // 已 committed 的批次
    stageRunOutputsToPublishOutput(stageInput(home, [makeCollected(runDir, 'done.md', 'done')], {
      deviceId: 'device-current', publishIdentity: 'pub-committed',
    }));
    const store = createWorkspacePublishOutputStore({ agentBeanHome: home, deviceId: 'device-current' });
    store.markCommitted('pub-committed', 'rev-9', 200);

    const pending = discoverWorkspacePublishOutputs({ agentBeanHome: home, deviceId: 'device-current', status: 'pending' });
    expect(pending.map((p) => p.manifest.publishIdentity).sort()).toEqual(['pub-other-channel', 'pub-test-1']);
    const all = discoverWorkspacePublishOutputs({ agentBeanHome: home, deviceId: 'device-current' });
    expect(all.map((p) => p.manifest.publishIdentity).sort())
      .toEqual(['pub-committed', 'pub-other-channel', 'pub-test-1']);

    // device.json 缺失/不匹配 → 不认领任何批次(恢复出的他机数据不获得当前设备身份)。
    rmSync(join(home, 'device.json'));
    expect(discoverWorkspacePublishOutputs({ agentBeanHome: home, deviceId: 'device-current' })).toEqual([]);
  });

  test('store 适配:markCommitted/markAbandoned/reportedAt 状态机', () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    stageRunOutputsToPublishOutput(stageInput(home, [makeCollected(runDir, 'a.md', 'aaa')]));
    stageRunOutputsToPublishOutput(stageInput(home, [makeCollected(runDir, 'b.md', 'bbb')], { publishIdentity: 'pub-2' }));
    const store = createWorkspacePublishOutputStore({ agentBeanHome: home, deviceId: 'device-1' });

    expect(store.listPending().map((r) => r.publishId).sort()).toEqual(['pub-2', 'pub-test-1']);

    store.markCommitted('pub-test-1', 'rev-2', 300);
    const committed = store.get('pub-test-1');
    expect(committed).toMatchObject({ status: 'committed', committedRevisionId: 'rev-2' });
    expect(committed?.files[0]).toMatchObject({ uploadedBytes: 3, complete: true });
    expect(store.listPending().map((r) => r.publishId)).toEqual(['pub-2']);

    // committed 后 markAbandoned 不生效;冲突批次 abandoned 后不再 pending。
    store.markAbandoned('pub-test-1', 310);
    expect(store.get('pub-test-1')?.status).toBe('committed');
    store.markAbandoned('pub-2', 320);
    expect(store.get('pub-2')?.status).toBe('abandoned');
    expect(store.listPending()).toEqual([]);

    markWorkspacePublishOutputReported({
      agentBeanHome: home, deviceId: 'device-1', publishId: 'pub-test-1', now: 400,
    });
    const located = discoverWorkspacePublishOutputs({ agentBeanHome: home, deviceId: 'device-1' })
      .find((candidate) => candidate.manifest.publishIdentity === 'pub-test-1');
    expect(located?.manifest.reportedAt).toBe(400);

    // remove 只摘控制 manifest,staged 文件保留供诊断。
    store.remove('pub-2');
    expect(store.get('pub-2')).toBeNull();
    const pub2Dir = join(home, 'workspaces', 'team-1', 'channels', 'channel-1', 'outputs', 'pub-2');
    expect(existsSync(join(pub2Dir, 'b.md'))).toBe(true);
  });

  test('网络中断后 daemon 重启:从 staged copy 断点续传并收敛(原 run 目录已删除)', async () => {
    const home = seedHome();
    const runDir = tempDir('publish-output-run-');
    const collected = [
      makeCollected(runDir, 'a.md', 'aaa'),
      makeCollected(runDir, 'b.md', 'bbbb'),
    ];
    const staged = stageRunOutputsToPublishOutput(stageInput(home, collected));
    const store = createWorkspacePublishOutputStore({ agentBeanHome: home, deviceId: 'device-1' });

    // 第一次交付:a.md 传完,b.md 传输中网络中断(模拟进程退出前的部分进度)。
    const serverFiles = new Map<string, { receivedBytes: number; complete: boolean }>([
      ['a.md', { receivedBytes: 3, complete: true }],
      ['b.md', { receivedBytes: 2, complete: false }],
    ]);
    store.save({
      publishId: 'pub-test-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      baselineRevisionId: 'rev-1',
      files: collected.map((artifact) => ({
        path: artifact.relativePath,
        absolutePath: join(staged.outputDir, artifact.relativePath),
        filename: artifact.filename,
        mimeType: 'text/markdown',
        expectedSizeBytes: artifact.sizeBytes,
        expectedSha256: artifact.sha256,
      })),
      status: 'pending',
      createdAt: 100,
      updatedAt: 100,
      provenance: { agentId: 'agent-1', taskId: 'task-1', taskAttempt: 2, workspaceRunId: 'run-1', deviceId: 'device-1' },
    });

    // 关键:原始 run 输出被清理,恢复只能从 staged copy 读。
    rmSync(runDir, { recursive: true, force: true });

    const puts: Array<{ path: string; offset: number; length: number }> = [];
    const client: StagingRemoteClient = {
      async begin() { throw new Error('resume 不应重新 begin(Server 已有会话)'); },
      async putChunk(input) {
        puts.push({ path: input.path, offset: input.offset, length: input.content.length });
        const current = serverFiles.get(input.path)!;
        current.receivedBytes = input.offset + input.content.length;
        current.complete = current.receivedBytes === 4;
        return {
          ok: true,
          staging: {
            files: [...serverFiles.entries()].map(([path, f]) => ({ path, receivedBytes: f.receivedBytes, complete: f.complete })),
          },
        };
      },
      async get() {
        return {
          ok: true,
          staging: {
            status: 'open',
            files: [...serverFiles.entries()].map(([path, f]) => ({ path, receivedBytes: f.receivedBytes, complete: f.complete })),
          },
        };
      },
      async commit() {
        return {
          ok: true,
          staging: { status: 'committed', committedRevisionId: 'rev-2' },
          workspace: { currentRevisionId: 'rev-2' },
        };
      },
    };

    const result = await resumeLocalWorkspacePublish({ store, client, publishId: 'pub-test-1', now: 500 });
    expect(result).toEqual({ kind: 'committed', committedRevisionId: 'rev-2' });
    // a.md 已 complete 不重传;b.md 从 offset=2 续传剩余 2 字节。
    expect(puts).toEqual([{ path: 'b.md', offset: 2, length: 2 }]);

    const manifest = readWorkspacePublishOutputManifest(staged.outputDir);
    expect(manifest).toMatchObject({ status: 'committed', committedRevisionId: 'rev-2' });
    expect(manifest?.files).toEqual([
      expect.objectContaining({ relativePath: 'a.md', uploadedBytes: 3, complete: true }),
      expect.objectContaining({ relativePath: 'b.md', uploadedBytes: 4, complete: true }),
    ]);

    // 重复 resume 收敛,不再产生任何网络调用。
    const again = await resumeLocalWorkspacePublish({ store, client, publishId: 'pub-test-1', now: 600 });
    expect(again).toEqual({ kind: 'committed', committedRevisionId: 'rev-2' });
    expect(puts).toHaveLength(1);
  });
});
