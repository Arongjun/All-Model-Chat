import React from 'react';
import { Bot, X, Pencil, RefreshCcw } from 'lucide-react';
import { useI18n } from '../../../../contexts/I18nContext';

interface ModelSelectorHeaderProps {
    isEditingList: boolean;
    setIsEditingList: (value: boolean) => void;
    onRefreshModels?: () => void | Promise<void>;
    isRefreshingModels?: boolean;
}

export const ModelSelectorHeader: React.FC<ModelSelectorHeaderProps> = ({
    isEditingList,
    setIsEditingList,
    onRefreshModels,
    isRefreshingModels = false,
}) => {
    const { t } = useI18n();

    return (
        <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-tertiary)] flex items-center gap-2">
                <Bot size={14} strokeWidth={1.5} /> {t('settingsManageModelsTitle')}
            </h4>

            <div className="flex items-center gap-2">
                {onRefreshModels && (
                    <button
                        type="button"
                        onPointerDown={(event) => {
                            event.preventDefault();
                        }}
                        onClick={() => {
                            void onRefreshModels();
                        }}
                        disabled={isRefreshingModels}
                        className="text-xs flex items-center gap-1 px-2 py-1 rounded text-[var(--theme-text-link)] hover:bg-[var(--theme-bg-tertiary)] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <RefreshCcw size={12} className={isRefreshingModels ? 'animate-spin' : ''} />
                        {isRefreshingModels ? t('settingsSyncingModels') : t('settingsSyncModels')}
                    </button>
                )}

                <button
                    type="button"
                    onPointerDown={(event) => {
                        event.preventDefault();
                    }}
                    onClick={() => setIsEditingList(!isEditingList)}
                    className={`text-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${isEditingList ? 'bg-[var(--theme-bg-accent)] text-[var(--theme-text-accent)]' : 'text-[var(--theme-text-link)] hover:bg-[var(--theme-bg-tertiary)]'}`}
                >
                    {isEditingList ? <X size={12} /> : <Pencil size={12} />}
                    {isEditingList ? t('settingsFinishModelListEdit') : t('settingsEditModelList')}
                </button>
            </div>
        </div>
    );
};
