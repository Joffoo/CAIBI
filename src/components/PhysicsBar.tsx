import type { PhysicsResult } from '../utils/types';
import { copyText } from '../utils/clipboard';

/** Hard Facts Bar — rendered immediately from 0-token local analysis. */
export function PhysicsBar({
  physics,
  onCopied,
}: {
  physics: PhysicsResult;
  onCopied: (msg: string) => void;
}) {
  const { palette, luminance, width, height, aspectRatio, closestStandardRatio } = physics;
  const copy = async (t: string) => {
    const ok = await copyText(t);
    onCopied(ok ? `✓ 已复制 ${t}` : '✗ 复制失败');
  };
  return (
    <div className="border-b border-ink bg-panel px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-mute">
        <span className="font-bold tracking-widest text-paper">HARD FACTS</span>
        <span className="font-mono text-[11px] text-paper">
          {width}×{height}
        </span>
        <button
          type="button"
          onClick={() => copy(aspectRatio)}
          className="border border-ink px-1 py-px font-mono font-bold text-paper hover:border-paper"
          title="点击复制宽高比"
        >
          {aspectRatio}
        </button>
        <button
          type="button"
          onClick={() => copy(closestStandardRatio)}
          className="border border-ink px-1 py-px font-mono text-mute hover:border-paper hover:text-paper"
          title="点击复制推荐 --ar 参数"
        >
          {closestStandardRatio}
        </button>
        <span className="ml-auto font-bold text-paper">{luminance.tag}</span>
      </div>

      <div className="mt-1.5 flex gap-1">
        {palette.map((c, i) => (
          <button
            key={`${c.hex}-${i}`}
            type="button"
            onClick={() => copy(c.hex)}
            title={`${c.hex} · ${c.percentage}% — 点击复制`}
            className="relative h-8 flex-1 cursor-pointer border border-ink transition-colors duration-150 hover:border-paper hover:ring-1 hover:ring-paper"
            style={{ backgroundColor: c.hex }}
          >
            <span className="absolute inset-x-0 bottom-0 truncate bg-obsidian/80 px-0.5 font-mono text-[9px] leading-[11px] text-paper">
              {c.hex} {c.percentage}%
            </span>
          </button>
        ))}
      </div>

      <div className="mt-1.5 flex h-2.5 w-full overflow-hidden border border-ink">
        <div className="bg-[#18181B]" style={{ width: `${luminance.shadows}%` }} />
        <div className="bg-dim" style={{ width: `${luminance.midtones}%` }} />
        <div className="bg-[#E4E4E7]" style={{ width: `${luminance.highlights}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-2xs text-mute">
        <span>SHADOWS {luminance.shadows}%</span>
        <span>MIDTONES {luminance.midtones}%</span>
        <span>HIGHLIGHTS {luminance.highlights}%</span>
        <span>σ {luminance.stdDev}</span>
      </div>
    </div>
  );
}
