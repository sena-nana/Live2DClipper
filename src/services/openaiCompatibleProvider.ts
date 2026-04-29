import type {
  GenerationPayload,
  GenerationResult,
  LayerNode,
  MatteBackground,
  OpenAICompatibleSettings,
} from '../types/layers';
import { buildMergeRecipePrompt } from '../data/prompts';
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
    layer.promptHint ? `图层补充要求：${layer.promptHint}。` : '',
    mode === 'color'
      ? '请先生成该图层的颜色结果，背景保持简单中性，不需要在本步输出透明通道。'
      : `本次背景：${background.name} ${background.hex.toUpperCase()}。`,
    mode === 'color'
      ? ''
      : background.role === 'estimate'
        ? '使用高频检查背景估算边界；不需要恢复真实透明度。'
        : `背景必须是严格纯色 ${background.hex.toUpperCase()}，不要添加纹理、光照、阴影、渐变或环境。`,
    payload.guideImageUrl
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

  for (const layer of targetLayers) {
    if (payload.tier === 'modelAlpha') {
      const colorUrl = await requestImageVersion(payload, layer, payload.backgrounds[0], settings, 'color');
      const alphaUrl = await requestImageVersion(payload, layer, payload.backgrounds[0], settings, 'alpha', colorUrl);
      const recovered = await recoverFromModelAlpha(colorUrl, alphaUrl);
      const recipe = await requestMergeRecipe(payload, layer, settings);

      results.push({
        tier: payload.tier,
        layerId: layer.id,
        rgbaUrl: recovered.rgbaUrl,
        promptRecipe: recipe,
      });
      continue;
    }

    const composites: CompositeInput[] = [];

    for (const background of payload.backgrounds) {
      const compositeUrl = await requestImageVersion(payload, layer, background, settings);
      composites.push({ background, url: compositeUrl });
    }

    const recovered =
      payload.tier === 'estimate'
        ? await recoverFromEstimate(composites[0])
        : payload.tier === 'standard'
          ? await recoverFromBlackWhite(composites[0], composites[1])
          : await recoverFromMultiBackground(composites);

    const recipe = await requestMergeRecipe(payload, layer, settings);

    results.push({
      tier: payload.tier,
      layerId: layer.id,
      rgbaUrl: recovered.rgbaUrl,
      promptRecipe: recipe,
    });
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
) => {
  const prompt =
    mode === 'alpha'
      ? alphaPromptForLayer(payload, layer)
      : imagePromptForBackground(payload, layer, background, mode);

  if (
    settings.imageApiMode === 'edits' &&
    (payload.sourceImageUrl || payload.guideImageUrl || colorReferenceUrl)
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
      payload.guideImageUrl ? { url: payload.guideImageUrl, name: 'drawing-guide.png' } : null,
      colorReferenceUrl ? { url: colorReferenceUrl, name: 'color-result.png' } : null,
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
      payload.guideImageUrl
        ? '用户还绘制了指导图，但当前接口模式为 generations，无法直接传入该指导图；建议切换到 images/edits。'
        : '',
      colorReferenceUrl
        ? '当前需要根据已生成颜色结果生成 Alpha 蒙版，但 generations 模式无法直接传入颜色结果；建议切换到 images/edits。'
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
    '输出必须是一张严格的黑白/灰度 PNG 蒙版，尺寸与颜色结果完全一致。',
    '白色 #FFFFFF 表示完全不透明，黑色 #000000 表示完全透明，灰色表示半透明。',
    '请保留发丝、发光、薄纱、玻璃、烟雾、阴影等半透明过渡。',
    '不要输出彩色内容、线稿、背景、文字、说明或棋盘格。',
    payload.guideImageUrl
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
          `背景版本：${payload.backgrounds.map((background) => `${background.name} ${background.hex}`).join(', ')}`,
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
