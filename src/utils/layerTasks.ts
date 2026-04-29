import type {
  FlatLayerNode,
  LayerEditSpec,
  LayerNode,
  LayerOperation,
  LayerRevision,
  LayerRole,
  LayerSide,
  LayerSourceRef,
  LayerStatus,
  SplitPartType,
  SplitTier,
} from '../types/layers';
import { createId } from './id';
import {
  cloneTree,
  findLayer,
  flattenTree,
  insertLayerAfter,
  updateLayer,
  updateLayerStatus,
} from './tree';

export const defaultEditSpec = (
  operation: LayerOperation = 'manual',
  instruction = '',
): LayerEditSpec => ({
  operation,
  instruction,
  edgePadding: 12,
  paired: false,
  asMask: false,
  algorithmOverride: null,
  targetStructure: '',
});

export const normalizeLayerNode = (node: LayerNode): LayerNode => ({
  ...node,
  role: node.role ?? 'artwork',
  side: node.side ?? 'none',
  exportable: node.exportable ?? node.type === 'layer',
  sources: node.sources ?? [],
  editSpec: node.editSpec ?? defaultEditSpec(),
  revisions: node.revisions ?? [],
  children: node.children?.map(normalizeLayerNode),
});

export const normalizeTree = (nodes: LayerNode[]): LayerNode[] => nodes.map(normalizeLayerNode);

export const createLayerNode = (options: {
  name: string;
  type?: 'layer' | 'group';
  partType?: SplitPartType;
  status?: LayerStatus;
  role?: LayerRole;
  side?: LayerSide;
  exportable?: boolean;
  locked?: boolean;
  opacity?: number;
  promptHint?: string;
  sources?: LayerSourceRef[];
  editSpec?: Partial<LayerEditSpec> & Pick<LayerEditSpec, 'operation'>;
  children?: LayerNode[];
}): LayerNode => {
  const type = options.type ?? 'layer';
  const operation = options.editSpec?.operation ?? 'manual';

  return {
    id: createId(type),
    name: options.name,
    type,
    partType: options.partType ?? 'base',
    status: options.status ?? 'dirty',
    role: options.role ?? 'artwork',
    side: options.side ?? 'none',
    exportable: options.exportable ?? type === 'layer',
    visible: true,
    solo: false,
    locked: options.locked ?? false,
    opacity: options.opacity ?? 1,
    promptHint: options.promptHint,
    sources: options.sources ?? [],
    editSpec: {
      ...defaultEditSpec(operation),
      ...(options.editSpec ?? {}),
    },
    revisions: [],
    children: options.children,
  };
};

export const summarizeLayerSource = (source: LayerNode, note: string): LayerSourceRef => ({
  layerId: source.id,
  role: 'primary',
  note,
});

export interface PlannedSplitTarget {
  name: string;
  side: LayerSide;
  operation: LayerOperation;
  instruction: string;
  paired?: boolean;
  reference: boolean;
}

const plannedSplitTemplates: Record<
  SplitPartType,
  Array<{
    suffix: string;
    side: LayerSide;
    operation: LayerOperation;
    instruction: string;
    paired?: boolean;
    reference?: boolean;
  }>
> = {
  hair: [
    { suffix: '前发', side: 'front', operation: 'split', instruction: '拆出前发，保留遮挡脸部的发束边缘。' },
    { suffix: '侧发 L', side: 'left', operation: 'split', instruction: '拆出左侧侧发，保留可摆动边缘。', paired: true },
    { suffix: '侧发 R', side: 'right', operation: 'split', instruction: '拆出右侧侧发，保留可摆动边缘。', paired: true },
    { suffix: '后发', side: 'back', operation: 'split', instruction: '拆出后发主体，补齐被身体遮挡的内侧边界。' },
    { suffix: '后发背面补全', side: 'back', operation: 'backfill', instruction: '生成后发背面补全，补齐被头部、肩部和服装遮挡的发束根部。' },
  ],
  clothing: [
    { suffix: '前片', side: 'front', operation: 'split', instruction: '拆出衣服正面可见结构，保留褶皱与边缘高光。' },
    { suffix: '左侧', side: 'left', operation: 'split', instruction: '拆出衣服左侧结构并补齐侧边。', paired: true },
    { suffix: '右侧', side: 'right', operation: 'split', instruction: '拆出衣服右侧结构并补齐侧边。', paired: true },
    { suffix: '背面补全', side: 'back', operation: 'backfill', instruction: '生成衣服背面结构，补齐被身体和头发遮挡的布料延展。' },
  ],
  body: [
    { suffix: '躯干', side: 'front', operation: 'split', instruction: '拆出身体躯干，补齐被衣服遮挡的绑定连接区。' },
    { suffix: '背面补全', side: 'back', operation: 'backfill', instruction: '生成身体背面或被衣物遮挡区域的合理补全。' },
  ],
  limb: [
    { suffix: '左侧', side: 'left', operation: 'split', instruction: '拆出左侧肢体并补齐关节连接处。', paired: true },
    { suffix: '右侧', side: 'right', operation: 'split', instruction: '拆出右侧肢体并补齐关节连接处。', paired: true },
    { suffix: '遮挡补全', side: 'inner', operation: 'occlusionFill', instruction: '补齐被其他部件遮挡的肢体边界。' },
  ],
  face: [
    { suffix: '脸部底色', side: 'front', operation: 'split', instruction: '拆出脸部底色，补齐被头发遮挡的皮肤边界。' },
    { suffix: '遮挡补全', side: 'front', operation: 'occlusionFill', instruction: '补全被前发遮挡的脸部区域，保持肤色过渡。' },
  ],
  eyes: [
    { suffix: '左眼', side: 'left', operation: 'split', instruction: '拆出左眼结构，保留眼白、虹膜和高光。', paired: true },
    { suffix: '右眼', side: 'right', operation: 'split', instruction: '拆出右眼结构，保留眼白、虹膜和高光。', paired: true },
  ],
  mouth: [
    { suffix: '嘴部', side: 'front', operation: 'split', instruction: '拆出嘴部闭合区域，保留口型变形边缘。' },
  ],
  accessory: [
    { suffix: '主体', side: 'front', operation: 'split', instruction: '拆出饰品主体，保留硬边、高光和挂点。' },
    { suffix: '背面补全', side: 'back', operation: 'backfill', instruction: '生成饰品背面或被遮挡结构。' },
  ],
  shadow: [
    { suffix: '阴影', side: 'none', operation: 'split', instruction: '只拆出柔和阴影，避免混入底色或线稿。' },
  ],
  effect: [
    { suffix: '特效', side: 'none', operation: 'split', instruction: '拆出特效层并保留半透明渐变。' },
  ],
  base: [
    { suffix: '主体', side: 'front', operation: 'split', instruction: '拆出基础主体轮廓并补齐绑定需要的边缘。' },
    { suffix: '背面补全', side: 'back', operation: 'backfill', instruction: '生成背面或被遮挡区域的合理补全。' },
  ],
};

const getSplitTemplates = (partType: SplitPartType) => plannedSplitTemplates[partType] ?? plannedSplitTemplates.base;

export const plannedSplitTargetsForPart = (partType: SplitPartType): PlannedSplitTarget[] =>
  getSplitTemplates(partType).map((template) => ({
    name: template.suffix,
    side: template.side,
    operation: template.operation,
    instruction: template.instruction,
    paired: Boolean(template.paired),
    reference: Boolean(template.reference),
  }));

export const planSplitForLayer = (
  nodes: LayerNode[],
  sourceId: string,
  plannedTargets?: PlannedSplitTarget[],
): LayerNode[] => {
  const source = findLayer(nodes, sourceId);
  if (!source || source.type !== 'layer') {
    return nodes;
  }

  const sourceRef = summarizeLayerSource(source, '拆分来源');
  const targets = (plannedTargets ?? plannedSplitTargetsForPart(source.partType)).filter((target) => target.name.trim());
  const referenceTargets: LayerNode[] = [];

  const createdTargets = targets.map((target) => {
    const isReference = target.reference;
    const node = createLayerNode({
      name: `${source.name} / ${target.name.trim()}`,
      partType: source.partType,
      side: target.side,
      role: isReference ? 'reference' : 'artwork',
      exportable: !isReference,
      locked: isReference,
      sources: [sourceRef],
      editSpec: {
        operation: target.operation,
        instruction: target.instruction,
        paired: Boolean(target.paired),
        edgePadding: target.operation === 'backfill' ? 20 : 12,
        targetStructure: target.name.trim(),
      },
      promptHint: target.instruction,
    });

    if (isReference) {
      referenceTargets.push(node);
    }

    return node;
  });

  const targetsWithReferenceLinks = createdTargets.map((target) =>
    target.role === 'reference'
      ? target
      : {
          ...target,
          sources: mergeSources(
            target.sources,
            referenceTargets.map((reference) => ({
              layerId: reference.id,
              role: 'style',
              note: '拆分结构参考',
            })),
          ),
        },
  );

  let nextNodes = updateLayer(nodes, sourceId, (layer) => ({
    ...layer,
    role: 'reference',
    exportable: false,
    locked: true,
    status: layer.status === 'pendingReview' ? layer.status : 'dirty',
  }));

  for (const target of targetsWithReferenceLinks.reverse()) {
    nextNodes = insertLayerAfter(nextNodes, sourceId, target);
  }

  return nextNodes;
};

export const addBackfillLayerForSource = (nodes: LayerNode[], sourceId: string): LayerNode[] => {
  const source = findLayer(nodes, sourceId);
  if (!source || source.type !== 'layer') {
    return nodes;
  }

  const target = createLayerNode({
    name: `${source.name} / 背面补全`,
    partType: source.partType,
    side: 'back',
    sources: [summarizeLayerSource(source, '背面补全来源')],
    editSpec: {
      operation: 'backfill',
      instruction: `根据「${source.name}」生成 Live2D 背面结构，补齐被前景遮挡的边缘。`,
      edgePadding: 20,
      targetStructure: '背面补全',
    },
    promptHint: `根据「${source.name}」生成 Live2D 背面结构，补齐被前景遮挡的边缘。`,
  });

  return insertLayerAfter(nodes, sourceId, target);
};

export const addSourceToLayer = (
  nodes: LayerNode[],
  targetId: string,
  sourceId: string,
  role: LayerSourceRef['role'] = 'primary',
): LayerNode[] => {
  if (targetId === sourceId) {
    return nodes;
  }

  const source = findLayer(nodes, sourceId);
  const target = findLayer(nodes, targetId);
  if (!source || !target) {
    return nodes;
  }

  return updateLayer(nodes, targetId, (layer) => ({
    ...layer,
    status: layer.status === 'pendingReview' ? layer.status : 'dirty',
    sources: mergeSources(layer.sources, [
      {
        layerId: source.id,
        role,
        note: role === 'primary' ? '手动添加来源' : '手动添加参考',
      },
    ]),
  }));
};

export const markLayerAsReference = (nodes: LayerNode[], id: string): LayerNode[] =>
  updateLayer(nodes, id, (layer) => ({
    ...layer,
    role: 'reference',
    exportable: false,
    locked: true,
    status: layer.status === 'pendingReview' ? layer.status : 'dirty',
  }));

export const updateLayerTaskSpec = (
  nodes: LayerNode[],
  id: string,
  patch: Partial<Pick<LayerNode, 'partType' | 'role' | 'side' | 'exportable'>> & {
    editSpec?: Partial<LayerEditSpec>;
  },
): LayerNode[] =>
  updateLayer(nodes, id, (layer) => ({
    ...layer,
    ...('partType' in patch ? { partType: patch.partType } : {}),
    ...('role' in patch ? { role: patch.role } : {}),
    ...('side' in patch ? { side: patch.side } : {}),
    ...('exportable' in patch ? { exportable: patch.exportable } : {}),
    editSpec: {
      ...layer.editSpec,
      ...(patch.editSpec ?? {}),
    },
    status: layer.status === 'pendingReview' ? layer.status : 'dirty',
  }));

export const recordLayerRevision = (
  nodes: LayerNode[],
  id: string,
  revision: Omit<LayerRevision, 'id' | 'createdAt'>,
): LayerNode[] =>
  updateLayer(nodes, id, (layer) => ({
    ...layer,
    revisions: [
      {
        id: createId('revision'),
        createdAt: new Date().toISOString(),
        ...revision,
      },
      ...layer.revisions,
    ].slice(0, 8),
  }));

export const approveLayerNode = (nodes: LayerNode[], id: string): LayerNode[] =>
  updateLayerStatus(nodes, [id], 'approved');

export const rejectLayerNode = (appliedNodes: LayerNode[], draftNodes: LayerNode[], id: string): LayerNode[] => {
  const appliedLayer = findLayer(appliedNodes, id);
  if (!appliedLayer) {
    return updateLayer(draftNodes, id, (layer) => ({
      ...layer,
      status: 'dirty',
      imageUrl: undefined,
      revisions: layer.revisions.slice(1),
    }));
  }

  return updateLayer(draftNodes, id, () => ({
    ...cloneTree([appliedLayer])[0],
    status: 'approved',
  }));
};

export const syncApprovedLayerToApplied = (
  appliedNodes: LayerNode[],
  draftNodes: LayerNode[],
  id: string,
): LayerNode[] => {
  const draftLayer = findLayer(draftNodes, id);
  const appliedLayer = findLayer(appliedNodes, id);

  if (!draftLayer) {
    return appliedNodes;
  }

  if (!appliedLayer) {
    return [...cloneTree(appliedNodes), { ...cloneTree([draftLayer])[0], status: 'approved' }];
  }

  return updateLayer(appliedNodes, id, () => ({
    ...cloneTree([draftLayer])[0],
    status: 'approved',
  }));
};

export const canDeleteLayerNode = (nodes: LayerNode[], id: string): boolean =>
  !flattenTree(nodes).some((layer) => layer.id !== id && layer.sources.some((source) => source.layerId === id));

export const isExportablePsdLayer = (layer: LayerNode | FlatLayerNode): boolean =>
  layer.type === 'layer' &&
  Boolean(layer.imageUrl) &&
  layer.exportable &&
  layer.role !== 'reference' &&
  layer.role !== 'guide' &&
  layer.status !== 'pendingReview' &&
  layer.status !== 'failed';

export const mergeSources = (base: LayerSourceRef[], incoming: LayerSourceRef[]) => {
  const next: LayerSourceRef[] = [];
  const seen = new Set<string>();

  for (const source of [...base, ...incoming]) {
    const key = `${source.layerId}:${source.role}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    next.push(source);
  }

  return next;
};

export const operationLabel = (operation: LayerOperation) => {
  const labels: Record<LayerOperation, string> = {
    manual: '手',
    split: '拆',
    backfill: '背',
    occlusionFill: '补',
    repair: '修',
    merge: '合',
  };

  return labels[operation];
};

export const sideLabel = (side: LayerSide) => {
  const labels: Record<LayerSide, string> = {
    none: '',
    front: 'F',
    back: 'B',
    left: 'L',
    right: 'R',
    inner: 'I',
  };

  return labels[side];
};

export const tierOrDefault = (tier: SplitTier | null, fallback: SplitTier) => tier ?? fallback;
