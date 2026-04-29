import type { OpenAICompatibleSettings } from '../types/layers';

const STORAGE_KEY = 'live2d-clipper.openai-compatible-settings';

export const DEFAULT_OPENAI_SETTINGS: OpenAICompatibleSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  imageModel: '',
  llmModel: '',
  imageApiMode: 'edits',
  imageSize: '1024x1024',
  imageQuality: 'auto',
  imageResponseFormat: 'auto',
  llmTemperature: 0.1,
  useJsonResponseFormat: true,
};

export const loadOpenAISettings = (): OpenAICompatibleSettings => {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_OPENAI_SETTINGS };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_OPENAI_SETTINGS };
    }

    return {
      ...DEFAULT_OPENAI_SETTINGS,
      ...JSON.parse(raw),
    };
  } catch {
    return { ...DEFAULT_OPENAI_SETTINGS };
  }
};

export const saveOpenAISettings = (settings: OpenAICompatibleSettings) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};
