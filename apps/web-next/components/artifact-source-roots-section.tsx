import { Plus, X } from 'lucide-react';
import {
  ARTIFACT_SOURCE_ROOTS_ENV_KEY,
  newArtifactSourceRootRow,
  type ArtifactSourceRootRow,
  type ArtifactSourceRootRole,
} from '@/lib/artifact-source-roots';

const ROLE_LABELS: Record<ArtifactSourceRootRole, string> = {
  run_output: '运行产物',
  deliverable: '交付物',
  intermediate: '中间产物',
};

export function ArtifactSourceRootsSection({
  rows,
  onChange,
  existingKeys = [],
  clearRequested = false,
  onClearRequested,
}: {
  rows: ArtifactSourceRootRow[];
  onChange: (rows: ArtifactSourceRootRow[]) => void;
  /** Server 已保存的 Key 名（值不可回显；同名 Key 填写会覆盖）。 */
  existingKeys?: string[];
  /** 用户已选择清除已配置的产物收集目录（保存后写入空声明覆盖旧值）。 */
  clearRequested?: boolean;
  onClearRequested?: (clear: boolean) => void;
}) {
  const reservedExistingKeys = existingKeys.filter(
    (key) => key === ARTIFACT_SOURCE_ROOTS_ENV_KEY || key.startsWith('AGENTBEAN_SOURCE_ROOT_'),
  );
  const hasExistingDeclaration = reservedExistingKeys.includes(ARTIFACT_SOURCE_ROOTS_ENV_KEY);
  const updateRow = (index: number, patch: Partial<ArtifactSourceRootRow>) => {
    if (clearRequested) onClearRequested?.(false);
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => {
    if (clearRequested) onClearRequested?.(false);
    onChange(rows.filter((_, i) => i !== index));
  };
  const addRow = () => {
    onClearRequested?.(false);
    onChange([...rows, newArtifactSourceRootRow(rows)]);
  };
  return (
    <div data-smoke="artifact-source-roots-section">
      <label className="mb-1 block text-xs font-medium text-neutral-600">产物收集目录</label>
      <p className="mb-2 text-[11px] text-neutral-400">
        当 Agent 不把结果写入项目目录或 AGENTBEAN_OUTPUT_DIR（例如 Hermes 写到 ~/.hermes）时，声明额外目录后，本次运行窗口内新增/修改的文件会作为运行产物收集进频道文件。仅收集支持的扩展名，最多 2000 个/根。
      </p>
      {reservedExistingKeys.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {reservedExistingKeys.map((key) => (
            <span
              key={key}
              className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-mono text-[11px] text-neutral-600"
              title="已配置（值不可回显；重新填写会覆盖）"
            >
              {key}
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="mb-2 text-[11px] text-neutral-400">
          {clearRequested
            ? '保存后将清除已配置的产物收集目录，daemon 不再从这些目录收集。'
            : '未配置。Agent 写在项目目录内的文件无需此设置。'}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={row.id} className="space-y-1.5 rounded-md border border-neutral-200 p-2">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
                <input
                  value={row.label}
                  onChange={(e) => updateRow(index, { label: e.target.value })}
                  className="min-w-0 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400"
                  placeholder="标签（如 Hermes 输出目录）"
                  aria-label={`产物目录标签 ${index + 1}`}
                />
                <input
                  value={row.path}
                  onChange={(e) => updateRow(index, { path: e.target.value })}
                  className="min-w-0 rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-sm outline-none focus:border-neutral-400"
                  placeholder="/absolute/path/to/output"
                  aria-label={`产物目录路径 ${index + 1}`}
                />
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="rounded-md border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50"
                  aria-label="删除产物目录"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <input
                  value={row.envVarName}
                  onChange={(e) => updateRow(index, { envVarName: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-xs outline-none focus:border-neutral-400"
                  placeholder="AGENTBEAN_SOURCE_ROOT_N"
                  aria-label={`产物目录环境变量名 ${index + 1}`}
                />
                <select
                  value={row.defaultRole}
                  onChange={(e) => updateRow(index, { defaultRole: e.target.value as ArtifactSourceRootRole })}
                  className="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-neutral-400"
                  aria-label={`产物目录默认角色 ${index + 1}`}
                >
                  {(Object.keys(ROLE_LABELS) as ArtifactSourceRootRole[]).map((role) => (
                    <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-900"
        >
          <Plus size={12} /> 添加目录
        </button>
        {clearRequested ? (
          <button
            type="button"
            onClick={() => onClearRequested?.(false)}
            className="text-xs font-medium text-neutral-600 hover:text-neutral-900"
          >
            撤销清除
          </button>
        ) : hasExistingDeclaration && rows.length === 0 ? (
          <button
            type="button"
            onClick={() => onClearRequested?.(true)}
            className="text-xs font-medium text-rose-600 hover:text-rose-700"
          >
            清除已配置目录
          </button>
        ) : null}
      </div>
    </div>
  );
}
