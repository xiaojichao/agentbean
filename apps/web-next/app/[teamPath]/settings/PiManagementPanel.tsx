'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PiProviderCardDto,
  ActivePiModelDto,
  PiConfigurationReadinessDto,
  PiProviderEndpointMode,
  PiProviderPreset,
  PiProviderPresetDescriptorDto,
} from '@agentbean/contracts';
import { piProviderEvents, systemKnowledgeEvents } from '@/lib/socket';
import { announcePiConfigurationReadinessChanged } from '@/lib/pi-configuration-readiness';
import { PiModelSwitcher } from '@/components/PiModelSwitcher';
import { SystemUserMemoryPanel } from '@/components/SystemUserMemoryPanel';

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
  const [activeModel, setActiveModel] = useState<ActivePiModelDto | null>(null);
  const [activeHistory, setActiveHistory] = useState<ActivePiModelDto[]>([]);
  const [configurationReadiness, setConfigurationReadiness] = useState<PiConfigurationReadinessDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeUnavailable, setActiveUnavailable] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PiProviderPreset>('openai');
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('form');
  const [form, setForm] = useState<CardFormState>(EMPTY_FORM);
  const [editorDirty, setEditorDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingCardId, setTestingCardId] = useState<string | null>(null);
  const editorInitializedRef = useRef(false);

  const load = useCallback(async (options: {
    preserveEditor?: boolean;
    preserveMessage?: boolean;
  } = {}) => {
    if (!isSystemAdmin) return;
    setLoading(true);
    if (!options.preserveMessage) setMessage(null);
    const [presetResult, cardResult, activeResult] = await Promise.all([
      piProviderEvents().listPresets(),
      piProviderEvents().listCards(),
      piProviderEvents().getActiveModel(),
    ]);
    setLoading(false);
    setActiveUnavailable(!activeResult.ok || !cardResult.ok);
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
    if (activeResult.ok) {
      setActiveModel(activeResult.activeModel ?? null);
      setActiveHistory(activeResult.history ?? []);
      setConfigurationReadiness(activeResult.readiness ?? null);
      announcePiConfigurationReadinessChanged();
    } else {
      setMessage({ ok: false, text: activeResult.message ?? activeResult.error ?? '当前模型加载失败，请刷新重试' });
    }
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
        <h2 className="text-xl font-semibold">模型与 Provider</h2>
        <p className="text-sm text-neutral-600">
          PI Provider Supply 仅系统管理员可访问。Team 作用域的自动化与 Memory 设置将在后续切片提供；当前不会展示 Provider、Model、Endpoint 或 Credential。
        </p>
      </div>
    );
  }

  const revealEditor = () => {
    document.querySelector('[data-smoke="settings-pi-card-editor"]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const startCreate = (preset: PiProviderPreset) => {
    const descriptor = presets.find((item) => item.preset === preset);
    editorInitializedRef.current = true;
    setEditingCardId(null);
    setSelectedPreset(preset);
    setEditorMode('form');
    setForm(descriptor ? formFromPreset(descriptor) : EMPTY_FORM);
    setEditorDirty(false);
    revealEditor();
    setMessage(null);
  };

  const startEdit = (card: PiProviderCardDto) => {
    editorInitializedRef.current = true;
    setEditingCardId(card.id);
    setSelectedPreset(card.preset);
    setEditorMode('form');
    setForm(formFromCard(card));
    setEditorDirty(false);
    revealEditor();
    setMessage(null);
  };

  const patchForm = (partial: Partial<CardFormState>) => {
    setEditorDirty(true);
    setForm((current) => {
      const next = { ...current, ...partial };
      if (editorMode === 'form') {
        return { ...next, advancedJson: syncAdvancedFromForm(next) };
      }
      return next;
    });
  };

  const switchEditorMode = (mode: EditorMode) => {
    if (mode === editorMode) return;
    if (mode === 'advanced') {
      setForm((current) => ({ ...current, advancedJson: syncAdvancedFromForm(current) }));
    } else {
      try {
        JSON.parse(form.advancedJson);
      } catch {
        setMessage({ ok: false, text: 'JSON 格式不正确，请修正后再切换到表单。' });
        return;
      }
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
    setEditorDirty(false);
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

  const discoverModels = async (cardId: string) => {
    setSaving(true);
    setMessage(null);
    const result = await piProviderEvents().discoverModels(cardId);
    setSaving(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message ?? result.error ?? '模型发现失败' });
      return;
    }
    setMessage({
      ok: true,
      text: result.discoverySupported
        ? `已刷新 ${result.models?.length ?? 0} 个候选模型（未发布、未改生产绑定）`
        : result.diagnosticCode === 'PI_PROVIDER_DISCOVERY_UNSUPPORTED'
          ? 'Provider 不支持模型发现，请手工填写 Model ID'
          : `模型发现失败：${result.diagnosticCode ?? 'PI_PROVIDER_DISCOVERY_UNKNOWN'}`,
    });
    await load({ preserveEditor: true, preserveMessage: true });
  };

  const runTest = async (cardId: string) => {
    setTestingCardId(cardId);
    setMessage(null);
    const result = await piProviderEvents().runTest(cardId);
    setTestingCardId(null);
    if (!result.ok || !result.card) {
      setMessage({ ok: false, text: result.message ?? result.error ?? '测试失败' });
      return;
    }
    const test = result.test as { status?: string; diagnosticCode?: string | null } | undefined;
    startEdit(result.card);
    setMessage({
      ok: test?.status === 'passed',
      text: test?.status === 'passed'
        ? '生产同路径测试通过，可发布'
        : test?.diagnosticCode === 'MANAGEMENT_MODEL_ABORTED'
          ? '生产同路径测试已取消'
          : `测试未通过${test?.diagnosticCode ? `：${test.diagnosticCode}` : ''}`,
    });
    await load({ preserveEditor: true, preserveMessage: true });
  };

  const cancelTest = async (cardId: string) => {
    const result = await piProviderEvents().cancelTest(cardId);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message ?? result.error ?? '取消测试失败' });
      return;
    }
    setMessage({ ok: true, text: result.cancelled ? '正在取消生产同路径测试' : '当前没有运行中的测试' });
  };

  const publishCard = async (cardId: string) => {
    setSaving(true);
    setMessage(null);
    const result = await piProviderEvents().publishCard(cardId);
    setSaving(false);
    if (!result.ok || !result.card) {
      setMessage({ ok: false, text: result.message ?? result.error ?? '发布失败' });
      return;
    }
    startEdit(result.card);
    setMessage({ ok: true, text: '已发布为不可变 revision' });
    await load({ preserveEditor: true, preserveMessage: true });
  };

  const activateRevision = async (revisionId: string): Promise<boolean> => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await piProviderEvents().setActiveModel(revisionId);
      if (!result.ok || !result.activeModel) {
        setMessage({ ok: false, text: result.message ?? result.error ?? '切换失败，请刷新当前配置后重试' });
        return false;
      }
      setActiveModel(result.activeModel);
      setMessage({ ok: true, text: `已切换至 ${result.activeModel.modelId}，新的消息协调与任务编排将使用此模型。` });
      await load({ preserveEditor: true, preserveMessage: true });
      return true;
    } catch {
      setActiveUnavailable(true);
      setMessage({ ok: false, text: '未能确认切换结果，请刷新以核实当前模型。' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-smoke="settings-pi-panel" data-pi-scope="system">
      <div>
        <h2 className="text-xl font-semibold">模型与 Provider</h2>
        <p className="mt-1 text-sm text-neutral-500">
          管理所有团队共用的 LLM。添加连接、验证模型，随时切换已发布版本。
        </p>
      </div>

      {message && <p role={message.ok ? 'status' : 'alert'} className={`rounded-lg border p-4 text-sm ${message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`} data-smoke="settings-pi-message">{message.text}</p>}
      <PiModelSwitcher cards={cards} activeModel={activeModel} history={activeHistory} readiness={configurationReadiness} loading={loading} disabled={saving || loading || testingCardId !== null} unavailable={activeUnavailable} onActivate={activateRevision} />

      <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-pi-provider-supply">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-neutral-700">Provider 配置</h3>
                <p className="mt-1 text-xs text-neutral-500">支持 OpenAI、OpenRouter、DeepSeek 和自定义兼容接口。保存草稿 → 测试 → 发布 → 在上方切换。</p>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading || saving || testingCardId !== null}
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
                  disabled={saving || testingCardId !== null || editorDirty}
              >
                  新建 {preset.displayName}
                </button>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-2" data-smoke="settings-pi-card-list">
              {cards.length === 0 && !loading ? (
                <p className="text-sm text-neutral-500">尚未创建 Provider Card。</p>
              ) : cards.map((card) => (
                <div
                  key={card.id}
                  className={`space-y-4 rounded-xl border p-4 ${activeModel?.cardId === card.id ? 'border-emerald-200 bg-emerald-50/30' : 'border-neutral-200'}`}
                  data-smoke="settings-pi-card-row"
                  data-card-id={card.id}
                >
                  <div>
                    <div className="text-sm font-semibold">{card.displayName}</div>
                    {activeModel?.cardId === card.id && <p className="mt-2 break-all text-xs text-emerald-700">当前生效：{activeModel.modelId} · {activeModel.revisionId}</p>}
                    <p className="my-2 break-all text-sm"><span className="mr-2 text-xs text-neutral-500">{card.draftRevision ? '草稿模型' : '已发布模型'}</span><span className="font-mono">{card.draftRevision?.config.modelId ?? card.publishedRevision?.config.modelId ?? '待选择模型'}</span></p>
                    <div className="text-xs text-neutral-500">
                      {card.preset}
                      {' · '}
                      {card.draftRevision ? '有 Draft' : '无 Draft'}
                      {' · '}
                      {card.publishedRevision ? '已发布' : '未发布'}
                      {' · '}
                      Credential {card.credential.configured ? '已配置' : '未配置'}
                      {card.credential.fingerprint ? ` (${card.credential.fingerprint})` : ''}
                      {' · '}
                      测试 {card.latestTest?.status === 'passed' ? '通过' : card.latestTest?.status === 'failed' ? '失败' : '未测'}
                      {card.canPublish ? ' · 可发布' : ''}
                      {(card.modelCandidates?.length ?? 0) > 0 ? ` · 候选 ${card.modelCandidates.length}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={saving || testingCardId !== null || editorDirty} onClick={() => startEdit(card)} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50">
                      编辑
                    </button>
                    <button type="button" onClick={() => void discoverModels(card.id)} disabled={saving || testingCardId !== null || editorDirty} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50" data-smoke="settings-pi-discover">
                      刷新模型
                    </button>
                    {testingCardId === card.id ? (
                      <button type="button" onClick={() => void cancelTest(card.id)} className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50" data-smoke="settings-pi-cancel-test">
                        取消测试
                      </button>
                    ) : (
                      <button type="button" onClick={() => void runTest(card.id)} disabled={saving || testingCardId !== null || editorDirty || !card.draftRevision} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50" data-smoke="settings-pi-run-test">
                        运行测试
                      </button>
                    )}
                    <button type="button" onClick={() => void publishCard(card.id)} disabled={saving || testingCardId !== null || editorDirty || !card.canPublish} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50" data-smoke="settings-pi-publish">
                      发布
                    </button>
                    <button type="button" onClick={() => void copyCard(card.id)} disabled={saving || testingCardId !== null || editorDirty} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50">
                      复制
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-pi-card-editor">
            {editorDirty && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
              <p>有未保存的修改。保存草稿后才能刷新模型、测试或发布；当前生效模型不受影响。</p>
              <button type="button" disabled={saving || testingCardId !== null} onClick={() => {
                const card = cards.find((item) => item.id === editingCardId);
                if (card) startEdit(card); else startCreate(selectedPreset);
              }} className="shrink-0 rounded border border-amber-300 px-2 py-1">放弃未保存修改</button>
            </div>}
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-neutral-700">
                {editingCardId ? '编辑 Draft' : `创建 Draft${selectedPresetDescriptor ? ` · ${selectedPresetDescriptor.displayName}` : ''}`}
              </h3>
              <div className="flex rounded-md border border-neutral-200 p-0.5">
                <button type="button" disabled={saving || testingCardId !== null} onClick={() => switchEditorMode('form')} className={`rounded px-2 py-1 text-xs ${editorMode === 'form' ? 'bg-neutral-900 text-white' : 'text-neutral-600'}`} data-smoke="settings-pi-editor-form">
                  表单
                </button>
                <button type="button" disabled={saving || testingCardId !== null} onClick={() => switchEditorMode('advanced')} className={`rounded px-2 py-1 text-xs ${editorMode === 'advanced' ? 'bg-neutral-900 text-white' : 'text-neutral-600'}`} data-smoke="settings-pi-editor-advanced">
                  高级 JSON
                </button>
              </div>
            </div>

            {editorMode === 'form' ? (
              <fieldset disabled={saving || testingCardId !== null} className="grid gap-3 sm:grid-cols-2">
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
                  <input value={form.modelId} onChange={(e) => patchForm({ modelId: e.target.value })} list="pi-model-candidates" className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" data-smoke="settings-pi-field-model-id" placeholder="可手填或从候选选择" />
                  <datalist id="pi-model-candidates">
                    {(cards.find((c) => c.id === editingCardId)?.modelCandidates ?? []).map((item) => (
                      <option key={item.modelId} value={item.modelId} />
                    ))}
                  </datalist>
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
              </fieldset>
            ) : (
              <div>
                <p className="mb-2 text-xs text-neutral-500">
                  高级 JSON 与表单编辑同一份类型化配置。仅允许 baseUrl、endpointMode、modelId、timeoutMs、maxOutputTokens 与空 compatibilityParams；禁止 Header/Body、OAuth、Shell 与环境变量插值。Credential 不在 JSON 中。
                </p>
                <textarea
                  disabled={saving || testingCardId !== null}
                  value={form.advancedJson}
                  onChange={(e) => { setEditorDirty(true); setForm((current) => ({ ...current, advancedJson: e.target.value })); }}
                  rows={14}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs"
                  data-smoke="settings-pi-field-advanced-json"
                />
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || testingCardId !== null}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                data-smoke="settings-pi-save"
              >
                {saving ? '保存中…' : '保存 Draft'}
              </button>
              {editingCardId && (
                <button
                  type="button"
                  disabled={saving || testingCardId !== null || editorDirty}
                  onClick={() => startCreate(selectedPreset)}
                  className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50"
                >
                  新建空白
                </button>
              )}
            </div>
      </section>
      <details className="rounded-lg border border-neutral-200 p-5"><summary className="cursor-pointer text-sm font-semibold">系统知识</summary><div className="mt-4">
      <SystemUserMemoryPanel
        scope="system"
        events={systemKnowledgeEvents()}
        title="System Knowledge"
        description="维护所有团队共用的产品知识。"
        dataSmoke="settings-system-knowledge"
      />

      </div></details>
    </div>
  );
}
