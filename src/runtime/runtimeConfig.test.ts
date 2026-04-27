import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeConfigAppSettingsOverrides } from './runtimeConfig';

describe('runtimeConfig', () => {
  afterEach(() => {
    delete window.__AMC_RUNTIME_CONFIG__;
  });

  it('returns empty overrides when runtime config is missing', () => {
    expect(getRuntimeConfigAppSettingsOverrides()).toEqual({});
  });

  it('reads supported app setting overrides from window runtime config', () => {
    window.__AMC_RUNTIME_CONFIG__ = {
      serverManagedApi: true,
      useCustomApiConfig: true,
      useApiProxy: true,
      apiProxyUrl: 'https://proxy.runtime.example/v1beta',
      openAiApiBase: 'https://openai-compatible.runtime.example/v1',
      anthropicApiBase: 'https://anthropic-compatible.runtime.example',
      liveApiEphemeralTokenEndpoint: '/api/live-token',
    };

    expect(getRuntimeConfigAppSettingsOverrides()).toEqual({
      serverManagedApi: true,
      useCustomApiConfig: true,
      useApiProxy: true,
      apiProxyUrl: 'https://proxy.runtime.example/v1beta',
      openAiApiBase: 'https://openai-compatible.runtime.example/v1',
      anthropicApiBase: 'https://anthropic-compatible.runtime.example',
      liveApiEphemeralTokenEndpoint: '/api/live-token',
    });
  });

  it('converts string values into typed setting overrides', () => {
    window.__AMC_RUNTIME_CONFIG__ = {
      serverManagedApi: 'true',
      useCustomApiConfig: '1',
      useApiProxy: 'false',
      apiProxyUrl: '  ',
      openAiApiBase: '  ',
      anthropicApiBase: '  ',
      liveApiEphemeralTokenEndpoint: '   ',
    };

    expect(getRuntimeConfigAppSettingsOverrides()).toEqual({
      serverManagedApi: true,
      useCustomApiConfig: true,
      useApiProxy: false,
      apiProxyUrl: null,
      openAiApiBase: null,
      anthropicApiBase: null,
      liveApiEphemeralTokenEndpoint: null,
    });
  });
});
