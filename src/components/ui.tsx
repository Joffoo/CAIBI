import { useState, type ReactNode } from 'react';
import type { CharacterAsset } from '../utils/types';
import { copyText } from '../utils/clipboard';
import { inferExtFromDataUrl } from '../utils/base64';

export function CopyButton({
  text,
  label = 'COPY',
  onCopied,
}: {
  text: string;
  label?: string;
  onCopied: (msg: string) => void;
}) {
  return (
    <button
      type="button"
      className="shrink-0 border border-ink px-1.5 py-0.5 text-2xs font-bold tracking-wider text-mute transition-colors hover:border-paper hover:text-paper"
      onClick={async () => {
        const ok = await copyText(text);
        onCopied(ok ? `✓ 已复制 ${label}` : '✗ 复制失败');
      }}
    >
      ⧉ {label}
    </button>
  );
}

export function PromptBox({
  label,
  text,
  onChange,
  onCopied,
  maxHeight = 'max-h-40',
}: {
  label: string;
  text: string;
  onChange?: (val: string) => void;
  onCopied: (msg: string) => void;
  maxHeight?: string;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="border border-ink">
      <div className="flex items-center justify-between gap-2 border-b border-ink bg-panel px-2 py-1">
        <span className="truncate text-2xs font-bold tracking-widest text-mute">{label}</span>
        <div className="flex shrink-0 items-center gap-1">
          {onChange && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className={`border px-1.5 py-0.5 text-2xs font-bold tracking-wider transition-colors ${
                editing
                  ? 'border-paper bg-paper text-obsidian'
                  : 'border-ink text-mute hover:border-paper hover:text-paper'
              }`}
            >
              {editing ? '完成' : '编辑'}
            </button>
          )}
          <CopyButton text={text} label={label.split(' ')[0]} onCopied={onCopied} />
        </div>
      </div>
      {editing && onChange ? (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={5}
          className={`vrc-scroll ${maxHeight} w-full resize-y bg-obsidian px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[#D4D4D8] focus:outline-none`}
        />
      ) : (
        <pre
          className={`vrc-scroll ${maxHeight} overflow-y-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[#D4D4D8]`}
        >
          {text || '—'}
        </pre>
      )}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs font-bold tracking-widest text-mute">{children}</span>
      <span className="h-px flex-1 bg-ink" />
    </div>
  );
}

export function ExtractedAssetPreview({
  asset,
  error,
  onNotify,
}: {
  asset: CharacterAsset | null;
  error: string;
  onNotify: (msg: string) => void;
}) {
  if (!error && !asset) return null;
  return (
    <>
      {error && (
        <div className="border border-[#EF4444] p-2 text-2xs text-[#EF4444]">
          ✗ 人物资产图提取失败：{error}
        </div>
      )}
      {asset && (
        <div className="space-y-1.5 border border-ink bg-panel p-2">
          <div className="flex items-center justify-between gap-2 text-2xs">
            <span className="truncate font-bold text-paper">✓ 人物资产图已存入全局资产库（{asset.name}）</span>
            <button
              type="button"
              onClick={() => {
                const a = document.createElement('a');
                a.href = asset.dataUrl;
                a.download = `vrc-character-${Date.now()}.${inferExtFromDataUrl(asset.dataUrl)}`;
                a.click();
                onNotify('✓ 已下载人物资产图');
              }}
              className="border border-ink px-1.5 py-0.5 text-mute hover:border-paper hover:text-paper"
            >
              ↓ 下载 PNG
            </button>
          </div>
          <img
            src={asset.dataUrl}
            alt={asset.name}
            className="max-h-52 w-full border border-ink bg-obsidian object-contain"
          />
        </div>
      )}
    </>
  );
}
