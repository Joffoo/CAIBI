export interface PaletteColor {
  hex: string;
  percentage: number;
  rgb: [number, number, number];
}

export interface LuminanceProfile {
  shadows: number;
  midtones: number;
  highlights: number;
  mean: number;
  stdDev: number;
  tag: string;
}

export interface PhysicsResult {
  width: number;
  height: number;
  aspectRatio: string;
  closestStandardRatio: string;
  palette: PaletteColor[];
  luminance: LuminanceProfile;
}

export interface JsonPromptSpec {
  aspect_ratio: string;
  subject: string;
  style_medium: string;
  composition_camera: string;
  lighting_atmosphere: string;
  color_palette: string;
  details_texture: string;
  [key: string]: string;
}

export interface ShortTemplateSpec {
  template: string;
  default_subject: string;
  subject_suggestions: string[];
}

export interface CompiledResult {
  category: string;
  tags: string[];
  json_prompt: JsonPromptSpec;
  short_prompt: string;
  /** @deprecated Legacy field kept optional for reading older IndexedDB records. */
  short_template?: ShortTemplateSpec;
}

export interface HistoryRecord {
  id: string;
  createdAt: number;
  srcUrl: string;
  pageUrl: string;
  pageTitle: string;
  thumbnail: string;
  physics: PhysicsResult;
  result: CompiledResult | null;
}

export interface CharacterAsset {
  id: string;
  createdAt: number;
  name: string;
  dataUrl: string;
  prompt: string;
  sourceUrl?: string;
}

export type TriggerMode = 'shortcut' | 'badge' | 'both';

export interface ExtensionSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  triggerMode: TriggerMode;
  imageGenBaseUrl: string;
  imageGenApiKey: string;
  imageGenModel: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  triggerMode: 'shortcut',
  imageGenBaseUrl: '',
  imageGenApiKey: '',
  imageGenModel: '',
};
