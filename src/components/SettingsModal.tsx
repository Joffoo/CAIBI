import { useState } from 'react';
import type { ExtensionSettings } from '../utils/types';
import { saveSettings } from '../services/settings';
import { fetchModelsViaBackground } from '../services/visionCompiler';
import { resolveImageGenConfig } from '../services/imageGenerator';

const FIELD_CLS =
  'w-full border border-ink bg-obsidian px-2 py-1 text-[11px] text-paper placeholder:text-dim focus:border-paper focus:outline-none';
const LABEL_CLS = 'mb-0.5 block text-2xs font-bold tracking-widest text-mute';

function ModelPicker({
  title,
  value,
  placeholder,
  models,
  fetching,
  error,
  onChange,
  onFetch,
}: {
  title: string;
  value: string;
  placeholder: string;
  models: string[];
  fetching: boolean;
  error: string;
  onChange: (v: string) => void;
  onFetch: () => void;
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between">
        <label className="text-2xs font-bold tracking-widest text-mute">{title}</label>
        {models.length > 0 && (
          <span className="text-2xs text-dim">已拉取 {models.length} 个模型</span>
        )}
      </div>
      <div className="flex gap-1">
        <input
          className={FIELD_CLS}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          disabled={fetching}
          onClick={onFetch}
          className="shrink-0 border border-ink px-2 py-1 text-2xs font-bold tracking-wider text-mute hover:border-paper hover:text-paper disabled:opacity-50"
          title="从当前 Base URL 拉取可用模型列表"
        >
          {fetching ? '拉取中…' : '↻ 拉取模型'}
        </button>
      </div>
      {models.length > 0 && (
        <select
          value={models.includes(value) ? value : ''}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
          }}
          className="mt-1 w-full border border-ink bg-obsidian px-2 py-1 text-[11px] text-paper focus:border-paper focus:outline-none"
        >
          {!models.includes(value) && (
            <option value="">选择已拉取模型 ({models.length})…</option>
          )}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
      {error && <p className="mt-1 break-words text-2xs text-[#EF4444]">{error}</p>}
    </div>
  );
}

export function SettingsModal({
  settings,
  onClose,
  onSaved,
  onNotify,
}: {
  settings: ExtensionSettings;
  onClose: () => void;
  onSaved: (s: ExtensionSettings) => void;
  onNotify: (msg: string) => void;
}) {
  const [local, setLocal] = useState<ExtensionSettings>({ ...settings });
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState('');

  const [imgOpen, setImgOpen] = useState(Boolean(settings.imageGenModel?.trim()));
  const [fetchingImgModels, setFetchingImgModels] = useState(false);
  const [imgModels, setImgModels] = useState<string[]>([]);
  const [imgModelError, setImgModelError] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showImgApiKey, setShowImgApiKey] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isDirty =
    local.baseUrl.trim() !== (settings.baseUrl ?? '').trim() ||
    local.apiKey.trim() !== (settings.apiKey ?? '').trim() ||
    local.model.trim() !== (settings.model ?? '').trim() ||
    local.imageGenBaseUrl.trim() !== (settings.imageGenBaseUrl ?? '').trim() ||
    local.imageGenApiKey.trim() !== (settings.imageGenApiKey ?? '').trim() ||
    local.imageGenModel.trim() !== (settings.imageGenModel ?? '').trim() ||
    local.triggerMode !== settings.triggerMode;

  const set = (patch: Partial<ExtensionSettings>) => {
    setConfirmDiscard(false);
    setLocal((prev) => ({ ...prev, ...patch }));
  };

  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setModelError('');
    try {
      const list = await fetchModelsViaBackground(local);
      setModels(list);
      if (list.length === 0) {
        setModelError('接口未返回可用模型');
      } else {
        setLocal((prev) =>
          !prev.model || !list.includes(prev.model) ? { ...prev, model: list[0] } : prev,
        );
        onNotify(`✓ 已拉取 ${list.length} 个可用模型`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setModelError(msg);
      onNotify(`✗ ${msg}`);
    } finally {
      setFetchingModels(false);
    }
  };

  const fetchImgModels = async () => {
    setFetchingImgModels(true);
    setImgModelError('');
    try {
      const resolved = resolveImageGenConfig(local);
      const list = await fetchModelsViaBackground({
        ...local,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
      });
      setImgModels(list);
      if (list.length === 0) {
        setImgModelError('接口未返回可用生图模型');
      } else {
        setLocal((prev) =>
          !prev.imageGenModel || !list.includes(prev.imageGenModel)
            ? { ...prev, imageGenModel: list[0] }
            : prev,
        );
        onNotify(`✓ 已拉取 ${list.length} 个生图候选模型`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImgModelError(msg);
      onNotify(`✗ ${msg}`);
    } finally {
      setFetchingImgModels(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const trimmed: ExtensionSettings = {
        ...local,
        baseUrl: local.baseUrl.trim(),
        apiKey: local.apiKey.trim(),
        model: local.model.trim(),
        imageGenBaseUrl: local.imageGenBaseUrl.trim(),
        imageGenApiKey: local.imageGenApiKey.trim(),
        imageGenModel: local.imageGenModel.trim(),
      };
      const merged = await saveSettings(trimmed);
      onSaved(merged);
      onNotify('✓ 设置已保存（chrome.storage.local）');
      onClose();
    } catch (e) {
      onNotify(`✗ 保存失败: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-obsidian/85 p-3">
      <div className="flex max-h-[580px] w-full max-w-[420px] flex-col border border-line bg-obsidian shadow-hud">
        <div className="flex shrink-0 items-center justify-between border-b border-ink bg-panel px-3 py-2">
          <span className="text-2xs font-bold tracking-widest text-paper">BYOK SETTINGS</span>
          <button
            type="button"
            onClick={requestClose}
            className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
          >
            ✕
          </button>
        </div>
        {confirmDiscard && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#EF4444]/60 bg-[#EF4444]/10 px-3 py-1.5 text-2xs">
            <span className="text-[#EF4444]">有未保存的设置修改，确定放弃并关闭吗？</span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className="border border-ink px-1.5 py-0.5 text-mute hover:border-paper hover:text-paper"
              >
                继续编辑
              </button>
              <button
                type="button"
                onClick={onClose}
                className="border border-[#EF4444] bg-[#EF4444]/20 px-1.5 py-0.5 font-bold text-[#EF4444]"
              >
                放弃并关闭
              </button>
            </div>
          </div>
        )}
        <div className="vrc-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <div>
            <label className={LABEL_CLS}>BASE URL · 接口地址（OpenAI 兼容格式）</label>
            <input
              className={FIELD_CLS}
              value={local.baseUrl}
              spellCheck={false}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1  (OpenRouter / OneAPI 等兼容地址)"
            />
          </div>
          <div>
            <label className={LABEL_CLS}>API KEY · 密钥（仅存本地）</label>
            <div className="flex gap-1">
              <input
                className={FIELD_CLS}
                type={showApiKey ? 'text' : 'password'}
                value={local.apiKey}
                spellCheck={false}
                onChange={(e) => set({ apiKey: e.target.value })}
                placeholder="sk-…"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="shrink-0 border border-ink px-2 py-1 text-2xs text-mute hover:border-paper hover:text-paper"
                title={showApiKey ? '隐藏密钥' : '显示密钥'}
              >
                {showApiKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
          <ModelPicker
            title="MODEL · 视觉模型名"
            value={local.model}
            placeholder="gpt-4o"
            models={models}
            fetching={fetchingModels}
            error={modelError}
            onChange={(v) => set({ model: v })}
            onFetch={() => void fetchModels()}
          />

          <div className="border border-ink bg-panel/60">
            <button
              type="button"
              onClick={() => setImgOpen(!imgOpen)}
              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-2xs font-bold tracking-wider text-paper hover:bg-panel"
            >
              <span>
                {imgOpen ? '▾' : '▸'} IMAGE GEN · 生图模型配置（可选）
              </span>
              <span className="text-dim">
                {local.imageGenModel.trim() ? local.imageGenModel.trim() : '未启用'}
              </span>
            </button>
            {imgOpen && (
              <div className="space-y-2.5 border-t border-ink p-2.5">
                <div>
                  <label className={LABEL_CLS}>IMAGE BASE URL · 留空复用主地址</label>
                  <input
                    className={FIELD_CLS}
                    value={local.imageGenBaseUrl}
                    spellCheck={false}
                    onChange={(e) => set({ imageGenBaseUrl: e.target.value })}
                    placeholder="留空复用主地址或默认 OpenAI /v1"
                  />
                </div>
                <div>
                  <label className={LABEL_CLS}>IMAGE API KEY · 留空复用主密钥</label>
                  <div className="flex gap-1">
                    <input
                      className={FIELD_CLS}
                      type={showImgApiKey ? 'text' : 'password'}
                      value={local.imageGenApiKey}
                      spellCheck={false}
                      onChange={(e) => set({ imageGenApiKey: e.target.value })}
                      placeholder="留空则自动复用上方 API KEY"
                    />
                    <button
                      type="button"
                      onClick={() => setShowImgApiKey((v) => !v)}
                      className="shrink-0 border border-ink px-2 py-1 text-2xs text-mute hover:border-paper hover:text-paper"
                      title={showImgApiKey ? '隐藏密钥' : '显示密钥'}
                    >
                      {showImgApiKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                </div>
                <ModelPicker
                  title="IMAGE MODEL · 生图模型（留空即禁用）"
                  value={local.imageGenModel}
                  placeholder="gpt-image-1 / dall-e-3"
                  models={imgModels}
                  fetching={fetchingImgModels}
                  error={imgModelError}
                  onChange={(v) => set({ imageGenModel: v })}
                  onFetch={() => void fetchImgModels()}
                />
              </div>
            )}
          </div>

          <div>
            <label className={LABEL_CLS}>TRIGGER MODE · 触发方式</label>
            <div className="flex gap-1">
              {(
                [
                  ['shortcut', '快捷键 Alt+右键'],
                  ['badge', '悬浮 [+] 徽章'],
                  ['both', '两者同时启用'],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => set({ triggerMode: v })}
                  className={`flex-1 border px-1 py-1 text-2xs ${
                    local.triggerMode === v
                      ? 'border-paper bg-paper text-obsidian'
                      : 'border-ink text-mute hover:border-paper hover:text-paper'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <p className="text-2xs leading-relaxed text-dim">
            Key 仅保存在本机 chrome.storage.local；图像抓取与 API 请求均由后台 Service
            Worker 直连，页面无法读取密钥。
          </p>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="w-full border border-paper bg-paper py-1.5 text-2xs font-bold tracking-widest text-obsidian hover:bg-[#E4E4E7] disabled:opacity-50"
          >
            {saving ? 'SAVING…' : 'SAVE SETTINGS'}
          </button>
        </div>
      </div>
    </div>
  );
}
