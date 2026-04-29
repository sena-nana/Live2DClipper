import assert from 'node:assert/strict';
import type { LayerNode } from '../src/types/layers';
import { collectChangedLayers, flattenTree, mergeLayerNodeInto } from '../src/utils/tree';
import {
  addBackfillLayerForSource,
  canDeleteLayerNode,
  isExportablePsdLayer,
  planSplitForLayer,
  plannedSplitTargetsForPart,
} from '../src/utils/layerTasks';
import {
  filterLayerTreeRows,
  layerCompactMarker,
  layerTaskTooltip,
  type LayerTreeFilter,
} from '../src/utils/layerTreeUx';

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

test('plans a custom split with reference framework targets linked to generated outputs', () => {
  const nextTree = planSplitForLayer(groupWith(baseLayer('skirt', '裙子', 'clothing')), 'skirt', [
    {
      name: '百褶参考结构',
      instruction: '按照百褶裙的每一褶单独拆分。',
      side: 'front',
      operation: 'split',
      reference: true,
    },
    {
      name: '褶 01',
      instruction: '根据百褶参考结构拆出第一褶。',
      side: 'front',
      operation: 'split',
      reference: false,
    },
  ]);
  const flat = flattenTree(nextTree);
  const reference = flat.find((layer) => layer.name === '裙子 / 百褶参考结构');
  const output = flat.find((layer) => layer.name === '裙子 / 褶 01');

  assert.equal(reference?.role, 'reference');
  assert.equal(reference?.exportable, false);
  assert.equal(reference?.editSpec.targetStructure, '百褶参考结构');
  assert.deepEqual(output?.sources.map((source) => `${source.role}:${source.layerId}`), [
    'primary:skirt',
    `style:${reference?.id}`,
  ]);
});

test('default planned split targets can seed an editable dialog', () => {
  const targets = plannedSplitTargetsForPart('clothing');

  assert.deepEqual(
    targets.map((target) => [target.name, target.reference]),
    [
      ['前片', false],
      ['左侧', false],
      ['右侧', false],
      ['背面补全', false],
    ],
  );
});

test('changed layer collection includes generated reference frameworks but not plain source references', () => {
  const nextTree = planSplitForLayer(groupWith(baseLayer('skirt', '裙子', 'clothing')), 'skirt', [
    {
      name: '百褶参考结构',
      instruction: '按照百褶裙的每一褶单独拆分。',
      side: 'front',
      operation: 'split',
      reference: true,
    },
  ]);

  assert.deepEqual(
    collectChangedLayers(nextTree).map((layer) => layer.name),
    ['裙子 / 百褶参考结构'],
  );
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

test('compact layer tree search matches names, instructions, structures, and source notes', () => {
  const source = baseLayer('source-hair', '头发源', 'hair');
  const target = {
    ...baseLayer('target-hair-back', '后发背面补全', 'hair'),
    status: 'dirty' as const,
    side: 'back' as const,
    editSpec: {
      ...baseLayer('target-template', 'template', 'hair').editSpec,
      operation: 'backfill' as const,
      instruction: '补齐被肩膀遮挡的发束根部',
      targetStructure: '后发背面结构',
    },
    sources: [{ layerId: source.id, role: 'primary' as const, note: '肩膀遮挡参考' }],
  };

  assert.deepEqual(
    filterLayerTreeRows(flattenTree(groupWith(source, target)), {
      query: '肩膀',
      status: 'all',
      sourceNameById: new Map([[source.id, source.name]]),
    }).map((layer) => layer.id),
    ['target-hair-back'],
  );
});

test('compact layer tree filters dirty, review, failed, and reference rows without changing source rows', () => {
  const rows = flattenTree(
    groupWith(
      { ...baseLayer('dirty', '已改层', 'hair'), status: 'dirty' as const },
      { ...baseLayer('review', '待审层', 'hair'), status: 'pendingReview' as const },
      { ...baseLayer('failed', '失败层', 'hair'), status: 'failed' as const },
      { ...baseLayer('reference', '参考层', 'hair'), role: 'reference' as const },
    ),
  );

  const idsFor = (status: LayerTreeFilter) =>
    filterLayerTreeRows(rows, { query: '', status, sourceNameById: new Map() }).map((layer) => layer.id);

  assert.deepEqual(idsFor('dirty'), ['dirty']);
  assert.deepEqual(idsFor('review'), ['review']);
  assert.deepEqual(idsFor('failed'), ['failed']);
  assert.deepEqual(idsFor('reference'), ['reference']);
});

test('compact layer marker prioritizes review state before operation and role metadata', () => {
  assert.deepEqual(layerCompactMarker({ ...baseLayer('review', '待审背面层', 'hair'), status: 'pendingReview', role: 'reference', editSpec: { ...baseLayer('x', 'x', 'hair').editSpec, operation: 'backfill' } }), {
    label: '待审',
    tone: 'pendingReview',
  });
  assert.deepEqual(layerCompactMarker({ ...baseLayer('reference', '参考层', 'hair'), role: 'reference' }), {
    label: '参',
    tone: 'reference',
  });
  assert.deepEqual(layerCompactMarker({ ...baseLayer('split', '拆分层', 'hair'), editSpec: { ...baseLayer('x2', 'x2', 'hair').editSpec, operation: 'split' } }), {
    label: '拆',
    tone: 'split',
  });
});

test('compact layer tooltip summarizes task metadata for dense tree rows', () => {
  const layer = {
    ...baseLayer('target', '裙子 / 褶 01', 'clothing'),
    status: 'dirty' as const,
    role: 'artwork' as const,
    side: 'front' as const,
    exportable: true,
    editSpec: {
      ...baseLayer('template', 'template', 'clothing').editSpec,
      operation: 'split' as const,
      instruction: '根据百褶参考结构拆出第一褶',
      targetStructure: '褶 01',
    },
    sources: [{ layerId: 'skirt-ref', role: 'style' as const, note: '拆分结构参考' }],
  };

  const tooltip = layerTaskTooltip(layer, new Map([['skirt-ref', '百褶参考结构']]));

  assert.ok(/裙子 \/ 褶 01/.test(tooltip));
  assert.ok(/状态：已修改/.test(tooltip));
  assert.ok(/操作：拆分/.test(tooltip));
  assert.ok(/方位：前/.test(tooltip));
  assert.ok(/来源：style: 百褶参考结构/.test(tooltip));
  assert.ok(/说明：根据百褶参考结构拆出第一褶/.test(tooltip));
});

for (const entry of tests) {
  entry.fn();
  console.log(`ok - ${entry.name}`);
}
