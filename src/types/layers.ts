export type SplitTier = 'estimate' | 'modelAlpha' | 'standard' | 'precise';

export type LayerStatus =
  | 'clean'
  | 'dirty'
  | 'generating'
  | 'pendingReview'
  | 'approved'
  | 'failed';

export type SplitPartType =
  | 'base'
  | 'hair'
  | 'face'
  | 'eyes'
  | 'mouth'
  | 'body'
  | 'clothing'
  | 'limb'
  | 'accessory'
  | 'shadow'
  | 'effect';

export interface LayerNode {
  id: string;
  name: string;
  type: 'group' | 'layer';
  partType: SplitPartType;
  status: LayerStatus;
  visible: boolean;
  solo: boolean;
  locked: boolean;
  opacity: number;
  children?: LayerNode[];
  imageUrl?: string;
  promptHint?: string;
}

export interface FlatLayerNode extends LayerNode {
  depth: number;
  parentId: string | null;
}

export interface MatteBackground {
  id: string;
  name: string;
  hex: string;
  rgb: [number, number, number];
  role: 'estimate' | 'matte' | 'preview';
}

export interface SplitTierConfig {
  id: SplitTier;
  name: string;
  shortName: string;
  description: string;
  transparentSupport: string;
  quality: string;
  backgrounds: MatteBackground[];
  outputCount: number;
  algorithm:
    | 'single-background-estimate'
    | 'model-generated-alpha'
    | 'black-white-matting'
    | 'multi-background-least-squares';
}

export interface GenerationPayload {
  projectName: string;
  tier: SplitTier;
  sourceImageUrl: string | null;
  guideImageUrl: string | null;
  layerTree: LayerNode[];
  changedLayers: LayerNode[];
  prompt: string;
  backgrounds: MatteBackground[];
}

export type ImageApiMode = 'edits' | 'generations';
export type ImageResponseFormat = 'auto' | 'b64_json' | 'url';

export interface OpenAICompatibleSettings {
  baseUrl: string;
  apiKey: string;
  imageModel: string;
  llmModel: string;
  imageApiMode: ImageApiMode;
  imageSize: string;
  imageQuality: 'auto' | 'low' | 'medium' | 'high';
  imageResponseFormat: ImageResponseFormat;
  llmTemperature: number;
  useJsonResponseFormat: boolean;
}

export interface GenerationResult {
  tier: SplitTier;
  layerId: string;
  rgbaUrl: string;
  promptRecipe: string;
}

export interface ProjectSnapshot {
  projectName: string;
  sourceImageUrl: string | null;
  draftTree: LayerNode[];
  appliedTree: LayerNode[];
  selectedLayerId: string | null;
  selectedTier: SplitTier;
}
