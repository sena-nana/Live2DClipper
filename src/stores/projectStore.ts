import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { GenerationPayload, LayerNode, SplitPartType, SplitTier } from '../types/layers';
import { buildSplitPrompt } from '../data/prompts';
import { getTierConfig } from '../data/splitTiers';
import { runOpenAICompatibleGeneration } from '../services/openaiCompatibleProvider';
import { exportLayersToPsd } from '../services/psdExporter';
import { loadOpenAISettings, saveOpenAISettings } from '../services/settingsStorage';
import { createId } from '../utils/id';
import { fileToDataUrl } from '../utils/image';
import {
  cloneTree,
  collectChangedLayers,
  deleteLayerNode,
  findLayer,
  flattenTree,
  hasDirtyLayers,
  hasPendingReview,
  indentLayerIntoPreviousGroup,
  markTreeClean,
  mergeLayerNodeInto,
  moveLayerToParent,
  moveLayerSibling,
  outdentLayer,
  updateLayer,
  updateLayerStatus,
} from '../utils/tree';

const createInitialTree = (): LayerNode[] => [
  {
    id: createId('group'),
    name: '角色主体',
    type: 'group',
    partType: 'base',
    status: 'clean',
    visible: true,
    solo: false,
    locked: false,
    opacity: 1,
    children: [
      {
        id: createId('layer'),
        name: '头发',
        type: 'layer',
        partType: 'hair',
        status: 'dirty',
        visible: true,
        solo: false,
        locked: false,
        opacity: 1,
        promptHint: '拆出前发、后发与发丝半透明边缘。',
      },
      {
        id: createId('layer'),
        name: '脸部',
        type: 'layer',
        partType: 'face',
        status: 'clean',
        visible: true,
        solo: false,
        locked: false,
        opacity: 1,
      },
      {
        id: createId('layer'),
        name: '服装',
        type: 'layer',
        partType: 'clothing',
        status: 'clean',
        visible: true,
        solo: false,
        locked: false,
        opacity: 1,
      },
    ],
  },
  {
    id: createId('group'),
    name: '特效与阴影',
    type: 'group',
    partType: 'effect',
    status: 'clean',
    visible: true,
    solo: false,
    locked: false,
    opacity: 1,
    children: [
      {
        id: createId('layer'),
        name: '柔和阴影',
        type: 'layer',
        partType: 'shadow',
        status: 'clean',
        visible: true,
        solo: false,
        locked: false,
        opacity: 0.72,
      },
    ],
  },
];

export const useProjectStore = defineStore('project', () => {
  const projectName = ref('Live2D 拆分项目');
  const sourceImageUrl = ref<string | null>(null);
  const guideDrawingUrl = ref<string | null>(null);
  const draftTree = ref<LayerNode[]>(createInitialTree());
  const appliedTree = ref<LayerNode[]>(cloneTree(draftTree.value));
  const selectedLayerId = ref<string | null>(flattenTree(draftTree.value).find((layer) => layer.type === 'layer')?.id ?? null);
  const selectedTier = ref<SplitTier>('standard');
  const providerSettings = ref(loadOpenAISettings());
  const settingsOpen = ref(false);
  const isGenerating = ref(false);
  const generationMessage = ref('等待生成');
  const lastPrompt = ref('');
  const lastRecipe = ref('');

  const flatDraftLayers = computed(() => flattenTree(draftTree.value));
  const selectedLayer = computed(() => findLayer(draftTree.value, selectedLayerId.value));
  const changedLayers = computed(() => collectChangedLayers(draftTree.value));
  const dirty = computed(() => hasDirtyLayers(draftTree.value));
  const pendingReview = computed(() => hasPendingReview(draftTree.value));
  const tierConfig = computed(() => getTierConfig(selectedTier.value));
  const visibleLayers = computed(() => {
    const flat = flatDraftLayers.value.filter((layer) => layer.type === 'layer');
    const soloIds = flat.filter((layer) => layer.solo).map((layer) => layer.id);

    return flat.filter((layer) => {
      if (soloIds.length > 0) {
        return soloIds.includes(layer.id);
      }

      return layer.visible;
    });
  });

  const providerReady = computed(
    () =>
      Boolean(providerSettings.value.baseUrl.trim()) &&
      Boolean(providerSettings.value.imageModel.trim()) &&
      Boolean(providerSettings.value.llmModel.trim()),
  );

  const uploadSourceImage = async (file: File) => {
    sourceImageUrl.value = await fileToDataUrl(file);
    markAllDirty();
  };

  const setGuideDrawingUrl = (url: string | null) => {
    guideDrawingUrl.value = url;
  };

  const setSelectedTier = (tier: SplitTier) => {
    selectedTier.value = tier;
  };

  const openSettings = () => {
    settingsOpen.value = true;
  };

  const closeSettings = () => {
    settingsOpen.value = false;
  };

  const persistSettings = () => {
    saveOpenAISettings(providerSettings.value);
    generationMessage.value = providerReady.value ? '接口设置已保存' : '接口设置未完整';
  };

  const selectLayer = (id: string) => {
    selectedLayerId.value = id;
  };

  const markLayerDirty = (id: string) => {
    draftTree.value = updateLayer(draftTree.value, id, (layer) => ({
      ...layer,
      status: layer.status === 'pendingReview' ? layer.status : 'dirty',
    }));
  };

  const markAllDirty = () => {
    const ids = flatDraftLayers.value.filter((layer) => layer.type === 'layer').map((layer) => layer.id);
    draftTree.value = updateLayerStatus(draftTree.value, ids, 'dirty');
  };

  const renameLayer = (id: string, name: string) => {
    draftTree.value = updateLayer(draftTree.value, id, (layer) => ({ ...layer, name, status: 'dirty' }));
  };

  const setLayerPartType = (id: string, partType: SplitPartType) => {
    draftTree.value = updateLayer(draftTree.value, id, (layer) => ({ ...layer, partType, status: 'dirty' }));
  };

  const deleteLayer = (id: string) => {
    if (pendingReview.value) {
      return;
    }

    draftTree.value = deleteLayerNode(draftTree.value, id);
    if (selectedLayerId.value === id) {
      selectedLayerId.value = flatDraftLayers.value.find((layer) => layer.type === 'layer')?.id ?? null;
    }
  };

  const mergeLayerInto = (sourceId: string, targetId: string) => {
    if (pendingReview.value) {
      return;
    }

    draftTree.value = mergeLayerNodeInto(draftTree.value, sourceId, targetId);
    selectedLayerId.value = targetId;
  };

  const toggleLayerVisible = (id: string) => {
    draftTree.value = updateLayer(draftTree.value, id, (layer) => ({ ...layer, visible: !layer.visible }));
  };

  const toggleLayerSolo = (id: string) => {
    draftTree.value = updateLayer(draftTree.value, id, (layer) => ({ ...layer, solo: !layer.solo }));
  };

  const addLayer = (partType: SplitPartType = 'base') => {
    const newLayer: LayerNode = {
      id: createId('layer'),
      name: `新图层 ${flatDraftLayers.value.filter((layer) => layer.type === 'layer').length + 1}`,
      type: 'layer',
      partType,
      status: 'dirty',
      visible: true,
      solo: false,
      locked: false,
      opacity: 1,
    };

    draftTree.value = [...draftTree.value, newLayer];
    selectedLayerId.value = newLayer.id;
  };

  const addGroup = () => {
    const group: LayerNode = {
      id: createId('group'),
      name: `新分组 ${flatDraftLayers.value.filter((layer) => layer.type === 'group').length + 1}`,
      type: 'group',
      partType: 'base',
      status: 'dirty',
      visible: true,
      solo: false,
      locked: false,
      opacity: 1,
      children: [],
    };

    draftTree.value = [...draftTree.value, group];
    selectedLayerId.value = group.id;
  };

  const moveSelectedLayer = (direction: -1 | 1) => {
    if (!selectedLayerId.value || pendingReview.value) {
      return;
    }

    draftTree.value = moveLayerSibling(draftTree.value, selectedLayerId.value, direction);
  };

  const indentSelectedLayer = () => {
    if (!selectedLayerId.value || pendingReview.value) {
      return;
    }

    draftTree.value = indentLayerIntoPreviousGroup(draftTree.value, selectedLayerId.value);
  };

  const outdentSelectedLayer = () => {
    if (!selectedLayerId.value || pendingReview.value) {
      return;
    }

    draftTree.value = outdentLayer(draftTree.value, selectedLayerId.value);
  };

  const moveLayerTo = (id: string, parentId: string | null, index: number) => {
    if (pendingReview.value) {
      return;
    }

    draftTree.value = moveLayerToParent(draftTree.value, id, parentId, index);
    selectedLayerId.value = id;
  };

  const runGeneration = async (layerId?: string) => {
    if (isGenerating.value || pendingReview.value) {
      return;
    }

    const requestedLayer = layerId ? findLayer(draftTree.value, layerId) : null;
    const changed =
      requestedLayer?.type === 'layer'
        ? [requestedLayer]
        : changedLayers.value.length > 0
          ? changedLayers.value
          : flatDraftLayers.value.filter((layer) => layer.type === 'layer');
    if (changed.length === 0) {
      return;
    }

    if (!providerReady.value || !providerSettings.value.apiKey.trim()) {
      settingsOpen.value = true;
      generationMessage.value = '请先配置 OpenAI 兼容接口';
      return;
    }

    isGenerating.value = true;
    generationMessage.value = `正在生成 ${tierConfig.value.outputCount} 个背景版本`;
    const ids = changed.map((layer) => layer.id);
    draftTree.value = updateLayerStatus(draftTree.value, ids, 'generating');

    const prompt = buildSplitPrompt(selectedTier.value, changed);
    lastPrompt.value = prompt;

    const payload: GenerationPayload = {
      projectName: projectName.value,
      tier: selectedTier.value,
      sourceImageUrl: sourceImageUrl.value,
      guideImageUrl: guideDrawingUrl.value,
      layerTree: cloneTree(draftTree.value),
      changedLayers: changed,
      prompt,
      backgrounds: tierConfig.value.backgrounds,
    };

    try {
      const results = await runOpenAICompatibleGeneration(payload, providerSettings.value);
      lastRecipe.value = results.map((result) => result.promptRecipe).join('\n\n');

      for (const result of results) {
        draftTree.value = updateLayer(draftTree.value, result.layerId, (layer) => ({
          ...layer,
          status: 'pendingReview',
          imageUrl: result.rgbaUrl,
        }));
      }

      generationMessage.value = '生成完成，等待审核';
    } catch (error) {
      draftTree.value = updateLayerStatus(draftTree.value, ids, 'failed');
      generationMessage.value = error instanceof Error ? error.message : '生成失败';
    } finally {
      isGenerating.value = false;
    }
  };

  const approvePending = () => {
    draftTree.value = markTreeClean(draftTree.value);
    appliedTree.value = cloneTree(draftTree.value);
    generationMessage.value = '已确认，可继续编辑';
  };

  const rejectPending = () => {
    const applied = cloneTree(appliedTree.value);
    draftTree.value = applied.map((node) => resetPendingFromDraft(node, draftTree.value));
    generationMessage.value = '已拒绝本次生成';
  };

  const exportPsd = async () => {
    await exportLayersToPsd(projectName.value, sourceImageUrl.value, appliedTree.value);
  };

  return {
    projectName,
    sourceImageUrl,
    guideDrawingUrl,
    draftTree,
    appliedTree,
    selectedLayerId,
    selectedLayer,
    selectedTier,
    providerSettings,
    settingsOpen,
    isGenerating,
    generationMessage,
    lastPrompt,
    lastRecipe,
    flatDraftLayers,
    changedLayers,
    dirty,
    pendingReview,
    tierConfig,
    visibleLayers,
    providerReady,
    uploadSourceImage,
    setGuideDrawingUrl,
    setSelectedTier,
    openSettings,
    closeSettings,
    persistSettings,
    selectLayer,
    markLayerDirty,
    renameLayer,
    setLayerPartType,
    deleteLayer,
    mergeLayerInto,
    toggleLayerVisible,
    toggleLayerSolo,
    addLayer,
    addGroup,
    moveSelectedLayer,
    indentSelectedLayer,
    outdentSelectedLayer,
    moveLayerTo,
    runGeneration,
    approvePending,
    rejectPending,
    exportPsd,
  };
});

const resetPendingFromDraft = (appliedNode: LayerNode, draftNodes: LayerNode[]): LayerNode => {
  const draftNode = findLayer(draftNodes, appliedNode.id);

  return {
    ...appliedNode,
    status: draftNode?.status === 'pendingReview' ? 'dirty' : appliedNode.status,
    children: appliedNode.children?.map((child) => resetPendingFromDraft(child, draftNodes)),
  };
};
