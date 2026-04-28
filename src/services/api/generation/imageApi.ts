import type { GenerateImagesConfig } from '@google/genai';
import type { GenerateImagesRequestOptions } from '../../../types';
import { getConfiguredApiClient, getEffectiveApiRequestSettings } from '../baseApi';
import { logService } from "../../logService";
import { buildExactImageGenerationPricing } from '../../../utils/usagePricingTelemetry';
import { SERVER_MANAGED_API_KEY } from '../../../utils/apiUtils';
import {
    buildOpenAiImagesRequestUrl,
    DEFAULT_OPENAI_API_BASE_URL,
    deriveSiblingProviderProxyUrl,
} from '../../../utils/apiProxyUrl';
import {
    isOpenAiImageModel,
    normalizeAspectRatioForModel,
    normalizeImageSizeForModel,
    stripModelProviderPrefix,
} from '../../../utils/modelHelpers';

const OPENAI_IMAGE_SIZE_PRESETS: Record<string, Record<string, string>> = {
    '1K': {
        '1:1': '1024x1024',
        '3:2': '1536x1024',
        '2:3': '1024x1536',
    },
};

const OPENAI_DEFAULT_IMAGE_SIZE = OPENAI_IMAGE_SIZE_PRESETS['1K']['1:1'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const readProviderErrorMessage = (payload: unknown): string | null => {
    if (!isRecord(payload)) {
        return null;
    }

    const error = payload.error;
    if (typeof error === 'string' && error.trim()) {
        return error.trim();
    }

    if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
        return error.message.trim();
    }

    if (typeof payload.message === 'string' && payload.message.trim()) {
        return payload.message.trim();
    }

    return null;
};

const resolveOpenAiImagesEndpoint = async (
    apiKey: string,
): Promise<{ headers: Headers; url: string }> => {
    const settings = await getEffectiveApiRequestSettings();
    const configuredProxyUrl = settings.useCustomApiConfig && settings.useApiProxy && settings.apiProxyUrl
        ? settings.apiProxyUrl
        : null;
    const siblingProxyUrl = configuredProxyUrl
        ? deriveSiblingProviderProxyUrl(configuredProxyUrl, 'openai')
        : null;
    const directOpenAiBaseUrl = settings.openAiApiBase?.trim() || DEFAULT_OPENAI_API_BASE_URL;
    const endpointUrl = buildOpenAiImagesRequestUrl(
        siblingProxyUrl || directOpenAiBaseUrl,
    );
    const headers = new Headers({
        'content-type': 'application/json',
    });

    if (apiKey !== SERVER_MANAGED_API_KEY) {
        headers.set('authorization', `Bearer ${apiKey}`);
    }

    if (siblingProxyUrl) {
        return { headers, url: endpointUrl };
    }

    if (apiKey === SERVER_MANAGED_API_KEY) {
        throw new Error('OpenAI image models require the server-managed API proxy. Configure `apiProxyUrl` to point at the workspace API.');
    }
    return { headers, url: endpointUrl };
};

const resolveOpenAiImageSize = (
    aspectRatio: string | undefined,
    imageSize: string | undefined,
): string => {
    if (imageSize?.toLowerCase() === 'auto') {
        return 'auto';
    }

    const normalizedImageSize = imageSize && OPENAI_IMAGE_SIZE_PRESETS[imageSize] ? imageSize : '1K';
    const normalizedAspectRatio = aspectRatio && OPENAI_IMAGE_SIZE_PRESETS[normalizedImageSize][aspectRatio]
        ? aspectRatio
        : '1:1';

    return OPENAI_IMAGE_SIZE_PRESETS[normalizedImageSize][normalizedAspectRatio] || OPENAI_DEFAULT_IMAGE_SIZE;
};

const normalizeOpenAiImageAspectRatio = (aspectRatio: string | undefined): string => {
    if (aspectRatio === '3:2' || aspectRatio === '2:3' || aspectRatio === '1:1') {
        return aspectRatio;
    }

    // Keep legacy saved ratios close to the official GPT Image API sizes.
    if (aspectRatio === '16:9' || aspectRatio === '4:3') {
        return '3:2';
    }

    if (aspectRatio === '9:16' || aspectRatio === '3:4') {
        return '2:3';
    }

    return '1:1';
};

const extractOpenAiImages = (payload: unknown): string[] => {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    const responseData = Array.isArray((payload as { data?: unknown[] }).data)
        ? (payload as { data: Array<Record<string, unknown>> }).data
        : [];

    return responseData
        .map((item) => item.b64_json ?? item.image_base64 ?? item.base64)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
};

const getOpenAiErrorMessage = async (response: Response): Promise<string> => {
    try {
        const payload = await response.json();
        const providerErrorMessage = readProviderErrorMessage(payload);
        if (providerErrorMessage) {
            return providerErrorMessage;
        }
    } catch {
        // Fall back to plain text response handling below.
    }

    try {
        const fallbackText = await response.text();
        if (fallbackText.trim()) {
            return fallbackText.trim();
        }
    } catch {
        // Ignore response body parse failures and fall through to the status text.
    }

    return response.statusText || `Request failed with status ${response.status}`;
};

const generateOpenAiImages = async (
    apiKey: string,
    modelId: string,
    prompt: string,
    aspectRatio: string,
    imageSize: string | undefined,
    abortSignal: AbortSignal,
    options: GenerateImagesRequestOptions = {},
): Promise<string[]> => {
    const { headers, url } = await resolveOpenAiImagesEndpoint(apiKey);
    const normalizedAspectRatio = normalizeOpenAiImageAspectRatio(aspectRatio);
    const normalizedImageSize = normalizeImageSizeForModel(modelId, imageSize) || '1K';
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: stripModelProviderPrefix(modelId),
            prompt,
            n: options.numberOfImages ?? 1,
            output_format: 'png',
            size: resolveOpenAiImageSize(normalizedAspectRatio, normalizedImageSize),
        }),
        signal: abortSignal,
    });

    if (!response.ok) {
        throw new Error(await getOpenAiErrorMessage(response));
    }

    const payload = await response.json();
    const images = extractOpenAiImages(payload);
    if (images.length === 0) {
        throw new Error("No images generated. The prompt may have been blocked or the model failed to respond.");
    }

    logService.recordTokenUsage(
        modelId,
        {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        },
        buildExactImageGenerationPricing(images.length),
    );

    return images;
};

export const generateImagesApi = async (
    apiKey: string,
    modelId: string,
    prompt: string,
    aspectRatio: string,
    imageSize: string | undefined,
    abortSignal: AbortSignal,
    options: GenerateImagesRequestOptions = {},
): Promise<string[]> => {
    logService.info(`Generating image with model ${modelId}`, { prompt, aspectRatio, imageSize });
    
    if (!prompt.trim()) {
        throw new Error("Image generation prompt cannot be empty.");
    }

    if (abortSignal.aborted) {
        const abortError = new Error("Image generation cancelled by user before starting.");
        abortError.name = "AbortError";
        throw abortError;
    }

    try {
        if (isOpenAiImageModel(modelId)) {
            return await generateOpenAiImages(
                apiKey,
                modelId,
                prompt,
                aspectRatio,
                imageSize,
                abortSignal,
                options,
            );
        }

        const ai = await getConfiguredApiClient(apiKey);
        const normalizedAspectRatio = normalizeAspectRatioForModel(modelId, aspectRatio) || '1:1';
        const normalizedImageSize = normalizeImageSizeForModel(modelId, imageSize);
        const config: GenerateImagesConfig = { 
            abortSignal,
            numberOfImages: options.numberOfImages ?? 1, 
            outputMimeType: 'image/png', 
            aspectRatio: normalizedAspectRatio,
        };

        if (normalizedImageSize) {
            config.imageSize = normalizedImageSize;
        }

        if (options.personGeneration) {
            config.personGeneration = options.personGeneration as GenerateImagesConfig['personGeneration'];
        }

        const response = await ai.models.generateImages({
            model: modelId,
            prompt: prompt,
            config: config,
        });

        if (abortSignal.aborted) {
            const abortError = new Error("Image generation cancelled by user.");
            abortError.name = "AbortError";
            throw abortError;
        }

        const images = response.generatedImages
            ?.map(img => img.image?.imageBytes)
            .filter((imageBytes): imageBytes is string => typeof imageBytes === 'string' && imageBytes.length > 0) ?? [];
        if (images.length === 0) {
            throw new Error("No images generated. The prompt may have been blocked or the model failed to respond.");
        }

        logService.recordTokenUsage(
            modelId,
            {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
            },
            buildExactImageGenerationPricing(images.length),
        );
        
        return images;

    } catch (error) {
        logService.error(`Failed to generate images with model ${modelId}:`, error);
        throw error;
    }
};
