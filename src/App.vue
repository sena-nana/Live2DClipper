<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  Boxes,
  Brush,
  Check,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileImage,
  FolderPlus,
  Indent,
  Layers,
  Loader2,
  MoveDown,
  MoveUp,
  Outdent,
  Plus,
  ScanLine,
  Search,
  Settings,
  Sparkles,
  Target,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next';
import { useProjectStore } from './stores/projectStore';
import { SPLIT_TIER_CONFIGS } from './data/splitTiers';
import type { FlatLayerNode, LayerNode, SplitPartType, SplitTier } from './types/layers';
import { loadImage } from './utils/image';
import { plannedSplitTargetsForPart, type PlannedSplitTarget } from './utils/layerTasks';
import {
  filterLayerTreeRows,
  layerCompactMarker,
  layerTaskTooltip,
  type LayerTreeFilter,
} from './utils/layerTreeUx';

const store = useProjectStore();
const fileInput = ref<HTMLInputElement | null>(null);
const drawingCanvas = ref<HTMLCanvasElement | null>(null);
const layerListRef = ref<HTMLElement | null>(null);
const zoom = ref(1);
const pan = ref({ x: 0, y: 0 });
const brushSize = ref(16);
const brushColor = ref('rgba(124, 156, 255, 0.82)');
const activeDrawTool = ref<'brush' | 'eraser'>('brush');
const isDrawing = ref(false);
const lastPointer = ref<{ x: number; y: number } | null>(null);
const isPanning = ref(false);
const panStart = ref<{ x: number; y: number; panX: number; panY: number } | null>(null);
const draggedLayerId = ref<string | null>(null);
const layerDropTarget = ref<{
  parentId: string | null;
  index: number;
  depth: number;
  top: number;
} | null>(null);
const contextMenu = ref<{
  layerId: string;
  x: number;
  y: number;
  showMergeTargets: boolean;
  showSourceTargets: boolean;
} | null>(null);
const editingLayerId = ref<string | null>(null);
const editingLayerName = ref('');
const editingInputRef = ref<HTMLInputElement | null>(null);
const layerSearchQuery = ref('');
const layerTreeFilter = ref<LayerTreeFilter>('all');
const taskDetailsExpanded = ref(false);
const splitPlanDialog = ref<{
  sourceId: string;
  sourceName: string;
  targets: PlannedSplitTarget[];
} | null>(null);

const partTypes: Array<{ value: SplitPartType; label: string }> = [
  { value: 'base', label: '基础' },
  { value: 'hair', label: '头发' },
  { value: 'face', label: '脸部' },
  { value: 'eyes', label: '眼睛' },
  { value: 'mouth', label: '嘴部' },
  { value: 'body', label: '身体' },
  { value: 'clothing', label: '服装' },
  { value: 'limb', label: '肢体' },
  { value: 'accessory', label: '饰品' },
  { value: 'shadow', label: '阴影' },
  { value: 'effect', label: '特效' },
];

const brushColors = [
  { label: '蓝色', value: 'rgba(124, 156, 255, 0.82)', swatch: '#7c9cff' },
  { label: '红色', value: 'rgba(255, 127, 145, 0.82)', swatch: '#ff7f91' },
  { label: '绿色', value: 'rgba(94, 224, 160, 0.82)', swatch: '#5ee0a0' },
  { label: '黄色', value: 'rgba(242, 195, 107, 0.86)', swatch: '#f2c36b' },
  { label: '白色', value: 'rgba(248, 250, 252, 0.86)', swatch: '#f8fafc' },
];

const layerTreeFilters: Array<{ value: LayerTreeFilter; label: string; title: string }> = [
  { value: 'all', label: '全部', title: '显示全部图层' },
  { value: 'dirty', label: '未应用', title: '仅显示已修改但未应用的图层' },
  { value: 'review', label: '待审', title: '仅显示等待审核的图层' },
  { value: 'failed', label: '失败', title: '仅显示生成失败的图层' },
  { value: 'reference', label: '参考', title: '仅显示参考源图层' },
];

const tierEntries = computed(() =>
  (['estimate', 'modelAlpha', 'standard', 'precise'] satisfies SplitTier[]).map((tier) => SPLIT_TIER_CONFIGS[tier]),
);
const selectedLayer = computed(() => store.selectedLayer);
const sourceNameById = computed(() => new Map(store.flatDraftLayers.map((layer) => [layer.id, layer.name] as const)));
const visibleTreeRows = computed(() =>
  filterLayerTreeRows(store.flatDraftLayers, {
    query: layerSearchQuery.value,
    status: layerTreeFilter.value,
    sourceNameById: sourceNameById.value,
  }),
);
const mergeTargetLayers = computed(() =>
  store.flatDraftLayers.filter(
    (layer) => layer.type === 'layer' && layer.id !== contextMenu.value?.layerId,
  ),
);
const sourceTargetLayers = computed(() =>
  store.flatDraftLayers.filter(
    (layer) => layer.type === 'layer' && layer.id !== selectedLayer.value?.id,
  ),
);
const contextLayer = computed(() =>
  contextMenu.value ? store.flatDraftLayers.find((layer) => layer.id === contextMenu.value?.layerId) ?? null : null,
);
const pendingCount = computed(
  () => store.flatDraftLayers.filter((layer) => layer.status === 'pendingReview').length,
);
const selectedLayerTooltip = computed(() =>
  selectedLayer.value ? layerTaskTooltip(selectedLayer.value, sourceNameById.value) : '',
);

const previewImage = computed(() => {
  const layer = selectedLayer.value?.type === 'layer' ? selectedLayer.value : store.visibleLayers[0];
  return layer?.imageUrl ?? store.sourceImageUrl;
});

const canvasTransform = computed(
  () => `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`,
);

const onFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    await store.uploadSourceImage(file);
  }
  input.value = '';
};

const statusLabel = (status: FlatLayerNode['status']) => {
  const labels: Record<FlatLayerNode['status'], string> = {
    clean: '已应用',
    dirty: '已修改',
    generating: '生成中',
    pendingReview: '待审核',
    approved: '已确认',
    failed: '失败',
  };

  return labels[status];
};

const roleLabel = (role: FlatLayerNode['role']) => {
  const labels: Record<FlatLayerNode['role'], string> = {
    artwork: '输出图层',
    reference: '参考源',
    guide: '指导层',
    mask: '遮罩层',
  };

  return labels[role];
};

const sideName = (side: FlatLayerNode['side']) => {
  const labels: Record<FlatLayerNode['side'], string> = {
    none: '无',
    front: '前',
    back: '背',
    left: '左',
    right: '右',
    inner: '内',
  };

  return labels[side];
};

const operationName = (operation: FlatLayerNode['editSpec']['operation']) => {
  const labels: Record<FlatLayerNode['editSpec']['operation'], string> = {
    manual: '手动',
    split: '拆分',
    backfill: '背面补全',
    occlusionFill: '遮挡补全',
    repair: '修复',
    merge: '合并',
  };

  return labels[operation];
};

const sourceSummary = (layer: Pick<LayerNode, 'sources'>) =>
  layer.sources
    .map((source) => {
      const sourceLayer = store.flatDraftLayers.find((item) => item.id === source.layerId);
      return `${source.role}: ${sourceLayer?.name ?? source.layerId}`;
    })
    .join('\n');

const compactMarker = (layer: FlatLayerNode) => layerCompactMarker(layer);

const compactMarkerTitle = (layer: FlatLayerNode) => {
  const marker = compactMarker(layer);
  if (!marker) {
    return layerTaskTooltip(layer, sourceNameById.value);
  }

  return `${marker.label}\n${layerTaskTooltip(layer, sourceNameById.value)}`;
};

const treeRowTitle = (layer: FlatLayerNode) => layerTaskTooltip(layer, sourceNameById.value);

const filterCountTitle = computed(() =>
  `当前显示 ${visibleTreeRows.value.length} / ${store.flatDraftLayers.length} 个节点`,
);

const sourceCountLabel = computed(() => {
  const count = selectedLayer.value?.sources.length ?? 0;
  return count === 0 ? '来源 0' : `来源 ${count}`;
});

const setTier = (tier: SplitTier) => {
  store.setSelectedTier(tier);
};

const tierTooltip = (tier: (typeof SPLIT_TIER_CONFIGS)[SplitTier]) =>
  [
    `${tier.name}：${tier.description}`,
    tier.quality,
    `透明度：${tier.transparentSupport}`,
    `背景：${tier.backgrounds.map((background) => `${background.name} ${background.hex}`).join(' / ')}`,
  ].join('\n');

const primaryActionTitle = computed(() => {
  if (store.pendingReview) {
    return `确认 ${pendingCount.value} 个待审核图层，并解锁继续编辑。`;
  }

  if (store.isGenerating) {
    return store.generationMessage;
  }

  return `${store.tierConfig.name}档：生成 ${store.tierConfig.outputCount} 个背景版本。${store.tierConfig.description}`;
});

const runPrimaryAction = () => {
  if (store.pendingReview) {
    store.approvePending();
    return;
  }

  store.runGeneration();
};

const openLayerContextMenu = (event: MouseEvent, layer: FlatLayerNode) => {
  event.preventDefault();
  store.selectLayer(layer.id);
  contextMenu.value = {
    layerId: layer.id,
    x: event.clientX,
    y: event.clientY,
    showMergeTargets: false,
    showSourceTargets: false,
  };
};

const closeContextMenu = () => {
  contextMenu.value = null;
};

const startRenameLayer = (layer: FlatLayerNode) => {
  editingLayerId.value = layer.id;
  editingLayerName.value = layer.name;
  closeContextMenu();
  void nextTick(() => {
    editingInputRef.value?.focus();
    editingInputRef.value?.select();
  });
};

const commitRenameLayer = () => {
  if (!editingLayerId.value) {
    return;
  }

  const name = editingLayerName.value.trim();
  if (name) {
    store.renameLayer(editingLayerId.value, name);
  }

  editingLayerId.value = null;
  editingLayerName.value = '';
};

const cancelRenameLayer = () => {
  editingLayerId.value = null;
  editingLayerName.value = '';
};

const deleteLayerFromMenu = () => {
  if (!contextMenu.value) {
    return;
  }

  store.deleteLayer(contextMenu.value.layerId);
  closeContextMenu();
};

const mergeLayerTo = (targetId: string) => {
  if (!contextMenu.value) {
    return;
  }

  store.mergeLayerInto(contextMenu.value.layerId, targetId);
  closeContextMenu();
};

const planSplitFromMenu = () => {
  if (!contextMenu.value) {
    return;
  }

  const source = store.flatDraftLayers.find((layer) => layer.id === contextMenu.value?.layerId);
  if (!source || source.type !== 'layer') {
    return;
  }

  splitPlanDialog.value = {
    sourceId: source.id,
    sourceName: source.name,
    targets: plannedSplitTargetsForPart(source.partType),
  };
  closeContextMenu();
};

const addSplitPlanTarget = () => {
  if (!splitPlanDialog.value) {
    return;
  }

  splitPlanDialog.value.targets.push({
    name: `目标 ${splitPlanDialog.value.targets.length + 1}`,
    side: 'front',
    operation: 'split',
    instruction: '',
    paired: false,
    reference: false,
  });
};

const removeSplitPlanTarget = (index: number) => {
  splitPlanDialog.value?.targets.splice(index, 1);
};

const applySplitPlan = () => {
  if (!splitPlanDialog.value) {
    return;
  }

  store.planSplit(splitPlanDialog.value.sourceId, splitPlanDialog.value.targets);
  splitPlanDialog.value = null;
};

const addBackfillFromMenu = () => {
  if (!contextMenu.value) {
    return;
  }

  store.addBackfillLayer(contextMenu.value.layerId);
  closeContextMenu();
};

const markReferenceFromMenu = () => {
  if (!contextMenu.value) {
    return;
  }

  store.markReference(contextMenu.value.layerId);
  closeContextMenu();
};

const addSourceToSelected = (sourceId: string, role: 'primary' | 'style' | 'occlusion' | 'mask' = 'primary') => {
  store.addSelectedLayerSource(sourceId, role);
  closeContextMenu();
};

const setZoom = (value: number) => {
  zoom.value = Math.min(4, Math.max(0.25, Number(value.toFixed(2))));
};

const zoomBy = (delta: number) => {
  setZoom(zoom.value + delta);
};

const resetViewport = () => {
  setZoom(1);
  pan.value = { x: 0, y: 0 };
};

const syncDrawingCanvasSize = async () => {
  if (!drawingCanvas.value || !previewImage.value) {
    return;
  }

  const image = await loadImage(previewImage.value);
  const canvas = drawingCanvas.value;
  const previous = canvas.width && canvas.height ? canvas.toDataURL('image/png') : null;
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  if (previous && store.guideDrawingUrl) {
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const previousImage = await loadImage(previous);
    context.drawImage(previousImage, 0, 0, canvas.width, canvas.height);
  }
};

watch(
  previewImage,
  () => {
    void nextTick(syncDrawingCanvasSize);
  },
  { immediate: true },
);

const toCanvasPoint = (event: PointerEvent) => {
  const canvas = drawingCanvas.value;
  if (!canvas) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
};

const commitGuideDrawing = () => {
  const canvas = drawingCanvas.value;
  if (!canvas) {
    return;
  }

  store.setGuideDrawingUrl(canvas.toDataURL('image/png'));
};

const drawStroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const canvas = drawingCanvas.value;
  const context = canvas?.getContext('2d');
  if (!canvas || !context) {
    return;
  }

  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = brushSize.value;

  if (activeDrawTool.value === 'eraser') {
    context.globalCompositeOperation = 'destination-out';
    context.strokeStyle = 'rgba(0, 0, 0, 1)';
  } else {
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = brushColor.value;
  }

  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
};

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) {
    return;
  }

  const canvas = drawingCanvas.value;
  const point = toCanvasPoint(event);
  if (!canvas || !point) {
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  isDrawing.value = true;
  lastPointer.value = point;
  drawStroke(point, point);
  commitGuideDrawing();
};

const onPointerMove = (event: PointerEvent) => {
  if (!isDrawing.value || !lastPointer.value) {
    return;
  }

  const point = toCanvasPoint(event);
  if (!point) {
    return;
  }

  drawStroke(lastPointer.value, point);
  lastPointer.value = point;
  commitGuideDrawing();
};

const endDrawing = (event: PointerEvent) => {
  if (drawingCanvas.value?.hasPointerCapture(event.pointerId)) {
    drawingCanvas.value.releasePointerCapture(event.pointerId);
  }

  isDrawing.value = false;
  lastPointer.value = null;
  commitGuideDrawing();
};

const clearDrawing = () => {
  const canvas = drawingCanvas.value;
  const context = canvas?.getContext('2d');
  if (!canvas || !context) {
    return;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  store.setGuideDrawingUrl(null);
};

const onWheel = (event: WheelEvent) => {
  event.preventDefault();
  zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
};

const startPan = (event: PointerEvent) => {
  if (event.button !== 1) {
    return;
  }

  event.preventDefault();
  isPanning.value = true;
  panStart.value = {
    x: event.clientX,
    y: event.clientY,
    panX: pan.value.x,
    panY: pan.value.y,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const movePan = (event: PointerEvent) => {
  if (!isPanning.value || !panStart.value) {
    return;
  }

  event.preventDefault();
  pan.value = {
    x: panStart.value.panX + event.clientX - panStart.value.x,
    y: panStart.value.panY + event.clientY - panStart.value.y,
  };
};

const endPan = (event: PointerEvent) => {
  if (!isPanning.value) {
    return;
  }

  if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  isPanning.value = false;
  panStart.value = null;
};

const startLayerDrag = (event: DragEvent, layer: FlatLayerNode) => {
  const target = event.target as HTMLElement | null;
  if (store.pendingReview || target?.closest('.ghost-icon')) {
    event.preventDefault();
    return;
  }

  draggedLayerId.value = layer.id;
  store.selectLayer(layer.id);
  event.dataTransfer?.setData('text/plain', layer.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }
};

const updateLayerDropTarget = (event: DragEvent) => {
  if (!draggedLayerId.value || !layerListRef.value) {
    return;
  }

  event.preventDefault();
  const rows = Array.from(layerListRef.value.querySelectorAll<HTMLElement>('.layer-row'));
  const rowEntries = rows.map((row) => ({
    element: row,
    id: row.dataset.layerId ?? '',
    depth: Number(row.dataset.depth ?? 0),
    rect: row.getBoundingClientRect(),
  }));
  const visibleRows = rowEntries.filter((row) => row.id && row.id !== draggedLayerId.value);

  if (visibleRows.length === 0) {
    layerDropTarget.value = { parentId: null, index: 0, depth: 0, top: 8 };
    return;
  }

  const targetRow =
    visibleRows.find((row) => event.clientY < row.rect.top + row.rect.height / 2) ??
    visibleRows[visibleRows.length - 1];
  const insertBefore = event.clientY < targetRow.rect.top + targetRow.rect.height / 2;
  const targetFlatIndex = store.flatDraftLayers.findIndex((layer) => layer.id === targetRow.id);
  const targetLayer = store.flatDraftLayers[targetFlatIndex];
  const maxDepth = Math.min(6, Math.max(0, targetLayer.depth + (insertBefore ? 0 : 1)));
  const desiredDepth = Math.min(maxDepth, Math.max(0, Math.round((event.clientX - targetRow.rect.left) / 18)));
  const insertionFlatIndex = targetFlatIndex + (insertBefore ? 0 : 1);
  const parentId = findDropParentId(insertionFlatIndex, desiredDepth);
  const index = countSiblingsBefore(insertionFlatIndex, parentId);
  const listRect = layerListRef.value.getBoundingClientRect();
  const top = (insertBefore ? targetRow.rect.top : targetRow.rect.bottom) - listRect.top + layerListRef.value.scrollTop;

  layerDropTarget.value = {
    parentId,
    index,
    depth: desiredDepth,
    top,
  };
};

const finishLayerDrag = () => {
  if (draggedLayerId.value && layerDropTarget.value) {
    store.moveLayerTo(draggedLayerId.value, layerDropTarget.value.parentId, layerDropTarget.value.index);
  }

  draggedLayerId.value = null;
  layerDropTarget.value = null;
};

const cancelLayerDrag = () => {
  draggedLayerId.value = null;
  layerDropTarget.value = null;
};

const findDropParentId = (flatIndex: number, desiredDepth: number) => {
  if (desiredDepth <= 0) {
    return null;
  }

  for (let index = flatIndex - 1; index >= 0; index -= 1) {
    const candidate = store.flatDraftLayers[index];
    if (candidate.id === draggedLayerId.value) {
      continue;
    }

    if (candidate.depth === desiredDepth - 1 && candidate.type === 'group') {
      return candidate.id;
    }
  }

  return null;
};

const countSiblingsBefore = (flatIndex: number, parentId: string | null) =>
  store.flatDraftLayers
    .slice(0, flatIndex)
    .filter((layer) => layer.parentId === parentId && layer.id !== draggedLayerId.value).length;
</script>

<template>
  <main class="app-shell">
    <div class="app-click-catcher" @click="closeContextMenu">
    <aside class="sidebar">
      <section class="brand-bar">
        <div
          class="app-title"
          :title="`${store.generationMessage}\n${store.dirty ? `${store.changedLayers.length} 个未应用修改` : '图层树已同步'}`"
        >
          <ScanLine :size="18" />
          Live2D Clipper
        </div>
        <div class="toolbar-cluster">
          <input ref="fileInput" class="hidden-input" type="file" accept="image/*" @change="onFileChange" />
          <button
            class="icon-button"
            :title="store.sourceImageUrl ? '更换立绘' : '选择立绘'"
            @click="fileInput?.click()"
          >
            <FileImage :size="16" />
          </button>
          <button class="icon-button" title="OpenAI 兼容接口设置" @click="store.openSettings">
            <Settings :size="16" />
          </button>
          <button class="icon-button" title="导出已确认图层为 PSD" :disabled="store.pendingReview" @click="store.exportPsd">
            <Download :size="16" />
          </button>
        </div>
      </section>

      <section class="panel layer-panel">
        <div class="layer-head">
          <div class="layer-head-main">
            <span class="layer-head-title" :title="`${tierTooltip(store.tierConfig)}\n${filterCountTitle}`">
              图层树 · {{ store.tierConfig.shortName }}
            </span>
            <span class="layer-count" :title="filterCountTitle">{{ visibleTreeRows.length }}/{{ store.flatDraftLayers.length }}</span>
          </div>
          <div class="toolbar-cluster">
            <button
              class="icon-button primary-icon-button"
              :title="primaryActionTitle"
              :disabled="store.isGenerating"
              @click="runPrimaryAction"
            >
              <Check v-if="store.pendingReview" :size="15" />
              <Loader2 v-else-if="store.isGenerating" class="spin" :size="15" />
              <Sparkles v-else :size="15" />
            </button>
            <button class="icon-button" title="新建图层" :disabled="store.pendingReview" @click="store.addLayer()">
              <Plus :size="15" />
            </button>
            <button class="icon-button" title="新建分组" :disabled="store.pendingReview" @click="store.addGroup()">
              <FolderPlus :size="15" />
            </button>
          </div>
          <div class="layer-filter-row">
            <label class="layer-search" title="按图层名、来源、任务说明和目标结构搜索">
              <Search :size="14" />
              <input v-model="layerSearchQuery" placeholder="搜索图层" />
            </label>
            <div class="filter-tabs" title="筛选图层状态">
              <button
                v-for="filter in layerTreeFilters"
                :key="filter.value"
                type="button"
                :class="{ active: layerTreeFilter === filter.value }"
                :title="filter.title"
                @click="layerTreeFilter = filter.value"
              >
                {{ filter.label }}
              </button>
            </div>
          </div>
        </div>

        <div
          ref="layerListRef"
          class="layer-list"
          @dragover="updateLayerDropTarget"
          @drop.prevent="finishLayerDrag"
          @dragleave="layerDropTarget = null"
        >
          <div
            v-if="layerDropTarget"
            class="drop-indicator"
            :style="{ top: `${layerDropTarget.top}px`, left: `${8 + layerDropTarget.depth * 18}px` }"
          />
          <button
            v-for="layer in visibleTreeRows"
            :key="layer.id"
            draggable="true"
            :data-layer-id="layer.id"
            :data-depth="layer.depth"
            class="layer-row"
            :class="{
              selected: store.selectedLayerId === layer.id,
              group: layer.type === 'group',
              dragging: draggedLayerId === layer.id,
            }"
            :style="{ '--depth': layer.depth }"
            :title="treeRowTitle(layer)"
            @dragstart="startLayerDrag($event, layer)"
            @dragend="cancelLayerDrag"
            @contextmenu="openLayerContextMenu($event, layer)"
            @click="store.selectLayer(layer.id)"
          >
            <span class="layer-indent" />
            <Layers v-if="layer.type === 'layer'" :size="14" />
            <Boxes v-else :size="14" />
            <input
              v-if="editingLayerId === layer.id"
              ref="editingInputRef"
              v-model="editingLayerName"
              class="layer-name-input"
              @click.stop
              @keydown.enter.prevent="commitRenameLayer"
              @keydown.esc.prevent="cancelRenameLayer"
              @blur="commitRenameLayer"
            />
            <span
              v-else
              class="layer-name"
              title="双击重命名"
              @dblclick.stop="startRenameLayer(layer)"
            >
              {{ layer.name }}
            </span>
            <span
              v-if="compactMarker(layer)"
              class="compact-marker"
              :data-tone="compactMarker(layer)?.tone"
              :title="compactMarkerTitle(layer)"
            >
              {{ compactMarker(layer)?.label }}
            </span>
            <span class="layer-row-actions">
              <button
                v-if="layer.type === 'layer'"
                class="ghost-icon"
                :class="{ active: !layer.visible }"
                :title="layer.visible ? '隐藏图层' : '显示图层'"
                @click.stop="store.toggleLayerVisible(layer.id)"
              >
                <Eye v-if="layer.visible" :size="14" />
                <EyeOff v-else :size="14" />
              </button>
              <button
                v-if="layer.type === 'layer'"
                class="ghost-icon"
                :class="{ active: layer.solo }"
                title="单独显示"
                @click.stop="store.toggleLayerSolo(layer.id)"
              >
                <Target :size="14" />
              </button>
            </span>
          </button>
          <div v-if="visibleTreeRows.length === 0" class="empty-tree-state">
            没有匹配的图层
          </div>
        </div>

        <div class="layer-footer">
          <div class="structure-tools">
          <button class="icon-button" title="上移选中图层" :disabled="store.pendingReview" @click="store.moveSelectedLayer(-1)">
            <MoveUp :size="15" />
          </button>
          <button class="icon-button" title="下移选中图层" :disabled="store.pendingReview" @click="store.moveSelectedLayer(1)">
            <MoveDown :size="15" />
          </button>
          <button class="icon-button" title="缩进到上一分组" :disabled="store.pendingReview" @click="store.indentSelectedLayer">
            <Indent :size="15" />
          </button>
          <button class="icon-button" title="提升到父级" :disabled="store.pendingReview" @click="store.outdentSelectedLayer">
            <Outdent :size="15" />
          </button>
          </div>
        </div>
      </section>

      <section class="panel task-card" v-if="selectedLayer">
        <div class="selected-editor task-detail">
          <div class="task-detail-head">
            <span :title="selectedLayerTooltip">图层任务</span>
            <div class="review-actions" v-if="selectedLayer.status === 'pendingReview'">
              <button class="mini-action" title="确认该图层" @click="store.approveLayer(selectedLayer.id)">确认</button>
              <button class="mini-action danger" title="拒绝该图层" @click="store.rejectLayer(selectedLayer.id)">拒绝</button>
            </div>
          </div>
          <div class="task-summary-strip" :title="selectedLayerTooltip">
            <span class="task-pill">{{ roleLabel(selectedLayer.role) }}</span>
            <span class="task-pill">{{ operationName(selectedLayer.editSpec.operation) }}</span>
            <span class="task-pill">方位 {{ sideName(selectedLayer.side) }}</span>
            <span class="task-pill">{{ selectedLayer.exportable ? '导出' : '不导出' }}</span>
            <span class="task-pill">{{ sourceCountLabel }}</span>
          </div>
          <div class="task-grid compact-task-grid">
            <select
              :value="selectedLayer.partType"
              title="拆分部件类型"
              :disabled="store.pendingReview || selectedLayer.locked"
              @change="store.updateLayerTask(selectedLayer.id, { partType: ($event.target as HTMLSelectElement).value as SplitPartType })"
            >
              <option v-for="partType in partTypes" :key="partType.value" :value="partType.value">
                {{ partType.label }}
              </option>
            </select>
            <select
              :value="selectedLayer.editSpec.operation"
              title="生成操作类型"
              :disabled="store.pendingReview || selectedLayer.locked"
              @change="store.updateLayerTask(selectedLayer.id, { editSpec: { operation: ($event.target as HTMLSelectElement).value as FlatLayerNode['editSpec']['operation'] } })"
            >
              <option value="manual">手动</option>
              <option value="split">拆分</option>
              <option value="backfill">背面补全</option>
              <option value="occlusionFill">遮挡补全</option>
              <option value="repair">修复</option>
              <option value="merge">合并</option>
            </select>
          </div>
          <div class="task-grid compact-task-grid">
            <select
              :value="selectedLayer.side"
              title="Live2D 方位"
              :disabled="store.pendingReview || selectedLayer.locked"
              @change="store.updateLayerTask(selectedLayer.id, { side: ($event.target as HTMLSelectElement).value as FlatLayerNode['side'] })"
            >
              <option value="none">无方位</option>
              <option value="front">前面</option>
              <option value="back">背面</option>
              <option value="left">左侧</option>
              <option value="right">右侧</option>
              <option value="inner">内侧</option>
            </select>
            <select
              :value="selectedLayer.role"
              title="图层角色"
              :disabled="store.pendingReview || selectedLayer.locked"
              @change="store.updateLayerTask(selectedLayer.id, { role: ($event.target as HTMLSelectElement).value as FlatLayerNode['role'] })"
            >
              <option value="artwork">输出图层</option>
              <option value="reference">参考源</option>
              <option value="guide">指导层</option>
              <option value="mask">遮罩层</option>
            </select>
          </div>
          <div class="task-compact-row">
            <label class="inline-toggle" title="关闭后不会导出 PSD">
              <input
                :checked="selectedLayer.exportable"
                type="checkbox"
                :disabled="store.pendingReview || selectedLayer.locked"
                @change="store.updateLayerTask(selectedLayer.id, { exportable: ($event.target as HTMLInputElement).checked })"
              />
              导出
            </label>
            <button class="mini-action detail-toggle" :title="taskDetailsExpanded ? '收起高级任务字段' : '展开高级任务字段'" @click="taskDetailsExpanded = !taskDetailsExpanded">
              <ChevronDown v-if="taskDetailsExpanded" :size="14" />
              <ChevronRight v-else :size="14" />
              高级
            </button>
          </div>
          <div v-if="taskDetailsExpanded" class="task-advanced">
            <div class="task-grid">
              <input
                :value="selectedLayer.editSpec.edgePadding"
                type="number"
                min="0"
                max="96"
                step="1"
                title="补边像素"
                :disabled="store.pendingReview || selectedLayer.locked"
                @change="store.updateLayerTask(selectedLayer.id, { editSpec: { edgePadding: Number(($event.target as HTMLInputElement).value) } })"
              />
              <select
                :value="selectedLayer.editSpec.algorithmOverride ?? ''"
                title="单层算法覆盖"
                :disabled="store.pendingReview || selectedLayer.locked"
                @change="store.updateLayerTask(selectedLayer.id, { editSpec: { algorithmOverride: (($event.target as HTMLSelectElement).value || null) as SplitTier | null } })"
              >
                <option value="">跟随设置</option>
                <option value="estimate">估算</option>
                <option value="modelAlpha">实验</option>
                <option value="standard">标准</option>
                <option value="precise">精确</option>
              </select>
            </div>
            <input
              :value="selectedLayer.editSpec.targetStructure"
              title="目标结构"
              placeholder="目标结构"
              :disabled="store.pendingReview || selectedLayer.locked"
              @change="store.updateLayerTask(selectedLayer.id, { editSpec: { targetStructure: ($event.target as HTMLInputElement).value } })"
            />
            <textarea
              :value="selectedLayer.editSpec.instruction"
              title="单图层生成说明"
              placeholder="单图层说明"
              :disabled="store.pendingReview || selectedLayer.locked"
              @change="store.updateLayerTask(selectedLayer.id, { editSpec: { instruction: ($event.target as HTMLTextAreaElement).value } })"
            />
            <div class="source-list" :title="sourceSummary(selectedLayer)">
              <span v-if="selectedLayer.sources.length === 0">无来源，默认参考原始立绘</span>
              <span v-for="source in selectedLayer.sources" :key="`${source.role}-${source.layerId}`">
                {{ source.role }} · {{ store.flatDraftLayers.find((layer) => layer.id === source.layerId)?.name ?? source.layerId }}
              </span>
            </div>
            <div class="revision-line" :title="selectedLayer.revisions[0]?.promptRecipe">
              {{ selectedLayer.revisions[0] ? `${operationName(selectedLayer.revisions[0].operation)} · ${selectedLayer.revisions[0].createdAt}` : `方位 ${sideName(selectedLayer.side)}` }}
            </div>
          </div>
        </div>
      </section>
    </aside>

    <section class="workspace">
      <section class="preview-stage">
          <div class="stage-toolbar">
            <div class="toolbar-cluster">
              <button
                class="icon-button"
                title="画笔：绘制给模型看的拆分指导线"
                :class="{ active: activeDrawTool === 'brush' }"
                @click="activeDrawTool = 'brush'"
              >
                <Brush :size="15" />
              </button>
              <button
                class="icon-button"
                title="橡皮：擦除绘制指导"
                :class="{ active: activeDrawTool === 'eraser' }"
                @click="activeDrawTool = 'eraser'"
              >
                <Eraser :size="15" />
              </button>
              <label class="brush-size" title="画笔大小">
                <input v-model.number="brushSize" type="range" min="2" max="72" step="1" />
              </label>
              <div class="color-palette" title="画笔颜色">
                <button
                  v-for="color in brushColors"
                  :key="color.value"
                  class="color-button"
                  :class="{ active: brushColor === color.value }"
                  :title="color.label"
                  :style="{ '--swatch': color.swatch }"
                  @click="brushColor = color.value; activeDrawTool = 'brush'"
                />
              </div>
              <button class="icon-button" title="清空绘制指导" @click="clearDrawing">
                <CircleOff :size="15" />
              </button>
            </div>

            <div class="toolbar-cluster">
              <button class="icon-button" title="缩小" @click="zoomBy(-0.1)">
                <ZoomOut :size="15" />
              </button>
              <span class="zoom-readout" title="滚轮也可以缩放">{{ Math.round(zoom * 100) }}%</span>
              <button class="icon-button" title="放大" @click="zoomBy(0.1)">
                <ZoomIn :size="15" />
              </button>
              <button class="icon-button" title="重置缩放" @click="resetViewport">
                <ScanLine :size="15" />
              </button>
            </div>
          </div>

          <div class="image-frame" @wheel="onWheel">
            <div
              v-if="previewImage"
              class="canvas-stack"
              :class="{ panning: isPanning }"
              :style="{ transform: canvasTransform }"
              @pointerdown="startPan"
              @pointermove="movePan"
              @pointerup="endPan"
              @pointercancel="endPan"
              @auxclick.prevent
            >
              <img :src="previewImage" alt="拆分预览" @load="syncDrawingCanvasSize" />
              <canvas
                ref="drawingCanvas"
                class="drawing-layer"
                title="在这里绘制拆分指导，内容会随生成请求发送给模型"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="endDrawing"
                @pointercancel="endDrawing"
                @pointerleave="endDrawing"
              />
            </div>
            <div v-else class="empty-state">
              <FileImage :size="34" />
              <span>载入立绘或点击生成后查看预览</span>
            </div>
          </div>
        </section>
    </section>
    </div>

    <div
      v-if="contextMenu"
      class="context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <button type="button" :disabled="!contextLayer" @click="contextLayer && startRenameLayer(contextLayer)">
        重命名
      </button>
      <button type="button" :disabled="!contextLayer || contextLayer.type !== 'layer' || store.pendingReview" @click="planSplitFromMenu">
        规划拆分
      </button>
      <button type="button" :disabled="!contextLayer || contextLayer.type !== 'layer' || store.pendingReview" @click="addBackfillFromMenu">
        生成背面/补全
      </button>
      <button
        type="button"
        :disabled="mergeTargetLayers.length === 0 || store.pendingReview"
        @click="contextMenu.showMergeTargets = !contextMenu.showMergeTargets"
      >
        合并到
      </button>
      <div v-if="contextMenu.showMergeTargets" class="merge-targets">
        <button
          v-for="target in mergeTargetLayers"
          :key="target.id"
          type="button"
          @click="mergeLayerTo(target.id)"
        >
          {{ target.name }}
        </button>
      </div>
      <button
        type="button"
        :disabled="sourceTargetLayers.length === 0 || store.pendingReview"
        @click="contextMenu.showSourceTargets = !contextMenu.showSourceTargets"
      >
        添加来源
      </button>
      <div v-if="contextMenu.showSourceTargets" class="merge-targets source-targets">
        <div v-for="target in sourceTargetLayers" :key="target.id" class="source-target-row">
          <span>{{ target.name }}</span>
          <button type="button" title="主来源" @click="addSourceToSelected(target.id, 'primary')">主</button>
          <button type="button" title="风格参考" @click="addSourceToSelected(target.id, 'style')">风</button>
          <button type="button" title="遮挡参考" @click="addSourceToSelected(target.id, 'occlusion')">挡</button>
          <button type="button" title="遮罩参考" @click="addSourceToSelected(target.id, 'mask')">罩</button>
        </div>
      </div>
      <button type="button" :disabled="!contextLayer || contextLayer.type !== 'layer' || store.pendingReview" @click="markReferenceFromMenu">
        设为参考源
      </button>
      <button type="button" class="danger-menu-item" :disabled="store.pendingReview" @click="deleteLayerFromMenu">
        删除
      </button>
    </div>

    <div v-if="splitPlanDialog" class="modal-backdrop" @click.self="splitPlanDialog = null">
      <section class="split-plan-modal">
        <header class="modal-header">
          <h2 :title="`来源图层：${splitPlanDialog.sourceName}`">规划拆分</h2>
          <button class="icon-button" title="关闭" @click="splitPlanDialog = null">
            <X :size="16" />
          </button>
        </header>

        <div class="split-plan-body">
          <div class="split-plan-list">
            <div
              v-for="(target, index) in splitPlanDialog.targets"
              :key="index"
              class="split-plan-row"
              :class="{ reference: target.reference }"
            >
              <input v-model="target.name" title="拆分目标名称" placeholder="目标名称" />
              <select v-model="target.operation" title="操作">
                <option value="split">拆分</option>
                <option value="backfill">背面补全</option>
                <option value="occlusionFill">遮挡补全</option>
                <option value="repair">修复</option>
                <option value="manual">手动</option>
              </select>
              <select v-model="target.side" title="方位">
                <option value="none">无</option>
                <option value="front">前</option>
                <option value="back">背</option>
                <option value="left">左</option>
                <option value="right">右</option>
                <option value="inner">内</option>
              </select>
              <label class="inline-toggle" title="参考目标会先生成结构，不作为最终 PSD 输出">
                <input v-model="target.reference" type="checkbox" />
                参考
              </label>
              <button class="icon-button" title="删除目标" @click="removeSplitPlanTarget(index)">
                <X :size="14" />
              </button>
              <textarea
                v-model="target.instruction"
                title="拆分说明"
                placeholder="例如：按照百褶裙的每一褶单独拆分"
              />
            </div>
          </div>
        </div>

        <footer class="modal-footer">
          <button class="secondary-button" @click="addSplitPlanTarget">
            <Plus :size="16" />
            添加目标
          </button>
          <button class="secondary-button" @click="splitPlanDialog = null">取消</button>
          <button class="primary-button" @click="applySplitPlan">
            <Check :size="16" />
            应用到图层树
          </button>
        </footer>
      </section>
    </div>

    <div v-if="store.settingsOpen" class="modal-backdrop" @click.self="store.closeSettings">
      <section class="settings-modal">
        <header class="modal-header">
          <h2 title="用于生图背景版本和 LLM 合并 recipe">OpenAI 兼容接口</h2>
          <button class="icon-button" title="关闭" @click="store.closeSettings">
            <X :size="16" />
          </button>
        </header>

        <div class="settings-grid">
          <section class="settings-section wide">
            <div class="settings-section-title">拆分算法</div>
            <div class="tier-grid">
              <button
                v-for="tier in tierEntries"
                :key="tier.id"
                type="button"
                class="tier-option"
                :class="{ active: store.selectedTier === tier.id }"
                :title="tierTooltip(tier)"
                :disabled="store.isGenerating"
                @click="setTier(tier.id)"
              >
                <span>{{ tier.shortName }}</span>
                <small>{{ tier.outputCount }} 张背景</small>
              </button>
            </div>
            <p class="settings-note">
              估算只请求 1 个图像版本，token 和图像调用最少；实验请求颜色图与 Alpha 图 2 次，提示词更长且稳定性依赖模型；
              标准请求黑白 2 个背景版本，适合简单透明；精确请求 5 个背景版本，图像调用和随附上下文最多，但透明度更稳定。
            </p>
          </section>

          <label class="field-label wide" title="OpenAI 兼容服务地址，例如 https://api.openai.com/v1 或你的后端代理">
            Base URL
            <input v-model="store.providerSettings.baseUrl" placeholder="https://api.openai.com/v1" />
          </label>

          <label class="field-label wide" title="浏览器直连会把 API Key 保存在本机 localStorage；生产环境建议使用后端代理">
            API Key
            <input v-model="store.providerSettings.apiKey" type="password" autocomplete="off" placeholder="sk-..." />
          </label>

          <label class="field-label" title="用于生成不同背景版本的图像模型">
            生图模型
            <input v-model="store.providerSettings.imageModel" placeholder="例如 gpt-image-1" />
          </label>

          <label class="field-label" title="用于生成结构化合并 recipe 的文本模型">
            LLM 模型
            <input v-model="store.providerSettings.llmModel" placeholder="例如 gpt-4.1-mini" />
          </label>

          <label class="field-label" title="edits 会上传原始立绘作为参考；generations 只发送文本提示词">
            生图接口
            <select v-model="store.providerSettings.imageApiMode">
              <option value="edits">/images/edits</option>
              <option value="generations">/images/generations</option>
            </select>
          </label>

          <label class="field-label" title="发送给生图接口的尺寸参数">
            图片尺寸
            <input v-model="store.providerSettings.imageSize" placeholder="1024x1024" />
          </label>

          <label class="field-label" title="发送给兼容图像接口的质量参数；不支持时可保持 auto">
            图片质量
            <select v-model="store.providerSettings.imageQuality">
              <option value="auto">auto</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <label class="field-label" title="auto 不传 response_format；b64_json 更适合浏览器直接处理">
            图片返回格式
            <select v-model="store.providerSettings.imageResponseFormat">
              <option value="auto">auto</option>
              <option value="b64_json">b64_json</option>
              <option value="url">url</option>
            </select>
          </label>

          <label class="field-label" title="合并 recipe 的随机性，建议保持较低">
            LLM 温度
            <input
              v-model.number="store.providerSettings.llmTemperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
            />
          </label>

          <label class="toggle-row" title="若兼容服务不支持 response_format，可关闭">
            <input v-model="store.providerSettings.useJsonResponseFormat" type="checkbox" />
            <span>要求 LLM 使用 JSON response_format</span>
          </label>
        </div>

        <footer class="modal-footer">
          <button class="secondary-button" @click="store.closeSettings">取消</button>
          <button class="primary-button" @click="store.persistSettings(); store.closeSettings()">
            <Check :size="16" />
            保存设置
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>
