import React, { useState } from 'react';
import { ModelOption } from '../../../types';
import { ModelSelectorHeader } from './model-selector/ModelSelectorHeader';
import { ModelListEditor } from './model-selector/ModelListEditor';
import { ModelListView } from './model-selector/ModelListView';

interface ModelSelectorProps {
  availableModels: ModelOption[];
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  setAvailableModels: (models: ModelOption[]) => void;
  onRefreshModels?: () => void | Promise<void>;
  isRefreshingModels?: boolean;
  modelsRefreshError?: string | null;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  availableModels,
  selectedModelId,
  onSelectModel,
  setAvailableModels,
  onRefreshModels,
  isRefreshingModels,
  modelsRefreshError
}) => {
  const [isEditingList, setIsEditingList] = useState(false);

  return (
    <div className="space-y-4">
        <ModelSelectorHeader 
            isEditingList={isEditingList} 
            setIsEditingList={setIsEditingList} 
            onRefreshModels={onRefreshModels}
            isRefreshingModels={isRefreshingModels}
        />

        {!isEditingList && modelsRefreshError && (
            <div className="rounded-xl border border-[var(--theme-border-danger)] bg-[var(--theme-bg-danger)]/10 px-3 py-2 text-xs text-[var(--theme-text-danger)]">
                {modelsRefreshError}
            </div>
        )}

        {isEditingList ? (
            <ModelListEditor 
                availableModels={availableModels} 
                onSave={setAvailableModels} 
                setIsEditingList={setIsEditingList} 
            />
        ) : (
            <ModelListView 
                availableModels={availableModels} 
                selectedModelId={selectedModelId} 
                onSelectModel={onSelectModel} 
            />
        )}
    </div>
  );
};
