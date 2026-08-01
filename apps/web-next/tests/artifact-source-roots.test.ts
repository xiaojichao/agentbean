import { describe, expect, test } from 'vitest';
import {
  ARTIFACT_SOURCE_ROOTS_ENV_KEY,
  buildArtifactSourceRootsEnv,
  mergeEnvWithSourceRoots,
  newArtifactSourceRootRow,
  nextArtifactSourceRootEnvVarName,
  parseArtifactSourceRootsFromEnv,
  validateArtifactSourceRoots,
  type ArtifactSourceRootRow,
} from '../lib/artifact-source-roots';

function row(overrides: Partial<ArtifactSourceRootRow> = {}): ArtifactSourceRootRow {
  return {
    id: 'src-1',
    label: 'Hermes 输出目录',
    envVarName: 'AGENTBEAN_SOURCE_ROOT_1',
    path: '/Users/shaw/.hermes',
    defaultRole: 'run_output',
    ...overrides,
  };
}

describe('artifact-source-roots', () => {
  test('build 写入声明 JSON 与每个 root 的路径环境变量', () => {
    const env = buildArtifactSourceRootsEnv([
      row(),
      row({ id: 'src-2', label: '交付目录', envVarName: 'AGENTBEAN_SOURCE_ROOT_2', path: '/tmp/deliver', defaultRole: 'deliverable' }),
    ]);
    expect(env[ARTIFACT_SOURCE_ROOTS_ENV_KEY]).toBe(
      JSON.stringify([
        { id: 'src-1', label: 'Hermes 输出目录', envVarName: 'AGENTBEAN_SOURCE_ROOT_1', defaultRole: 'run_output' },
        { id: 'src-2', label: '交付目录', envVarName: 'AGENTBEAN_SOURCE_ROOT_2', defaultRole: 'deliverable' },
      ]),
    );
    expect(env.AGENTBEAN_SOURCE_ROOT_1).toBe('/Users/shaw/.hermes');
    expect(env.AGENTBEAN_SOURCE_ROOT_2).toBe('/tmp/deliver');
  });

  test('空列表不写入 AGENTBEAN_ARTIFACT_SOURCE_ROOTS', () => {
    expect(buildArtifactSourceRootsEnv([])).toEqual({});
  });

  test('parse 从 env 还原行并解析路径（json 键 + 路径键）', () => {
    const env = buildArtifactSourceRootsEnv([row()]);
    const parsed = parseArtifactSourceRootsFromEnv(env);
    expect(parsed).toEqual([row()]);
  });

  test('parse 忽略非法 JSON 与非法项', () => {
    expect(parseArtifactSourceRootsFromEnv({ [ARTIFACT_SOURCE_ROOTS_ENV_KEY]: 'not-json' })).toEqual([]);
    expect(parseArtifactSourceRootsFromEnv({ [ARTIFACT_SOURCE_ROOTS_ENV_KEY]: '[{"id":1}]' })).toEqual([]);
    expect(parseArtifactSourceRootsFromEnv(undefined)).toEqual([]);
  });

  test('merge 剔除产物目录保留键，通用行与产物目录行合并为最终 env', () => {
    const env = mergeEnvWithSourceRoots(
      [
        { key: 'API_KEY', value: 'secret' },
        { key: 'AGENTBEAN_SOURCE_ROOT_1', value: '/stale' },
        { key: ARTIFACT_SOURCE_ROOTS_ENV_KEY, value: 'stale-json' },
      ],
      [row()],
    );
    expect(env.API_KEY).toBe('secret');
    expect(env.AGENTBEAN_SOURCE_ROOT_1).toBe('/Users/shaw/.hermes');
    expect(env[ARTIFACT_SOURCE_ROOTS_ENV_KEY]).toContain('src-1');
  });

  test('validate 通过合法行', () => {
    expect(validateArtifactSourceRoots([row()]).ok).toBe(true);
  });

  test('validate 拒绝非绝对路径、非法环境变量名、重复 id、空标签', () => {
    expect(validateArtifactSourceRoots([row({ path: 'relative/path' })]).ok).toBe(false);
    expect(validateArtifactSourceRoots([row({ envVarName: 'lower-case' })]).ok).toBe(false);
    expect(validateArtifactSourceRoots([row(), row({ id: 'src-1' })]).ok).toBe(false);
    expect(validateArtifactSourceRoots([row({ label: '' })]).ok).toBe(false);
    expect(validateArtifactSourceRoots([row({ label: 'a/b' })]).ok).toBe(false);
  });

  test('nextArtifactSourceRootEnvVarName 生成未占用序号', () => {
    const rows = [row({ envVarName: 'AGENTBEAN_SOURCE_ROOT_1' }), row({ envVarName: 'AGENTBEAN_SOURCE_ROOT_2' })];
    expect(nextArtifactSourceRootEnvVarName(rows)).toBe('AGENTBEAN_SOURCE_ROOT_3');
    expect(nextArtifactSourceRootEnvVarName([])).toBe('AGENTBEAN_SOURCE_ROOT_1');
    expect(newArtifactSourceRootRow([row()]).envVarName).toBe('AGENTBEAN_SOURCE_ROOT_2');
  });
});
