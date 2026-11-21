import type {
  CharacterAsset,
  ExtensionSettings,
  GeneratedImage,
  HistoryRecord,
  PhysicsResult,
} from '../utils/types';
import { arrayBufferToBase64 } from '../utils/base64';
import { loadSettings } from '../services/settings';
import { callVisionApi, fetchAvailableModels } from '../services/visionCompiler';
import { callImageGenApi } from '../services/imageGenerator';
import {
  dbAddAsset,
  dbAddRecord,
  dbAppendGeneratedImage,
  dbClearRecords,
  dbDeleteAsset,
  dbDeleteGeneratedImage,
  dbDeleteRecord,
  dbListAssets,
  dbListRecords,
  dbReorderAssets,
  dbUpdateAsset,
} from '../services/db';

/**
 * Module B/C support — background service worker.
 * 1) CORS-safe image fetching pipeline (page CORS is bypassed here).
 * 2) BYOK Vision LLM request relay (avoids content-script CORS entirely).
 * 3) Global extension-origin IndexedDB history store + context menu / action triggers.
 */
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'vrc-analyze',
        title: '传彩笔 CAIBI · 视觉逆向解剖',
        contexts: ['image'],
      });
    });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'vrc-analyze' || !tab?.id) return;
    chrome.tabs.sendMessage(tab.id, {
      type: 'OPEN_HUD',
      srcUrl: info.srcUrl,
    }).catch(() => {
      /* content script not present (e.g. chrome:// page) */
    });
  });

  chrome.action.onClicked.addListener((tab) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'OPEN_HUD' }).catch(() => {
      /* ignore */
    });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'FETCH_IMAGE_BASE64') {
      fetchImagePayload(String(msg.url))
        .then((payload) => sendResponse({ ok: true, ...payload }))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errorMessage(e) }),
        );
      return true; // async response
    }

    if (msg?.type === 'FETCH_MODELS') {
      fetchAvailableModels(msg.settings as ExtensionSettings)
        .then((models) => sendResponse({ ok: true, models }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'IMAGE_GENERATE') {
      (async () => {
        const settings = await loadSettings();
        const dataUrl = await callImageGenApi(
          {
            prompt: String(msg.prompt ?? ''),
            referenceDataUrl:
              typeof msg.referenceDataUrl === 'string' ? msg.referenceDataUrl : undefined,
          },
          settings,
        );
        return { ok: true, dataUrl };
      })()
        .then(sendResponse)
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'DB_ADD') {
      dbAddRecord(msg.record as HistoryRecord)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'DB_LIST') {
      dbListRecords(typeof msg.limit === 'number' ? msg.limit : 300)
        .then((records) => sendResponse({ ok: true, records }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'DB_DELETE') {
      dbDeleteRecord(String(msg.id ?? ''))
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'DB_CLEAR') {
      dbClearRecords()
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'DB_APPEND_GEN') {
      dbAppendGeneratedImage(String(msg.recordId ?? ''), msg.image as GeneratedImage)
        .then((record) => sendResponse({ ok: true, record }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'DB_DELETE_GEN') {
      dbDeleteGeneratedImage(String(msg.recordId ?? ''), String(msg.imageId ?? ''))
        .then((record) => sendResponse({ ok: true, record }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'ASSET_ADD') {
      dbAddAsset(msg.asset as CharacterAsset)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'ASSET_LIST') {
      dbListAssets(typeof msg.limit === 'number' ? msg.limit : 100)
        .then((assets) => sendResponse({ ok: true, assets }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'ASSET_DELETE') {
      dbDeleteAsset(String(msg.id ?? ''))
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'ASSET_UPDATE') {
      dbUpdateAsset(
        String(msg.id ?? ''),
        (msg.patch && typeof msg.patch === 'object' ? msg.patch : {}) as Partial<
          Pick<CharacterAsset, 'name' | 'starred' | 'sortOrder'>
        >,
      )
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    if (msg?.type === 'ASSET_REORDER') {
      const ids = Array.isArray(msg.orderedIds) ? msg.orderedIds.map(String) : [];
      dbReorderAssets(ids)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: errorMessage(e) }));
      return true;
    }

    return false;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'vrc-compile') return;
    let ctrl: AbortController | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let disconnected = false;
    const stopKeepalive = () => {
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
    };
    const safePost = (payload: Record<string, unknown>) => {
      if (disconnected) return;
      try {
        port.postMessage(payload);
      } catch {
        disconnected = true;
        stopKeepalive();
      }
    };

    port.onDisconnect.addListener(() => {
      disconnected = true;
      stopKeepalive();
      ctrl?.abort();
    });

    port.onMessage.addListener(
      (msg: { type?: string; dataUrl?: string; physics?: PhysicsResult }) => {
        if (msg?.type === 'CANCEL') {
          stopKeepalive();
          ctrl?.abort();
          return;
        }
        if (msg?.type === 'VISION_COMPILE_START' && msg.dataUrl && msg.physics) {
          ctrl?.abort();
          stopKeepalive();
          const current = new AbortController();
          ctrl = current;
          // Keep MV3 service worker alive while waiting for slow first-token responses (>30s).
          keepalive = setInterval(() => {
            safePost({ type: 'ping' });
          }, 15_000);
          (async () => {
            const settings = await loadSettings();
            const data = await callVisionApi(
              String(msg.dataUrl),
              msg.physics as PhysicsResult,
              settings,
              {
                signal: current.signal,
                onProgress: (p) => safePost({ type: 'progress', ...p }),
              },
            );
            safePost({ type: 'done', data });
          })()
            .catch((e: unknown) => {
              if (!current.signal.aborted && !disconnected) {
                safePost({ type: 'error', error: errorMessage(e) });
              }
            })
            .finally(() => {
              if (ctrl === current) stopKeepalive();
            });
        }
      },
    );
  });
});

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const MAX_EDGE = 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const ALPHA_MIME_TYPES = new Set(['image/png', 'image/webp', 'image/gif']);

async function fetchImagePayload(
  url: string,
): Promise<{ dataUrl: string; width?: number; height?: number }> {
  if (!/^https?:|^data:|^blob:/i.test(url)) {
    throw new Error(`不支持的图像 URL: ${url.slice(0, 80)}`);
  }
  let res = await fetch(url, {
    credentials: 'omit',
    mode: 'cors',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && /^https?:/i.test(url)) {
    try {
      const retry = await fetch(url, {
        credentials: 'include',
        mode: 'cors',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (retry.ok) res = retry;
    } catch {
      /* keep original status error */
    }
  }
  if (!res.ok) throw new Error(`图像抓取失败 HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`图像体积超过 30MB 上限 (${Math.round(blob.size / (1024 * 1024))}MB)`);
  }

  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    bmp = null;
  }

  // SVG or formats unsupported by createImageBitmap in Service Worker: pass raw Data URL to content script
  if (!bmp) {
    const buf = await blob.arrayBuffer();
    const mime = blob.type || /^data:([^;,]+)/i.exec(url)?.[1] || 'image/svg+xml';
    return { dataUrl: `data:${mime};base64,${arrayBufferToBase64(buf)}` };
  }

  try {
    const origWidth = bmp.width;
    const origHeight = bmp.height;
    if (!origWidth || !origHeight) throw new Error('无法读取图像尺寸');

    const scale = Math.min(1, MAX_EDGE / Math.max(origWidth, origHeight));
    const w = Math.max(1, Math.round(origWidth * scale));
    const h = Math.max(1, Math.round(origHeight * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D 上下文不可用');
    ctx.drawImage(bmp, 0, 0, w, h);

    const outType = ALPHA_MIME_TYPES.has(blob.type.toLowerCase()) ? 'image/png' : 'image/jpeg';
    const out = await canvas.convertToBlob(
      outType === 'image/png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.9 },
    );
    const buf = await out.arrayBuffer();
    return {
      dataUrl: `data:${outType};base64,${arrayBufferToBase64(buf)}`,
      width: origWidth,
      height: origHeight,
    };
  } finally {
    bmp.close();
  }
}
