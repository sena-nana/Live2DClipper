import type { MatteBackground, SplitTier, SplitTierConfig } from '../types/layers';

export const MATTE_BACKGROUNDS = {
  highFrequency: {
    id: 'check-preview',
    name: '高频棋盘估算',
    hex: '#808080',
    rgb: [128, 128, 128],
    role: 'estimate',
  },
  black: {
    id: 'matte-black',
    name: '纯黑',
    hex: '#000000',
    rgb: [0, 0, 0],
    role: 'matte',
  },
  white: {
    id: 'matte-white',
    name: '纯白',
    hex: '#ffffff',
    rgb: [255, 255, 255],
    role: 'matte',
  },
  red: {
    id: 'matte-red',
    name: '纯红',
    hex: '#ff0000',
    rgb: [255, 0, 0],
    role: 'matte',
  },
  green: {
    id: 'matte-green',
    name: '纯绿',
    hex: '#00ff00',
    rgb: [0, 255, 0],
    role: 'matte',
  },
  blue: {
    id: 'matte-blue',
    name: '纯蓝',
    hex: '#0000ff',
    rgb: [0, 0, 255],
    role: 'matte',
  },
  checkPreview: {
    id: 'check-preview-only',
    name: '棋盘检查',
    hex: '#9aa0a6',
    rgb: [154, 160, 166],
    role: 'preview',
  },
} satisfies Record<string, MatteBackground>;

export const SPLIT_TIER_CONFIGS: Record<SplitTier, SplitTierConfig> = {
  estimate: {
    id: 'estimate',
    name: '估算',
    shortName: '估算',
    description: '单张高频背景辅助抠图，适合快速拆层和纯不透明部件。',
    transparentSupport: '不支持真实透明，只提供边缘估算',
    quality: '速度最快，透明区域仅供参考',
    backgrounds: [MATTE_BACKGROUNDS.highFrequency],
    outputCount: 1,
    algorithm: 'single-background-estimate',
  },
  modelAlpha: {
    id: 'modelAlpha',
    name: '实验',
    shortName: '实验',
    description: '先生成拆分颜色结果，再引导模型生成对应 Alpha 通道图。',
    transparentSupport: '实验性透明度，依赖模型理解蒙版',
    quality: '比估算更细，但不如差分法稳定',
    backgrounds: [MATTE_BACKGROUNDS.checkPreview],
    outputCount: 2,
    algorithm: 'model-generated-alpha',
  },
  standard: {
    id: 'standard',
    name: '标准',
    shortName: '标准',
    description: '黑白双背景差分，适合发丝、薄纱、简单发光等透明度。',
    transparentSupport: '支持简单透明度',
    quality: '需要模型保持前景一致',
    backgrounds: [MATTE_BACKGROUNDS.black, MATTE_BACKGROUNDS.white],
    outputCount: 2,
    algorithm: 'black-white-matting',
  },
  precise: {
    id: 'precise',
    name: '精确',
    shortName: '精确',
    description: '黑白红绿蓝五背景最小二乘，面向复杂透明材质和高光。',
    transparentSupport: '支持复杂透明度',
    quality: '最稳但生成成本最高',
    backgrounds: [
      MATTE_BACKGROUNDS.black,
      MATTE_BACKGROUNDS.white,
      MATTE_BACKGROUNDS.red,
      MATTE_BACKGROUNDS.green,
      MATTE_BACKGROUNDS.blue,
    ],
    outputCount: 5,
    algorithm: 'multi-background-least-squares',
  },
};

export const getTierConfig = (tier: SplitTier): SplitTierConfig => SPLIT_TIER_CONFIGS[tier];
