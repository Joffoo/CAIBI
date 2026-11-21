import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CharacterAsset,
  ExtensionSettings,
  HistoryRecord,
} from '../utils/types';
import { DEFAULT_SETTINGS } from '../utils/types';
import { analyzeImageAndThumbnail } from '../utils/imagePhysics';
import {
  compileViaPort,
  fetchImagePayload,
  normalizeCompiledResult,
  type CompileProgress,
} from '../services/visionCompiler';
import {
  ANIME_TO_REAL_CHARACTER_SHEET_PROMPT,
  CHARACTER_SHEET_EXTRACT_PROMPT,
  generateImageViaBackground,
  isImageGenConfigured,
} from '../services/imageGenerator';
import { addAsset, addRecord, deleteAsset, listAssets, uuid } from '../services/db';
import { loadSettings, watchSettings } from '../services/settings';
import { PhysicsBar } from './PhysicsBar';
import { HudWorkspace } from './HudWorkspace';
import { HistoryDrawer } from './HistoryDrawer';
import { SettingsModal } from './SettingsModal';
import { ExtractedAssetPreview } from './ui';

type Status = 'idle' | 'fetching' | 'physics' | 'confirm' | 'compiling' | 'ready' | 'error';

interface OpenDetail {
  srcUrl?: string;
  fromAction?: boolean;
  x?: number;
  y?: number;
}

const HUD_WIDTH = 480;
const HUD_HEIGHT = 640;

export function HudApp() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 80, y: 80 });
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [record, setRecord] = useState<HistoryRecord | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [progress, setProgress] = useState<CompileProgress>({ phase: 'connecting', chars: 0 });
  const [elapsedSec, setElapsedSec] = useState(0);
  const [assets, setAssets] = useState<CharacterAsset[]>([]);
  const [extractingMode, setExtractingMode] = useState<'standard' | 'anime2real' | null>(null);
  const [extractedAsset, setExtractedAsset] = useState<CharacterAsset | null>(null);
  const [extractError, setExtractError] = useState('');
  const [sourceDataUrl, setSourceDataUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const dataUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const elapsedTimer = useRef<number | null>(null);
  const cancelCompileRef = useRef<(() => void) | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const jobIdRef = useRef(0);

  const stopTimersAndStream = useCallback(() => {
    if (elapsedTimer.current) {
      clearInterval(elapsedTimer.current);
      elapsedTimer.current = null;
    }
    if (cancelCompileRef.current) {
      const fn = cancelCompileRef.current;
      cancelCompileRef.current = null;
      fn();
    }
  }, []);

  useEffect(() => {
    loadSettings().then(setSettings);
    listAssets(100).then(setAssets);
    const unwatch = watchSettings(setSettings);
    return () => {
      unwatch();
      if (toastTimer.current) clearTimeout(toastTimer.current);
      dragCleanupRef.current?.();
      stopTimersAndStream();
    };
  }, [stopTimersAndStream]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 1800);
  }, []);

  const clampPos = useCallback((x: number, y: number) => {
    const w = Math.min(HUD_WIDTH, window.innerWidth - 16);
    const maxX = Math.max(8, window.innerWidth - w - 8);
    const maxY = Math.max(8, window.innerHeight - 120);
    return {
      x: Math.max(8, Math.min(x, maxX)),
      y: Math.max(8, Math.min(y, maxY)),
    };
  }, []);

  const handleSaveAsset = useCallback(
    async ({ name, dataUrl, prompt }: { name: string; dataUrl: string; prompt: string }) => {
      const asset: CharacterAsset = {
        id: uuid(),
        createdAt: Date.now(),
        name,
        dataUrl,
        prompt,
        sourceUrl: record?.srcUrl,
      };
      await addAsset(asset);
      setAssets((prev) => [asset, ...prev.filter((a) => a.id !== asset.id)]);
      notify('✓ 已存入全局人物资产库');
    },
    [notify, record?.srcUrl],
  );

  const handleDeleteAsset = useCallback(
    async (id: string) => {
      await deleteAsset(id);
      setAssets((prev) => prev.filter((a) => a.id !== id));
      setExtractedAsset((prev) => (prev?.id === id ? null : prev));
      notify('✓ 已删除人物资产');
    },
    [notify],
  );

  const setSourceData = useCallback((url: string | null) => {
    dataUrlRef.current = url;
    setSourceDataUrl(url);
  }, []);

  const ensureRasterDataUrl = useCallback(async (srcUrl: string, jobId: number): Promise<string> => {
    if (dataUrlRef.current) return dataUrlRef.current;
    const fetched = await fetchImagePayload(srcUrl);
    if (jobIdRef.current !== jobId) throw new Error('已取消');
    let rasterDataUrl = fetched.dataUrl;
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(fetched.dataUrl)) {
      const converted = await analyzeImageAndThumbnail(
        fetched.dataUrl,
        fetched.width,
        fetched.height,
        256,
      );
      if (jobIdRef.current !== jobId) throw new Error('已取消');
      rasterDataUrl = converted.rasterDataUrl;
    }
    setSourceData(rasterDataUrl);
    return rasterDataUrl;
  }, [setSourceData]);

  const runPhysicsConfirm = useCallback(
    async (
      rawDataUrl: string,
      srcUrl: string,
      jobId: number,
      width?: number,
      height?: number,
    ) => {
      setStatus('physics');
      const { physics, thumbnail, rasterDataUrl } = await analyzeImageAndThumbnail(
        rawDataUrl,
        width,
        height,
        256,
      );
      if (jobIdRef.current !== jobId) return;

      setSourceData(rasterDataUrl);
      const baseRec: HistoryRecord = {
        id: uuid(),
        createdAt: Date.now(),
        srcUrl,
        pageUrl: location.href,
        pageTitle: document.title,
        thumbnail,
        physics,
        result: null,
      };
      setRecord(baseRec);
      // Stop at confirmation view: never invoke LLM until user explicitly clicks
      setStatus('confirm');
    },
    [setSourceData],
  );

  const analyzeUrl = useCallback(
    async (srcUrl: string, jobId: number) => {
      setStatus('fetching');
      try {
        const fetched = await fetchImagePayload(srcUrl);
        if (jobIdRef.current !== jobId) return;
        await runPhysicsConfirm(fetched.dataUrl, srcUrl, jobId, fetched.width, fetched.height);
      } catch (e) {
        if (jobIdRef.current !== jobId) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [runPhysicsConfirm],
  );

  const handleAnalyzeUrlInput = useCallback(() => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      notify('请输入图片 URL');
      return;
    }
    const jobId = ++jobIdRef.current;
    stopTimersAndStream();
    setRecord(null);
    setError('');
    setExtractedAsset(null);
    setExtractError('');
    setExtractingMode(null);
    setSourceData(null);
    void analyzeUrl(trimmed, jobId);
  }, [analyzeUrl, notify, setSourceData, stopTimersAndStream, urlInput]);

  const analyzeLocalFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        notify('请拖入或选择图片文件');
        return;
      }
      const jobId = ++jobIdRef.current;
      stopTimersAndStream();
      setRecord(null);
      setError('');
      setExtractedAsset(null);
      setExtractError('');
      setExtractingMode(null);
      setSourceData(null);
      setStatus('physics');

      const reader = new FileReader();
      reader.onload = () => {
        if (jobIdRef.current !== jobId) return;
        const result = typeof reader.result === 'string' ? reader.result : '';
        if (!result) {
          setStatus('error');
          setError('无法读取本地图片文件');
          return;
        }
        runPhysicsConfirm(result, '', jobId).catch((err) => {
          if (jobIdRef.current !== jobId) return;
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        });
      };
      reader.onerror = () => {
        if (jobIdRef.current !== jobId) return;
        setStatus('error');
        setError('读取本地图片失败');
      };
      reader.readAsDataURL(file);
    },
    [notify, runPhysicsConfirm, setSourceData, stopTimersAndStream],
  );

  const handleLocalFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      analyzeLocalFile(file);
    },
    [analyzeLocalFile],
  );

  const openHud = useCallback(
    async (d: OpenDetail) => {
      const jobId = ++jobIdRef.current;
      stopTimersAndStream();
      setVisible(true);
      setHistoryOpen(false);
      setSettingsOpen(false);
      const w = Math.min(HUD_WIDTH, window.innerWidth - 16);
      setPos(clampPos((d.x ?? window.innerWidth / 2 - w / 2) + 16, (d.y ?? 80) + 16));
      setRecord(null);
      setError('');
      setExtractedAsset(null);
      setExtractError('');
      setExtractingMode(null);
      setSourceData(null);

      void listAssets(100).then((list) => {
        if (jobIdRef.current === jobId) setAssets(list);
      });

      const srcUrl = d.srcUrl;
      if (!srcUrl) {
        if (d.fromAction) {
          setStatus('idle');
        } else {
          setStatus('error');
          setError('未捕获到图像 URL — 请将光标悬停在图片上再按 Alt+右键 / Alt+Q');
        }
        return;
      }
      await analyzeUrl(srcUrl, jobId);
    },
    [analyzeUrl, clampPos, setSourceData, stopTimersAndStream],
  );

  const startCompile = useCallback(async () => {
    if (!record) return;
    const jobId = ++jobIdRef.current;
    stopTimersAndStream();
    setError('');
    setProgress({ phase: 'connecting', chars: 0 });
    setElapsedSec(0);

    try {
      let rasterDataUrl = dataUrlRef.current;
      if (!rasterDataUrl) {
        if (!record.srcUrl) {
          setStatus('error');
          setError('缺少图像来源 URL，无法编译');
          return;
        }
        setStatus('fetching');
        rasterDataUrl = await ensureRasterDataUrl(record.srcUrl, jobId);
        if (jobIdRef.current !== jobId) return;
      }

      setStatus('compiling');
      const startedAt = Date.now();
      elapsedTimer.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);

      const { promise, cancel } = compileViaPort(rasterDataUrl, record.physics, (p) => {
        if (jobIdRef.current === jobId) setProgress(p);
      });
      cancelCompileRef.current = cancel;

      const result = await promise;
      if (jobIdRef.current !== jobId) return;

      stopTimersAndStream();
      const rec: HistoryRecord = { ...record, result };
      setRecord(rec);
      await addRecord(rec);
      if (jobIdRef.current !== jobId) return;
      setStatus('ready');
    } catch (e) {
      if (jobIdRef.current !== jobId) return;
      stopTimersAndStream();
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ensureRasterDataUrl, record, stopTimersAndStream]);

  const cancelCompile = useCallback(() => {
    jobIdRef.current += 1;
    stopTimersAndStream();
    setStatus(record ? 'confirm' : 'idle');
    notify('已取消生成，物理事实已保留');
  }, [notify, record, stopTimersAndStream]);

  const extractCharacterSheet = useCallback(
    async (mode: 'standard' | 'anime2real' = 'standard') => {
      if (!record) return;
      if (!isImageGenConfigured(settings)) {
        notify('请先在设置中配置可选生图模型');
        setSettingsOpen(true);
        return;
      }
      const isAnimeToReal = mode === 'anime2real';
      const prompt = isAnimeToReal
        ? ANIME_TO_REAL_CHARACTER_SHEET_PROMPT
        : CHARACTER_SHEET_EXTRACT_PROMPT;
      const assetPrefix = isAnimeToReal ? '漫转真人' : '50/50 角色';

      const jobId = jobIdRef.current;
      setExtractingMode(mode);
      setExtractError('');
      try {
        const refDataUrl = await ensureRasterDataUrl(record.srcUrl, jobId);
        if (jobIdRef.current !== jobId) return;
        const dataUrl = await generateImageViaBackground({
          prompt,
          referenceDataUrl: refDataUrl,
        });
        if (jobIdRef.current !== jobId) return;
        const asset: CharacterAsset = {
          id: uuid(),
          createdAt: Date.now(),
          name: `${assetPrefix} ${new Date().toLocaleTimeString()}`,
          dataUrl,
          prompt,
          sourceUrl: record.srcUrl,
        };
        await addAsset(asset);
        if (jobIdRef.current !== jobId) return;
        setAssets((prev) => [asset, ...prev]);
        setExtractedAsset(asset);
        notify(isAnimeToReal ? '✓ 已生成真人资产图并存入资产库' : '✓ 已提取人物资产图并存入资产库');
      } catch (e) {
        if (jobIdRef.current !== jobId) return;
        const msg = e instanceof Error ? e.message : String(e);
        setExtractError(msg);
        notify(`✗ ${msg}`);
      } finally {
        setExtractingMode(null);
      }
    },
    [ensureRasterDataUrl, notify, record, settings],
  );

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenDetail>).detail ?? {};
      void openHud(detail);
    };
    window.addEventListener('vrc:open', onOpen);
    return () => window.removeEventListener('vrc:open', onOpen);
  }, [openHud]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (settingsOpen) {
        setSettingsOpen(false);
      } else if (historyOpen) {
        setHistoryOpen(false);
      } else {
        jobIdRef.current += 1;
        stopTimersAndStream();
        setVisible(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [visible, settingsOpen, historyOpen, stopTimersAndStream]);

  useEffect(() => {
    if (!visible) return;
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible, clampPos]);

  const onHeaderDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement | null)?.closest('button')) return;
    dragCleanupRef.current?.();
    const start = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y };
    const move = (ev: PointerEvent) =>
      setPos(clampPos(start.x + ev.clientX - start.mx, start.y + ev.clientY - start.my));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  if (!visible) return null;

  const busy = status === 'fetching' || status === 'physics' || status === 'compiling';
  const imageGenEnabled = isImageGenConfigured(settings);
  const stagePrefix =
    progress.stage === 'converge' ? '[2/2 精简压缩] ' : progress.stage === 'diverge' ? '[1/2 视觉解构] ' : '';
  const compileLabel =
    progress.phase === 'thinking'
      ? `${stagePrefix}THINKING · 深度思考中…`
      : progress.phase === 'streaming'
        ? `${stagePrefix}COMPILING · 流式输出中 (${progress.chars} chars)`
        : `${stagePrefix}CONNECTING · 正在连接 Vision LLM…`;
  const statusLabel =
    status === 'fetching'
      ? 'FETCHING · CORS 代理抓图…'
      : status === 'physics'
        ? 'PHYSICS · 0-token 本地分析…'
        : status === 'compiling'
          ? compileLabel
          : '';

  const hudWidth = Math.min(HUD_WIDTH, window.innerWidth - 16);

  return (
    <div
      className="fixed z-[2147483647] text-paper"
      style={{ left: pos.x, top: pos.y, width: hudWidth }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) analyzeLocalFile(file);
      }}
    >
      <div
        className={`flex max-h-[640px] min-h-[120px] flex-col border bg-obsidian shadow-hud ${
          dragOver ? 'border-paper' : 'border-line'
        }`}
        style={{ maxHeight: Math.min(HUD_HEIGHT, window.innerHeight - 24) }}
      >
        {/* Draggable brutalist header */}
        <header
          onPointerDown={onHeaderDown}
          className="flex cursor-move select-none items-center gap-2 border-b border-ink bg-panel px-2.5 py-1.5"
        >
          <span className="text-2xs font-bold tracking-widest text-paper">
            传彩笔 CAIBI
          </span>
          <span
            className={`h-2 w-2 ${
              status === 'ready'
                ? 'bg-[#22C55E]'
                : status === 'error'
                  ? 'bg-[#EF4444]'
                  : status === 'confirm' || status === 'idle'
                    ? 'bg-paper'
                    : 'bg-[#EAB308]'
            }`}
          />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setHistoryOpen(!historyOpen);
                setSettingsOpen(false);
              }}
              className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
              title="历史记录"
            >
              历史
            </button>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(!settingsOpen);
                setHistoryOpen(false);
              }}
              className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
              title="设置"
            >
              设置
            </button>
            <button
              type="button"
              onClick={() => {
                jobIdRef.current += 1;
                stopTimersAndStream();
                setVisible(false);
              }}
              className="border border-ink px-1.5 py-0.5 text-2xs text-mute hover:border-paper hover:text-paper"
              title="关闭"
            >
              ✕
            </button>
          </div>
        </header>

        {record && <PhysicsBar physics={record.physics} onCopied={notify} />}

        {status === 'idle' && !record && (
          <div className="flex-1 space-y-3 p-4">
            <div className="border border-ink bg-panel p-3 text-[11px] leading-relaxed text-mute">
              <div className="mb-1 text-2xs font-bold tracking-widest text-paper">
                READY · 传彩笔 CAIBI 视觉逆向工作台
              </div>
              <p>悬停任意网页图片并按 Alt+右键 或 Alt+Q 即可触发 0-token 物理分析，也可以直接上传本地图片或输入图片 URL。</p>
              <div className="mt-2 border-t border-ink pt-1.5 text-2xs text-dim">
                {settings.apiKey.trim()
                  ? `视觉模型：OpenAI · ${settings.model || '未填写'}`
                  : '视觉模型：未配置 Key（仍可免费使用 0-token 本地物理分析）'}
              </div>
            </div>

            <div className="space-y-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleLocalFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full border border-paper bg-paper px-3 py-1.5 text-2xs font-bold tracking-wider text-obsidian hover:bg-[#E4E4E7]"
              >
                上传本地图片分析
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAnalyzeUrlInput();
                }}
                className="flex gap-1"
              >
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://..."
                  spellCheck={false}
                  className="min-w-0 flex-1 border border-ink bg-obsidian px-2 py-1 text-[11px] text-paper placeholder:text-dim focus:border-paper focus:outline-none"
                />
                <button
                  type="submit"
                  className="shrink-0 border border-ink bg-panel px-2.5 py-1 text-2xs font-bold tracking-wider text-paper hover:border-paper"
                >
                  分析
                </button>
              </form>
            </div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="flex-1 border border-ink px-2 py-1.5 text-2xs font-bold tracking-wider text-paper hover:border-paper"
              >
                打开历史记录
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex-1 border border-ink px-2 py-1.5 text-2xs font-bold tracking-wider text-paper hover:border-paper"
              >
                配置 BYOK 设置
              </button>
            </div>
          </div>
        )}

        {status === 'confirm' && record && (
          <div className="vrc-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
            <div className="flex items-center gap-2.5 border border-ink bg-panel p-2">
              <img
                src={record.thumbnail}
                alt=""
                className="h-16 w-16 shrink-0 border border-ink object-cover"
                draggable={false}
              />
              <div className="min-w-0 flex-1 space-y-0.5 text-2xs">
                <div className="font-bold tracking-wider text-paper">
                  0-TOKEN 物理事实已就绪 · 请选择下一步操作
                </div>
                <div className="truncate text-mute">
                  视觉模型：OpenAI · {settings.model || '未填写'}
                  {!settings.apiKey ? '（未填 Key）' : ''}
                </div>
                <div className="truncate text-dim">
                  生图模型：
                  {imageGenEnabled
                    ? `OpenAI · ${settings.imageGenModel}`
                    : '未启用（可在设置选配）'}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => void startCompile()}
                className="w-full border border-paper bg-paper px-3 py-2 text-left text-2xs font-bold tracking-wider text-obsidian hover:bg-[#E4E4E7]"
              >
                开始 Vision LLM 解构（JSON + 精简版提示词）
              </button>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={extractingMode !== null}
                  onClick={() => void extractCharacterSheet('standard')}
                  className="flex-1 border border-ink bg-panel px-2 py-1.5 text-2xs font-bold tracking-wider text-paper hover:border-paper disabled:opacity-50"
                >
                  {extractingMode === 'standard'
                    ? '提取人物资产图中…'
                    : imageGenEnabled
                      ? '提取人物资产图（50/50）'
                      : '提取人物资产图（需配生图）'}
                </button>
                <button
                  type="button"
                  disabled={extractingMode !== null}
                  onClick={() => void extractCharacterSheet('anime2real')}
                  className="flex-1 border border-ink bg-panel px-2 py-1.5 text-2xs font-bold tracking-wider text-paper hover:border-paper disabled:opacity-50"
                >
                  {extractingMode === 'anime2real'
                    ? '漫转真人资产图中…'
                    : imageGenEnabled
                      ? '漫转真人资产图（50/50）'
                      : '漫转真人资产图（需配生图）'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="shrink-0 border border-ink px-2.5 py-1.5 text-2xs text-mute hover:border-paper hover:text-paper"
                >
                  切换模型
                </button>
              </div>
            </div>

            <ExtractedAssetPreview
              asset={extractedAsset}
              error={extractError}
              onNotify={notify}
            />
          </div>
        )}

        {busy && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6">
            <div className="flex h-2.5 w-44 border border-ink bg-panel p-0.5">
              <div className="h-full w-1/2 bg-paper" />
            </div>
            <div className="text-2xs font-bold tracking-widest text-paper">{statusLabel}</div>
            {status === 'compiling' && (
              <>
                <div className="text-center text-2xs text-dim">
                  已耗时 {elapsedSec}s · 首包上限 300s / 包间空闲上限 120s
                  {progress.phase === 'connecting' && progress.probe === 'ok' && (
                    <span className="text-[#10B981]"> · 链路连通正常</span>
                  )}
                  {progress.phase === 'connecting' && progress.probe === 'warn' && (
                    <span className="text-[#F59E0B]"> · 链路探测无响应（可取消重试）</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={cancelCompile}
                  className="mt-1 border border-ink px-3 py-1 text-2xs text-mute hover:border-paper hover:text-paper"
                >
                  ✕ 取消生成
                </button>
              </>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="flex-1 space-y-2 p-3">
            <div className="border border-[#EF4444] p-2">
              <div className="text-2xs font-bold tracking-widest text-[#EF4444]">
                ✗ {record ? 'LLM 编译失败（物理事实已保留）' : '发生错误'}
              </div>
              <p className="mt-1 break-words text-[11px] leading-relaxed text-mute">
                {error}
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              {record && !record.result && (
                <>
                  <button
                    type="button"
                    onClick={() => void startCompile()}
                    className="border border-paper bg-paper px-2 py-1 text-2xs font-bold tracking-widest text-obsidian hover:bg-[#E4E4E7]"
                  >
                    ↻ 重试编译
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setStatus('confirm');
                    }}
                    className="border border-ink px-2 py-1 text-2xs text-mute hover:border-paper hover:text-paper"
                  >
                    ← 返回待确认
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="border border-ink px-2 py-1 text-2xs text-mute hover:border-paper hover:text-paper"
              >
                检查 BYOK 设置
              </button>
            </div>
          </div>
        )}

        {record?.result && status === 'ready' && (
          <HudWorkspace
            record={record}
            onCopied={notify}
            imageGenEnabled={imageGenEnabled}
            sourceDataUrl={sourceDataUrl}
            assets={assets}
            onSaveAsset={handleSaveAsset}
            onDeleteAsset={handleDeleteAsset}
            onExtractCharacter={() => void extractCharacterSheet('standard')}
            onExtractAnimeToReal={() => void extractCharacterSheet('anime2real')}
            extractingMode={extractingMode}
            extractedAsset={extractedAsset}
            extractError={extractError}
          />
        )}

        {historyOpen && (
          <HistoryDrawer
            assets={assets}
            onDeleteAsset={handleDeleteAsset}
            onSelect={(r) => {
              const jobId = ++jobIdRef.current;
              stopTimersAndStream();
              const normalizedRecord: HistoryRecord = r.result
                ? { ...r, result: normalizeCompiledResult(r.result, r.physics) }
                : r;
              setRecord(normalizedRecord);
              setStatus(normalizedRecord.result ? 'ready' : 'error');
              setError(normalizedRecord.result ? '' : '该记录编译失败，无 LLM 结果');
              setExtractedAsset(null);
              setExtractError('');
              setExtractingMode(null);
              setSourceData(r.thumbnail || null);
              setHistoryOpen(false);
              if (r.srcUrl) {
                fetchImagePayload(r.srcUrl)
                  .then(async (fetched) => {
                    if (jobIdRef.current !== jobId) return;
                    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(fetched.dataUrl)) {
                      setSourceData(fetched.dataUrl);
                      return;
                    }
                    const analyzed = await analyzeImageAndThumbnail(
                      fetched.dataUrl,
                      fetched.width,
                      fetched.height,
                      256,
                    );
                    if (jobIdRef.current !== jobId) return;
                    setSourceData(analyzed.rasterDataUrl);
                  })
                  .catch(() => {
                    /* fallback to r.thumbnail already set */
                  });
              }
            }}
            onClose={() => setHistoryOpen(false)}
            onNotify={notify}
          />
        )}

        {settingsOpen && (
          <SettingsModal
            settings={settings}
            onClose={() => setSettingsOpen(false)}
            onSaved={setSettings}
            onNotify={notify}
          />
        )}

        {toast && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-50 -translate-x-1/2 border border-paper bg-obsidian px-3 py-1 text-2xs font-bold tracking-wider text-paper shadow-hud">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
