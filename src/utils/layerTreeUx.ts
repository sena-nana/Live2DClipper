import type { FlatLayerNode, LayerNode, LayerOperation, LayerRole, LayerSide, LayerStatus } from '../types/layers';
import { operationLabel } from './layerTasks';

export type LayerTreeFilter = 'all' | 'dirty' | 'review' | 'failed' | 'reference';

export interface LayerCompactMarker {
  label: string;
  tone: LayerStatus | LayerRole | LayerOperation;
}

const statusNames: Record<LayerStatus, string> = {
  clean: '已应用',
  dirty: '已修改',
  generating: '生成中',
  pendingReview: '待审核',
  approved: '已确认',
  failed: '失败',
};

const operationNames: Record<LayerOperation, string> = {
  manual: '手动',
  split: '拆分',
  backfill: '背面补全',
  occlusionFill: '遮挡补全',
  repair: '修复',
  merge: '合并',
};

const roleNames: Record<LayerRole, string> = {
  artwork: '输出图层',
  reference: '参考源',
  guide: '指导层',
  mask: '遮罩层',
};

const sideNames: Record<LayerSide, string> = {
  none: '无',
  front: '前',
  back: '背',
  left: '左',
  right: '右',
  inner: '内',
};

const filterMatchesStatus = (layer: FlatLayerNode, status: LayerTreeFilter) => {
  if (status === 'all') {
    return true;
  }

  if (status === 'dirty') {
    return layer.status === 'dirty';
  }

  if (status === 'review') {
    return layer.status === 'pendingReview';
  }

  if (status === 'failed') {
    return layer.status === 'failed';
  }

  return layer.role === 'reference';
};

const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase();

const searchableLayerText = (layer: FlatLayerNode, sourceNameById: Map<string, string>) =>
  [
    layer.name,
    layer.partType,
    layer.status,
    layer.role,
    layer.side,
    layer.editSpec.operation,
    layer.editSpec.instruction,
    layer.editSpec.targetStructure,
    layer.promptHint ?? '',
    ...layer.sources.flatMap((source) => [
      source.role,
      source.note,
      sourceNameById.get(source.layerId) ?? source.layerId,
    ]),
  ]
    .join(' ')
    .toLocaleLowerCase();

export const filterLayerTreeRows = (
  rows: FlatLayerNode[],
  options: {
    query: string;
    status: LayerTreeFilter;
    sourceNameById: Map<string, string>;
  },
) => {
  const query = normalizeSearch(options.query);

  return rows.filter((layer) => {
    if (!filterMatchesStatus(layer, options.status)) {
      return false;
    }

    if (!query) {
      return true;
    }

    return searchableLayerText(layer, options.sourceNameById).includes(query);
  });
};

export const layerCompactMarker = (layer: Pick<LayerNode, 'status' | 'role' | 'editSpec'>): LayerCompactMarker | null => {
  if (layer.status === 'pendingReview') {
    return { label: '待审', tone: 'pendingReview' };
  }

  if (layer.status === 'failed') {
    return { label: '失败', tone: 'failed' };
  }

  if (layer.status === 'generating') {
    return { label: '生成', tone: 'generating' };
  }

  if (layer.status === 'dirty') {
    return { label: '已改', tone: 'dirty' };
  }

  if (layer.role === 'reference') {
    return { label: '参', tone: 'reference' };
  }

  if (layer.role === 'guide') {
    return { label: '导', tone: 'guide' };
  }

  if (layer.role === 'mask') {
    return { label: '罩', tone: 'mask' };
  }

  if (layer.editSpec.operation !== 'manual') {
    return { label: operationLabel(layer.editSpec.operation), tone: layer.editSpec.operation };
  }

  return null;
};

export const layerTaskTooltip = (
  layer: Pick<
    LayerNode,
    'name' | 'status' | 'role' | 'side' | 'exportable' | 'sources' | 'editSpec'
  >,
  sourceNameById: Map<string, string>,
) => {
  const lines = [
    layer.name,
    `状态：${statusNames[layer.status]}`,
    `角色：${roleNames[layer.role]}`,
    `操作：${operationNames[layer.editSpec.operation]}`,
    `方位：${sideNames[layer.side]}`,
    `导出：${layer.exportable ? '是' : '否'}`,
  ];

  if (layer.editSpec.targetStructure) {
    lines.push(`结构：${layer.editSpec.targetStructure}`);
  }

  if (layer.sources.length > 0) {
    lines.push(
      `来源：${layer.sources
        .map((source) => `${source.role}: ${sourceNameById.get(source.layerId) ?? source.layerId}`)
        .join(' / ')}`,
    );
  } else {
    lines.push('来源：原始立绘');
  }

  if (layer.editSpec.instruction) {
    lines.push(`说明：${layer.editSpec.instruction}`);
  }

  return lines.join('\n');
};

