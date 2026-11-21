import { useEffect, useRef, useState } from 'react';
import type {
  CharacterAsset,
  CompiledResult,
  GeneratedImageSource,
  HistoryRecord,
} from '../utils/types';
import { copyText } from '../utils/clipboard';
import { inferExtFromDataUrl } from '../utils/base64';
import { exportToObsidianMarkdown } from '../services/db';
import { ConfirmDeleteButton, CopyButton, ExtractedAssetPreview, PromptBox, SectionLabel } from './ui';
import { ImageGenPanel } from './ImageGenPanel';

const PRESET_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;

function toJsonMap(jp: CompiledResult['json_prompt'] | undefined): Record<string, string> {
  if (!jp) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(jp)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

function applyAspectRatioToShort(shortText: string, ratio: string, prevRatio: string): string {
  if (!ratio) return shortText;
  if (/画幅比例\s*\d+:\d+/.test(shortText)) {
    return shortText.replace(/画幅比例\s*\d+:\d+/g, `画幅比例 ${ratio}`);
  }
  if (/--ar\s+\d+:\d+/i.test(shortText)) {
    return shortText.replace(/--ar\s+\d+:\d+/gi, `--ar ${ratio}`);
  }
  if (prevRatio) {
    const esc = prevRatio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^0-9:])${esc}(?=$|[^0-9:])`, 'g');
    if (re.test(shortText)) {
      return shortText.replace(re, `$1${ratio}`);
    }
  }
  return shortText ? `${shortText}，画幅比例 ${ratio}` : `画幅比例 ${ratio}`;
}

export function HudWorkspace({
  record,
  onCopied,
  imageGenEnabled,
  sourceDataUrl,
  assets,
  onSaveAsset,
  onDeleteAsset,
  onGeneratedImage,
  onDeleteGeneratedImage,
  onExtractCharacter,
  onExtractAnimeToReal,
  extractingMode,
  extractedAsset,
  extractError,
}: {
  record: HistoryRecord;
  onCopied: (msg: string) => void;
  imageGenEnabled: boolean;
  sourceDataUrl: string | null;
  assets: CharacterAsset[];
  onSaveAsset: (asset: { name: string; dataUrl: string; prompt: string }) => Promise<void>;
  onDeleteAsset: (id: string) => Promise<void>;
  onGeneratedImage: (
    recordId: string,
    img: { dataUrl: string; prompt: string; referenceSummary: string; source: GeneratedImageSource },
  ) => Promise<void>;
  onDeleteGeneratedImage: (recordId: string, imageId: string) => Promise<void>;
  onExtractCharacter?: () => void;
  onExtractAnimeToReal?: () => void;
  extractingMode?: 'standard' | 'anime2real' | null;
  extractedAsset: CharacterAsset | null;
  extractError: string;
}) {
  const result: CompiledResult | null = record.result;

  const [refMode, setRefMode] = useState<'none' | 'source' | 'asset' | 'upload'>('none');
  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  const [uploadedRef, setUploadedRef] = useState<string>('');
  const refFileRef = useRef<HTMLInputElement | null>(null);
  const assetUploadRef = useRef<HTMLInputElement | null>(null);

  const originalRatio =
    record.physics?.aspectRatio?.trim() || result?.json_prompt?.aspect_ratio?.trim() || '';
  const [aspectRatio, setAspectRatio] = useState(originalRatio);
  const [editedJsonObj, setEditedJsonObj] = useState<Record<string, string>>(() =>
    toJsonMap(result?.json_prompt),
  );
  const [editedShortPrompt, setEditedShortPrompt] = useState(() => result?.short_prompt ?? '');
  const [editingJson, setEditingJson] = useState(false);

  useEffect(() => {
    setAspectRatio(
      record.physics?.aspectRatio?.trim() || result?.json_prompt?.aspect_ratio?.trim() || '',
    );
    setEditedJsonObj(toJsonMap(result?.json_prompt));
    setEditedShortPrompt(result?.short_prompt ?? '');
    setEditingJson(false);
  }, [record.id, record.physics?.aspectRatio, result]);

  const editedJsonText = JSON.stringify(editedJsonObj, null, 2);

  const updateAspectRatio = (nextRaw: string) => {
    const prev = aspectRatio.trim();
    setAspectRatio(nextRaw);
    const next = nextRaw.trim();
    if (!next) return;
    setEditedJsonObj((prevObj) => ({ ...prevObj, aspect_ratio: next }));
    setEditedShortPrompt((s) => applyAspectRatioToShort(s, next, prev));
  };

  useEffect(() => {
    if (refMode === 'asset' && selectedAssetId && !assets.some((a) => a.id === selectedAssetId)) {
      setRefMode('none');
      setSelectedAssetId('');
    }
  }, [assets, refMode, selectedAssetId]);

  if (!result) return null;

  const selectedAsset = assets.find((a) => a.id === selectedAssetId);
  const effectiveRef =
    refMode === 'source'
      ? sourceDataUrl ?? undefined
      : refMode === 'asset'
        ? selectedAsset?.dataUrl
        : refMode === 'upload'
          ? uploadedRef || undefined
          : undefined;

  const refSummary =
    refMode === 'source' && sourceDataUrl
      ? '垫图: 当前原图'
      : refMode === 'asset' && selectedAsset
        ? `垫图: ${selectedAsset.name}`
        : refMode === 'upload' && uploadedRef
          ? '垫图: 本地上传'
          : '无垫图';

  const onRefFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (dataUrl) {
        setUploadedRef(dataUrl);
        setRefMode('upload');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const genBaseProps = {
    onSaveAsset,
    onNotify: onCopied,
    referenceDataUrl: effectiveRef,
    referenceSummary: refSummary,
  };
  // Capture record.id now: the generation may finish after the user switches records.
  const recordId = record.id;
  const makeOnGenerated =
    (source: GeneratedImageSource) =>
    (img: { dataUrl: string; prompt: string; referenceSummary: string }) =>
      onGeneratedImage(recordId, { ...img, source });
  const generatedImages = record.generatedImages ?? [];

  const buildMarkdown = () =>
    exportToObsidianMarkdown(record, {
      jsonText: editedJsonText,
      shortPrompt: editedShortPrompt,
    });

  const handleExportMd = async () => {
    const md = buildMarkdown();
    const ok = await copyText(md);
    onCopied(ok ? '✓ 已复制 Obsidian Markdown' : '✗ 复制失败');
  };

  const handleDownloadMd = () => {
    const md = buildMarkdown();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chuancaibi-${record.id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    onCopied('✓ 已下载 Markdown');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="vrc-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* Category, tags & top actions */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 border border-ink bg-panel px-2 py-1.5 text-2xs text-mute">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="font-bold tracking-widest text-paper">
              {result.category || '未知品类'}
            </span>
            {(result.tags ?? []).map((t) => (
              <span key={t} className="border border-ink px-1 py-px text-dim">
                {t}
              </span>
            ))}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {imageGenEnabled && sourceDataUrl && onExtractCharacter && (
              <button
                type="button"
                disabled={Boolean(extractingMode)}
                onClick={onExtractCharacter}
                className="border border-ink bg-obsidian px-1.5 py-0.5 text-2xs font-bold tracking-wider text-paper hover:border-paper disabled:opacity-50"
              >
                {extractingMode === 'standard' ? '提取中…' : '提取人物资产图'}
              </button>
            )}
            {imageGenEnabled && sourceDataUrl && onExtractAnimeToReal && (
              <button
                type="button"
                disabled={Boolean(extractingMode)}
                onClick={onExtractAnimeToReal}
                className="border border-ink bg-obsidian px-1.5 py-0.5 text-2xs font-bold tracking-wider text-paper hover:border-paper disabled:opacity-50"
              >
                {extractingMode === 'anime2real' ? '转真人中…' : '漫转真人资产图'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleExportMd()}
              className="border border-ink bg-obsidian px-1.5 py-0.5 text-2xs tracking-wider text-mute hover:border-paper hover:text-paper"
            >
              复制 .MD
            </button>
            <button
              type="button"
              onClick={handleDownloadMd}
              className="border border-ink bg-obsidian px-1.5 py-0.5 text-2xs tracking-wider text-mute hover:border-paper hover:text-paper"
            >
              ↓ 下载 .MD
            </button>
          </div>
        </div>

        <ExtractedAssetPreview
          asset={extractedAsset}
          error={extractError}
          onNotify={onCopied}
        />

        {/* Shared Reference Image Bar */}
        {imageGenEnabled && (
          <div className="space-y-2 border border-ink bg-panel/40 p-2">
            <input
              ref={refFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onRefFilePick}
            />
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-2xs text-dim">垫图参考:</span>
              <button
                type="button"
                onClick={() => setRefMode('none')}
                className={`border px-1.5 py-0.5 text-2xs ${
                  refMode === 'none'
                    ? 'border-paper bg-paper text-obsidian'
                    : 'border-ink text-mute hover:border-paper'
                }`}
              >
                无垫图
              </button>
              {sourceDataUrl && (
                <button
                  type="button"
                  onClick={() => setRefMode('source')}
                  className={`border px-1.5 py-0.5 text-2xs ${
                    refMode === 'source'
                      ? 'border-paper bg-paper text-obsidian'
                      : 'border-ink text-mute hover:border-paper'
                  }`}
                >
                  当前原图
                </button>
              )}
              <button
                type="button"
                onClick={() => refFileRef.current?.click()}
                className={`border px-1.5 py-0.5 text-2xs ${
                  refMode === 'upload' && uploadedRef
                    ? 'border-paper bg-paper text-obsidian'
                    : 'border-ink text-mute hover:border-paper'
                }`}
              >
                上传本地垫图
              </button>
              <span className="ml-auto text-2xs text-dim">{refSummary}</span>
            </div>

            <div>
              <input
                ref={assetUploadRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const baseName = file.name.replace(/\.[^.]+$/, '').trim() || '自定义人物资产';
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = String(reader.result ?? '');
                    if (dataUrl) {
                      void onSaveAsset({
                        name: baseName,
                        dataUrl,
                        prompt: '用户上传人物资产',
                      });
                    }
                  };
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }}
              />
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-2xs text-dim">
                  {assets.length > 0
                    ? '从人物资产库挑选垫图（点击选中 / 再次点击取消）：'
                    : '人物资产库暂无资产，可直接上传：'}
                </span>
                <button
                  type="button"
                  onClick={() => assetUploadRef.current?.click()}
                  className="shrink-0 border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                >
                  + 上传人物资产
                </button>
              </div>
              {assets.length > 0 && (
                <div className="vrc-scroll flex gap-1.5 overflow-x-auto pb-1">
                  {assets.map((a) => {
                    const active = refMode === 'asset' && selectedAssetId === a.id;
                    return (
                      <div
                        key={a.id}
                        onClick={() => {
                          if (active) {
                            setRefMode('none');
                            setSelectedAssetId('');
                          } else {
                            setRefMode('asset');
                            setSelectedAssetId(a.id);
                          }
                        }}
                        className={`group relative w-14 shrink-0 cursor-pointer border p-0.5 ${
                          active
                            ? 'border-paper bg-paper/15'
                            : 'border-ink hover:border-mute'
                        }`}
                        title={`${a.name}\n点击设为垫图`}
                      >
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="h-12 w-full object-cover"
                          draggable={false}
                        />
                        {a.starred && (
                          <span
                            className="absolute left-0.5 top-0.5 bg-obsidian/85 px-0.5 text-[9px] leading-none text-[#EAB308]"
                            title="已加星置顶"
                          >
                            ★
                          </span>
                        )}
                        <div className="truncate pt-0.5 text-[9px] text-mute">{a.name}</div>
                        <ConfirmDeleteButton
                          onConfirm={() => {
                            if (active) {
                              setRefMode('none');
                              setSelectedAssetId('');
                            }
                            return onDeleteAsset(a.id);
                          }}
                          title="删除该人物资产"
                          className="absolute right-0.5 top-0.5 hidden bg-obsidian/90 px-1 text-[9px] text-mute hover:text-[#EF4444] group-hover:block"
                          confirmClassName="absolute right-0.5 top-0.5 z-10 bg-obsidian/95 text-[9px]"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Aspect Ratio Control (defaults to original image ratio, editable) */}
        <div className="flex flex-wrap items-center gap-1 border border-ink bg-panel/40 px-2 py-1.5">
          <span className="text-2xs text-dim">画幅比例:</span>
          {originalRatio && (
            <button
              type="button"
              onClick={() => updateAspectRatio(originalRatio)}
              className={`border px-1.5 py-0.5 text-2xs ${
                aspectRatio.trim() === originalRatio
                  ? 'border-paper bg-paper text-obsidian'
                  : 'border-ink text-mute hover:border-paper'
              }`}
            >
              原图 {originalRatio}
            </button>
          )}
          {PRESET_RATIOS.filter((r) => r !== originalRatio).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => updateAspectRatio(r)}
              className={`border px-1.5 py-0.5 text-2xs ${
                aspectRatio.trim() === r
                  ? 'border-paper bg-paper text-obsidian'
                  : 'border-ink text-mute hover:border-paper'
              }`}
            >
              {r}
            </button>
          ))}
          <input
            type="text"
            value={aspectRatio}
            onChange={(e) => updateAspectRatio(e.target.value)}
            placeholder="自定义如 21:9"
            spellCheck={false}
            className="ml-auto w-20 border border-ink bg-obsidian px-1.5 py-0.5 font-mono text-2xs text-paper placeholder:text-dim focus:border-paper focus:outline-none"
          />
        </div>

        {/* Block 1: Structured JSON Prompt */}
        <section className="space-y-1.5 border border-ink bg-obsidian p-2.5">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>① JSON PROMPT · 结构化 JSON 提示词</SectionLabel>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setEditingJson((v) => !v)}
                className={`border px-1.5 py-0.5 text-2xs font-bold tracking-wider transition-colors ${
                  editingJson
                    ? 'border-paper bg-paper text-obsidian'
                    : 'border-ink text-mute hover:border-paper hover:text-paper'
                }`}
              >
                {editingJson ? '完成' : '编辑'}
              </button>
              <CopyButton text={editedJsonText} label="JSON" onCopied={onCopied} />
            </div>
          </div>
          <div className="vrc-scroll max-h-60 overflow-auto border border-ink bg-panel">
            <table className="w-full border-collapse text-[11px] leading-relaxed">
              <tbody>
                {Object.entries(editedJsonObj).map(([k, v]) => (
                  <tr key={k} className="border-b border-ink/60 last:border-b-0">
                    <td className="w-32 shrink-0 select-text border-r border-ink/60 px-2 py-1 align-top font-mono text-2xs text-dim break-all">
                      {k}
                    </td>
                    <td className="px-2 py-1 align-top text-paper">
                      {editingJson ? (
                        <textarea
                          value={v}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEditedJsonObj((prev) => ({ ...prev, [k]: val }));
                            if (k === 'aspect_ratio') setAspectRatio(val);
                          }}
                          spellCheck={false}
                          rows={v.length > 60 ? 3 : 1}
                          className="vrc-scroll w-full resize-y border border-ink bg-obsidian px-1.5 py-0.5 text-[11px] leading-relaxed text-paper focus:border-paper focus:outline-none"
                        />
                      ) : (
                        <span className="whitespace-pre-wrap break-words">{v || '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {imageGenEnabled && (
            <ImageGenPanel
              prompt={editedJsonText}
              promptLabel="按 JSON 提示词生图"
              onGenerated={makeOnGenerated('json')}
              {...genBaseProps}
            />
          )}
        </section>

        {/* Block 2: Lossless Short Prompt */}
        <section className="space-y-2 border border-ink bg-obsidian p-2.5">
          <SectionLabel>② SHORT PROMPT · 无损精简提示词</SectionLabel>

          <PromptBox
            label="精简版生图提示词"
            text={editedShortPrompt}
            onChange={setEditedShortPrompt}
            onCopied={onCopied}
            maxHeight="max-h-48"
          />

          {imageGenEnabled && (
            <ImageGenPanel
              prompt={editedShortPrompt}
              promptLabel="按精简版提示词生图"
              onGenerated={makeOnGenerated('short')}
              {...genBaseProps}
            />
          )}
        </section>

        {/* Block 3: Images generated from this record's prompts (persisted in history) */}
        {generatedImages.length > 0 && (
          <section className="space-y-1.5 border border-ink bg-obsidian p-2.5">
            <SectionLabel>③ GENERATED · 已生成图片（{generatedImages.length}，已存入历史）</SectionLabel>
            <div className="vrc-scroll flex gap-1.5 overflow-x-auto pb-1">
              {generatedImages.map((g) => (
                <div
                  key={g.id}
                  className="group relative w-20 shrink-0 border border-ink p-0.5"
                  title={`${g.source === 'json' ? 'JSON 提示词' : '精简版提示词'} · ${
                    g.referenceSummary ?? ''
                  }\n${new Date(g.createdAt).toLocaleString()}`}
                >
                  <img
                    src={g.dataUrl}
                    alt="Generated"
                    className="h-20 w-full cursor-pointer bg-panel object-cover"
                    draggable={false}
                    onClick={() => {
                      const a = document.createElement('a');
                      a.href = g.dataUrl;
                      a.download = `vrc-gen-${g.createdAt}.${inferExtFromDataUrl(g.dataUrl)}`;
                      a.click();
                      onCopied('✓ 已下载生成图片');
                    }}
                  />
                  <div className="truncate pt-0.5 text-[9px] text-mute">
                    {g.source === 'json' ? 'JSON' : '精简版'} · {new Date(g.createdAt).toLocaleTimeString()}
                  </div>
                  <ConfirmDeleteButton
                    onConfirm={() => onDeleteGeneratedImage(recordId, g.id)}
                    title="从历史中删除该生成图片"
                    className="absolute right-0.5 top-0.5 hidden bg-obsidian/90 px-1 text-[9px] text-mute hover:text-[#EF4444] group-hover:block"
                    confirmClassName="absolute right-0.5 top-0.5 z-10 bg-obsidian/95 text-[9px]"
                  />
                </div>
              ))}
            </div>
            <div className="text-2xs text-dim">点击缩略图下载原图</div>
          </section>
        )}
      </div>
    </div>
  );
}
