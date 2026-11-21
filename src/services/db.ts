import { openDB, type IDBPDatabase } from 'idb';
import type { CharacterAsset, GeneratedImage, HistoryRecord } from '../utils/types';

const DB_NAME = 'vrc-history';
const STORE = 'records';
const ASSET_STORE = 'assets';
const VERSION = 2;
const MAX_RECORDS = 500;
const MAX_ASSETS = 200;
const MAX_GENERATED_PER_RECORD = 20;

let dbPromise: Promise<IDBPDatabase> | null = null;

function isExtensionOrigin(): boolean {
  if (typeof document === 'undefined') return true;
  return typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
}

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains(ASSET_STORE)) {
          const aStore = d.createObjectStore(ASSET_STORE, { keyPath: 'id' });
          aStore.createIndex('createdAt', 'createdAt');
        }
      },
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

async function putWithCap(storeName: string, item: unknown, maxItems: number): Promise<void> {
  const d = await db();
  const tx = d.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  await store.put(item);
  const total = await store.count();
  if (total > maxItems) {
    let excess = total - maxItems;
    let cursor = await store.index('createdAt').openCursor();
    while (cursor && excess > 0) {
      await cursor.delete();
      excess -= 1;
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

async function listByCreatedAt<T>(storeName: string, limit: number): Promise<T[]> {
  const d = await db();
  const tx = d.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index('createdAt');
  const out: T[] = [];
  let cursor = await index.openCursor(null, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value as T);
    cursor = await cursor.continue();
  }
  await tx.done;
  return out;
}

export async function dbAddRecord(record: HistoryRecord): Promise<void> {
  try {
    await putWithCap(STORE, record, MAX_RECORDS);
  } catch (e) {
    console.warn('[VRC] Failed to save history record', e);
  }
}

export async function dbListRecords(limit = 300): Promise<HistoryRecord[]> {
  try {
    return await listByCreatedAt<HistoryRecord>(STORE, limit);
  } catch (e) {
    console.warn('[VRC] Failed to list history records', e);
    return [];
  }
}

export async function dbDeleteRecord(id: string): Promise<void> {
  try {
    const d = await db();
    await d.delete(STORE, id);
  } catch (e) {
    console.warn('[VRC] Failed to delete history record', e);
  }
}

export async function dbClearRecords(): Promise<void> {
  try {
    const d = await db();
    await d.clear(STORE);
  } catch (e) {
    console.warn('[VRC] Failed to clear history records', e);
  }
}

/**
 * Atomically prepend a generated image to an existing history record.
 * Read-modify-write happens in one transaction so concurrent generations
 * (JSON + short prompt panels) never overwrite each other.
 * Returns the updated record, or null if the record does not exist / write failed.
 */
export async function dbAppendGeneratedImage(
  recordId: string,
  image: GeneratedImage,
): Promise<HistoryRecord | null> {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = (await store.get(recordId)) as HistoryRecord | undefined;
    if (!existing) {
      await tx.done;
      return null;
    }
    const prev = (existing.generatedImages ?? []).filter((g) => g.id !== image.id);
    const updated: HistoryRecord = {
      ...existing,
      generatedImages: [image, ...prev].slice(0, MAX_GENERATED_PER_RECORD),
    };
    await store.put(updated);
    await tx.done;
    return updated;
  } catch (e) {
    console.warn('[VRC] Failed to append generated image', e);
    return null;
  }
}

/** Remove one generated image from a record. Returns the updated record or null. */
export async function dbDeleteGeneratedImage(
  recordId: string,
  imageId: string,
): Promise<HistoryRecord | null> {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = (await store.get(recordId)) as HistoryRecord | undefined;
    if (!existing) {
      await tx.done;
      return null;
    }
    const updated: HistoryRecord = {
      ...existing,
      generatedImages: (existing.generatedImages ?? []).filter((g) => g.id !== imageId),
    };
    await store.put(updated);
    await tx.done;
    return updated;
  } catch (e) {
    console.warn('[VRC] Failed to delete generated image', e);
    return null;
  }
}

export async function dbAddAsset(asset: CharacterAsset): Promise<void> {
  try {
    const existing = await dbListAssets(MAX_ASSETS);
    const minOrder = existing.reduce(
      (m, a) => (typeof a.sortOrder === 'number' ? Math.min(m, a.sortOrder) : m),
      0,
    );
    const toSave: CharacterAsset =
      typeof asset.sortOrder === 'number' ? asset : { ...asset, sortOrder: minOrder - 1 };
    await putWithCap(ASSET_STORE, toSave, MAX_ASSETS);
  } catch (e) {
    console.warn('[VRC] Failed to save character asset', e);
  }
}

export async function dbListAssets(limit = 100): Promise<CharacterAsset[]> {
  try {
    const rows = await listByCreatedAt<CharacterAsset>(ASSET_STORE, Math.max(limit, MAX_ASSETS));
    rows.sort((a, b) => {
      const ao = typeof a.sortOrder === 'number' ? a.sortOrder : Number.POSITIVE_INFINITY;
      const bo = typeof b.sortOrder === 'number' ? b.sortOrder : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return b.createdAt - a.createdAt;
    });
    return rows.slice(0, limit);
  } catch (e) {
    console.warn('[VRC] Failed to list character assets', e);
    return [];
  }
}

export async function dbUpdateAsset(
  id: string,
  patch: Partial<Pick<CharacterAsset, 'name' | 'starred' | 'sortOrder'>>,
): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(ASSET_STORE, 'readwrite');
    const store = tx.objectStore(ASSET_STORE);
    const existing = (await store.get(id)) as CharacterAsset | undefined;
    if (existing) {
      await store.put({ ...existing, ...patch });
    }
    await tx.done;
  } catch (e) {
    console.warn('[VRC] Failed to update character asset', e);
  }
}

export async function dbReorderAssets(orderedIds: string[]): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(ASSET_STORE, 'readwrite');
    const store = tx.objectStore(ASSET_STORE);
    for (let i = 0; i < orderedIds.length; i++) {
      const existing = (await store.get(orderedIds[i])) as CharacterAsset | undefined;
      if (existing) {
        await store.put({ ...existing, sortOrder: i });
      }
    }
    await tx.done;
  } catch (e) {
    console.warn('[VRC] Failed to reorder character assets', e);
  }
}

export async function dbDeleteAsset(id: string): Promise<void> {
  try {
    const d = await db();
    await d.delete(ASSET_STORE, id);
  } catch (e) {
    console.warn('[VRC] Failed to delete character asset', e);
  }
}

async function viaBg<T>(
  msg: Record<string, unknown>,
  extract: (res: Record<string, unknown>) => T | undefined,
  fallback: () => Promise<T>,
): Promise<T> {
  if (isExtensionOrigin()) return fallback();
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as Record<string, unknown> | undefined;
    if (res?.ok) {
      const val = extract(res);
      if (val !== undefined) return val;
    }
  } catch {
    /* fallback to local origin IndexedDB */
  }
  return fallback();
}

async function viaBgVoid(
  msg: Record<string, unknown>,
  fallback: () => Promise<void>,
): Promise<void> {
  if (isExtensionOrigin()) return fallback();
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as { ok?: boolean } | undefined;
    if (res?.ok) return;
  } catch {
    /* fallback to local origin IndexedDB */
  }
  return fallback();
}

export function addRecord(record: HistoryRecord): Promise<void> {
  return viaBgVoid({ type: 'DB_ADD', record }, () => dbAddRecord(record));
}

export function listRecords(limit = 300): Promise<HistoryRecord[]> {
  return viaBg(
    { type: 'DB_LIST', limit },
    (r) => (Array.isArray(r.records) ? (r.records as HistoryRecord[]) : undefined),
    () => dbListRecords(limit),
  );
}

export function deleteRecord(id: string): Promise<void> {
  return viaBgVoid({ type: 'DB_DELETE', id }, () => dbDeleteRecord(id));
}

export function clearRecords(): Promise<void> {
  return viaBgVoid({ type: 'DB_CLEAR' }, () => dbClearRecords());
}

export function appendGeneratedImage(
  recordId: string,
  image: GeneratedImage,
): Promise<HistoryRecord | null> {
  return viaBg(
    { type: 'DB_APPEND_GEN', recordId, image },
    (r) =>
      r.record === null
        ? null
        : r.record && typeof r.record === 'object'
          ? (r.record as HistoryRecord)
          : undefined,
    () => dbAppendGeneratedImage(recordId, image),
  );
}

export function deleteGeneratedImage(
  recordId: string,
  imageId: string,
): Promise<HistoryRecord | null> {
  return viaBg(
    { type: 'DB_DELETE_GEN', recordId, imageId },
    (r) =>
      r.record === null
        ? null
        : r.record && typeof r.record === 'object'
          ? (r.record as HistoryRecord)
          : undefined,
    () => dbDeleteGeneratedImage(recordId, imageId),
  );
}

export function addAsset(asset: CharacterAsset): Promise<void> {
  return viaBgVoid({ type: 'ASSET_ADD', asset }, () => dbAddAsset(asset));
}

export function listAssets(limit = 100): Promise<CharacterAsset[]> {
  return viaBg(
    { type: 'ASSET_LIST', limit },
    (r) => (Array.isArray(r.assets) ? (r.assets as CharacterAsset[]) : undefined),
    () => dbListAssets(limit),
  );
}

export function deleteAsset(id: string): Promise<void> {
  return viaBgVoid({ type: 'ASSET_DELETE', id }, () => dbDeleteAsset(id));
}

export function updateAsset(
  id: string,
  patch: Partial<Pick<CharacterAsset, 'name' | 'starred' | 'sortOrder'>>,
): Promise<void> {
  return viaBgVoid({ type: 'ASSET_UPDATE', id, patch }, () => dbUpdateAsset(id, patch));
}

export function reorderAssets(orderedIds: string[]): Promise<void> {
  return viaBgVoid({ type: 'ASSET_REORDER', orderedIds }, () => dbReorderAssets(orderedIds));
}

/** Classify a hex color into a coarse color family (Chinese label). */
export function classifyColorFamily(hex: string): string {
  const m = hex.replace('#', '');
  if (m.length < 6) return '灰';
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.1) return '黑';
  if (l > 0.92) return '白';
  if (s < 0.12) return '灰';
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  if (h < 15 || h >= 345) return '红';
  if (h < 45) return l < 0.4 ? '棕' : '橙';
  if (h < 70) return '黄';
  if (h < 165) return '绿';
  if (h < 200) return '青';
  if (h < 260) return '蓝';
  if (h < 300) return '紫';
  return '粉';
}

export const COLOR_FAMILIES = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '粉', '棕', '灰', '黑', '白'] as const;

const yml = (s: string): string => JSON.stringify(s ?? '');

/** Export a record as Obsidian-flavored Markdown with YAML frontmatter. */
export function exportToObsidianMarkdown(
  r: HistoryRecord,
  overrides?: { jsonText?: string; shortPrompt?: string },
): string {
  const d = new Date(r.createdAt);
  const cat = r.result?.category ?? '未知品类';
  const tags = r.result?.tags ?? [];
  const L: string[] = [];

  L.push('---');
  L.push(`title: ${yml(`视觉逆向 · ${cat}`)}`);
  L.push(`date: ${d.toISOString()}`);
  L.push(`source: ${yml(r.srcUrl)}`);
  L.push(`page: ${yml(r.pageUrl)}`);
  L.push(`category: ${yml(cat)}`);
  L.push(`aspect_ratio: ${yml(r.physics.aspectRatio)}`);
  L.push(`recommended_ar: ${yml(r.physics.closestStandardRatio)}`);
  L.push(`luminance: ${yml(r.physics.luminance.tag)}`);
  L.push(`palette: [${r.physics.palette.map((c) => yml(c.hex)).join(', ')}]`);
  L.push('tags:');
  L.push('  - visual-compiler');
  for (const t of tags) L.push(`  - ${yml(t)}`);
  L.push('---');
  L.push('');
  L.push(`# 视觉逆向 · ${cat}`);
  L.push('');
  L.push('> 提取时间：' + d.toLocaleString());
  L.push('');
  L.push('## 📐 物理事实（0-token 本地分析）');
  L.push('');
  L.push(`- 尺寸：**${r.physics.width} × ${r.physics.height}** px`);
  L.push(`- 宽高比：**${r.physics.aspectRatio}**（推荐 ${r.physics.closestStandardRatio}）`);
  L.push(
    `- 色板：${r.physics.palette.map((c) => `\`${c.hex}\` ${c.percentage}%`).join(' · ')}`,
  );
  L.push(
    `- 明度：Shadows ${r.physics.luminance.shadows}% / Midtones ${r.physics.luminance.midtones}% / Highlights ${r.physics.luminance.highlights}%，σ=${r.physics.luminance.stdDev}（${r.physics.luminance.tag}）`,
  );
  L.push('');

  if (r.result) {
    L.push('## ① 结构化 JSON 提示词');
    L.push('');
    L.push('```json');
    L.push(overrides?.jsonText ?? JSON.stringify(r.result.json_prompt, null, 2));
    L.push('```');
    L.push('');

    const shortText =
      overrides?.shortPrompt ??
      (r.result.short_prompt ||
        (r.result.short_template
          ? r.result.short_template.template.replace(
              /\{\{subject\}\}/g,
              r.result.short_template.default_subject || '',
            )
          : ''));
    if (shortText) {
      L.push('## ② 无损精简提示词');
      L.push('');
      L.push('```text');
      L.push(shortText);
      L.push('```');
      L.push('');
    }
  }
  return L.join('\n');
}
