import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, generateImagesMock, getAppSettingsMock, getConfiguredApiClientMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  generateImagesMock: vi.fn(),
  getAppSettingsMock: vi.fn(),
  getConfiguredApiClientMock: vi.fn(),
}));

vi.mock('../baseApi', () => ({
  getConfiguredApiClient: getConfiguredApiClientMock,
  getEffectiveApiRequestSettings: async () => ({
    useCustomApiConfig: true,
    useApiProxy: false,
    apiProxyUrl: null,
    openAiApiBase: null,
    ...(await getAppSettingsMock()),
  }),
}));

vi.mock('../../../utils/db', () => ({
  dbService: {
    getAppSettings: getAppSettingsMock,
  },
}));

vi.mock('../../logService', () => ({
  logService: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), recordTokenUsage: vi.fn() },
}));

import { generateImagesApi } from './imageApi';

describe('generateImagesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    getAppSettingsMock.mockResolvedValue(null);
    getConfiguredApiClientMock.mockResolvedValue({
      models: {
        generateImages: generateImagesMock,
      },
    });
    generateImagesMock.mockResolvedValue({
      generatedImages: [
        {
          image: {
            imageBytes: 'base64-image',
          },
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits imageSize for imagen-4.0-fast-generate-001', async () => {
    await generateImagesApi(
      'api-key',
      'imagen-4.0-fast-generate-001',
      'draw a robot',
      '1:1',
      '1K',
      new AbortController().signal,
    );

    expect(generateImagesMock).toHaveBeenCalledWith({
      model: 'imagen-4.0-fast-generate-001',
      prompt: 'draw a robot',
      config: {
        abortSignal: expect.any(AbortSignal),
        numberOfImages: 1,
        outputMimeType: 'image/png',
        aspectRatio: '1:1',
      },
    });
  });

  it('keeps imageSize for imagen-4.0-generate-001', async () => {
    await generateImagesApi(
      'api-key',
      'imagen-4.0-generate-001',
      'draw a robot',
      '1:1',
      '1K',
      new AbortController().signal,
    );

    expect(generateImagesMock).toHaveBeenCalledWith({
      model: 'imagen-4.0-generate-001',
      prompt: 'draw a robot',
      config: {
        abortSignal: expect.any(AbortSignal),
        numberOfImages: 1,
        outputMimeType: 'image/png',
        aspectRatio: '1:1',
        imageSize: '1K',
      },
    });
  });

  it('passes through Imagen-specific generation options', async () => {
    await (generateImagesApi as unknown as (
      apiKey: string,
      modelId: string,
      prompt: string,
      aspectRatio: string,
      imageSize: string | undefined,
      abortSignal: AbortSignal,
      options: { numberOfImages: number; personGeneration: string },
    ) => Promise<string[]>)(
      'api-key',
      'imagen-4.0-generate-001',
      'draw a family portrait',
      '16:9',
      '2K',
      new AbortController().signal,
      {
        numberOfImages: 4,
        personGeneration: 'ALLOW_ALL',
      },
    );

    expect(generateImagesMock).toHaveBeenCalledWith({
      model: 'imagen-4.0-generate-001',
      prompt: 'draw a family portrait',
      config: {
        abortSignal: expect.any(AbortSignal),
        numberOfImages: 4,
        outputMimeType: 'image/png',
        aspectRatio: '16:9',
        imageSize: '2K',
        personGeneration: 'ALLOW_ALL',
      },
    });
  });

  it('normalizes stale aspect ratio and image size values for Imagen standard', async () => {
    await generateImagesApi(
      'api-key',
      'imagen-4.0-generate-001',
      'draw a robot',
      '1:4',
      '4K',
      new AbortController().signal,
    );

    expect(generateImagesMock).toHaveBeenCalledWith({
      model: 'imagen-4.0-generate-001',
      prompt: 'draw a robot',
      config: {
        abortSignal: expect.any(AbortSignal),
        numberOfImages: 1,
        outputMimeType: 'image/png',
        aspectRatio: '1:1',
        imageSize: '1K',
      },
    });
  });

  it('routes gpt-image models to the OpenAI images endpoint with official landscape size', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'openai-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await generateImagesApi(
      'api-key',
      'gpt-image-2',
      'draw a robot',
      '3:2',
      '1K',
      new AbortController().signal,
      {
        numberOfImages: 2,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);

    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer api-key');

    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'draw a robot',
      n: 2,
      output_format: 'png',
      size: '1536x1024',
    });
    expect(getConfiguredApiClientMock).not.toHaveBeenCalled();
  });

  it('normalizes stale gpt-image 2K/16:9 settings to the closest official OpenAI image size', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'openai-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await generateImagesApi(
      'api-key',
      'gpt-image-2',
      'draw a robot',
      '16:9',
      '2K',
      new AbortController().signal,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-image-2',
      size: '1536x1024',
    });
  });

  it('sends auto size for gpt-image models when Auto is selected', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'openai-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await generateImagesApi(
      'api-key',
      'gpt-image-2',
      'draw a robot',
      '2:3',
      'Auto',
      new AbortController().signal,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-image-2',
      size: 'auto',
    });
  });

  it('uses the sibling server-managed proxy for gpt-image models when configured', async () => {
    getAppSettingsMock.mockResolvedValue({
      useCustomApiConfig: true,
      useApiProxy: true,
      apiProxyUrl: '/api/gemini',
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'openai-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await generateImagesApi(
      '__SERVER_MANAGED_API_KEY__',
      'gpt-image-2',
      'draw a robot',
      '1:1',
      '1K',
      new AbortController().signal,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/openai/v1/images/generations');
    expect((init.headers as Headers).get('authorization')).toBeNull();
  });

  it('uses the configured OpenAI base URL for direct gpt-image requests when proxy is off', async () => {
    getAppSettingsMock.mockResolvedValue({
      useCustomApiConfig: true,
      useApiProxy: false,
      openAiApiBase: 'https://openai-compatible.example.com/v1',
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'openai-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await generateImagesApi(
      'api-key',
      'gpt-image-2',
      'draw a robot',
      '1:1',
      '1K',
      new AbortController().signal,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openai-compatible.example.com/v1/images/generations');
  });
});
