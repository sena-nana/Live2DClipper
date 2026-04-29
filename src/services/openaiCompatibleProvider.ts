import type {
  GenerationPayload,
  GenerationResult,
  LayerNode,
  MatteBackground,
  OpenAICompatibleSettings,
} from '../types/layers';
import { buildMergeRecipePrompt } from '../data/prompts';
import { getTierConfig } from '../data/splitTiers';
import { tierOrDefault } from '../utils/layerTasks';
import {
  recoverFromBlackWhite,
  recoverFromEstimate,
  recoverFromModelAlpha,
  recoverFromMultiBackground,
  type CompositeInput,
} from '../utils/matting';
import { dataUrlToBlob, remoteImageToDataUrl } from '../utils/dataUrl';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
}

const trimBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

const asEndpoint = (baseUrl: string, path: string) => `${trimBaseUrl(baseUrl)}${path}`;

const buildAuthHeaders = (settings: OpenAICompatibleSettings) => {
  const headers: Record<string, string> = {};

  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  }

  return headers;
};

const ensureSettings = (settings: OpenAICompatibleSettings) => {
  if (!settings.baseUrl.trim()) {
    throw new Error('请先在设置中填写 OpenAI 兼容接口 Base URL');
  }

  if (!settings.imageModel.trim()) {
    throw new Error('请先在设置中填写生图模型名称');
  }

  if (!settings.llmModel.trim()) {
    throw new Error('请先在设置中填写 LLM 模型名称');
  }
};

const imagePromptForBackground = (
  payload: GenerationPayload,
  layer: LayerNode,
  background: MatteBackground,
  mode: 'matte' | 'color' = 'matte',
) =>
  [
    payload.prompt,
    '',
    `当前只处理图层：${layer.name}。图层类型：${layer.partType}。`,
    `图层操作：${layer.editSpec.operation}。方位：${layer.side}。目标结构：${layer.editSpec.targetStructure || '按图层名判断'}。`,
    layer.role === 'reference'
      ? '当前图层是拆分参考结构层。请生成用于指导后续拆分的结构参考图，重点表达分区边界、切分顺序和部件框架；该结果不会作为最终 PSD 输出。'
      : '',
    `单层修改说明：${layer.editSpec.instruction || layer.promptHint || '按 Live2D 可绑定拆分补齐。'}`,
    `补边需求：向遮挡区域合理延展约 ${layer.editSpec.edgePadding}px；成对部件：${layer.editSpec.paired ? '是' : '否'}；遮罩层：${layer.editSpec.asMask ? '是' : '否'}。`,
    layer.sources.length > 0
      ? `来源图层：${layer.sources.map((source) => `${source.role}:${source.layerId}(${source.note})`).join('；')}。`
      : '',
    layer.promptHint ? `图层补充要求：${layer.promptHint}。` : '',
    mode === 'color'
      ? '请先生成该图层的颜色结果，背景保持简单中性，不需要在本步输出透明通道。'
      : `本次背景：${background.name} ${background.hex.toUpperCase()}。`,
    mode === 'color'
      ? ''
      : background.role === 'estimate'
        ? '使用高频检查背景估算边界；不需要恢复真实透明度。'
        : `背景必须是严格纯色 ${background.hex.toUpperCase()}，不要添加纹理、光照、阴影、渐变或环境。`,
    (layer.guideImageUrl || payload.guideImageUrl)
      ? '用户提供了一张透明背景的绘制指导图作为额外参考。请把其中的笔触理解为拆分边界、补全部位、透明区域或局部修改意图，不要把彩色笔触原样画进最终图像。'
      : '',
    '保持前景主体、轮廓、半透明区域、发光、毛发、材质和位置完全不变。',
    '如果需要补全被遮挡区域，只补全该图层本身，不要生成其他图层内容。',
  ]
    .filter(Boolean)
    .join('\n');

export const runOpenAICompatibleGeneration = async (
  payload: GenerationPayload,
  settings: OpenAICompatibleSettings,
): Promise<GenerationResult[]> => {
  ensureSettings(settings);

  const targetLayers =
    payload.changedLayers.length > 0
      ? payload.changedLayers
      : payload.layerTree.flatMap((node) => node.children ?? [node]).filter((node) => node.type === 'layer');

  if (targetLayers.length === 0) {
    throw new Error('没有可生成的图层');
  }

  const results: GenerationResult[] = [];
  const generatedLayerImages = new Map<string, string>();

  for (const layer of targetLayers) {
    const layerTier = tierOrDefault(layer.editSpec.algorithmOverride, payload.tier);
    const layerConfig = getTierConfig(layerTier);
    if (layerTier === 'modelAlpha') {
      const colorUrl = await requestImageVersion(
        payload,
        layer,
        layerConfig.backgrounds[0],
        settings,
        'color',
        undefined,
        generatedLayerImages,
      );
      const alphaUrl = await requestImageVersion(
        payload,
        layer,
        layerConfig.backgrounds[0],
        settings,
        'alpha',
        colorUrl,
        generatedLayerImages,
      );
      const recovered = await recoverFromModelAlpha(colorUrl, alphaUrl);
      const recipe = await requestMergeRecipe(payload, layer, settings);

      results.push({
        tier: layerTier,
        layerId: layer.id,
        operation: layer.editSpec.operation,
        rgbaUrl: recovered.rgbaUrl,
        promptRecipe: recipe,
      });
      generatedLayerImages.set(layer.id, recovered.rgbaUrl);
      continue;
    }

    const composites: CompositeInput[] = [];

    for (const background of layerConfig.backgrounds) {
      const compositeUrl = await requestImageVersion(
        payload,
        layer,
        background,
        settings,
        'matte',
        undefined,
        generatedLayerImages,
      );
      composites.push({ background, url: compositeUrl });
    }

    const recovered =
      layerTier === 'estimate'
        ? await recoverFromEstimate(composites[0])
        : layerTier === 'standard'
          ? await recoverFromBlackWhite(composites[0], composites[1])
          : await recoverFromMultiBackground(composites);

    const recipe = await requestMergeRecipe(payload, layer, settings);

    results.push({
      tier: layerTier,
      layerId: layer.id,
      operation: layer.editSpec.operation,
      rgbaUrl: recovered.rgbaUrl,
      promptRecipe: recipe,
    });
    generatedLayerImages.set(layer.id, recovered.rgbaUrl);
  }

  return results;
};

const requestImageVersion = async (
  payload: GenerationPayload,
  layer: LayerNode,
  background: MatteBackground,
  settings: OpenAICompatibleSettings,
  mode: 'matte' | 'color' | 'alpha' = 'matte',
  colorReferenceUrl?: string,
  generatedLayerImages = new Map<string, string>(),
) => {
  const prompt =
    mode === 'alpha'
      ? alphaPromptForLayer(payload, layer)
      : imagePromptForBackground(payload, layer, background, mode);
  const generatedReferenceImages = layer.sources
    .map((source) => generatedLayerImages.get(source.layerId))
    .filter((url): url is string => Boolean(url));

  if (
    settings.imageApiMode === 'edits' &&
    (payload.sourceImageUrl ||
      layer.guideImageUrl ||
      payload.guideImageUrl ||
      colorReferenceUrl ||
      generatedReferenceImages.length > 0)
  ) {
    const formData = new FormData();
    formData.append('model', settings.imageModel.trim());
    formData.append('prompt', prompt);
    formData.append('size', settings.imageSize);

    if (settings.imageQuality !== 'auto') {
      formData.append('quality', settings.imageQuality);
    }

    if (settings.imageResponseFormat !== 'auto') {
      formData.append('response_format', settings.imageResponseFormat);
    }

    const inputImages = [
      payload.sourceImageUrl ? { url: payload.sourceImageUrl, name: 'source.png' } : null,
      layer.guideImageUrl || payload.guideImageUrl
        ? { url: layer.guideImageUrl ?? payload.guideImageUrl ?? '', name: 'drawing-guide.png' }
        : null,
      colorReferenceUrl ? { url: colorReferenceUrl, name: 'color-result.png' } : null,
      ...generatedReferenceImages.map((url, index) => ({
        url,
        name: `structure-reference-${index + 1}.png`,
      })),
    ].filter((image): image is { url: string; name: string } => Boolean(image));
    const imageFieldName = inputImages.length > 1 ? 'image[]' : 'image';

    for (const image of inputImages) {
      formData.append(imageFieldName, await dataUrlToBlob(image.url), image.name);
    }

    const response = await fetch(asEndpoint(settings.baseUrl, '/images/edits'), {
      method: 'POST',
      headers: buildAuthHeaders(settings),
      body: formData,
    });

    return parseImageResponse(response);
  }

  const body: Record<string, unknown> = {
    model: settings.imageModel.trim(),
    prompt: [
      prompt,
      '',
      payload.sourceImageUrl
        ? '用户上传了原始立绘，但当前接口模式为 generations，无法直接传入参考图；请根据文本要求生成背景版本。'
        : '',
      (layer.guideImageUrl || payload.guideImageUrl)
        ? '用户还绘制了指导图，但当前接口模式为 generations，无法直接传入该指导图；建议切换到 images/edits。'
        : '',
      colorReferenceUrl
        ? '当前需要根据已生成颜色结果生成 Alpha 蒙版，但 generations 模式无法直接传入颜色结果；建议切换到 images/edits。'
        : '',
      generatedReferenceImages.length > 0
        ? `本图层有 ${generatedReferenceImages.length} 张已生成的参考结构图，但 generations 模式无法直接传入；请严格遵循提示词中的参考结构来源说明。`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    size: settings.imageSize,
    n: 1,
  };

  if (settings.imageQuality !== 'auto') {
    body.quality = settings.imageQuality;
  }

  if (settings.imageResponseFormat !== 'auto') {
    body.response_format = settings.imageResponseFormat;
  }

  const response = await fetch(asEndpoint(settings.baseUrl, '/images/generations'), {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return parseImageResponse(response);
};

const alphaPromptForLayer = (payload: GenerationPayload, layer: LayerNode) =>
  [
    '任务：根据提供的拆分颜色结果，生成对应的 Alpha 通道图。',
    `当前图层：${layer.name}。图层类型：${layer.partType}。`,
    `图层操作：${layer.editSpec.operation}。单层说明：${layer.editSpec.instruction || layer.promptHint || '按图层需求生成 Alpha。'}`,
    '输出必须是一张严格的黑白/灰度 PNG 蒙版，尺寸与颜色结果完全一致。',
    '白色 #FFFFFF 表示完全不透明，黑色 #000000 表示完全透明，灰色表示半透明。',
    '请保留发丝、发光、薄纱、玻璃、烟雾、阴影等半透明过渡。',
    '不要输出彩色内容、线稿、背景、文字、说明或棋盘格。',
    (layer.guideImageUrl || payload.guideImageUrl)
      ? '用户绘制的指导图用于提示透明边界和需要保留/擦除的区域，不要把彩色笔触画入蒙版。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

const parseImageResponse = async (response: Response) => {
  const json = (await response.json().catch(() => ({}))) as ImageResponse;

  if (!response.ok) {
    throw new Error(json.error?.message ?? `生图接口请求失败：${response.status}`);
  }

  const image = json.data?.[0];
  if (!image) {
    throw new Error('生图接口没有返回图片');
  }

  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }

  if (image.url) {
    return remoteImageToDataUrl(image.url);
  }

  throw new Error('生图接口返回格式不包含 b64_json 或 url');
};

const requestMergeRecipe = async (
  payload: GenerationPayload,
  layer: LayerNode,
  settings: OpenAICompatibleSettings,
) => {
  const body: Record<string, unknown> = {
    model: settings.llmModel.trim(),
    temperature: settings.llmTemperature,
    messages: [
      {
        role: 'system',
        content: buildMergeRecipePrompt(),
      },
      {
        role: 'user',
        content: [
          '请为下面的 Live2D 图层拆分结果输出合并 recipe。',
          `项目：${payload.projectName}`,
          `档位：${payload.tier}`,
          `图层：${layer.name}`,
          `图层 ID：${layer.id}`,
          `图层类型：${layer.partType}`,
          `操作类型：${layer.editSpec.operation}`,
          `方位：${layer.side}`,
          `来源：${layer.sources.map((source) => `${source.role}:${source.layerId}(${source.note})`).join(', ') || '无'}`,
          `单层说明：${layer.editSpec.instruction || layer.promptHint || '无'}`,
          `背景版本：${getTierConfig(tierOrDefault(layer.editSpec.algorithmOverride, payload.tier)).backgrounds.map((background) => `${background.name} ${background.hex}`).join(', ')}`,
          '只输出 JSON，不要输出解释文字。',
        ].join('\n'),
      },
    ],
  };

  if (settings.useJsonResponseFormat) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(asEndpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as ChatCompletionResponse;

  if (!response.ok) {
    throw new Error(json.error?.message ?? `LLM 接口请求失败：${response.status}`);
  }

  return json.choices?.[0]?.message?.content ?? '{}';
};
