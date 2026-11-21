import type { PaletteColor, PhysicsResult } from './types';

/**
 * Module B — 0-token deterministic local image analyzer.
 * Pure TypeScript + Canvas, no external libraries, safe inside content scripts.
 */

const DOWNSAMPLE_EDGE = 100;
const K = 5;
const KMEANS_ITERS = 10;

function gcd(a: number, b: number): number {
  let x = Math.round(Math.abs(a));
  let y = Math.round(Math.abs(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function simplifyRatio(w: number, h: number): string {
  if (!w || !h) return '?';
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  if (a > 40 || b > 40) return `${(w / h).toFixed(2)}:1`;
  return `${a}:${b}`;
}

const STANDARD: Array<[string, number]> = [
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['3:2', 1.5],
  ['2:3', 2 / 3],
  ['5:4', 1.25],
  ['4:5', 0.8],
  ['21:9', 21 / 9],
  ['2:1', 2],
  ['1:2', 0.5],
  ['5:3', 5 / 3],
  ['3:5', 0.6],
];

export function closestStandardRatio(w: number, h: number): string {
  if (!w || !h) return '--ar 1:1';
  const r = w / h;
  let best = STANDARD[0];
  let bestDist = Infinity;
  for (const s of STANDARD) {
    const d = Math.abs(Math.log(r / s[1]));
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return `--ar ${best[0]}`;
}

interface Cluster {
  r: number;
  g: number;
  b: number;
  count: number;
}

/** Fast K-Means in RGB space with deterministic luminance-quantile seeding. */
function kmeans(px: number[], k: number, iters: number): Cluster[] {
  const n = px.length / 3;
  if (n === 0) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort(
    (a, b) =>
      px[a * 3] + px[a * 3 + 1] + px[a * 3 + 2] -
      (px[b * 3] + px[b * 3 + 1] + px[b * 3 + 2]),
  );
  const centers: number[][] = [];
  for (let c = 0; c < k; c++) {
    const i = idx[Math.min(n - 1, Math.floor(((c + 0.5) * n) / k))] * 3;
    centers.push([px[i], px[i + 1], px[i + 2]]);
  }
  const assign = new Int32Array(n);
  const counts = new Int32Array(k);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let bestDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < k; c++) {
        const dr = px[i * 3] - centers[c][0];
        const dg = px[i * 3 + 1] - centers[c][1];
        const db = px[i * 3 + 2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          bestC = c;
        }
      }
      assign[i] = bestC;
    }
    const sums: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]];
      s[0] += px[i * 3];
      s[1] += px[i * 3 + 1];
      s[2] += px[i * 3 + 2];
      s[3] += 1;
    }
    for (let c = 0; c < k; c++) {
      counts[c] = sums[c][3];
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }
  return centers
    .map((c, i) => ({ r: c[0], g: c[1], b: c[2], count: counts[i] }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图像解码失败（Image decode failed）'));
    img.src = src;
  });
}

function drawDownscaled(
  img: HTMLImageElement,
  edge: number,
  fallbackW = 1,
  fallbackH = 1,
): { data: Uint8ClampedArray; w: number; h: number } {
  const srcW = img.naturalWidth || fallbackW;
  const srcH = img.naturalHeight || fallbackH;
  const scale = Math.min(1, edge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

function collectPixels(
  data: Uint8ClampedArray,
  skipTransparent: boolean,
): {
  px: number[];
  lum: number[];
  shadows: number;
  midtones: number;
  highlights: number;
  sum: number;
} {
  const px: number[] = [];
  const lum: number[] = [];
  let shadows = 0;
  let midtones = 0;
  let highlights = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (skipTransparent && data[i + 3] < 16) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    px.push(r, g, b);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; // relative luminance
    lum.push(y);
    sum += y;
    if (y < 64) shadows++;
    else if (y > 191) highlights++;
    else midtones++;
  }
  return { px, lum, shadows, midtones, highlights, sum };
}

function analyzeLoadedImage(
  img: HTMLImageElement,
  origWidth?: number,
  origHeight?: number,
): PhysicsResult {
  const width = origWidth || img.naturalWidth;
  const height = origHeight || img.naturalHeight;
  const { data } = drawDownscaled(img, DOWNSAMPLE_EDGE, width || 1, height || 1);
  let stats = collectPixels(data, true);
  if (stats.px.length === 0) {
    stats = collectPixels(data, false);
  }
  const { px, lum, shadows, midtones, highlights, sum } = stats;

  const n = lum.length || 1;
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < lum.length; i++) {
    const d = lum[i] - mean;
    varSum += d * d;
  }
  const stdDev = Math.sqrt(varSum / n);

  const clusterCount = Math.max(1, Math.min(K, Math.floor(px.length / 3)));
  const clusters = kmeans(px, clusterCount, KMEANS_ITERS);
  const total = px.length / 3 || 1;
  const palette: PaletteColor[] = clusters.map((c) => ({
    hex: rgbToHex(c.r, c.g, c.b),
    percentage: Math.round((c.count / total) * 1000) / 10,
    rgb: [Math.round(c.r), Math.round(c.g), Math.round(c.b)],
  }));

  const pct = (v: number) => Math.round((v / n) * 1000) / 10;
  const pShadows = pct(shadows);
  const pHighlights = pct(highlights);
  let tag: string;
  if (pHighlights >= 55 && pShadows <= 20) tag = 'High-Key Bright 高调明亮';
  else if (pShadows >= 55 && pHighlights <= 20) tag = 'Low-Key Dark 低调暗黑';
  else if (stdDev >= 48 && pShadows >= 15 && pHighlights >= 8)
    tag = 'High Contrast Chiaroscuro 高反差明暗对照';
  else tag = 'Balanced Flat 均衡平调';

  return {
    width,
    height,
    aspectRatio: simplifyRatio(width, height),
    closestStandardRatio: closestStandardRatio(width, height),
    palette,
    luminance: {
      shadows: pShadows,
      midtones: pct(midtones),
      highlights: pHighlights,
      mean: Math.round(mean * 10) / 10,
      stdDev: Math.round(stdDev * 10) / 10,
      tag,
    },
  };
}

function renderScaledDataUrl(
  img: HTMLImageElement,
  maxEdge: number,
  mimeType: 'image/jpeg' | 'image/png',
  quality?: number,
  fallbackW = 1,
  fallbackH = 1,
): string {
  const srcW = img.naturalWidth || fallbackW;
  const srcH = img.naturalHeight || fallbackH;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  ctx.drawImage(img, 0, 0, w, h);
  return mimeType === 'image/png'
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', quality ?? 0.82);
}

/** Decode once to produce physics metrics, history thumbnail, and a rasterized Data URL for Vision LLM. */
export async function analyzeImageAndThumbnail(
  dataUrl: string,
  origWidth?: number,
  origHeight?: number,
  maxThumbEdge = 256,
): Promise<{ physics: PhysicsResult; thumbnail: string; rasterDataUrl: string }> {
  const img = await loadImage(dataUrl);
  const physics = analyzeLoadedImage(img, origWidth, origHeight);
  const thumbnail = renderScaledDataUrl(
    img,
    maxThumbEdge,
    'image/jpeg',
    0.82,
    physics.width || 1,
    physics.height || 1,
  );
  const isSupportedRaster = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(dataUrl);
  const rasterDataUrl = isSupportedRaster
    ? dataUrl
    : renderScaledDataUrl(img, 1024, 'image/png', undefined, physics.width || 1, physics.height || 1);
  return { physics, thumbnail, rasterDataUrl };
}
