import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateImagesMock, getAppSettingsMock, getConfiguredApiClientMock, recordTokenUsageMock } = vi.hoisted(() => ({
  generateImagesMock: vi.fn(),
  getConfiguredApiClientMock: vi.fn(),
  getAppSettingsMock: vi.fn(),
  recordTokenUsageMock: vi.fn(),
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
  logService: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    recordTokenUsage: recordTokenUsageMock,
  },
}));

import { generateImagesApi } from './imageApi';

describe('image pricing usage logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppSettingsMock.mockResolvedValue(null);
    getConfiguredApiClientMock.mockResolvedValue({
      models: {
        generateImages: generateImagesMock,
      },
    });
    generateImagesMock.mockResolvedValue({
      generatedImages: [
        { image: { imageBytes: 'base64-image-1' } },
        { image: { imageBytes: 'base64-image-2' } },
      ],
    });
  });

  it('records exact Imagen pricing metadata from generated image counts', async () => {
    await generateImagesApi(
      'api-key',
      'imagen-4.0-generate-001',
      'draw a robot',
      '1:1',
      '1K',
      new AbortController().signal,
    );

    expect(recordTokenUsageMock).toHaveBeenCalledWith(
      'imagen-4.0-generate-001',
      expect.objectContaining({
        promptTokens: 0,
        completionTokens: 0,
      }),
      expect.objectContaining({
        requestKind: 'image_generate',
        generatedImageCount: 2,
      }),
    );
  });
});
