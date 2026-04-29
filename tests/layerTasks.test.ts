import assert from 'node:assert/strict';
import type { LayerNode } from '../src/types/layers';
import { flattenTree, mergeLayerNodeInto } from '../src/utils/tree';
import {
  addBackfillLayerForSource,
  canDeleteLayerNode,
  isExportablePsdLayer,
  planSplitForLayer,
} from '../src/utils/layerTasks';

const tests: Array<{ name: string; fn: () => void }> = [];

const test = (name: string, fn: () => void) => {
  tests.push({ name, fn });
};

const baseLayer = (id: string, name: string, partType: LayerNode['partType']): LayerNode => ({
  id,
  name,
  type: 'layer',
  partType,
  status: 'clean',
  visible: true,
  solo: false,
  locked: false,
  opacity: 1,
  role: 'artwork',
  side: 'none',
  exportable: true,
  sources: [],
  editSpec: {
    operation: 'manual',
    instruction: '',
    edgePadding: 12,
    paired: false,
    asMask: false,
    algorithmOverride: null,
    targetStructure: '',
  },
  revisions: [],
});

const groupWith = (...children: LayerNode[]): LayerNode[] => [
  {
    id: 'group-root',
    name: '角色主体',
    type: 'group',
    partType: 'base',
    status: 'clean',
    visible: true,
    solo: false,
    locked: false,
    opacity: 1,
    role: 'artwork',
    side: 'none',
    exportable: false,
    sources: [],
    editSpec: {
      operation: 'manual',
      instruction: '',
      edgePadding: 12,
      paired: false,
      asMask: false,
      algorithmOverride: null,
      targetStructure: '',
    },
    revisions: [],
    children,
  },
];

test('plans a Live2D hair split with source provenance and back layer metadata', () => {
  const nextTree = planSplitForLayer(groupWith(baseLayer('hair-source', '头发', 'hair')), 'hair-source');
  const flat = flattenTree(nextTree);
  const source = flat.find((layer) => layer.id === 'hair-source');
  const targets = flat.filter((layer) =>
    layer.sources.some((sourceRef) => sourceRef.layerId === 'hair-source' && sourceRef.role === 'primary'),
  );

  assert.equal(source?.role, 'reference');
  assert.equal(source?.exportable, false);
  assert.equal(source?.locked, true);
  assert.deepEqual(
    targets.map((layer) => layer.name),
    ['头发 / 前发', '头发 / 侧发 L', '头发 / 侧发 R', '头发 / 后发', '头发 / 后发背面补全'],
  );
  assert.equal(targets[0].editSpec.operation, 'split');
  assert.equal(targets[4].editSpec.operation, 'backfill');
  assert.equal(targets[4].side, 'back');
  assert.ok(targets.every((layer) => layer.exportable && layer.status === 'dirty'));
});

test('creates a backfill target that keeps a precise primary source link', () => {
  const nextTree = addBackfillLayerForSource(groupWith(baseLayer('coat', '衣服', 'clothing')), 'coat');
  const target = flattenTree(nextTree).find((layer) => layer.name === '衣服 / 背面补全');

  assert.equal(target?.editSpec.operation, 'backfill');
  assert.equal(target?.side, 'back');
  assert.deepEqual(target?.sources, [
    {
      layerId: 'coat',
      role: 'primary',
      note: '背面补全来源',
    },
  ]);
});

test('merge keeps both provenance chains instead of reducing them to a text note', () => {
  const target = {
    ...baseLayer('target', '脸部阴影', 'shadow'),
    sources: [{ layerId: 'face', role: 'primary' as const, note: '原始脸部' }],
  };
  const source = {
    ...baseLayer('source', '发丝阴影', 'shadow'),
    sources: [{ layerId: 'hair', role: 'primary' as const, note: '原始头发' }],
  };
  const merged = flattenTree(mergeLayerNodeInto(groupWith(target, source), 'source', 'target')).find(
    (layer) => layer.id === 'target',
  );

  assert.deepEqual(
    merged?.sources.map((sourceRef) => sourceRef.layerId),
    ['face', 'hair', 'source'],
  );
  assert.equal(merged?.editSpec.operation, 'merge');
});

test('referenced source layers are protected from deletion', () => {
  const tree = groupWith({
    ...baseLayer('target', '头发 / 后发背面补全', 'hair'),
    sources: [{ layerId: 'hair-source', role: 'primary', note: '背面补全来源' }],
  }, baseLayer('hair-source', '头发', 'hair'));

  assert.equal(canDeleteLayerNode(tree, 'hair-source'), false);
  assert.equal(canDeleteLayerNode(tree, 'target'), true);
});

test('PSD export filter ignores reference, pending, failed, and non-exportable layers', () => {
  const approved = { ...baseLayer('ok', '可导出', 'base'), status: 'approved' as const, imageUrl: 'data:image/png;base64,ok' };
  const reference = { ...approved, id: 'ref', role: 'reference' as const };
  const pending = { ...approved, id: 'pending', status: 'pendingReview' as const };
  const disabled = { ...approved, id: 'disabled', exportable: false };
  const failed = { ...approved, id: 'failed', status: 'failed' as const };

  assert.deepEqual(
    [approved, reference, pending, disabled, failed].filter(isExportablePsdLayer).map((layer) => layer.id),
    ['ok'],
  );
});

for (const entry of tests) {
  entry.fn();
  console.log(`ok - ${entry.name}`);
}
