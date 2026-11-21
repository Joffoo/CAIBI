import { DEFAULT_SETTINGS, type ExtensionSettings } from '../utils/types';

const STORAGE_KEY = 'vrc_settings';

/** Normalize stored settings, trim whitespace, and strip obsolete fields. */
export function normalizeSettings(raw?: Partial<ExtensionSettings> | null): ExtensionSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const triggerMode =
    merged.triggerMode === 'shortcut' ||
    merged.triggerMode === 'badge' ||
    merged.triggerMode === 'both'
      ? merged.triggerMode
      : DEFAULT_SETTINGS.triggerMode;
  return {
    baseUrl: (merged.baseUrl ?? '').trim() || DEFAULT_SETTINGS.baseUrl,
    apiKey: (merged.apiKey ?? '').trim(),
    model: (merged.model ?? '').trim(),
    triggerMode,
    imageGenBaseUrl: (merged.imageGenBaseUrl ?? '').trim(),
    imageGenApiKey: (merged.imageGenApiKey ?? '').trim(),
    imageGenModel: (merged.imageGenModel ?? '').trim(),
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeSettings(obj[STORAGE_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const merged = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}

export function watchSettings(cb: (s: ExtensionSettings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(normalizeSettings(changes[STORAGE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
