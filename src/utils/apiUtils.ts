import { AppSettings, ChatSettings } from '../types';
import {
    ANTHROPIC_API_KEY_LAST_USED_INDEX_KEY,
    API_KEY_LAST_USED_INDEX_KEY,
    OPENAI_API_KEY_LAST_USED_INDEX_KEY,
    SERVER_MANAGED_API_APP_SETTING_DEFAULTS,
} from '../constants/appConstants';
import { logService } from '../services/logService';
import { isAnthropicCompatibleChatModel, isOpenAiCompatibleChatModel, isOpenAiImageModel } from './modelHelpers';
import { getRuntimeConfigAppSettingsOverrides } from '../runtime/runtimeConfig';

export const SERVER_MANAGED_API_KEY = '__SERVER_MANAGED_API_KEY__';
type ApiProvider = 'gemini' | 'openai' | 'anthropic';

const PROVIDER_ROTATION_STORAGE_KEYS: Record<ApiProvider, string> = {
    gemini: API_KEY_LAST_USED_INDEX_KEY,
    openai: OPENAI_API_KEY_LAST_USED_INDEX_KEY,
    anthropic: ANTHROPIC_API_KEY_LAST_USED_INDEX_KEY,
};

type ServerManagedProxyEligibility = Pick<
    AppSettings,
    'serverManagedApi' | 'useCustomApiConfig' | 'useApiProxy' | 'apiProxyUrl'
>;

export const isServerManagedApiEnabledForProxyRequests = (
    appSettings: ServerManagedProxyEligibility,
): boolean =>
    !!(
        appSettings.serverManagedApi &&
        appSettings.useCustomApiConfig &&
        appSettings.useApiProxy &&
        appSettings.apiProxyUrl?.trim()
    );

const getProviderForModel = (modelId: string): ApiProvider =>
    isAnthropicCompatibleChatModel(modelId)
        ? 'anthropic'
        : isOpenAiImageModel(modelId) || isOpenAiCompatibleChatModel(modelId)
          ? 'openai'
          : 'gemini';

const getActiveApiConfig = (appSettings: AppSettings, provider: ApiProvider): { apiKeysString: string | null } => {
    const envWithApiKeys = (
        import.meta as ImportMeta & {
            env?: {
                VITE_GEMINI_API_KEY?: string;
                VITE_OPENAI_API_KEY?: string;
                VITE_ANTHROPIC_API_KEY?: string;
            };
        }
    ).env;

    if (appSettings.useCustomApiConfig) {
        return {
            apiKeysString: provider === 'anthropic'
                ? appSettings.anthropicApiKey ?? null
                : provider === 'openai'
                  ? appSettings.openAiApiKey ?? null
                  : appSettings.apiKey,
        };
    }
    return {
        apiKeysString: provider === 'anthropic'
            ? envWithApiKeys?.VITE_ANTHROPIC_API_KEY || null
            : provider === 'openai'
              ? envWithApiKeys?.VITE_OPENAI_API_KEY || null
              : envWithApiKeys?.VITE_GEMINI_API_KEY || null,
    };
};

export const parseApiKeys = (apiKeysString: string | null): string[] => {
    if (!apiKeysString) return [];
    return apiKeysString
        .split(/[\n,]+/)
        .map((k) => k.trim().replace(/^["']|["']$/g, ''))
        .filter((k) => k.length > 0);
};

export const getKeyForRequest = (
    appSettings: AppSettings,
    currentChatSettings: ChatSettings,
    options: { skipIncrement?: boolean } = {},
): { key: string; isNewKey: boolean } | { error: string } => {
    const { skipIncrement = false } = options;
    const effectiveAppSettings = {
        ...SERVER_MANAGED_API_APP_SETTING_DEFAULTS,
        ...appSettings,
        ...getRuntimeConfigAppSettingsOverrides(),
    };
    const provider = getProviderForModel(currentChatSettings.modelId);
    const rotationStorageKey = PROVIDER_ROTATION_STORAGE_KEYS[provider];
    const shouldUseServerManagedMarker = isServerManagedApiEnabledForProxyRequests(effectiveAppSettings);

    const logUsage = (key: string) => {
        if (effectiveAppSettings.useCustomApiConfig) {
            logService.recordApiKeyUsage(key);
        }
    };

    const { apiKeysString } = getActiveApiConfig(effectiveAppSettings, provider);
    if (!apiKeysString) {
        if (shouldUseServerManagedMarker) {
            return { key: SERVER_MANAGED_API_KEY, isNewKey: false };
        }
        return { error: 'API Key not configured.' };
    }

    const availableKeys = parseApiKeys(apiKeysString);

    if (availableKeys.length === 0) {
        if (shouldUseServerManagedMarker) {
            return { key: SERVER_MANAGED_API_KEY, isNewKey: false };
        }
        return { error: 'No valid API keys found.' };
    }

    if (currentChatSettings.lockedApiKey) {
        if (availableKeys.includes(currentChatSettings.lockedApiKey)) {
            logUsage(currentChatSettings.lockedApiKey);
            return { key: currentChatSettings.lockedApiKey, isNewKey: false };
        }
        logService.warn('Locked key not found in current configuration. Falling back to rotation.');
    }

    if (availableKeys.length === 1) {
        const key = availableKeys[0];
        logUsage(key);
        const isNewKey = currentChatSettings.lockedApiKey !== key;
        return { key, isNewKey };
    }

    let lastUsedIndex = -1;
    try {
        const storedIndex = localStorage.getItem(rotationStorageKey);
        if (storedIndex !== null) {
            lastUsedIndex = parseInt(storedIndex, 10);
        }
    } catch (e) {
        logService.error('Could not parse last used API key index', e);
    }

    if (isNaN(lastUsedIndex) || lastUsedIndex < 0 || lastUsedIndex >= availableKeys.length) {
        lastUsedIndex = -1;
    }

    let targetIndex: number;

    if (skipIncrement) {
        targetIndex = lastUsedIndex === -1 ? 0 : lastUsedIndex;
    } else {
        targetIndex = (lastUsedIndex + 1) % availableKeys.length;
        try {
            localStorage.setItem(rotationStorageKey, targetIndex.toString());
        } catch (e) {
            logService.error('Could not save last used API key index', e);
        }
    }

    const nextKey = availableKeys[targetIndex];
    logUsage(nextKey);
    return { key: nextKey, isNewKey: true };
};

export const getApiKeyErrorTranslationKey = (error: string): string | null => {
    switch (error) {
        case 'API Key not configured.':
            return 'apiRuntime_keyNotConfigured';
        case 'No valid API keys found.':
            return 'apiRuntime_noValidKeysFound';
        default:
            return null;
    }
};
