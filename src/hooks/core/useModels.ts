
import { useState, useCallback, useEffect, useRef } from 'react';
import { ModelOption } from '../../types';
import { sanitizeModelOptions } from '../../utils/modelHelpers';
import {
    canDiscoverWorkspaceModels,
    discoverAndMergeModels,
    MODEL_DISCOVERY_REFRESH_EVENT,
} from '../../services/modelDiscovery';

const CUSTOM_MODELS_KEY = 'custom_model_list_v1';

const persistModels = (models: ModelOption[]) => {
    localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(models));
};

const parseStoredModels = (storedValue: string | null): ModelOption[] | null => {
    if (storedValue === null) {
        return null;
    }

    return sanitizeModelOptions(JSON.parse(storedValue));
};

export const useModels = () => {
    // Initialize with persisted models or defaults
    const [apiModels, setApiModelsState] = useState<ModelOption[]>(() => {
        try {
            const storedModels = parseStoredModels(localStorage.getItem(CUSTOM_MODELS_KEY));
            if (storedModels) {
                return storedModels;
            }
        } catch (e) {
            console.error('Failed to load custom models', e);
        }
        return [];
    });
    const [isModelsLoading, setIsModelsLoading] = useState(() => apiModels.length === 0);
    const [modelsLoadingError, setModelsLoadingError] = useState<string | null>(null);
    const [isModelsRefreshing, setIsModelsRefreshing] = useState(false);
    const [modelsRefreshError, setModelsRefreshError] = useState<string | null>(null);
    const [lastModelRefreshAt, setLastModelRefreshAt] = useState<string | null>(null);
    const modelsRef = useRef(apiModels);
    const isMountedRef = useRef(true);
    const autoRefreshStartedRef = useRef(false);

    useEffect(() => {
        modelsRef.current = apiModels;
    }, [apiModels]);

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const setApiModels = useCallback((models: ModelOption[]) => {
        const sanitizedModels = sanitizeModelOptions(models);
        modelsRef.current = sanitizedModels;
        setApiModelsState(sanitizedModels);
        setIsModelsLoading(false);
        setModelsLoadingError(null);
        setModelsRefreshError(null);
        persistModels(sanitizedModels);
    }, []);

    const refreshModelsFromApi = useCallback(async (options: { silent?: boolean } = {}) => {
        if (typeof fetch !== 'function') {
            return;
        }

        if (isMountedRef.current) {
            setIsModelsRefreshing(true);
            if (!options.silent) {
                setModelsRefreshError(null);
            }
        }

        try {
            if (!(await canDiscoverWorkspaceModels())) {
                if (isMountedRef.current && !options.silent) {
                    setModelsRefreshError('请先到「设置」→「账号与额度」登录后再同步 API 模型。');
                }
                return;
            }

            const { models } = await discoverAndMergeModels(modelsRef.current);
            if (!isMountedRef.current) {
                return;
            }

            modelsRef.current = models;
            setApiModelsState(models);
            setIsModelsLoading(false);
            setModelsLoadingError(null);
            setModelsRefreshError(null);
            setLastModelRefreshAt(new Date().toISOString());
            persistModels(models);
        } catch (error) {
            if (!isMountedRef.current || options.silent) {
                return;
            }
            setModelsRefreshError(error instanceof Error ? error.message : 'Failed to sync API models.');
        } finally {
            if (isMountedRef.current) {
                setIsModelsRefreshing(false);
            }
        }
    }, []);

    useEffect(() => {
        if (apiModels.length > 0) {
            setIsModelsLoading(false);
            return;
        }

        let isActive = true;

        void import('../../utils/defaultModelOptions')
            .then(({ getDefaultModelOptions }) => {
                if (!isActive) return;
                const defaultModels = getDefaultModelOptions();
                modelsRef.current = defaultModels;
                setApiModelsState(defaultModels);
                setIsModelsLoading(false);
            })
            .catch((error) => {
                console.error('Failed to load default models', error);
                if (!isActive) return;
                setModelsLoadingError('Failed to load default models');
                setIsModelsLoading(false);
            });

        return () => {
            isActive = false;
        };
    }, [apiModels.length]);

    useEffect(() => {
        if (autoRefreshStartedRef.current || isModelsLoading || modelsRef.current.length === 0) {
            return;
        }

        autoRefreshStartedRef.current = true;
        void refreshModelsFromApi({ silent: true });
    }, [isModelsLoading, refreshModelsFromApi]);

    useEffect(() => {
        const handleModelDiscoveryRefresh = () => {
            void refreshModelsFromApi();
        };

        window.addEventListener(MODEL_DISCOVERY_REFRESH_EVENT, handleModelDiscoveryRefresh);
        return () => window.removeEventListener(MODEL_DISCOVERY_REFRESH_EVENT, handleModelDiscoveryRefresh);
    }, [refreshModelsFromApi]);

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== CUSTOM_MODELS_KEY) {
                return;
            }

            try {
                const storedModels = parseStoredModels(event.newValue);
                if (storedModels) {
                    modelsRef.current = storedModels;
                    setApiModelsState(storedModels);
                    setIsModelsLoading(false);
                    setModelsLoadingError(null);
                    return;
                }

                modelsRef.current = [];
                setApiModelsState([]);
                setIsModelsLoading(true);
                setModelsLoadingError(null);
            } catch (error) {
                console.error('Failed to sync custom models from storage', error);
                setModelsLoadingError('Failed to load default models');
                setIsModelsLoading(false);
            }
        };

        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    return {
        apiModels,
        setApiModels,
        isModelsLoading,
        modelsLoadingError,
        refreshModelsFromApi,
        isModelsRefreshing,
        modelsRefreshError,
        lastModelRefreshAt,
    };
};
