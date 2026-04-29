export type SplitTier = 'estimate' | 'modelAlpha' | 'standard' | 'precise';

export type LayerStatus =
  | 'clean'
  | 'dirty'
  | 'generating'
  | 'pendingReview'
  | 'approved'
  | 'failed';

export type LayerRole = 'artwork' | 'reference' | 'guide' | 'mask';

export type LayerSide = 'none' | 'front' | 'back' | 'left' | 'right' | 'inner';

export type LayerSourceRole = 'primary' | 'style' | 'occlusion' | 'mask';

export type LayerOperation = 'manual' | 'split' | 'backfill' | 'occlusionFill' | 'repair' | 'merge';

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
  role: LayerRole;
  side: LayerSide;
  exportable: boolean;
  visible: boolean;
  solo: boolean;
  locked: boolean;
  opacity: number;
  children?: LayerNode[];
  imageUrl?: string;
  guideImageUrl?: string;
  promptHint?: string;
  sources: LayerSourceRef[];
  editSpec: LayerEditSpec;
  revisions: LayerRevision[];
}

export interface FlatLayerNode extends LayerNode {
  depth: number;
  parentId: string | null;
}

export interface LayerSourceRef {
  layerId: string;
  role: LayerSourceRole;
  note: string;
}

export interface LayerEditSpec {
  operation: LayerOperation;
  instruction: string;
  edgePadding: number;
  paired: boolean;
  asMask: boolean;
  algorithmOverride: SplitTier | null;
  targetStructure: string;
}

export interface LayerRevision {
  id: string;
  createdAt: string;
  operation: LayerOperation;
  promptRecipe: string;
  imageUrl?: string;
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
  operation: LayerOperation;
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
