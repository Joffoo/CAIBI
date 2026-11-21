import { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterAsset, GeneratedImage, HistoryRecord } from '../utils/types';
import { inferExtFromDataUrl } from '../utils/base64';
import {
  COLOR_FAMILIES,
  classifyColorFamily,
  clearRecords,
  deleteGeneratedImage,
  deleteRecord,
  exportToObsidianMarkdown,
  listRecords,
} from '../services/db';
import { ConfirmDeleteButton } from './ui';

export function HistoryDrawer({
  assets,
  busy = false,
  onSaveAsset,
  onDeleteAsset,
  onToggleStarAsset,
  onRenameAsset,
  onReorderAssets,
  onRecordDeleted,
  onCleared,
  onGeneratedDeleted,
  onSelect,
  onClose,
  onNotify,
}: {
  assets: CharacterAsset[];
  busy?: boolean;
  onSaveAsset?: (asset: { name: string; dataUrl: string; prompt: string }) => Promise<void>;
  onDeleteAsset: (id: string) => Promise<void>;
  onToggleStarAsset?: (id: string) => Promise<void>;
  onRenameAsset?: (id: string, name: string) => Promise<void>;
  onReorderAssets?: (orderedIds: string[]) => Promise<void>;
  onRecordDeleted?: (id: string) => void;
  onCleared?: () => void;
  onGeneratedDeleted?: (recordId: string, updated: HistoryRecord | null) => void;
  onSelect: (r: HistoryRecord) => void;
  onClose: () => void;
  onNotify: (msg: string) => void;
}) {
  const [tab, setTab] = useState<'records' | 'generated' | 'assets'>('records');
  const [records, setRecords] = useState<HistoryRecord[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [family, setFamily] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const clearTimerRef = useRef<number | null>(null);
  const assetFileRef = useRef<HTMLInputElement | null>(null);
  const [dragAssetId, setDragAssetId] = useState<string | null>(null);
  const [dragOverAssetId, setDragOverAssetId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  useEffect(() => {
    let alive = true;
    listRecords(300).then((rs) => {
      if (alive) setRecords(rs);
    });
    return () => {
      alive = false;
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const generated = useMemo(() => {
    const out: { record: HistoryRecord; image: GeneratedImage }[] = [];
    for (const r of records ?? []) {
      for (const image of r.generatedImages ?? []) out.push({ record: r, image });
    }
    out.sort((a, b) => b.image.createdAt - a.image.createdAt);
    return out;
  }, [records]);

  const removeGenerated = async (recordId: string, imageId: string) => {
    const updated = await deleteGeneratedImage(recordId, imageId);
    setRecords((prev) =>
      prev
        ? prev.map((r) =>
            r.id === recordId
              ? {
                  ...r,
                  generatedImages: updated
                    ? updated.generatedImages
                    : (r.generatedImages ?? []).filter((g) => g.id !== imageId),
                }
              : r,
          )
        : prev,
    );
    onGeneratedDeleted?.(recordId, updated);
    onNotify(updated ? '✓ 已删除该生成图片' : '✗ 删除失败（记录不存在）');
  };

  const filtered = useMemo(() => {
    const rs = records ?? [];
    const kw = keyword.trim().toLowerCase();
    return rs.filter((r) => {
      if (family) {
        const dom = r.physics?.palette?.[0]?.hex ?? '#000000';
        if (classifyColorFamily(dom) !== family) return false;
      }
      if (kw) {
        const parts = [
          r.pageTitle,
          r.srcUrl,
          r.result?.category,
          ...(r.result?.tags ?? []),
          r.result?.short_prompt,
          ...Object.values(r.result?.json_prompt ?? {}),
        ];
        const hay = parts.filter(Boolean).join('\n').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [records, keyword, family]);

  const handleSelect = (r: HistoryRecord) => {
    if (busy) {
      onNotify('✗ 当前正在解构或提取中，请稍候再切换记录');
      return;
    }
    onSelect(r);
  };

  const remove = async (id: string) => {
    await deleteRecord(id);
    setRecords((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    onRecordDeleted?.(id);
    onNotify('✓ 已删除该记录');
  };

  const clearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = window.setTimeout(() => {
        setConfirmClear(false);
        clearTimerRef.current = null;
      }, 3000);
      return;
    }
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setConfirmClear(false);
    await clearRecords();
    setRecords([]);
    onCleared?.();
    onNotify('✓ 已清空历史记录');
  };

  const cancelClear = () => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setConfirmClear(false);
  };

  const exportAll = () => {
    if (!records || records.length === 0) return;
    const md = records.map((r) => exportToObsidianMarkdown(r)).join('\n\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chuancaibi-history-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    onNotify(`✓ 已导出 ${records.length} 条记录 (.md)`);
  };

  return (
    <div className="absolute inset-0 z-20 flex">
      <div className="flex-1 bg-obsidian/70" onClick={onClose} />
      <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-ink bg-obsidian">
        <div className="flex items-center justify-between border-b border-ink px-3 py-2">
          <span className="text-2xs font-bold tracking-widest text-paper">
            HISTORY ·{' '}
            {tab === 'records'
              ? records
                ? filtered.length
                : '…'
              : tab === 'generated'
                ? records
                  ? generated.length
                  : '…'
                : assets.length}
          </span>
          <div className="flex items-center gap-1">
            {tab === 'records' && records && records.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={exportAll}
                  className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                  title="导出全部历史记录为 Markdown"
                >
                  导出全部
                </button>
                <button
                  type="button"
                  onClick={() => void clearAll()}
                  className={`border px-1.5 py-0.5 text-2xs ${
                    confirmClear
                      ? 'border-[#EF4444] bg-[#EF4444] font-bold text-paper'
                      : 'border-ink text-mute hover:border-[#EF4444] hover:text-[#EF4444]'
                  }`}
                  title={confirmClear ? '再次点击确认清空全部历史' : '清空全部历史'}
                >
                  {confirmClear ? '确认清空?' : 'CLEAR'}
                </button>
                {confirmClear && (
                  <button
                    type="button"
                    onClick={cancelClear}
                    className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                  >
                    取消
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex border-b border-ink bg-panel">
          <button
            type="button"
            onClick={() => setTab('records')}
            className={`flex-1 border-r border-ink px-2 py-1.5 text-2xs font-bold tracking-wider ${
              tab === 'records' ? 'bg-paper text-obsidian' : 'text-mute hover:text-paper'
            }`}
          >
            解剖记录 ({records ? records.length : '…'})
          </button>
          <button
            type="button"
            onClick={() => {
              cancelClear();
              setTab('generated');
            }}
            className={`flex-1 border-r border-ink px-2 py-1.5 text-2xs font-bold tracking-wider ${
              tab === 'generated' ? 'bg-paper text-obsidian' : 'text-mute hover:text-paper'
            }`}
          >
            生成图片 ({records ? generated.length : '…'})
          </button>
          <button
            type="button"
            onClick={() => {
              cancelClear();
              setTab('assets');
            }}
            className={`flex-1 px-2 py-1.5 text-2xs font-bold tracking-wider ${
              tab === 'assets' ? 'bg-paper text-obsidian' : 'text-mute hover:text-paper'
            }`}
          >
            人物资产 ({assets.length})
          </button>
        </div>

        {tab === 'records' ? (
          <>
            <div className="space-y-1.5 border-b border-ink p-2">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索关键词 / 标签 / 键名 / URL…"
                spellCheck={false}
                className="w-full border border-ink bg-obsidian px-2 py-1 text-[11px] text-paper placeholder:text-dim focus:border-paper focus:outline-none"
              />
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setFamily('')}
                  className={`border px-1.5 py-0.5 text-2xs ${
                    family === '' ? 'border-paper bg-paper text-obsidian' : 'border-ink text-mute hover:border-paper'
                  }`}
                >
                  全部
                </button>
                {COLOR_FAMILIES.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFamily(f === family ? '' : f)}
                    className={`border px-1.5 py-0.5 text-2xs ${
                      family === f ? 'border-paper bg-paper text-obsidian' : 'border-ink text-mute hover:border-paper'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div className="vrc-scroll min-h-0 flex-1 overflow-y-auto">
              {records === null && (
                <div className="p-3 text-2xs text-dim">读取 IndexedDB 中…</div>
              )}
              {records !== null && filtered.length === 0 && (
                <div className="p-3 text-2xs text-dim">无匹配的历史记录</div>
              )}
              {filtered.map((r) => (
                <div
                  key={r.id}
                  onClick={() => handleSelect(r)}
                  className="group flex cursor-pointer items-center gap-2 border-b border-ink/60 px-2 py-2 hover:bg-panel"
                >
                  <img
                    src={r.thumbnail}
                    alt=""
                    className="h-12 w-12 shrink-0 border border-ink object-cover"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-bold text-paper">
                      {r.result?.category ?? '未分类'}
                    </div>
                    <div className="truncate text-2xs text-dim">
                      {new Date(r.createdAt).toLocaleString()}
                    </div>
                    <div className="mt-0.5 flex gap-0.5">
                      {(r.physics?.palette ?? []).slice(0, 5).map((c, i) => (
                        <span
                          key={i}
                          className="h-2 w-4 border border-ink"
                          style={{ backgroundColor: c.hex }}
                          title={`${c.hex} ${c.percentage}%`}
                        />
                      ))}
                      <span className="ml-1 text-2xs text-dim">{r.physics?.aspectRatio}</span>
                      {(r.generatedImages?.length ?? 0) > 0 && (
                        <span className="ml-1 text-2xs text-mute">
                          · {r.generatedImages!.length} 图
                        </span>
                      )}
                    </div>
                  </div>
                  <ConfirmDeleteButton
                    onConfirm={() => remove(r.id)}
                    title="删除记录"
                    className="shrink-0 border border-ink px-1 py-0.5 text-2xs text-dim opacity-0 hover:border-paper hover:text-paper focus:opacity-100 group-hover:opacity-100"
                    confirmClassName="shrink-0"
                  />
                </div>
              ))}
            </div>
          </>
        ) : tab === 'generated' ? (
          <div className="vrc-scroll min-h-0 flex-1 overflow-y-auto">
            {records === null && (
              <div className="p-3 text-2xs text-dim">读取 IndexedDB 中…</div>
            )}
            {records !== null && generated.length === 0 && (
              <div className="p-3 text-2xs text-dim">
                暂无生成图片。在解构结果页使用「按 JSON 提示词生图」或「按精简版提示词生图」后会自动保存在此。
              </div>
            )}
            {generated.map(({ record: r, image }) => (
              <div
                key={image.id}
                onClick={() => handleSelect(r)}
                className="group flex cursor-pointer items-start gap-2 border-b border-ink/60 px-2 py-2 hover:bg-panel"
                title="点击打开所属解剖记录"
              >
                <img
                  src={image.dataUrl}
                  alt="Generated"
                  className="h-14 w-14 shrink-0 border border-ink bg-obsidian object-cover"
                  draggable={false}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate text-[11px] font-bold text-paper">
                    {r.result?.category ?? '未分类'} · {image.source === 'json' ? 'JSON' : '精简版'}
                  </div>
                  <div className="truncate text-2xs text-dim">
                    {new Date(image.createdAt).toLocaleString()}
                    {image.referenceSummary ? ` · ${image.referenceSummary}` : ''}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const a = document.createElement('a');
                        a.href = image.dataUrl;
                        a.download = `vrc-gen-${image.createdAt}.${inferExtFromDataUrl(image.dataUrl)}`;
                        a.click();
                        onNotify('✓ 已下载生成图片');
                      }}
                      className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                    >
                      ↓ 下载图片
                    </button>
                  </div>
                </div>
                <ConfirmDeleteButton
                  onConfirm={() => removeGenerated(r.id, image.id)}
                  title="删除生成图片"
                  className="shrink-0 border border-ink px-1 py-0.5 text-2xs text-dim opacity-0 hover:border-paper hover:text-paper focus:opacity-100 group-hover:opacity-100"
                  confirmClassName="shrink-0"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="vrc-scroll min-h-0 flex-1 overflow-y-auto">
            {onSaveAsset && (
              <div className="flex items-center justify-between gap-2 border-b border-ink px-2 py-2">
                <input
                  ref={assetFileRef}
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
                <button
                  type="button"
                  onClick={() => assetFileRef.current?.click()}
                  className="border border-paper bg-paper px-2 py-1 text-2xs font-bold tracking-wider text-obsidian hover:bg-[#E4E4E7]"
                >
                  + 上传人物资产
                </button>
                <span className="text-2xs text-dim">拖拽卡片可重排 · ★ 置顶</span>
              </div>
            )}
            {assets.length === 0 && (
              <div className="p-3 text-2xs text-dim">
                暂无保存的人物资产图。可点击上方「+ 上传人物资产」，或在解剖确认页/结果页提取。
              </div>
            )}
            {assets.map((asset) => {
              const isDropTarget = dragOverAssetId === asset.id && dragAssetId !== asset.id;
              return (
                <div
                  key={asset.id}
                  draggable={renamingId !== asset.id}
                  onDragStart={(e) => {
                    setDragAssetId(asset.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', asset.id);
                  }}
                  onDragOver={(e) => {
                    if (!dragAssetId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverAssetId !== asset.id) setDragOverAssetId(asset.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverAssetId === asset.id) setDragOverAssetId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const srcId = dragAssetId || e.dataTransfer.getData('text/plain');
                    setDragAssetId(null);
                    setDragOverAssetId(null);
                    if (!srcId || srcId === asset.id || !onReorderAssets) return;
                    const ids = assets.map((a) => a.id);
                    const fromIdx = ids.indexOf(srcId);
                    const toIdx = ids.indexOf(asset.id);
                    if (fromIdx === -1 || toIdx === -1) return;
                    ids.splice(fromIdx, 1);
                    ids.splice(toIdx, 0, srcId);
                    void onReorderAssets(ids);
                  }}
                  onDragEnd={() => {
                    setDragAssetId(null);
                    setDragOverAssetId(null);
                  }}
                  className={`group flex items-start gap-2 border-b px-2 py-2 hover:bg-panel ${
                    isDropTarget ? 'border-t-2 border-t-paper border-b-ink/60 bg-panel/70' : 'border-ink/60'
                  } ${renamingId !== asset.id ? 'cursor-grab active:cursor-grabbing' : ''}`}
                >
                  <img
                    src={asset.dataUrl}
                    alt={asset.name}
                    className="h-14 w-14 shrink-0 border border-ink bg-obsidian object-cover"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    {renamingId === asset.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const next = renameDraft.trim();
                              if (next && onRenameAsset) void onRenameAsset(asset.id, next);
                              setRenamingId(null);
                            } else if (e.key === 'Escape') {
                              setRenamingId(null);
                            }
                          }}
                          autoFocus
                          className="min-w-0 flex-1 border border-paper bg-obsidian px-1.5 py-0.5 text-[11px] text-paper focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = renameDraft.trim();
                            if (next && onRenameAsset) void onRenameAsset(asset.id, next);
                            setRenamingId(null);
                          }}
                          className="border border-paper bg-paper px-1.5 py-0.5 text-2xs font-bold text-obsidian"
                        >
                          保存
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="truncate text-[11px] font-bold text-paper">{asset.name}</span>
                        {onRenameAsset && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingId(asset.id);
                              setRenameDraft(asset.name);
                            }}
                            className="shrink-0 text-2xs text-dim opacity-0 hover:text-paper focus:opacity-100 group-hover:opacity-100"
                            title="重命名"
                          >
                            ✎
                          </button>
                        )}
                      </div>
                    )}
                    <div className="truncate text-2xs text-dim">
                      {new Date(asset.createdAt).toLocaleString()}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          const a = document.createElement('a');
                          a.href = asset.dataUrl;
                          a.download = `vrc-character-${asset.createdAt}.${inferExtFromDataUrl(asset.dataUrl)}`;
                          a.click();
                          onNotify('✓ 已下载人物资产图');
                        }}
                        className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                      >
                        ↓ 下载 PNG
                      </button>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {onToggleStarAsset && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onToggleStarAsset(asset.id);
                        }}
                        className={`border px-1 py-0.5 text-2xs ${
                          asset.starred
                            ? 'border-[#EAB308] text-[#EAB308]'
                            : 'border-ink text-dim opacity-0 hover:border-paper hover:text-paper focus:opacity-100 group-hover:opacity-100'
                        }`}
                        title={asset.starred ? '取消星标' : '加星并置顶'}
                      >
                        {asset.starred ? '★' : '☆'}
                      </button>
                    )}
                    <ConfirmDeleteButton
                      onConfirm={() => onDeleteAsset(asset.id)}
                      title="删除人物资产"
                      className="shrink-0 border border-ink px-1 py-0.5 text-2xs text-dim opacity-0 hover:border-paper hover:text-paper focus:opacity-100 group-hover:opacity-100"
                      confirmClassName="shrink-0"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
