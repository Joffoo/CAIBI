import { useState } from 'react';
import { generateImageViaBackground } from '../services/imageGenerator';
import { inferExtFromDataUrl } from '../utils/base64';

export function ImageGenPanel({
  prompt,
  promptLabel,
  assetNamePrefix = '人物资产',
  onSaveAsset,
  onNotify,
  onGenerated,
  referenceDataUrl,
  referenceSummary,
}: {
  prompt: string;
  promptLabel?: string;
  assetNamePrefix?: string;
  onSaveAsset: (asset: { name: string; dataUrl: string; prompt: string }) => Promise<void>;
  onNotify: (msg: string) => void;
  /** Called once per successful generation so the caller can persist it to history. */
  onGenerated?: (img: { dataUrl: string; prompt: string; referenceSummary: string }) => Promise<void>;
  referenceDataUrl?: string;
  referenceSummary: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultUrl, setResultUrl] = useState('');
  const [savedCurrent, setSavedCurrent] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const runGenerate = async () => {
    if (!prompt.trim()) {
      onNotify('✗ 提示词为空');
      return;
    }
    setLoading(true);
    setError('');
    setSavedCurrent(false);
    let dataUrl = '';
    try {
      dataUrl = await generateImageViaBackground({
        prompt,
        referenceDataUrl,
      });
      setResultUrl(dataUrl);
      setOpen(true);
      onNotify('✓ 生图完成');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setOpen(true);
      onNotify(`✗ ${msg}`);
    } finally {
      setLoading(false);
    }
    if (dataUrl && onGenerated) {
      try {
        await onGenerated({ dataUrl, prompt, referenceSummary });
      } catch (e) {
        console.warn('[VRC] Failed to persist generated image', e);
        onNotify('✗ 生成图片未能写入历史记录');
      }
    }
  };

  const downloadImg = () => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = `vrc-gen-${Date.now()}.${inferExtFromDataUrl(resultUrl)}`;
    a.click();
    onNotify('✓ 已下载生成图片');
  };

  const saveAsAsset = async () => {
    if (!resultUrl || savedCurrent) return;
    await onSaveAsset({
      name: `${assetNamePrefix} ${new Date().toLocaleTimeString()}`,
      dataUrl: resultUrl,
      prompt,
    });
    setSavedCurrent(true);
  };

  return (
    <div className="border border-ink bg-panel/40">
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-2xs text-mute hover:text-paper"
        >
          <span>{open ? '▾' : '▸'}</span>
          <span className="font-bold tracking-wider text-paper">
            {promptLabel ?? '生图'}
          </span>
          <span className="text-dim">({referenceSummary})</span>
        </button>
        <button
          type="button"
          disabled={loading || !prompt.trim()}
          onClick={() => void runGenerate()}
          className="border border-paper bg-paper px-2 py-0.5 text-2xs font-bold tracking-wider text-obsidian hover:bg-[#E4E4E7] disabled:opacity-50"
        >
          {loading ? '生成中…' : '生成图片'}
        </button>
      </div>

      {(open || loading || error || resultUrl) && (
        <div className="space-y-2 border-t border-ink p-2">
          {open && !loading && !error && !resultUrl && (
            <div className="text-2xs text-dim">当前使用上方统一垫图设置：{referenceSummary}</div>
          )}

          {loading && (
            <div className="border border-dashed border-ink py-4 text-center text-2xs tracking-widest text-mute">
              <div className="mx-auto mb-1.5 flex h-2 w-28 border border-ink bg-panel p-px">
                <div className="h-full w-1/2 bg-paper" />
              </div>
              正在调用生图模型…
            </div>
          )}

          {error && (
            <div className="border border-[#EF4444] p-1.5 text-2xs text-[#EF4444]">
              ✗ {error}
            </div>
          )}

          {resultUrl && (
            <div className="space-y-1.5">
              <img
                src={resultUrl}
                alt="Generated"
                onClick={() => setExpanded(!expanded)}
                className={`w-full cursor-pointer border border-ink bg-obsidian object-contain ${
                  expanded ? 'max-h-[420px]' : 'max-h-48'
                }`}
              />
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                >
                  {expanded ? '▾ 收起' : '+ 放大预览'}
                </button>
                <button
                  type="button"
                  onClick={downloadImg}
                  className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
                >
                  ↓ 下载 PNG
                </button>
                <button
                  type="button"
                  disabled={savedCurrent}
                  onClick={() => void saveAsAsset()}
                  className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper disabled:opacity-50"
                >
                  {savedCurrent ? '✓ 已存入资产库' : '存入人物资产库'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
