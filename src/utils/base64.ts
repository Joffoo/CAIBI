export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function inferExtFromDataUrl(dataUrl: string): string {
  const m = /^data:image\/([a-zA-Z0-9+.-]+);/i.exec(dataUrl);
  const sub = m?.[1]?.toLowerCase() ?? '';
  if (sub === 'jpeg' || sub === 'jpg') return 'jpg';
  if (sub === 'webp') return 'webp';
  if (sub === 'gif') return 'gif';
  return 'png';
}
