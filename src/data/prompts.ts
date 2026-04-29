import type { FlatLayerNode, LayerNode, SplitPartType, SplitTier } from '../types/layers';
import { getTierConfig } from './splitTiers';
import { operationLabel, sideLabel, tierOrDefault } from '../utils/layerTasks';

const PART_PROMPTS: Record<SplitPartType, string> = {
  base: '保持角色基础轮廓、躯干遮挡补全和 Live2D 可绑定边缘。',
  hair: '重点保持发丝边缘、半透明发梢、内侧被遮挡发束和可分层摆动区域。',
  face: '保留脸部轮廓、肤色过渡和被头发遮挡处的合理补全。',
  eyes: '拆出眼白、虹膜、高光与眼睑边缘，避免改变视线方向。',
  mouth: '保留口型边缘、内侧阴影和后续变形所需的闭合区域。',
  body: '补全肩颈、躯干和被衣物遮挡的连接处，保持绑定用连续边界。',
  clothing: '保留衣物褶皱、阴影、高光和被肢体遮挡处的合理延展。',
  limb: '补全手臂、手指、腿部连接处，避免关节边缘缺失。',
  accessory: '保留饰品硬边、高光和挂点，透明材质需要单独保留 alpha。',
  shadow: '只拆出柔和阴影层，避免把底色或线稿混入阴影。',
  effect: '保留发光、烟雾、魔法特效的半透明渐变和边缘能量。',
};

const TIER_PROMPTS: Record<SplitTier, string> = {
  estimate:
    '使用单张高频检查背景进行快速估算。该档位不要求恢复真实透明度，优先保证图层边界完整、无明显缺口。',
  modelAlpha:
    '使用实验性模型 Alpha 蒙版方案。先生成拆分颜色结果，再根据颜色结果生成对应黑白 Alpha 通道图；白色表示完全不透明，黑色表示完全透明，灰色表示半透明。',
  standard:
    '使用黑白双背景差分。请输出同一前景分别位于纯黑和纯白背景上的版本。只允许背景颜色变化，禁止修改前景任何像素。',
  precise:
    '使用黑、白、红、绿、蓝五背景最小二乘 matting。请输出同一前景分别位于五种纯色背景上的版本，前景形状、位置、轮廓、发光、毛发和材质必须完全一致。',
};

const sourceName = (flatLayers: FlatLayerNode[], id: string) =>
  flatLayers.find((layer) => layer.id === id)?.name ?? id;

export const buildSplitPrompt = (tier: SplitTier, changedLayers: LayerNode[], flatLayers: FlatLayerNode[] = []) => {
  const config = getTierConfig(tier);
  const partLines = changedLayers.map((layer) => {
    const partPrompt = PART_PROMPTS[layer.partType] ?? PART_PROMPTS.base;
    const layerTier = getTierConfig(tierOrDefault(layer.editSpec.algorithmOverride, tier));
    const sources = layer.sources.length
      ? layer.sources
          .map((source) => `${source.role}=${sourceName(flatLayers, source.layerId)}（${source.note}）`)
          .join('；')
      : '无显式来源，参考原始立绘。';
    return [
      `- ${layer.name}: ${partPrompt}`,
      `  操作：${operationLabel(layer.editSpec.operation)} / ${layer.editSpec.operation}；方位：${sideLabel(layer.side) || 'none'}；导出：${layer.exportable ? '是' : '否'}。`,
      layer.role === 'reference'
        ? '  该目标是参考结构层：请先生成清晰的拆分结构、边界或分区参考，用于后续目标图层继续拆分；不要把它视为最终 PSD 输出。'
        : '',
      `  来源：${sources}`,
      `  目标结构：${layer.editSpec.targetStructure || '按图层名与部件类型判断'}`,
      `  单层说明：${layer.editSpec.instruction || layer.promptHint || '按 Live2D 可绑定拆分补齐。'}`,
      `  补边：${layer.editSpec.edgePadding}px；成对部件：${layer.editSpec.paired ? '是' : '否'}；遮罩层：${layer.editSpec.asMask ? '是' : '否'}。`,
      `  算法覆盖：${layerTier.name}。`,
    ].join('\n');
  });

  const backgroundLines = config.backgrounds.map(
    (background) => `- ${background.name}: ${background.hex.toUpperCase()}`,
  );

  return [
    '任务：将用户提供的立绘拆分为 Live2D 可编辑图层。',
    '保持画面尺寸、角色比例、轮廓位置和线稿风格完全一致。',
    '不要添加额外背景、光影、纹理或环境元素。',
    '需要补全被遮挡区域，使图层可独立显示并适合后续绑定。',
    '',
    `透明度档位：${config.name}。${TIER_PROMPTS[tier]}`,
    `算法：${config.algorithm}。${config.transparentSupport}。`,
    '',
    '需要拆分或重新生成的部件：',
    partLines.length > 0 ? partLines.join('\n') : '- 当前选中图层：按图层树 dirty 状态处理。',
    '',
    '背景版本：',
    backgroundLines.length > 0 ? backgroundLines.join('\n') : '- 无固定背景版本，按模型 Alpha 蒙版流程处理。',
    '',
    '输出要求：PNG，无损，sRGB，尺寸完全一致。用于差分的背景必须是严格纯色，不使用渐变、抗锯齿边界或压缩。',
  ].join('\n');
};

export const buildMergeRecipePrompt = () =>
  [
    '请按照固定 JSON 模板输出图层合并 recipe，不要输出可执行代码。',
    '模板字段：layerId、sourceBackgrounds、alphaStrategy、rgbStrategy、bounds、blendMode、opacity、notes。',
    'alphaStrategy 只能是 opaque_estimate、model_alpha_mask、black_white_difference 或 multi_background_least_squares。',
    'rgbStrategy 只能是 original_color_recovery、model_color_with_mask 或 alpha_unpremultiply。',
  ].join('\n');
