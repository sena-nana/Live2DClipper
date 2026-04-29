import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { GenerationPayload, LayerEditSpec, LayerNode, LayerRole, LayerSide, SplitPartType, SplitTier } from '../types/layers';
import { buildSplitPrompt } from '../data/prompts';
import { getTierConfig } from '../data/splitTiers';
import { runOpenAICompatibleGeneration } from '../services/openaiCompatibleProvider';
import { exportLayersToPsd } from '../services/psdExporter';
import { loadOpenAISettings, saveOpenAISettings } from '../services/settingsStorage';
import { createId } from '../utils/id';
import { fileToDataUrl } from '../utils/image';
import {
  addBackfillLayerForSource,
  addSourceToLayer,
  approveLayerNode,
  canDeleteLayerNode,
  createLayerNode,
  defaultEditSpec,
  markLayerAsReference,
  normalizeTree,
  type PlannedSplitTarget,
  planSplitForLayer,
  recordLayerRevision,
  rejectLayerNode,
  syncApprovedLayerToApplied,
  tierOrDefault,
  updateLayerTaskSpec,
} from '../utils/layerTasks';
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
    role: 'artwork',
    side: 'none',
    exportable: false,
    visible: true,
    solo: false,
    locked: false,
    opacity: 1,
    sources: [],
    editSpec: defaultEditSpec(),
    revisions: [],
    children: [
      {
        id: createId('layer'),
        name: '头发',
        type: 'layer',
        partType: 'hair',
        status: 'dirty',
        role: 'artwork',
        side: 'none',
        exportable: true,
        visible: true,
        solo: false,
        locked: false,
        opacity: 1,
        promptHint: '拆出前发、后发与发丝半透明边缘。',
        sources: [],
        editSpec: {
          ...defaultEditSpec('split'),
          instruction: '拆出前发、后发与发丝半透明边缘。',
          targetStructure: '前发、后发、发丝边缘',
        },
        revisions: [],
      },
      {
        id: createId('layer'),
        name: '脸部',
        type: 'layer',
        partType: 'face',
        status: 'clean',
        role: 'artwork',
        side: 'front',
        exportable: true,
        visible: true,
        solo: false,
        locked: false,
        opacity: 1,
        sources: [],
        editSpec: defaultEditSpec(),
        revisions: [],
      },
      {
        id: createId('layer'),
        name: '服装',
        type: 'layer',
        partType: 'clothing',
        status: 'clean',
        role: 'artwork',
        side: 'front',
        exportable: true,
        visible: true,
        solo: false,
        locked: false,
        opacity: 1,
        sources: [],
        editSpec: defaultEditSpec(),
        revisions: [],
      },
    ],
  },
  {
    id: createId('group'),
    name: '特效与阴影',
    type: 'group',
    partType: 'effect',
    status: 'clean',
    role: 'artwork',
    side: 'none',
    exportable: false,
    visible: true,
    solo: false,
    locked: false,
    opacity: 1,
    sources: [],
    editSpec: defaultEditSpec(),
    revisions: [],
    children: [
      {
        id: createId('layer'),
        name: '柔和阴影',
        type: 'layer',
        partType: 'shadow',
        status: 'clean',
        role: 'artwork',
        side: 'none',
        exportable: true,
        visible: true,
        solo: false,
        locked: false,
        opacity: 0.72,
        sources: [],
        editSpec: defaultEditSpec(),
        revisions: [],
      },
    ],
  },
];

export const useProjectStore = defineStore('project', () => {
  const projectName = ref('Live2D 拆分项目');
  const sourceImageUrl = ref<string | null>(null);
  const guideDrawingUrl = ref<string | null>(null);
  const draftTree = ref<LayerNode[]>(normalizeTree(createInitialTree()));
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
    if (selectedLayerId.value) {
      draftTree.value = updateLayer(draftTree.value, selectedLayerId.value, (layer) => ({
        ...layer,
        guideImageUrl: url ?? undefined,
      }));
      return;
    }

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

  const updateLayerTask = (
    id: string,
    patch: Partial<Pick<LayerNode, 'partType' | 'role' | 'side' | 'exportable'>> & {
      editSpec?: Partial<LayerEditSpec>;
    },
  ) => {
    draftTree.value = updateLayerTaskSpec(draftTree.value, id, patch);
  };

  const deleteLayer = (id: string) => {
    if (pendingReview.value) {
      return;
    }

    if (!canDeleteLayerNode(draftTree.value, id)) {
      generationMessage.value = '该图层仍被其他图层引用，先移除来源关系后再删除';
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
    const newLayer = createLayerNode({
      name: `新图层 ${flatDraftLayers.value.filter((layer) => layer.type === 'layer').length + 1}`,
      partType,
    });

    draftTree.value = [...draftTree.value, newLayer];
    selectedLayerId.value = newLayer.id;
  };

  const addGroup = () => {
    const group = createLayerNode({
      name: `新分组 ${flatDraftLayers.value.filter((layer) => layer.type === 'group').length + 1}`,
      type: 'group',
      exportable: false,
      children: [],
    });

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

  const planSplit = (id: string, targets?: PlannedSplitTarget[]) => {
    if (pendingReview.value) {
      return;
    }

    draftTree.value = planSplitForLayer(draftTree.value, id, targets);
    generationMessage.value = '已创建拆分目标图层';
  };

  const addBackfillLayer = (id: string) => {
    if (pendingReview.value) {
      return;
    }

    draftTree.value = addBackfillLayerForSource(draftTree.value, id);
    generationMessage.value = '已创建背面补全图层';
  };

  const markReference = (id: string) => {
    if (pendingReview.value) {
      return;
    }

    draftTree.value = markLayerAsReference(draftTree.value, id);
    generationMessage.value = '已设为参考源图层';
  };

  const addSelectedLayerSource = (sourceId: string, role: 'primary' | 'style' | 'occlusion' | 'mask' = 'primary') => {
    if (!selectedLayerId.value || pendingReview.value) {
      return;
    }

    draftTree.value = addSourceToLayer(draftTree.value, selectedLayerId.value, sourceId, role);
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
          : flatDraftLayers.value.filter(
              (layer) =>
                layer.type === 'layer' &&
                layer.role !== 'guide' &&
                (layer.exportable || (layer.role === 'reference' && layer.sources.length > 0)),
            );
    if (changed.length === 0) {
      return;
    }

    const generationTargets = [...changed].sort((a, b) => {
      if (a.role === b.role) {
        return 0;
      }

      return a.role === 'reference' ? -1 : 1;
    });

    if (!providerReady.value || !providerSettings.value.apiKey.trim()) {
      settingsOpen.value = true;
      generationMessage.value = '请先配置 OpenAI 兼容接口';
      return;
    }

    isGenerating.value = true;
    const maxOutputCount = Math.max(
      ...generationTargets.map((layer) => getTierConfig(tierOrDefault(layer.editSpec.algorithmOverride, selectedTier.value)).outputCount),
    );
    generationMessage.value = generationTargets.some((layer) => layer.role === 'reference')
      ? `正在先生成参考结构，再生成最多 ${maxOutputCount} 个背景版本`
      : `正在生成最多 ${maxOutputCount} 个背景版本`;
    const ids = generationTargets.map((layer) => layer.id);
    draftTree.value = updateLayerStatus(draftTree.value, ids, 'generating');

    const prompt = buildSplitPrompt(selectedTier.value, generationTargets, flatDraftLayers.value);
    lastPrompt.value = prompt;

    const payload: GenerationPayload = {
      projectName: projectName.value,
      tier: selectedTier.value,
      sourceImageUrl: sourceImageUrl.value,
      guideImageUrl: guideDrawingUrl.value,
      layerTree: cloneTree(draftTree.value),
      changedLayers: generationTargets,
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
        draftTree.value = recordLayerRevision(draftTree.value, result.layerId, {
          operation: result.operation,
          promptRecipe: result.promptRecipe,
          imageUrl: result.rgbaUrl,
        });
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

  const approveLayer = (id: string) => {
    draftTree.value = approveLayerNode(draftTree.value, id);
    appliedTree.value = syncApprovedLayerToApplied(appliedTree.value, draftTree.value, id);
    generationMessage.value = '已确认图层';
  };

  const rejectLayer = (id: string) => {
    draftTree.value = rejectLayerNode(appliedTree.value, draftTree.value, id);
    generationMessage.value = '已拒绝图层生成';
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
    updateLayerTask,
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
    planSplit,
    addBackfillLayer,
    markReference,
    addSelectedLayerSource,
    runGeneration,
    approvePending,
    approveLayer,
    rejectPending,
    rejectLayer,
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
