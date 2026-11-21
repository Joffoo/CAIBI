import type { CompiledResult, ExtensionSettings, PhysicsResult } from '../utils/types';
import { SHORT_CONVERGE_SYSTEM_PROMPT, VISUAL_DIVERGE_SYSTEM_PROMPT } from './promptSpec';

/** Build the deterministic physics digest injected into the LLM user message. */
export function buildPhysicsDigest(p: PhysicsResult): string {
  return JSON.stringify(
    {
      dimensions: `${p.width}x${p.height}`,
      aspect_ratio: p.aspectRatio,
      recommended_ar: p.closestStandardRatio,
      palette_hex: p.palette.map((c) => `${c.hex} (${c.percentage}%)`),
      luminance_profile: {
        shadows_pct: p.luminance.shadows,
        midtones_pct: p.luminance.midtones,
        highlights_pct: p.luminance.highlights,
        mean_y: p.luminance.mean,
        contrast_stddev: p.luminance.stdDev,
        tag: p.luminance.tag,
      },
    },
    null,
    2,
  );
}

const FIRST_TOKEN_TIMEOUT_MS = 300_000;
const IDLE_CHUNK_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 15_000;
const PROBE_INITIAL_DELAY_MS = 15_000;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export type StreamPhase = 'connecting' | 'thinking' | 'streaming';
export type CompileStage = 'diverge' | 'converge';

export interface CompileProgress {
  phase: StreamPhase;
  chars: number;
  probe?: 'ok' | 'warn';
  stage?: CompileStage;
}

export interface CompileOptions {
  signal?: AbortSignal;
  onProgress?: (p: CompileProgress) => void;
}

function createIdleController(externalSignal?: AbortSignal) {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut: 'first' | 'idle' | null = null;
  let offlineAborted = false;
  let stage: 'first' | 'idle' = 'first';

  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const onOffline = () => {
    offlineAborted = true;
    ctrl.abort();
  };
  if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('offline', onOffline);
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    offlineAborted = true;
    ctrl.abort();
  }

  const arm = (phase: 'first' | 'idle') => {
    stage = phase;
    if (timer) clearTimeout(timer);
    const ms = phase === 'first' ? FIRST_TOKEN_TIMEOUT_MS : IDLE_CHUNK_TIMEOUT_MS;
    timer = setTimeout(() => {
      timedOut = phase;
      ctrl.abort();
    }, ms);
  };

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (typeof globalThis !== 'undefined' && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('offline', onOffline);
    }
  };

  const toError = (err: unknown): Error => {
    if (externalSignal?.aborted) return new Error('已取消编译');
    if (offlineAborted) return new Error('网络连接已断开（设备处于离线状态）');
    if (timedOut === 'first' || (stage === 'first' && timedOut)) {
      return new Error('首包响应超时（300 秒无响应）— 请检查网络/代理或切换更快的模型');
    }
    if (timedOut === 'idle') {
      return new Error('流式响应空闲超时（120 秒未收到新数据）— 模型输出中断，请重试');
    }
    return err instanceof Error ? err : new Error(String(err));
  };

  return { signal: ctrl.signal, arm, cleanup, toError };
}

async function consumeSse(
  res: Response,
  idle: ReturnType<typeof createIdleController>,
  onData: (payload: string) => void,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('响应体不支持流式读取');
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let seenChunk = false;
  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    onData(payload);
  };
  try {
    while (true) {
      idle.arm(seenChunk ? 'idle' : 'first');
      const { done, value } = await reader.read();
      if (done) break;
      seenChunk = true;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) processLine(line);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function hasAspectRatio(text: string, ratioText: string, arFlag: string): boolean {
  if (!ratioText) return true;
  if (arFlag && text.includes(arFlag)) return true;
  const escaped = ratioText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9:])${escaped}(?:$|[^0-9:])`).test(text);
}

function ensureShortPromptAspectRatio(
  shortPrompt: string,
  ratioText: string,
  arFlag: string,
): string {
  if (!ratioText || hasAspectRatio(shortPrompt, ratioText, arFlag)) return shortPrompt;
  const tag = `画幅比例 ${ratioText}`;
  return shortPrompt ? `${shortPrompt}，${tag}` : tag;
}

/** Normalize untrusted LLM JSON (and legacy records) into the simplified CompiledResult. */
export function normalizeCompiledResult(raw: unknown, physics?: PhysicsResult): CompiledResult {
  const root = asObj(raw);
  const arFlag = physics?.closestStandardRatio?.trim() ?? '';
  const ratioText =
    arFlag.replace(/^--ar\s+/i, '').trim() || physics?.aspectRatio?.trim() || '';

  // Support legacy 4-tab schema seamlessly when loading older IndexedDB records
  if (!root.json_prompt && (root.taxonomy || root.slot_template || root.compiled_prompts)) {
    const tax = asObj(root.taxonomy);
    const cp = asObj(root.compiled_prompts);
    const st = asObj(root.slot_template);
    const slots = Array.isArray(st.slots) ? st.slots : [];
    const firstSlot = asObj(slots[0]);
    const defaultSubj = asStr(firstSlot.original_value_zh);
    const tplRaw = asStr(st.template_string_zh) || asStr(cp.natural_language_zh);
    const shortPrompt = ensureShortPromptAspectRatio(
      tplRaw.includes('{{slot_1}}')
        ? tplRaw.replace(/\{\{slot_1\}\}/g, defaultSubj)
        : tplRaw,
      ratioText,
      arFlag,
    );
    return {
      category: asStr(tax.category) || '未分类',
      tags: asStrArr(tax.core_dna_tags),
      json_prompt: {
        aspect_ratio: ratioText,
        subject: defaultSubj,
        style_medium: asStr(tax.category),
        composition_camera: '',
        lighting_atmosphere: '',
        color_palette: '',
        details_texture: asStr(cp.natural_language_zh),
      },
      short_prompt: shortPrompt,
    };
  }

  const jpRaw = asObj(root.json_prompt);
  const json_prompt: CompiledResult['json_prompt'] = {
    aspect_ratio: ratioText || asStr(jpRaw.aspect_ratio),
    subject: asStr(jpRaw.subject),
    style_medium: asStr(jpRaw.style_medium),
    composition_camera: asStr(jpRaw.composition_camera),
    lighting_atmosphere: asStr(jpRaw.lighting_atmosphere),
    color_palette: asStr(jpRaw.color_palette),
    details_texture: asStr(jpRaw.details_texture),
  };
  for (const [k, v] of Object.entries(jpRaw)) {
    if (!(k in json_prompt) && typeof v === 'string') {
      json_prompt[k] = v;
    }
  }

  let shortPrompt = asStr(root.short_prompt);
  if (!shortPrompt && root.short_template) {
    const st = asObj(root.short_template);
    const defaultSubj = asStr(st.default_subject) || json_prompt.subject;
    const tpl = asStr(st.template);
    shortPrompt = tpl.includes('{{subject}}')
      ? tpl.replace(/\{\{subject\}\}/g, defaultSubj)
      : tpl;
  }
  if (!shortPrompt) {
    shortPrompt = Object.values(json_prompt).filter(Boolean).join('，');
  }
  shortPrompt = ensureShortPromptAspectRatio(shortPrompt, ratioText, arFlag);

  return {
    category: asStr(root.category) || '未分类',
    tags: asStrArr(root.tags),
    json_prompt,
    short_prompt: shortPrompt,
  };
}

/** Robust JSON object extraction — strips accidental markdown fences / prose. */
export function extractJsonObject(raw: string): Record<string, unknown> {
  let t = raw.trim();
  t = t
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?[ \t]*```\s*$/, '')
    .trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) {
    throw new Error('模型响应中未找到 JSON 对象');
  }
  try {
    return asObj(JSON.parse(t.slice(s, e + 1)));
  } catch (err) {
    throw new Error(`JSON 解析失败: ${String(err)}`);
  }
}

export function compileViaPort(
  dataUrl: string,
  physics: PhysicsResult,
  onProgress?: (p: CompileProgress) => void,
): { promise: Promise<CompiledResult>; cancel: () => void } {
  let cancelled = false;
  let settled = false;
  let port: chrome.runtime.Port | null = null;
  let rejectFn: ((err: Error) => void) | null = null;

  const closePort = () => {
    try {
      port?.disconnect();
    } catch {
      /* ignore */
    }
    port = null;
  };

  const promise = new Promise<CompiledResult>((resolve, reject) => {
    rejectFn = reject;
    try {
      port = chrome.runtime.connect({ name: 'vrc-compile' });
    } catch (err) {
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      closePort();
      fn();
    };

    port.onMessage.addListener(
      (msg: {
        type?: string;
        phase?: StreamPhase;
        chars?: number;
        probe?: 'ok' | 'warn';
        stage?: CompileStage;
        data?: CompiledResult;
        error?: string;
      }) => {
        if (msg?.type === 'progress' && msg.phase) {
          onProgress?.({
            phase: msg.phase,
            chars: msg.chars ?? 0,
            probe: msg.probe,
            stage: msg.stage,
          });
        } else if (msg?.type === 'done' && msg.data) {
          finish(() => resolve(msg.data as CompiledResult));
        } else if (msg?.type === 'error') {
          finish(() => reject(new Error(msg.error || 'Vision 编译失败')));
        }
      },
    );

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError?.message;
      finish(() =>
        reject(new Error(cancelled ? '已取消编译' : lastErr || '后台编译连接已断开')),
      );
    });

    port.postMessage({ type: 'VISION_COMPILE_START', dataUrl, physics });
  });

  const cancel = () => {
    cancelled = true;
    try {
      port?.postMessage({ type: 'CANCEL' });
    } catch {
      /* ignore */
    }
    if (!settled) {
      settled = true;
      closePort();
      rejectFn?.(new Error('已取消编译'));
    }
  };

  return { promise, cancel };
}

export async function fetchModelsViaBackground(s: ExtensionSettings): Promise<string[]> {
  const res = (await chrome.runtime.sendMessage({
    type: 'FETCH_MODELS',
    settings: s,
  })) as { ok?: boolean; models?: string[]; error?: string } | undefined;
  if (!res?.ok || !Array.isArray(res.models)) {
    throw new Error(res?.error ?? '拉取可用模型失败');
  }
  return res.models;
}

function normalizeVisionBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)(?:\?.*)?$/i, '')
    .replace(/\/+$/, '');
}

function getVisionBaseUrlCandidates(raw: string): string[] {
  const clean = normalizeVisionBaseUrl(raw) || 'https://api.openai.com/v1';
  if (/\/v\d+(?:alpha|beta)?$/i.test(clean) || /\/openai$/i.test(clean)) {
    return [clean];
  }
  try {
    const u = new URL(clean);
    if (u.pathname === '/' || u.pathname === '') {
      return [`${clean}/v1`, clean];
    }
  } catch {
    /* ignore invalid URL */
  }
  return [clean, `${clean}/v1`];
}

export async function fetchAvailableModels(s: ExtensionSettings): Promise<string[]> {
  const candidates = getVisionBaseUrlCandidates(s.baseUrl);
  const headers: Record<string, string> = {};
  if (s.apiKey.trim()) headers.Authorization = `Bearer ${s.apiKey.trim()}`;

  let lastStatus = 404;
  let lastBody = '';
  for (const base of candidates) {
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as {
        data?: Array<{ id?: string }>;
        models?: Array<{ id?: string; name?: string }>;
      };
      const list = Array.isArray(j.data)
        ? j.data.map((m) => m?.id)
        : Array.isArray(j.models)
          ? j.models.map((m) => m?.id ?? m?.name)
          : [];
      const ids = list.filter((x): x is string => typeof x === 'string' && x.length > 0);
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    }
    lastStatus = res.status;
    lastBody = await res.text().catch(() => '');
    if (![404, 405, 501].includes(res.status)) {
      throw new Error(`拉取模型列表失败 ${res.status}: ${lastBody.slice(0, 200)}`);
    }
  }
  throw new Error(`拉取模型列表失败 ${lastStatus}: ${lastBody.slice(0, 200)}`);
}

export interface FetchedImagePayload {
  dataUrl: string;
  width?: number;
  height?: number;
}

async function readUrlInPageContext(url: string): Promise<FetchedImagePayload> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`页面上下文抓图失败 HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`图像体积超过 30MB 上限 (${Math.round(blob.size / (1024 * 1024))}MB)`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('FileReader 读取图像失败'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl };
}

export async function fetchImagePayload(url: string): Promise<FetchedImagePayload> {
  if (/^blob:/i.test(url) && typeof document !== 'undefined') {
    return readUrlInPageContext(url);
  }
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'FETCH_IMAGE_BASE64',
      url,
    })) as
      | { ok?: boolean; dataUrl?: string; width?: number; height?: number; error?: string }
      | undefined;
    if (res?.ok && res.dataUrl) {
      return { dataUrl: res.dataUrl, width: res.width, height: res.height };
    }
    throw new Error(res?.error ?? '图像获取失败');
  } catch (err) {
    if (typeof document !== 'undefined' && /^data:|^blob:/i.test(url)) {
      return readUrlInPageContext(url);
    }
    throw err;
  }
}

export async function callVisionApi(
  dataUrl: string,
  physics: PhysicsResult,
  s: ExtensionSettings,
  options?: CompileOptions,
): Promise<CompiledResult> {
  if (!s.apiKey.trim()) throw new Error('未配置 API Key — 请打开 Settings 填写 BYOK 密钥');
  if (!s.model.trim()) throw new Error('未配置视觉模型 — 请打开 Settings 填写或拉取视觉模型名');
  const digest = buildPhysicsDigest(physics);
  const divergeUserText =
    `【前端 Canvas 预提取的确定性物理元数据（你的分析必须锚定这些硬事实）】\n` +
    `${digest}\n\n` +
    `请对随附图像执行发散式视觉解构，严格按系统指令仅输出一个合法 JSON 对象。`;
  const runModel = (
    stage: CompileStage,
    systemPrompt: string,
    imgUrl: string | null,
    userText: string,
  ) =>
    callOpenAI(systemPrompt, imgUrl, userText, s, {
      signal: options?.signal,
      onProgress: options?.onProgress
        ? (p) => options.onProgress?.({ ...p, stage })
        : undefined,
    });

  const divergeText = await runModel('diverge', VISUAL_DIVERGE_SYSTEM_PROMPT, dataUrl, divergeUserText);
  const root = extractJsonObject(divergeText);

  // Agent 2 (Converge): decouple lossless short_prompt compilation from Agent 1 divergence.
  // Skip only when a legacy/mock upstream response already includes short_prompt or short_template.template.
  const existingShortTemplate = asObj(root.short_template);
  if (!asStr(root.short_prompt) && !asStr(existingShortTemplate.template)) {
    const convergeUserText =
      `【Agent 1 发散视觉解构结果与推荐画幅】\n` +
      `${JSON.stringify(
        {
          recommended_ar: physics.closestStandardRatio,
          category: root.category,
          tags: root.tags,
          json_prompt: root.json_prompt,
        },
        null,
        2,
      )}\n\n` +
      `请执行无损电报式压缩（若原图含任何文字，必须一字不漏保留全部可见文字原文与排版位置），严格按系统指令仅输出一个合法 JSON 对象。`;
    const convergeText = await runModel('converge', SHORT_CONVERGE_SYSTEM_PROMPT, null, convergeUserText);
    const convergeObj = extractJsonObject(convergeText);
    root.short_prompt = asStr(convergeObj.short_prompt);
  }

  return normalizeCompiledResult(root, physics);
}

export function splitDataUrl(dataUrl: string): [string, string] {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) throw new Error('非法 base64 Data URL');
  return [m[1], m[2]];
}

async function postOpenAI(
  base: string,
  systemPrompt: string,
  dataUrl: string | null,
  userText: string,
  s: ExtensionSettings,
  useJsonFormat: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const userContent = dataUrl
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]
    : userText;
  const body: Record<string, unknown> = {
    model: s.model.trim(),
    temperature: 0.4,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.apiKey.trim()}`,
    },
    signal,
    body: JSON.stringify(body),
  });
}

async function callOpenAI(
  systemPrompt: string,
  dataUrl: string | null,
  userText: string,
  s: ExtensionSettings,
  options?: CompileOptions,
): Promise<string> {
  const candidates = getVisionBaseUrlCandidates(s.baseUrl);
  const idle = createIdleController(options?.signal);
  let probeDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let probeInterval: ReturnType<typeof setInterval> | null = null;
  const stopProbe = () => {
    if (probeDelayTimer) {
      clearTimeout(probeDelayTimer);
      probeDelayTimer = null;
    }
    if (probeInterval) {
      clearInterval(probeInterval);
      probeInterval = null;
    }
  };
  const runProbe = async (base: string) => {
    if (idle.signal.aborted) return;
    try {
      const headers: Record<string, string> = {};
      if (s.apiKey.trim()) headers.Authorization = `Bearer ${s.apiKey.trim()}`;
      await fetch(`${base}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.any([idle.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
      });
      if (!idle.signal.aborted) {
        options?.onProgress?.({ phase: 'connecting', chars: 0, probe: 'ok' });
      }
    } catch {
      if (!idle.signal.aborted) {
        options?.onProgress?.({ phase: 'connecting', chars: 0, probe: 'warn' });
      }
    }
  };
  let activeBase = candidates[0];
  try {
    options?.onProgress?.({ phase: 'connecting', chars: 0 });
    probeDelayTimer = setTimeout(() => {
      void runProbe(activeBase);
      probeInterval = setInterval(() => void runProbe(activeBase), PROBE_INTERVAL_MS);
    }, PROBE_INITIAL_DELAY_MS);
    let res: Response | null = null;
    let lastStatus = 404;
    let lastBody = '';

    for (const base of candidates) {
      activeBase = base;
      idle.arm('first');
      let candidateRes = await postOpenAI(base, systemPrompt, dataUrl, userText, s, true, idle.signal);
      if (candidateRes.status === 400 || candidateRes.status === 422) {
        idle.arm('first');
        candidateRes = await postOpenAI(base, systemPrompt, dataUrl, userText, s, false, idle.signal);
      }
      if (candidateRes.ok) {
        res = candidateRes;
        break;
      }
      lastStatus = candidateRes.status;
      lastBody = await candidateRes.text().catch(() => '');
      if (![404, 405, 501].includes(candidateRes.status)) {
        throw new Error(`OpenAI 兼容接口错误 ${candidateRes.status}: ${lastBody.slice(0, 300)}`);
      }
    }

    if (!res) {
      throw new Error(`OpenAI 兼容接口错误 ${lastStatus}: ${lastBody.slice(0, 300)}`);
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && !ct.includes('event-stream')) {
      stopProbe();
      idle.arm('idle');
      const j = (await res.json()) as {
        error?: { message?: string } | string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      if (j?.error) {
        const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
        throw new Error(`OpenAI 兼容接口错误: ${msg.slice(0, 300)}`);
      }
      const content = j?.choices?.[0]?.message?.content ?? '';
      options?.onProgress?.({ phase: 'streaming', chars: content.length });
      return content;
    }

    let acc = '';
    let sseError = '';
    await consumeSse(res, idle, (payload) => {
      stopProbe();
      try {
        const chunk = JSON.parse(payload) as {
          error?: { message?: string } | string;
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string };
            message?: { content?: string };
          }>;
        };
        if (chunk.error) {
          sseError =
            typeof chunk.error === 'string'
              ? chunk.error
              : chunk.error.message || JSON.stringify(chunk.error);
        }
        const delta = chunk.choices?.[0]?.delta;
        const msgContent = chunk.choices?.[0]?.message?.content;
        if (
          (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
          (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0)
        ) {
          options?.onProgress?.({ phase: 'thinking', chars: acc.length });
        }
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          acc += delta.content;
          options?.onProgress?.({ phase: 'streaming', chars: acc.length });
        } else if (typeof msgContent === 'string' && msgContent.length > 0 && acc.length === 0) {
          acc += msgContent;
          options?.onProgress?.({ phase: 'streaming', chars: acc.length });
        }
      } catch {
        /* ignore non-JSON keepalive lines */
      }
    });
    if (!acc && sseError) {
      throw new Error(`OpenAI 兼容接口错误: ${sseError.slice(0, 300)}`);
    }
    return acc;
  } catch (err) {
    throw idle.toError(err);
  } finally {
    stopProbe();
    idle.cleanup();
  }
}
