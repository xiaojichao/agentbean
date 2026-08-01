/**
 * 自定义 Agent 的额外产物收集目录（Artifact source roots）配置助手。
 *
 * 契约（与 Server 端 parseAgentArtifactSourceRoots / daemon resolveConfiguredArtifactRoots 对齐）：
 * - 环境变量 `AGENTBEAN_ARTIFACT_SOURCE_ROOTS` 存 JSON 数组，每项
 *   { id, label, envVarName, defaultRole }；
 * - 每个 root 的真实路径放在 `envVarName` 指定的另一个环境变量里。
 * daemon 只收集本次运行窗口内（mtime > startedAt）新增或修改的受支持文件。
 */

export type ArtifactSourceRootRole = 'run_output' | 'deliverable' | 'intermediate';

export interface ArtifactSourceRootRow {
  id: string;
  label: string;
  envVarName: string;
  path: string;
  defaultRole: ArtifactSourceRootRole;
}

export const ARTIFACT_SOURCE_ROOTS_ENV_KEY = 'AGENTBEAN_ARTIFACT_SOURCE_ROOTS';

const ROOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ROLE_VALUES: readonly ArtifactSourceRootRole[] = ['run_output', 'deliverable', 'intermediate'];

export function isArtifactSourceRootRole(value: unknown): value is ArtifactSourceRootRole {
  return typeof value === 'string' && ROLE_VALUES.includes(value as ArtifactSourceRootRole);
}

/** 从环境变量解析已声明的产物收集目录（path 缺失时保留空串，便于 UI 编辑）。 */
export function parseArtifactSourceRootsFromEnv(env: Record<string, string> | undefined): ArtifactSourceRootRow[] {
  const raw = env?.[ARTIFACT_SOURCE_ROOTS_ENV_KEY];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: ArtifactSourceRootRow[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.envVarName !== 'string') {
      continue;
    }
    rows.push({
      id: item.id,
      label: item.label,
      envVarName: item.envVarName,
      path: typeof item.path === 'string' ? item.path : (env?.[item.envVarName] ?? ''),
      defaultRole: isArtifactSourceRootRole(item.defaultRole) ? item.defaultRole : 'run_output',
    });
  }
  return rows;
}

/** 生成写入自定义 Agent 环境变量的键值对（声明 JSON + 每个 root 的路径）。 */
export function buildArtifactSourceRootsEnv(rows: ArtifactSourceRootRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  if (rows.length === 0) {
    return env;
  }
  env[ARTIFACT_SOURCE_ROOTS_ENV_KEY] = JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      label: row.label,
      envVarName: row.envVarName,
      defaultRole: row.defaultRole,
    })),
  );
  for (const row of rows) {
    env[row.envVarName] = row.path;
  }
  return env;
}

/**
 * 显式清除产物收集目录的 env 声明。
 *
 * 服务端 updateAgentConfig 对 env 采用部分合并：缺省 key 保留、空串跳过，
 * 因此「删除全部目录」必须显式写入 `AGENTBEAN_ARTIFACT_SOURCE_ROOTS: "[]"`，
 * 否则旧声明会继续生效，daemon 仍会从用户以为已移除的目录收集产物。
 */
export function buildClearedArtifactSourceRootsEnv(): Record<string, string> {
  return { [ARTIFACT_SOURCE_ROOTS_ENV_KEY]: '[]' };
}

/** 校验 UI 行，规则与 Server 端 parseAgentArtifactSourceRoots 一致。 */
export function validateArtifactSourceRoots(
  rows: ArtifactSourceRootRow[],
): { ok: true } | { ok: false; error: string } {
  const ids = new Set<string>();
  const envVarNames = new Set<string>();
  for (const row of rows) {
    if (!ROOT_ID_PATTERN.test(row.id)) {
      return { ok: false, error: `产物目录 id 非法：${row.id}` };
    }
    if (ids.has(row.id)) {
      return { ok: false, error: `产物目录 id 重复：${row.id}` };
    }
    ids.add(row.id);
    const label = row.label.trim();
    if (!label || label.length > 80 || label === '.' || label === '..' || /[/\\\u0000-\u001f]/.test(label)) {
      return { ok: false, error: '产物目录标签必填且不能包含路径分隔符或控制字符（≤80 字符）' };
    }
    const envVarName = row.envVarName.trim();
    if (!ENV_VAR_PATTERN.test(envVarName)) {
      return { ok: false, error: `产物目录环境变量名非法：${envVarName}（需以字母/下划线开头，仅大写字母、数字、下划线）` };
    }
    if (envVarNames.has(envVarName)) {
      return { ok: false, error: `产物目录环境变量名重复：${envVarName}` };
    }
    envVarNames.add(envVarName);
    if (!row.path.trim()) {
      return { ok: false, error: `产物目录「${label}」的路径不能为空` };
    }
    if (!row.path.startsWith('/') || row.path.includes('\u0000')) {
      return { ok: false, error: `产物目录「${label}」的路径必须是设备上的绝对路径` };
    }
    if (!isArtifactSourceRootRole(row.defaultRole)) {
      return { ok: false, error: `产物目录「${label}」的角色值非法` };
    }
  }
  return { ok: true };
}

/** 生成下一个可用的路径环境变量名（AGENTBEAN_SOURCE_ROOT_N）。 */
export function nextArtifactSourceRootEnvVarName(rows: ArtifactSourceRootRow[]): string {
  const used = new Set(rows.map((row) => row.envVarName));
  let index = rows.length + 1;
  let candidate = `AGENTBEAN_SOURCE_ROOT_${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `AGENTBEAN_SOURCE_ROOT_${index}`;
  }
  return candidate;
}

export function newArtifactSourceRootRow(rows: ArtifactSourceRootRow[]): ArtifactSourceRootRow {
  const usedIds = new Set(rows.map((row) => row.id));
  let index = rows.length + 1;
  let id = `src-${index}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `src-${index}`;
  }
  return {
    id,
    label: '',
    envVarName: nextArtifactSourceRootEnvVarName(rows),
    path: '',
    defaultRole: 'run_output',
  };
}

/**
 * 把通用环境变量行与产物目录行合并为最终 env：
 * 产物目录占用的保留键（AGENTBEAN_ARTIFACT_SOURCE_ROOTS + 各 envVarName）
 * 从通用行里剔除，避免双重写入或脏值。
 */
export function mergeEnvWithSourceRoots(
  envRows: ReadonlyArray<{ key: string; value: string }>,
  sourceRootRows: ArtifactSourceRootRow[],
): Record<string, string> {
  const reserved = new Set<string>([
    ARTIFACT_SOURCE_ROOTS_ENV_KEY,
    ...sourceRootRows.map((row) => row.envVarName.trim()).filter(Boolean),
  ]);
  const env: Record<string, string> = {};
  for (const row of envRows) {
    const key = row.key.trim();
    if (!key || reserved.has(key)) continue;
    env[key] = row.value;
  }
  Object.assign(env, buildArtifactSourceRootsEnv(sourceRootRows));
  return env;
}
