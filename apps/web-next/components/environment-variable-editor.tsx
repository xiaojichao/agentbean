import { Plus, X } from 'lucide-react';

export interface EnvironmentVariableRow {
  key: string;
  value: string;
}

/**
 * 自定义 Agent 运行环境变量编辑器：创建/编辑 Agent 时填写键值，
 * 已保存的密钥只回显 Key 名（值留在服务端），同名 Key 重新填写即覆盖。
 */
export function EnvironmentVariableEditor({
  rows,
  onChange,
  existingKeys = [],
  hint,
}: {
  rows: EnvironmentVariableRow[];
  onChange: (rows: EnvironmentVariableRow[]) => void;
  /** Public key names already stored (values never leave the server). */
  existingKeys?: string[];
  hint?: string;
}) {
  const updateRow = (index: number, patch: Partial<EnvironmentVariableRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-600">环境变量</label>
      <p className="mb-2 text-[11px] text-neutral-400">
        {hint ?? '创建后会注入到 Coding Agent 运行时环境。'}
      </p>
      {existingKeys.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {existingKeys.map((key) => (
            <span
              key={key}
              className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-mono text-[11px] text-neutral-600"
              title="已配置（值不可回显；下方填写同名 Key 可覆盖）"
            >
              {key}
            </span>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <input value={row.key} onChange={(e) => updateRow(index, { key: e.target.value })} className="min-w-0 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="KEY" />
            <input value={row.value} onChange={(e) => updateRow(index, { value: e.target.value })} className="min-w-0 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="value" />
            <button type="button" onClick={() => removeRow(index)} className="rounded-md border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50" aria-label="删除环境变量">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...rows, { key: '', value: '' }])} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-900">
        <Plus size={12} /> 添加变量
      </button>
    </div>
  );
}
