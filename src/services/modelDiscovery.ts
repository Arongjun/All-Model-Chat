import type { ModelOption, WorkspaceDiscoveredModel, WorkspaceModelDiscoveryResponse } from '../types';
import { getDefaultModelOptions } from '../utils/defaultModelOptions';
import { sanitizeModelOptions, sortModels } from '../utils/modelHelpers';
import { workspaceApi } from './workspaceApi';

export const MODEL_DISCOVERY_REFRESH_EVENT = 'arong-model-discovery-refresh';

export interface ModelDiscoveryRefreshResult {
  discovery: WorkspaceModelDiscoveryResponse;
  models: ModelOption[];
  addedCount: number;
}

export const canDiscoverWorkspaceModels = async (): Promise<boolean> => {
  try {
    const session = await workspaceApi.getSession();
    return !session.bootstrapped || !!session.currentUser;
  } catch {
    return false;
  }
};

const toDiscoveredModelOption = (model: WorkspaceDiscoveredModel): ModelOption => ({
  id: model.id,
  name: model.name || model.rawId || model.id,
});

const normalizeModelKey = (modelId: string): string => modelId.trim().toLowerCase();

const upsertModel = (modelsById: Map<string, ModelOption>, model: ModelOption): void => {
  const sanitizedModel = sanitizeModelOptions([model])[0];
  if (!sanitizedModel) {
    return;
  }

  const key = normalizeModelKey(sanitizedModel.id);
  const existing = modelsById.get(key);
  modelsById.set(key, {
    ...existing,
    ...sanitizedModel,
    name: sanitizedModel.name || existing?.name || sanitizedModel.id,
    isPinned: sanitizedModel.isPinned ?? existing?.isPinned,
  });
};

export const mergeDiscoveredModels = (
  currentModels: ModelOption[],
  discoveredModels: WorkspaceDiscoveredModel[],
  defaultModels: ModelOption[] = getDefaultModelOptions(),
): ModelOption[] => {
  const modelsById = new Map<string, ModelOption>();

  defaultModels.forEach((model) => upsertModel(modelsById, model));
  currentModels.forEach((model) => upsertModel(modelsById, model));
  discoveredModels.forEach((model) => upsertModel(modelsById, toDiscoveredModelOption(model)));

  return sortModels(sanitizeModelOptions([...modelsById.values()]));
};

export const discoverAndMergeModels = async (
  currentModels: ModelOption[],
): Promise<ModelDiscoveryRefreshResult> => {
  const beforeIds = new Set(currentModels.map((model) => normalizeModelKey(model.id)));
  const discovery = await workspaceApi.discoverModels();
  const models = mergeDiscoveredModels(currentModels, discovery.models);
  const addedCount = models.filter((model) => !beforeIds.has(normalizeModelKey(model.id))).length;

  return {
    discovery,
    models,
    addedCount,
  };
};

export const requestModelDiscoveryRefresh = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(MODEL_DISCOVERY_REFRESH_EVENT));
};
