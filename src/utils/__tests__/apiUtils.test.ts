import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../constants/appConstants';
import { ChatSettings } from '../../types';
import {
  getKeyForRequest,
  isServerManagedApiEnabledForProxyRequests,
  SERVER_MANAGED_API_KEY,
} from '../apiUtils';

vi.mock('../../services/logService', () => ({
  logService: {
    recordApiKeyUsage: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('getKeyForRequest', () => {
  const chatSettings: ChatSettings = {
    modelId: 'gemini-2.5-flash-preview-09-2025',
    temperature: 1,
    topP: 0.95,
    topK: 64,
    showThoughts: false,
    systemInstruction: '',
    ttsVoice: 'Puck',
    thinkingBudget: 0,
  };

  beforeEach(() => {
    localStorage.clear();
    window.__AMC_RUNTIME_CONFIG__ = undefined;
  });

  it('returns server-managed marker key when using proxy custom config with no browser key', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: 'https://proxy.example.com/v1beta',
        apiKey: null,
      },
      chatSettings
    );

    expect(result).toEqual({
      key: SERVER_MANAGED_API_KEY,
      isNewKey: false,
    });
  });

  it('keeps legacy API key missing error when server-managed flow is not enabled', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: false,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: 'https://proxy.example.com/v1beta',
        apiKey: null,
      },
      chatSettings
    );

    expect(result).toEqual({ error: 'API Key not configured.' });
  });

  it('uses runtime-managed proxy settings even when a stale app settings snapshot disables them', () => {
    window.__AMC_RUNTIME_CONFIG__ = {
      serverManagedApi: true,
      useCustomApiConfig: true,
      useApiProxy: true,
      apiProxyUrl: '/api/gemini',
    };

    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: false,
        useCustomApiConfig: false,
        useApiProxy: false,
        apiProxyUrl: null,
        apiKey: null,
      },
      chatSettings
    );

    expect(result).toEqual({
      key: SERVER_MANAGED_API_KEY,
      isNewKey: false,
    });
  });

  it('uses real configured API key when server-managed mode is enabled but key exists', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: 'https://proxy.example.com/v1beta',
        apiKey: 'real-browser-key',
      },
      chatSettings
    );

    expect(result).toEqual({
      key: 'real-browser-key',
      isNewKey: true,
    });
  });

  it('selects OpenAI keys for GPT image models instead of Gemini keys', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        useCustomApiConfig: true,
        apiKey: 'gemini-browser-key',
        openAiApiKey: 'openai-browser-key',
      },
      {
        ...chatSettings,
        modelId: 'gpt-image-2',
      }
    );

    expect(result).toEqual({
      key: 'openai-browser-key',
      isNewKey: true,
    });
  });

  it('selects OpenAI-compatible keys for manually added market chat models', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        useCustomApiConfig: true,
        apiKey: 'gemini-browser-key',
        openAiApiKey: 'openai-compatible-key',
      },
      {
        ...chatSettings,
        modelId: 'gpt-4o',
      }
    );

    expect(result).toEqual({
      key: 'openai-compatible-key',
      isNewKey: true,
    });
  });

  it('lets provider prefixes force OpenAI-compatible routing for gateway model ids', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        useCustomApiConfig: true,
        apiKey: 'gemini-browser-key',
        openAiApiKey: 'openai-compatible-key',
      },
      {
        ...chatSettings,
        modelId: 'openai:gemini-2.5-pro',
      }
    );

    expect(result).toEqual({
      key: 'openai-compatible-key',
      isNewKey: true,
    });
  });

  it('selects Anthropic-compatible keys for Claude models', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        useCustomApiConfig: true,
        apiKey: 'gemini-browser-key',
        openAiApiKey: 'openai-compatible-key',
        anthropicApiKey: 'anthropic-compatible-key',
      },
      {
        ...chatSettings,
        modelId: 'claude-3-5-sonnet-latest',
      }
    );

    expect(result).toEqual({
      key: 'anthropic-compatible-key',
      isNewKey: true,
    });
  });

  it('returns server-managed marker for OpenAI-compatible chat when only the proxy owns the key', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: '/api/gemini',
        apiKey: 'gemini-browser-key',
        openAiApiKey: null,
      },
      {
        ...chatSettings,
        modelId: 'deepseek-chat',
      }
    );

    expect(result).toEqual({
      key: SERVER_MANAGED_API_KEY,
      isNewKey: false,
    });
  });

  it('returns server-managed marker for Anthropic-compatible chat when only the proxy owns the key', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: '/api/gemini',
        apiKey: 'gemini-browser-key',
        anthropicApiKey: null,
      },
      {
        ...chatSettings,
        modelId: 'claude-3-5-sonnet-latest',
      }
    );

    expect(result).toEqual({
      key: SERVER_MANAGED_API_KEY,
      isNewKey: false,
    });
  });

  it('returns server-managed marker for GPT image models when only the proxy owns the key', () => {
    const result = getKeyForRequest(
      {
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: '/api/gemini',
        apiKey: 'gemini-browser-key',
        openAiApiKey: null,
      },
      {
        ...chatSettings,
        modelId: 'gpt-image-2',
      }
    );

    expect(result).toEqual({
      key: SERVER_MANAGED_API_KEY,
      isNewKey: false,
    });
  });
});

describe('isServerManagedApiEnabledForProxyRequests', () => {
  it('returns true only when all required server-managed proxy conditions are met', () => {
    expect(
      isServerManagedApiEnabledForProxyRequests({
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: 'https://proxy.example.com/v1beta',
      })
    ).toBe(true);

    expect(
      isServerManagedApiEnabledForProxyRequests({
        ...DEFAULT_APP_SETTINGS,
        serverManagedApi: true,
        useCustomApiConfig: true,
        useApiProxy: true,
        apiProxyUrl: '   ',
      })
    ).toBe(false);
  });
});
