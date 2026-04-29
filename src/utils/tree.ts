import type { FlatLayerNode, LayerNode, LayerSourceRef, LayerStatus } from '../types/layers';

export const cloneTree = (nodes: LayerNode[]): LayerNode[] =>
  nodes.map((node) => ({
    ...node,
    children: node.children ? cloneTree(node.children) : undefined,
  }));

export const flattenTree = (
  nodes: LayerNode[],
  depth = 0,
  parentId: string | null = null,
): FlatLayerNode[] =>
  nodes.flatMap((node) => [
    { ...node, depth, parentId },
    ...(node.children ? flattenTree(node.children, depth + 1, node.id) : []),
  ]);

export const findLayer = (nodes: LayerNode[], id: string | null): LayerNode | null => {
  if (!id) {
    return null;
  }

  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }

    const child = findLayer(node.children ?? [], id);
    if (child) {
      return child;
    }
  }

  return null;
};

export const updateLayer = (
  nodes: LayerNode[],
  id: string,
  updater: (node: LayerNode) => LayerNode,
): LayerNode[] =>
  nodes.map((node) => {
    if (node.id === id) {
      return updater(node);
    }

    if (!node.children) {
      return node;
    }

    return {
      ...node,
      children: updateLayer(node.children, id, updater),
    };
  });

export const updateLayerStatus = (nodes: LayerNode[], ids: string[], status: LayerStatus): LayerNode[] =>
  nodes.map((node) => ({
    ...node,
    status: ids.includes(node.id) ? status : node.status,
    children: node.children ? updateLayerStatus(node.children, ids, status) : undefined,
  }));

export const collectChangedLayers = (nodes: LayerNode[]) =>
  flattenTree(nodes).filter(
    (node) =>
      node.type === 'layer' &&
      node.status === 'dirty' &&
      node.role !== 'guide' &&
      (node.exportable || (node.role === 'reference' && node.sources.length > 0)),
  );

export const hasPendingReview = (nodes: LayerNode[]) =>
  flattenTree(nodes).some((node) => node.status === 'pendingReview');

export const hasDirtyLayers = (nodes: LayerNode[]) =>
  flattenTree(nodes).some((node) => node.status === 'dirty');

export const markTreeClean = (nodes: LayerNode[]): LayerNode[] =>
  nodes.map((node) => ({
    ...node,
    status: node.status === 'pendingReview' || node.status === 'dirty' ? 'approved' : node.status,
    children: node.children ? markTreeClean(node.children) : undefined,
  }));

export const moveLayerSibling = (nodes: LayerNode[], id: string, direction: -1 | 1): LayerNode[] => {
  const nextNodes = cloneTree(nodes);
  const siblings = findSiblings(nextNodes, id);

  if (!siblings) {
    return nodes;
  }

  const index = siblings.findIndex((node) => node.id === id);
  const targetIndex = index + direction;

  if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) {
    return nodes;
  }

  const [node] = siblings.splice(index, 1);
  siblings.splice(targetIndex, 0, { ...node, status: node.status === 'pendingReview' ? node.status : 'dirty' });
  return nextNodes;
};

export const indentLayerIntoPreviousGroup = (nodes: LayerNode[], id: string): LayerNode[] => {
  const nextNodes = cloneTree(nodes);
  const siblings = findSiblings(nextNodes, id);

  if (!siblings) {
    return nodes;
  }

  const index = siblings.findIndex((node) => node.id === id);
  const previous = siblings[index - 1];

  if (index <= 0 || previous?.type !== 'group') {
    return nodes;
  }

  const [node] = siblings.splice(index, 1);
  previous.children = [
    ...(previous.children ?? []),
    { ...node, status: node.status === 'pendingReview' ? node.status : 'dirty' },
  ];
  previous.status = previous.status === 'pendingReview' ? previous.status : 'dirty';
  return nextNodes;
};

export const outdentLayer = (nodes: LayerNode[], id: string): LayerNode[] => {
  const nextNodes = cloneTree(nodes);
  const parentPath = findParentPath(nextNodes, id);

  if (!parentPath || parentPath.length === 0) {
    return nodes;
  }

  const parent = parentPath[parentPath.length - 1];
  const parentSiblings = parentPath.length === 1 ? nextNodes : parentPath[parentPath.length - 2].children;

  if (!parent.children || !parentSiblings) {
    return nodes;
  }

  const index = parent.children.findIndex((node) => node.id === id);
  const parentIndex = parentSiblings.findIndex((node) => node.id === parent.id);

  if (index < 0 || parentIndex < 0) {
    return nodes;
  }

  const [node] = parent.children.splice(index, 1);
  parentSiblings.splice(parentIndex + 1, 0, {
    ...node,
    status: node.status === 'pendingReview' ? node.status : 'dirty',
  });
  parent.status = parent.status === 'pendingReview' ? parent.status : 'dirty';
  return nextNodes;
};

export const moveLayerToParent = (
  nodes: LayerNode[],
  id: string,
  targetParentId: string | null,
  targetIndex: number,
): LayerNode[] => {
  const nextNodes = cloneTree(nodes);
  const removed = removeNode(nextNodes, id);

  if (!removed) {
    return nodes;
  }

  const targetSiblings = targetParentId ? findLayer(nextNodes, targetParentId)?.children : nextNodes;
  if (!targetSiblings) {
    return nodes;
  }

  if (isDescendant(removed.node, targetParentId)) {
    return nodes;
  }

  const adjustedIndex =
    removed.parentId === targetParentId && removed.index < targetIndex ? targetIndex - 1 : targetIndex;
  const dirtyNode: LayerNode = {
    ...removed.node,
    status: removed.node.status === 'pendingReview' ? removed.node.status : 'dirty',
  };
  targetSiblings.splice(Math.min(Math.max(0, adjustedIndex), targetSiblings.length), 0, dirtyNode);
  return nextNodes;
};

export const insertLayerAfter = (nodes: LayerNode[], afterId: string, newNode: LayerNode): LayerNode[] => {
  const nextNodes = cloneTree(nodes);
  const siblings = findSiblings(nextNodes, afterId);

  if (!siblings) {
    return nodes;
  }

  const index = siblings.findIndex((node) => node.id === afterId);
  if (index < 0) {
    return nodes;
  }

  siblings.splice(index + 1, 0, newNode);
  return nextNodes;
};

export const deleteLayerNode = (nodes: LayerNode[], id: string): LayerNode[] => {
  const nextNodes = cloneTree(nodes);
  const removed = removeNode(nextNodes, id);
  return removed ? nextNodes : nodes;
};

export const mergeLayerNodeInto = (nodes: LayerNode[], sourceId: string, targetId: string): LayerNode[] => {
  if (sourceId === targetId) {
    return nodes;
  }

  const source = findLayer(nodes, sourceId);
  const target = findLayer(nodes, targetId);

  if (!source || !target || source.type !== 'layer' || target.type !== 'layer') {
    return nodes;
  }

  const nextNodes = deleteLayerNode(nodes, sourceId);
  return updateLayer(nextNodes, targetId, (layer) => ({
    ...layer,
    name: `${layer.name} + ${source.name}`,
    editSpec: {
      ...layer.editSpec,
      operation: 'merge',
      instruction: [layer.editSpec.instruction, `合并「${source.name}」作为同一输出图层。`]
        .filter(Boolean)
        .join('\n'),
    },
    sources: mergeLayerSources(layer.sources, [
      ...source.sources,
      {
        layerId: source.id,
        role: 'primary',
        note: `合并来源：${source.name}`,
      },
    ]),
    status: layer.status === 'pendingReview' ? layer.status : 'dirty',
    promptHint: [layer.promptHint, `合并来源：${source.name}`].filter(Boolean).join('；'),
  }));
};

const mergeLayerSources = (base: LayerSourceRef[], incoming: LayerSourceRef[]) => {
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

const findSiblings = (nodes: LayerNode[], id: string): LayerNode[] | null => {
  if (nodes.some((node) => node.id === id)) {
    return nodes;
  }

  for (const node of nodes) {
    if (!node.children) {
      continue;
    }

    const siblings = findSiblings(node.children, id);
    if (siblings) {
      return siblings;
    }
  }

  return null;
};

const findParentPath = (nodes: LayerNode[], id: string, path: LayerNode[] = []): LayerNode[] | null => {
  for (const node of nodes) {
    if (!node.children) {
      continue;
    }

    if (node.children.some((child) => child.id === id)) {
      return [...path, node];
    }

    const childPath = findParentPath(node.children, id, [...path, node]);
    if (childPath) {
      return childPath;
    }
  }

  return null;
};

const removeNode = (
  nodes: LayerNode[],
  id: string,
  parentId: string | null = null,
): { node: LayerNode; parentId: string | null; index: number } | null => {
  const index = nodes.findIndex((node) => node.id === id);

  if (index >= 0) {
    const [node] = nodes.splice(index, 1);
    return { node, parentId, index };
  }

  for (const node of nodes) {
    if (!node.children) {
      continue;
    }

    const removed = removeNode(node.children, id, node.id);
    if (removed) {
      return removed;
    }
  }

  return null;
};

const isDescendant = (node: LayerNode, targetParentId: string | null): boolean => {
  if (!targetParentId) {
    return false;
  }

  if (node.id === targetParentId) {
    return true;
  }

  return (node.children ?? []).some((child) => isDescendant(child, targetParentId));
};
