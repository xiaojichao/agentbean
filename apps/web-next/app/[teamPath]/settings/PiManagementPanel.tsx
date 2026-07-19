'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PiProviderCardDto,
  PiProviderEndpointMode,
  PiProviderPreset,
  PiProviderPresetDescriptorDto,
} from '@agentbean/contracts';
import { piProviderEvents } from '@/lib/socket';

type EditorMode = 'form' | 'advanced';

/** MVP 四类 Preset（与 contracts/domain 对齐；用于 UI 静态文案与测试断言）。 */
const MVP_PRESETS = ['openai', 'openrouter', 'deepseek', 'custom_openai_compatible'] as const satisfies readonly PiProviderPreset[];

interface CardFormState {
  displayName: string;
  baseUrl: string;
  endpointMode: PiProviderEndpointMode;
  modelId: string;
  timeoutMs: string;
  maxOutputTokens: string;
  notes: string;
  consoleUrl: string;
  apiKey: string;
  advancedJson: string;
}

const EMPTY_FORM: CardFormState = {
  displayName: '',
  baseUrl: '',
  endpointMode: 'chat_completions',
  modelId: '',
  timeoutMs: '60000',
  maxOutputTokens: '4096',
  notes: '',
  consoleUrl: '',
  apiKey: '',
  advancedJson: '{\n  "baseUrl": "",\n  "endpointMode": "chat_completions",\n  "modelId": "",\n  "timeoutMs": 60000,\n  "maxOutputTokens": 4096,\n  "compatibilityParams": {}\n}',
};

function formFromPreset(preset: PiProviderPresetDescriptorDto): CardFormState {
  return {
    ...EMPTY_FORM,
    displayName: preset.displayName,
    baseUrl: preset.defaultBaseUrl,
    endpointMode: preset.defaultEndpointMode,
    consoleUrl: preset.defaultConsoleUrl ?? '',
    advancedJson: JSON.stringify({
      baseUrl: preset.defaultBaseUrl,
      endpointMode: preset.defaultEndpointMode,
      modelId: '',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      compatibilityParams: {},
    }, null, 2),
  };
}

function formFromCard(card: PiProviderCardDto): CardFormState {
  const revision = card.draftRevision ?? card.publishedRevision;
  const config = revision?.config;
  return {
    displayName: card.displayName,
    baseUrl: config?.baseUrl ?? '',
    endpointMode: config?.endpointMode ?? 'chat_completions',
    modelId: config?.modelId ?? '',
    timeoutMs: String(config?.timeoutMs ?? 60_000),
    maxOutputTokens: String(config?.maxOutputTokens ?? 4096),
    notes: card.notes ?? '',
    consoleUrl: card.consoleUrl ?? '',
    apiKey: '',
    advancedJson: JSON.stringify({
      baseUrl: config?.baseUrl ?? '',
      endpointMode: config?.endpointMode ?? 'chat_completions',
      modelId: config?.modelId ?? '',
      timeoutMs: config?.timeoutMs ?? 60_000,
      maxOutputTokens: config?.maxOutputTokens ?? 4096,
      compatibilityParams: config?.compatibilityParams ?? {},
    }, null, 2),
  };
}

function syncAdvancedFromForm(form: CardFormState): string {
  return JSON.stringify({
    baseUrl: form.baseUrl,
    endpointMode: form.endpointMode,
    modelId: form.modelId,
    timeoutMs: Number(form.timeoutMs) || 60_000,
    maxOutputTokens: Number(form.maxOutputTokens) || 4096,
    compatibilityParams: {},
  }, null, 2);
}

function applyAdvancedToForm(form: CardFormState, advancedJson: string): CardFormState {
  try {
    const parsed = JSON.parse(advancedJson) as Record<string, unknown>;
    return {
      ...form,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : form.baseUrl,
      endpointMode: parsed.endpointMode === 'chat_completions' ? 'chat_completions' : form.endpointMode,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : form.modelId,
      timeoutMs: parsed.timeoutMs !== undefined ? String(parsed.timeoutMs) : form.timeoutMs,
      maxOutputTokens: parsed.maxOutputTokens !== undefined ? String(parsed.maxOutputTokens) : form.maxOutputTokens,
      advancedJson,
    };
  } catch {
    return { ...form, advancedJson };
  }
}

export function PiManagementPanel({ isSystemAdmin }: { isSystemAdmin: boolean }) {
  const [presets, setPresets] = useState<PiProviderPresetDescriptorDto[]>([]);
  const [cards, setCards] = useState<PiProviderCardDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PiProviderPreset>('openai');
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('form');
  const [form, setForm] = useState<CardFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const editorInitializedRef = useRef(false);

  const load = useCallback(async (options: {
    preserveEditor?: boolean;
    preserveMessage?: boolean;
  } = {}) => {
    if (!isSystemAdmin) return;
    setLoading(true);
    if (!options.preserveMessage) setMessage(null);
    const [presetResult, cardResult] = await Promise.all([
      piProviderEvents().listPresets(),
      piProviderEvents().listCards(),
    ]);
    setLoading(false);
    if (!presetResult.ok) {
      setMessage({ ok: false, text: presetResult.message ?? presetResult.error ?? '加载 Preset 失败' });
      return;
    }
    if (!cardResult.ok) {
      setMessage({ ok: false, text: cardResult.message ?? cardResult.error ?? '加载 Provider Card 失败' });
      return;
    }
    setPresets(presetResult.presets ?? []);
    setCards(cardResult.cards ?? []);
    if (!options.preserveEditor && !editorInitializedRef.current && (presetResult.presets?.length ?? 0) > 0) {
      const first = presetResult.presets![0]!;
      editorInitializedRef.current = true;
      setSelectedPreset(first.preset);
      setForm(formFromPreset(first));
    }
  }, [isSystemAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedPresetDescriptor = useMemo(
    () => presets.find((item) => item.preset === selectedPreset) ?? null,
    [presets, selectedPreset],
  );

  if (!isSystemAdmin) {
    return (
      <div className="mx-auto max-w-2xl space-y-4" data-smoke="settings-pi-forbidden">
        <h2 className="text-xl font-semibold">PI Agent</h2>
        <p className="text-sm text-neutral-600">
          PI Provider Supply 仅系统管理员可访问。Team 作用域的自动化与 Memory 设置将在后续切片提供；当前不会展示 Provider、Model、Endpoint 或 Credential。
        </p>
      </div>
    );
  }

  const startCreate = (preset: PiProviderPreset) => {
    const descriptor = presets.find((item) => item.preset === preset);
    editorInitializedRef.current = true;
    setEditingCardId(null);
    setSelectedPreset(preset);
    setEditorMode('form');
    setForm(descriptor ? formFromPreset(descriptor) : EMPTY_FORM);
    setMessage(null);
  };

  const startEdit = (card: PiProviderCardDto) => {
    editorInitializedRef.current = true;
    setEditingCardId(card.id);
    setSelectedPreset(card.preset);
    setEditorMode('form');
    setForm(formFromCard(card));
    setMessage(null);
  };

  const patchForm = (partial: Partial<CardFormState>) => {
    setForm((current) => {
      const next = { ...current, ...partial };
      if (editorMode === 'form') {
        return { ...next, advancedJson: syncAdvancedFromForm(next) };
      }
      return next;
    });
  };

  const switchEditorMode = (mode: EditorMode) => {
    if (mode === 'advanced') {
      setForm((current) => ({ ...current, advancedJson: syncAdvancedFromForm(current) }));
    } else {
      setForm((current) => applyAdvancedToForm(current, current.advancedJson));
    }
    setEditorMode(mode);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const payloadBase = {
      displayName: form.displayName,
      baseUrl: form.baseUrl,
      endpointMode: form.endpointMode,
      modelId: form.modelId,
      timeoutMs: Number(form.timeoutMs),
      maxOutputTokens: Number(form.maxOutputTokens),
      notes: form.notes || null,
      consoleUrl: form.consoleUrl || null,
      compatibilityParams: {} as const,
      advancedConfig: editorMode === 'advanced' ? form.advancedJson : undefined,
    };

    const result = editingCardId
      ? await piProviderEvents().updateCard({
          cardId: editingCardId,
          ...payloadBase,
          apiKey: form.apiKey || null,
        })
      : await piProviderEvents().createCard({
          preset: selectedPreset,
          ...payloadBase,
          apiKey: form.apiKey,
        });

    setSaving(false);
    if (!result.ok || !result.card) {
      setMessage({ ok: false, text: result.message ?? result.error ?? '保存失败' });
      return;
    }
    setMessage({ ok: true, text: editingCardId ? 'Draft 已更新' : 'Draft 已创建' });
    setEditingCardId(result.card.id);
    setForm(formFromCard(result.card));
    await load({ preserveEditor: true, preserveMessage: true });
  };

  const copyCard = async (cardId: string) => {
    setSaving(true);
    setMessage(null);
    const result = await piProviderEvents().copyCard({ sourceCardId: cardId });
    setSaving(false);
    if (!result.ok || !result.card) {
      setMessage({ ok: false, text: result.message ?? result.error ?? '复制失败' });
      return;
    }
    startEdit(result.card);
    setMessage({ ok: true, text: '已复制为新 Draft' });
    await load({ preserveEditor: true, preserveMessage: true });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-smoke="settings-pi-panel" data-pi-scope="system">
      <div>
        <h2 className="text-xl font-semibold">PI Agent</h2>
        <p className="mt-1 text-sm text-neutral-500">
          系统作用域管理 Provider Supply；与团队设置分离，不共享表单。
        </p>
      </div>

      <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-pi-provider-supply">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-neutral-700">Provider Supply</h3>
                <p className="mt-1 text-xs text-neutral-500">从 OpenAI / OpenRouter / DeepSeek / Custom 创建 Draft；Credential 加密保存且永不回显。</p>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50"
              >
                刷新
              </button>
            </div>

            <div className="mb-4 flex flex-wrap gap-2" data-smoke="settings-pi-presets" data-mvp-presets={MVP_PRESETS.join(',')}>
              {presets.map((preset) => (
                <button
                  key={preset.preset}
                  type="button"
                  onClick={() => startCreate(preset.preset)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${selectedPreset === preset.preset && !editingCardId ? 'border-pink-300 bg-pink-50 text-pink-800' : 'border-neutral-200 hover:bg-neutral-50'}`}
                  data-smoke={`settings-pi-preset-${preset.preset}`}
                >
                  新建 {preset.displayName}
                </button>
              ))}
            </div>

            <div className="space-y-2" data-smoke="settings-pi-card-list">
              {cards.length === 0 && !loading ? (
                <p className="text-sm text-neutral-500">尚未创建 Provider Card。</p>
              ) : cards.map((card) => (
                <div
                  key={card.id}
                  className="flex items-center justify-between rounded-md border border-neutral-100 px-3 py-2"
                  data-smoke="settings-pi-card-row"
                  data-card-id={card.id}
                >
                  <div>
                    <div className="text-sm font-medium">{card.displayName}</div>
                    <div className="text-xs text-neutral-500">
                      {card.preset}
                      {' · '}
                      {card.draftRevision ? '有 Draft' : '无 Draft'}
                      {' · '}
                      {card.publishedRevision ? '已发布' : '未发布'}
                      {' · '}
                      Credential {card.credential.configured ? '已配置' : '未配置'}
                      {card.credential.fingerprint ? ` (${card.credential.fingerprint})` : ''}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => startEdit(card)} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50">
                      编辑
                    </button>
                    <button type="button" onClick={() => void copyCard(card.id)} disabled={saving} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50">
                      复制
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-pi-card-editor">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-neutral-700">
                {editingCardId ? '编辑 Draft' : `创建 Draft${selectedPresetDescriptor ? ` · ${selectedPresetDescriptor.displayName}` : ''}`}
              </h3>
              <div className="flex rounded-md border border-neutral-200 p-0.5">
                <button type="button" onClick={() => switchEditorMode('form')} className={`rounded px-2 py-1 text-xs ${editorMode === 'form' ? 'bg-neutral-900 text-white' : 'text-neutral-600'}`} data-smoke="settings-pi-editor-form">
                  表单
                </button>
                <button type="button" onClick={() => switchEditorMode('advanced')} className={`rounded px-2 py-1 text-xs ${editorMode === 'advanced' ? 'bg-neutral-900 text-white' : 'text-neutral-600'}`} data-smoke="settings-pi-editor-advanced">
                  高级 JSON
                </button>
              </div>
            </div>

            {editorMode === 'form' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-neutral-500 sm:col-span-2">
                  显示名称
                  <input value={form.displayName} onChange={(e) => patchForm({ displayName: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-display-name" />
                </label>
                <label className="block text-xs text-neutral-500 sm:col-span-2">
                  Base URL
                  <input value={form.baseUrl} onChange={(e) => patchForm({ baseUrl: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-base-url" />
                </label>
                <label className="block text-xs text-neutral-500">
                  Endpoint Mode
                  <select value={form.endpointMode} onChange={(e) => patchForm({ endpointMode: e.target.value as PiProviderEndpointMode })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-endpoint-mode">
                    <option value="chat_completions">chat_completions</option>
                  </select>
                </label>
                <label className="block text-xs text-neutral-500">
                  Model ID
                  <input value={form.modelId} onChange={(e) => patchForm({ modelId: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-model-id" />
                </label>
                <label className="block text-xs text-neutral-500">
                  Timeout (ms)
                  <input value={form.timeoutMs} onChange={(e) => patchForm({ timeoutMs: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-timeout" />
                </label>
                <label className="block text-xs text-neutral-500">
                  Max output tokens
                  <input value={form.maxOutputTokens} onChange={(e) => patchForm({ maxOutputTokens: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-max-output-tokens" />
                </label>
                <label className="block text-xs text-neutral-500 sm:col-span-2">
                  控制台链接
                  <input value={form.consoleUrl} onChange={(e) => patchForm({ consoleUrl: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-console-url" />
                </label>
                <label className="block text-xs text-neutral-500 sm:col-span-2">
                  备注
                  <textarea value={form.notes} onChange={(e) => patchForm({ notes: e.target.value })} rows={2} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-notes" />
                </label>
                <label className="block text-xs text-neutral-500 sm:col-span-2">
                  API Key {editingCardId ? '（留空则保留现有 Credential）' : ''}
                  <input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => patchForm({ apiKey: e.target.value })} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-api-key" placeholder={editingCardId ? '••••••••（不回显）' : 'Bearer API Key'} />
                </label>
              </div>
            ) : (
              <div>
                <p className="mb-2 text-xs text-neutral-500">
                  高级 JSON 与表单编辑同一份类型化配置。仅允许 baseUrl、endpointMode、modelId、timeoutMs、maxOutputTokens 与空 compatibilityParams；禁止 Header/Body、OAuth、Shell 与环境变量插值。Credential 不在 JSON 中。
                </p>
                <textarea
                  value={form.advancedJson}
                  onChange={(e) => setForm((current) => ({ ...current, advancedJson: e.target.value }))}
                  rows={14}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs"
                  data-smoke="settings-pi-field-advanced-json"
                />
              </div>
            )}

            {message && (
              <p className={`mt-3 text-sm ${message.ok ? 'text-emerald-700' : 'text-red-600'}`} data-smoke="settings-pi-message">
                {message.text}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                data-smoke="settings-pi-save"
              >
                {saving ? '保存中…' : '保存 Draft'}
              </button>
              {editingCardId && (
                <button
                  type="button"
                  onClick={() => startCreate(selectedPreset)}
                  className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50"
                >
                  新建空白
                </button>
              )}
            </div>
      </section>
    </div>
  );
}
