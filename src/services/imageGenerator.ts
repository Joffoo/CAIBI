import type { ExtensionSettings } from '../utils/types';
import { arrayBufferToBase64 } from '../utils/base64';
import { splitDataUrl } from './visionCompiler';

const IMAGE_GEN_TIMEOUT_MS = 120_000;

export const CHARACTER_SHEET_EXTRACT_PROMPT =
  '角色设定集，画面左右平分。左半边：并排展示人物的正面全身（头部打码模糊）与背面全身。右半边：铺满大尺寸的四分之三侧面脸部高清特写。整体为纯中性灰影棚背景，柔和均匀平光，无强烈阴影与刺眼高光。';

export const ANIME_TO_REAL_CHARACTER_SHEET_PROMPT =
  '将参考图中的动漫/漫画角色直出转化为真人摄影级角色设定集，画面左右平分。左半边：并排展示真人化后的正面全身（头部打码模糊）与背面全身，保留原角色服装造型并转化为真实织物面料、剪裁与垂坠质感。右半边：铺满大尺寸的四分之三侧面真人脸部高清人像特写（85mm微单直出质感）。严格保留原角色的发色、发长、刘海走向、翘起碎发呆毛与发束层次，以及眼型、眉形、嘴型、神态气质与标志性表情，不要重新设计；五官转化为真实人类骨骼比例，剥离夸张二次元画风特征；还原真实自然人类肤色（剔除原画环境色染色，皮肤具真实毛孔、细小绒毛与自然明暗过渡，不磨皮），发丝根根分明带自然毛躁。整体为纯中性灰影棚背景，柔和均匀且有方向感的影棚主光，高光不过曝，暗部保留细节。避免：二次元插画感、塑料假人感、过度美颜、涂色皮肤、杂乱背景、改变原角色发型与表情神态。';

export interface ImageGenParams {
  prompt: string;
  referenceDataUrl?: string;
}

export function isImageGenConfigured(s: ExtensionSettings): boolean {
  return Boolean(s.imageGenModel?.trim());
}

function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|images?(?:\/(?:generations|edits))?)(?:\?.*)?$/i, '')
    .replace(/\/models(?:\?.*)?$/i, '')
    .replace(/\/+$/, '');
}

function inferImageMimeFromBase64(b64: string): string {
  const head = b64.slice(0, 12);
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  return 'image/png';
}

function getVersionedBaseUrlCandidates(baseUrl: string): string[] {
  const clean = baseUrl.replace(/\/+$/, '');
  if (!clean) return [];
  if (/\/v\d+(?:alpha|beta)?$/i.test(clean)) {
    return [clean];
  }
  try {
    const u = new URL(clean);
    if (u.pathname === '/' || u.pathname === '') {
      return [`${clean}/v1`, clean];
    }
  } catch {
    /* ignore invalid URL and fall back to suffix append */
  }
  return [clean, `${clean}/v1`];
}

export function resolveImageGenConfig(s: ExtensionSettings): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  let baseUrl = normalizeBaseUrl(s.imageGenBaseUrl);
  if (!baseUrl) {
    baseUrl = s.baseUrl.trim() ? normalizeBaseUrl(s.baseUrl) : 'https://api.openai.com/v1';
  }
  const apiKey = s.imageGenApiKey.trim() || s.apiKey.trim();
  return {
    baseUrl,
    apiKey,
    model: s.imageGenModel.trim(),
  };
}

export async function generateImageViaBackground(params: ImageGenParams): Promise<string> {
  const res = (await chrome.runtime.sendMessage({
    type: 'IMAGE_GENERATE',
    prompt: params.prompt,
    referenceDataUrl: params.referenceDataUrl,
  })) as { ok?: boolean; dataUrl?: string; error?: string } | undefined;
  if (!res?.ok || !res.dataUrl) {
    throw new Error(res?.error ?? '生图失败');
  }
  return res.dataUrl;
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; ext: string } {
  const [mime, b64] = splitDataUrl(dataUrl);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  return { blob: new Blob([bytes], { type: mime }), ext };
}

async function fetchAsDataUrl(url: string): Promise<string> {
  if (/^data:/i.test(url)) return url;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`下载生成图失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const buf = await blob.arrayBuffer();
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS) }).catch((err) => {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`生图请求超时（超过 ${IMAGE_GEN_TIMEOUT_MS / 1000} 秒未响应）`);
    }
    throw err;
  });
}

export async function callImageGenApi(
  params: ImageGenParams,
  settings: ExtensionSettings,
): Promise<string> {
  const cfg = resolveImageGenConfig(settings);
  if (!cfg.model) throw new Error('未配置生图模型 — 请打开 Settings 填写生图模型名');
  if (!params.prompt.trim()) {
    throw new Error('提示词为空，无法生成图片');
  }

  return callOpenAiImageGen(params, cfg);
}

interface AttemptRecord {
  endpoint: string;
  status: number;
  body: string;
}

const isRouteMissingStatus = (status: number) => [404, 405, 501].includes(status);

function formatAllEndpointsFailedError(prefix: string, attempts: AttemptRecord[]): Error {
  const summary = attempts.map((a) => `${a.endpoint} (${a.status})`).join(' -> ');
  const last = attempts[attempts.length - 1];
  const detail = last?.body ? `: ${last.body.slice(0, 200)}` : '';
  return new Error(`${prefix} ${last?.status ?? 404}（已尝试端点：${summary}）${detail}`);
}

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly rawBody = '',
  ) {
    super(message);
  }
}

async function parseOpenAiImageResponse(res: Response): Promise<string> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpStatusError(res.status, `生图接口错误 ${res.status}: ${body.slice(0, 300)}`, body);
  }
  const j = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = j.data?.[0];
  if (first?.b64_json) {
    return `data:${inferImageMimeFromBase64(first.b64_json)};base64,${first.b64_json}`;
  }
  if (first?.url) {
    return fetchAsDataUrl(first.url);
  }
  throw new Error('生图响应中未包含 b64_json 或 url');
}

function extractImageFromText(text: string): string | null {
  const dataMatch = text.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/);
  if (dataMatch) return dataMatch[0];
  const mdMatch = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/i);
  if (mdMatch?.[1]) return mdMatch[1];
  const urlMatch = text.match(/https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)]*)?/i);
  if (urlMatch) return urlMatch[0];
  return null;
}

async function extractImageFromChatItem(item: unknown): Promise<string | null> {
  if (typeof item === 'string') {
    const found = extractImageFromText(item);
    return found ? fetchAsDataUrl(found) : null;
  }
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.b64_json === 'string' && obj.b64_json) {
    return `data:${inferImageMimeFromBase64(obj.b64_json)};base64,${obj.b64_json}`;
  }
  if (typeof obj.url === 'string' && obj.url) {
    return fetchAsDataUrl(obj.url);
  }
  if (typeof obj.image_url === 'string' && obj.image_url) {
    return fetchAsDataUrl(obj.image_url);
  }
  if (obj.image_url && typeof obj.image_url === 'object') {
    const u = (obj.image_url as Record<string, unknown>).url;
    if (typeof u === 'string' && u) return fetchAsDataUrl(u);
  }
  const inline = (obj.inlineData ?? obj.inline_data) as Record<string, unknown> | undefined;
  if (inline && typeof inline.data === 'string' && inline.data) {
    const mime =
      (typeof inline.mimeType === 'string' && inline.mimeType) ||
      (typeof inline.mime_type === 'string' && inline.mime_type) ||
      'image/png';
    return `data:${mime};base64,${inline.data}`;
  }
  if (obj.type === 'image' && typeof obj.data === 'string' && obj.data) {
    const mime =
      (typeof obj.mimeType === 'string' && obj.mimeType) ||
      (typeof obj.mime_type === 'string' && obj.mime_type) ||
      'image/png';
    return `data:${mime};base64,${obj.data}`;
  }
  if (typeof obj.text === 'string' && obj.text) {
    const found = extractImageFromText(obj.text);
    if (found) return fetchAsDataUrl(found);
  }
  return null;
}

async function parseOpenAiChatSseBody(text: string): Promise<string> {
  let accText = '';
  const images: unknown[] = [];
  let sseError: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as {
        error?: { message?: string } | string;
        choices?: Array<{
          delta?: { content?: unknown; images?: unknown[] };
          message?: { content?: unknown; images?: unknown[] };
        }>;
      };
      if (chunk.error) {
        sseError =
          typeof chunk.error === 'string'
            ? chunk.error
            : chunk.error.message || JSON.stringify(chunk.error);
      }
      const choice = chunk.choices?.[0];
      if (Array.isArray(choice?.delta?.images)) images.push(...choice.delta.images);
      if (Array.isArray(choice?.message?.images)) images.push(...choice.message.images);

      for (const partSource of [choice?.delta?.content, choice?.message?.content]) {
        if (typeof partSource === 'string') {
          accText += partSource;
        } else if (Array.isArray(partSource)) {
          images.push(...partSource);
          for (const item of partSource) {
            if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
              accText += (item as { text: string }).text;
            }
          }
        }
      }
    } catch {
      /* ignore non-JSON keepalive lines */
    }
  }

  for (const img of images) {
    const resolved = await extractImageFromChatItem(img);
    if (resolved) return resolved;
  }
  if (accText) {
    const found = extractImageFromText(accText);
    if (found) return fetchAsDataUrl(found);
    const trimmed = accText.trim();
    if (trimmed) {
      throw new Error(`模型未返回图像（仅返回文本：${trimmed.slice(0, 140)}）`);
    }
  }
  if (sseError) {
    throw new Error(`生图接口错误: ${sseError.slice(0, 300)}`);
  }
  throw new Error('生图响应中未包含图像数据');
}

async function parseOpenAiChatImageResponse(res: Response): Promise<string> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpStatusError(res.status, `生图接口错误 ${res.status}: ${body.slice(0, 300)}`, body);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    return parseOpenAiChatSseBody(await res.text());
  }

  const rawText = await res.text();
  let j: {
    error?: { message?: string } | string;
    data?: Array<{ b64_json?: string; url?: string }>;
    choices?: Array<{
      message?: {
        images?: unknown[];
        content?: unknown;
      };
    }>;
  };
  try {
    j = JSON.parse(rawText) as typeof j;
  } catch {
    if (/^\s*data:/m.test(rawText)) {
      return parseOpenAiChatSseBody(rawText);
    }
    throw new Error(`生图响应不是合法 JSON: ${rawText.slice(0, 160)}`);
  }

  if (j.error) {
    const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
    throw new Error(`生图接口错误: ${msg.slice(0, 300)}`);
  }

  if (j.data?.[0]?.b64_json) {
    return `data:${inferImageMimeFromBase64(j.data[0].b64_json)};base64,${j.data[0].b64_json}`;
  }
  if (j.data?.[0]?.url) {
    return fetchAsDataUrl(j.data[0].url);
  }

  const msg = j.choices?.[0]?.message;
  if (Array.isArray(msg?.images)) {
    for (const img of msg.images) {
      const resolved = await extractImageFromChatItem(img);
      if (resolved) return resolved;
    }
  }
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      const resolved = await extractImageFromChatItem(part);
      if (resolved) return resolved;
    }
  }
  if (typeof msg?.content === 'string') {
    const found = extractImageFromText(msg.content);
    if (found) return fetchAsDataUrl(found);
    const trimmed = msg.content.trim();
    if (trimmed) {
      throw new Error(`模型未返回图像（仅返回文本：${trimmed.slice(0, 140)}）`);
    }
  }

  throw new Error('生图响应中未包含图像数据');
}

async function callOpenAiChatImageGen(
  params: ImageGenParams,
  cfg: { baseUrl: string; apiKey: string; model: string },
  authHeaders: Record<string, string>,
): Promise<string> {
  const headers = { 'Content-Type': 'application/json', ...authHeaders };
  const content: unknown = params.referenceDataUrl
    ? [
        { type: 'text', text: params.prompt },
        { type: 'image_url', image_url: { url: params.referenceDataUrl } },
      ]
    : params.prompt;

  const postChat = (modalities?: string[]) =>
    fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        ...(modalities ? { modalities } : {}),
        messages: [{ role: 'user', content }],
      }),
    });

  let res = await postChat(['image', 'text']);
  if (res.status === 404) {
    const bodyText = await res.clone().text().catch(() => '');
    if (/output modalities/i.test(bodyText)) {
      res = await postChat(['image']);
    }
  }
  if (res.status === 400 || res.status === 422) {
    res = await postChat(undefined);
  }
  return parseOpenAiChatImageResponse(res);
}

async function callOpenAiImageGen(
  params: ImageGenParams,
  cfg: { baseUrl: string; apiKey: string; model: string },
): Promise<string> {
  const authHeaders: Record<string, string> = {};
  if (cfg.apiKey) authHeaders.Authorization = `Bearer ${cfg.apiKey}`;
  const baseCandidates = getVersionedBaseUrlCandidates(cfg.baseUrl);
  const attempts: AttemptRecord[] = [];
  let chatFallbackErr: Error | null = null;

  for (const baseUrl of baseCandidates) {
    const candidateCfg = { ...cfg, baseUrl };

    if (params.referenceDataUrl) {
      const { blob, ext } = dataUrlToBlob(params.referenceDataUrl);
      const form = new FormData();
      form.append('model', cfg.model);
      form.append('prompt', params.prompt);
      form.append('n', '1');
      form.append('response_format', 'b64_json');
      form.append('image', blob, `reference.${ext}`);

      const editsUrl = `${baseUrl}/images/edits`;
      let editRes = await fetchWithTimeout(editsUrl, {
        method: 'POST',
        headers: authHeaders,
        body: form,
      });
      if (editRes.ok) {
        return parseOpenAiImageResponse(editRes);
      }
      if (editRes.status === 400) {
        const formNoFmt = new FormData();
        formNoFmt.append('model', cfg.model);
        formNoFmt.append('prompt', params.prompt);
        formNoFmt.append('n', '1');
        formNoFmt.append('image', blob, `reference.${ext}`);
        editRes = await fetchWithTimeout(editsUrl, {
          method: 'POST',
          headers: authHeaders,
          body: formNoFmt,
        });
        if (editRes.ok) return parseOpenAiImageResponse(editRes);
      }
      if (!isRouteMissingStatus(editRes.status)) {
        return parseOpenAiImageResponse(editRes);
      }
      attempts.push({
        endpoint: editsUrl,
        status: editRes.status,
        body: await editRes.text().catch(() => ''),
      });

      // Provider does not implement /images/edits: try /chat/completions first so referenceDataUrl is preserved
      // (required by OpenRouter and chat-based image models like gemini-2.5-flash-image / gpt-4o-image).
      try {
        return await callOpenAiChatImageGen(params, candidateCfg, authHeaders);
      } catch (err) {
        if (err instanceof HttpStatusError) {
          if (
            /support image input|does not support image|image_url.*not supported|vision.*not supported/i.test(
              err.rawBody,
            )
          ) {
            throw new Error(
              '当前生图模型不支持参考图/垫图输入（请切换支持图像输入的模型，或取消垫图改为纯文生图）',
            );
          }
          attempts.push({
            endpoint: `${baseUrl}/chat/completions`,
            status: err.status,
            body: err.rawBody,
          });
          if (err.status !== 400 && err.status !== 422 && !isRouteMissingStatus(err.status)) {
            throw err;
          }
        }
        chatFallbackErr = err instanceof Error ? err : new Error(String(err));
        // Fall back to text-only /images/generations
      }
    }

    const genUrl = `${baseUrl}/images/generations`;
    const genHeaders = { 'Content-Type': 'application/json', ...authHeaders };
    let res = await fetchWithTimeout(genUrl, {
      method: 'POST',
      headers: genHeaders,
      body: JSON.stringify({
        model: cfg.model,
        prompt: params.prompt,
        n: 1,
        response_format: 'b64_json',
      }),
    });
    if (res.status === 400) {
      res = await fetchWithTimeout(genUrl, {
        method: 'POST',
        headers: genHeaders,
        body: JSON.stringify({
          model: cfg.model,
          prompt: params.prompt,
          n: 1,
        }),
      });
    }
    if (res.ok) {
      return parseOpenAiImageResponse(res);
    }
    if (!isRouteMissingStatus(res.status)) {
      return parseOpenAiImageResponse(res);
    }
    attempts.push({
      endpoint: genUrl,
      status: res.status,
      body: await res.text().catch(() => ''),
    });

    if (!params.referenceDataUrl) {
      try {
        return await callOpenAiChatImageGen(params, candidateCfg, authHeaders);
      } catch (err) {
        if (err instanceof HttpStatusError) {
          attempts.push({
            endpoint: `${baseUrl}/chat/completions`,
            status: err.status,
            body: err.rawBody,
          });
          if (!isRouteMissingStatus(err.status)) {
            throw err;
          }
        } else {
          throw err;
        }
      }
    } else if (
      chatFallbackErr &&
      !(chatFallbackErr instanceof HttpStatusError && isRouteMissingStatus(chatFallbackErr.status))
    ) {
      throw chatFallbackErr;
    }
  }

  throw formatAllEndpointsFailedError('生图接口错误', attempts);
}
