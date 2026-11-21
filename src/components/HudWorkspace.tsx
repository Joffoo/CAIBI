import { useEffect, useRef, useState } from 'react';
import type { CharacterAsset, CompiledResult, HistoryRecord } from '../utils/types';
import { copyText } from '../utils/clipboard';
import { exportToObsidianMarkdown } from '../services/db';
import { CopyButton, ExtractedAssetPreview, PromptBox, SectionLabel } from './ui';
import { ImageGenPanel } from './ImageGenPanel';

export function HudWorkspace({
  record,
  onCopied,
  imageGenEnabled,
  sourceDataUrl,
  assets,
  onSaveAsset,
  onDeleteAsset,
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

  const [editedJsonText, setEditedJsonText] = useState(() =>
    result ? JSON.stringify(result.json_prompt, null, 2) : '',
  );
  const [editedShortPrompt, setEditedShortPrompt] = useState(() => result?.short_prompt ?? '');
  const [editingJson, setEditingJson] = useState(false);

  useEffect(() => {
    setEditedJsonText(result ? JSON.stringify(result.json_prompt, null, 2) : '');
    setEditedShortPrompt(result?.short_prompt ?? '');
    setEditingJson(false);
  }, [record.id, result]);

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

            {assets.length > 0 && (
              <div>
                <div className="mb-1 text-2xs text-dim">
                  从人物资产库挑选垫图（点击选中 / 再次点击取消）：
                </div>
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
                        <div className="truncate pt-0.5 text-[9px] text-mute">{a.name}</div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (active) {
                              setRefMode('none');
                              setSelectedAssetId('');
                            }
                            void onDeleteAsset(a.id);
                          }}
                          className="absolute right-0.5 top-0.5 hidden bg-obsidian/90 px-1 text-[9px] text-mute hover:text-[#EF4444] group-hover:block"
                          title="删除该人物资产"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

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
          {editingJson ? (
            <textarea
              value={editedJsonText}
              onChange={(e) => setEditedJsonText(e.target.value)}
              spellCheck={false}
              rows={8}
              className="vrc-scroll max-h-52 w-full resize-y border border-ink bg-panel p-2 font-mono text-[11px] leading-relaxed text-paper focus:border-paper focus:outline-none"
            />
          ) : (
            <pre className="vrc-scroll max-h-52 overflow-auto border border-ink bg-panel p-2 font-mono text-[11px] leading-relaxed text-paper">
              {editedJsonText}
            </pre>
          )}
          {imageGenEnabled && (
            <ImageGenPanel
              prompt={editedJsonText}
              promptLabel="按 JSON 提示词生图"
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
              {...genBaseProps}
            />
          )}
        </section>
      </div>
    </div>
  );
}
