import { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterAsset, HistoryRecord } from '../utils/types';
import { inferExtFromDataUrl } from '../utils/base64';
import {
  COLOR_FAMILIES,
  classifyColorFamily,
  clearRecords,
  deleteRecord,
  exportToObsidianMarkdown,
  listRecords,
} from '../services/db';

export function HistoryDrawer({
  assets,
  onDeleteAsset,
  onSelect,
  onClose,
  onNotify,
}: {
  assets: CharacterAsset[];
  onDeleteAsset: (id: string) => Promise<void>;
  onSelect: (r: HistoryRecord) => void;
  onClose: () => void;
  onNotify: (msg: string) => void;
}) {
  const [tab, setTab] = useState<'records' | 'assets'>('records');
  const [records, setRecords] = useState<HistoryRecord[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [family, setFamily] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const clearTimerRef = useRef<number | null>(null);

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

  const remove = async (id: string) => {
    await deleteRecord(id);
    setRecords((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
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
            HISTORY · {tab === 'records' ? (records ? filtered.length : '…') : assets.length}
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
                  onClick={() => onSelect(r)}
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
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(r.id);
                    }}
                    className="shrink-0 border border-ink px-1 py-0.5 text-2xs text-dim opacity-0 hover:border-paper hover:text-paper focus:opacity-100 group-hover:opacity-100"
                    title="删除"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="vrc-scroll min-h-0 flex-1 overflow-y-auto">
            {assets.length === 0 && (
              <div className="p-3 text-2xs text-dim">
                暂无保存的人物资产图。可在解剖确认页或结果页点击「提取人物资产图」或「漫转真人资产图」。
              </div>
            )}
            {assets.map((asset) => (
              <div
                key={asset.id}
                className="group flex items-start gap-2 border-b border-ink/60 px-2 py-2 hover:bg-panel"
              >
                <img
                  src={asset.dataUrl}
                  alt={asset.name}
                  className="h-14 w-14 shrink-0 border border-ink bg-obsidian object-cover"
                  draggable={false}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate text-[11px] font-bold text-paper">{asset.name}</div>
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
                <button
                  type="button"
                  onClick={() => void onDeleteAsset(asset.id)}
                  className="shrink-0 border border-ink px-1 py-0.5 text-2xs text-dim opacity-0 hover:border-paper hover:text-paper focus:opacity-100 group-hover:opacity-100"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
