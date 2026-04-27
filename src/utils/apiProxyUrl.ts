const GEMINI_API_VERSION_SUFFIX = /\/v\d+(?:(?:alpha|beta)\d*|\.\d+)?$/i;
const OPENAI_API_VERSION_SUFFIX = /\/v1$/i;
const ANTHROPIC_API_VERSION_SUFFIX = /\/v1$/i;

export const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_GEMINI_API_VERSION = 'v1beta';
export const DEFAULT_GEMINI_PROXY_URL = 'https://api-proxy.de/gemini';

const ABSOLUTE_URL_PROTOCOL = /^[a-z][a-z\d+\-.]*:\/\//i;

const getCurrentOrigin = (): string => {
  const browserOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined;
  if (browserOrigin && browserOrigin !== 'null') {
    return browserOrigin;
  }

  const globalOrigin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (globalOrigin && globalOrigin !== 'null') {
    return globalOrigin;
  }

  return 'http://localhost';
};

export const resolveApiBaseUrlForSdk = (baseUrl: string): string => {
  const trimmedBaseUrl = baseUrl.trim();
  if (!trimmedBaseUrl || ABSOLUTE_URL_PROTOCOL.test(trimmedBaseUrl)) {
    return trimmedBaseUrl;
  }

  return new URL(trimmedBaseUrl, getCurrentOrigin()).toString();
};

export const normalizeGeminiApiBaseUrl = (baseUrl: string): string => {
  const resolvedBaseUrl = resolveApiBaseUrlForSdk(baseUrl).replace(/\/+$/, '');
  return resolvedBaseUrl.replace(GEMINI_API_VERSION_SUFFIX, '');
};

export const normalizeOpenAiApiBaseUrl = (baseUrl: string): string => {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return trimmedBaseUrl.replace(OPENAI_API_VERSION_SUFFIX, '');
};

export const normalizeAnthropicApiBaseUrl = (baseUrl: string): string => {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return trimmedBaseUrl.replace(ANTHROPIC_API_VERSION_SUFFIX, '');
};

export const buildGeminiRequestPreviewUrl = (
  baseUrl: string,
  modelId: string,
  method: 'generateContent' | 'streamGenerateContent',
  apiVersion: string = DEFAULT_GEMINI_API_VERSION,
): string => {
  const normalizedBaseUrl = normalizeGeminiApiBaseUrl(baseUrl);
  return `${normalizedBaseUrl}/${apiVersion}/models/${modelId}:${method}`;
};

export const buildOpenAiImagesRequestUrl = (baseUrl: string): string =>
  `${normalizeOpenAiApiBaseUrl(baseUrl)}/v1/images/generations`;

export const buildOpenAiChatCompletionsRequestUrl = (baseUrl: string): string =>
  `${normalizeOpenAiApiBaseUrl(baseUrl)}/v1/chat/completions`;

export const buildAnthropicMessagesRequestUrl = (baseUrl: string): string =>
  `${normalizeAnthropicApiBaseUrl(baseUrl)}/v1/messages`;

export const deriveSiblingProviderProxyUrl = (
  baseUrl: string,
  providerSegment: string,
): string => {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const normalizedProviderSegment = providerSegment.trim().replace(/^\/+|\/+$/g, '');

  if (!trimmedBaseUrl || !normalizedProviderSegment) {
    return trimmedBaseUrl;
  }

  const normalizedLowerBaseUrl = trimmedBaseUrl.toLowerCase();
  const normalizedLowerProvider = normalizedProviderSegment.toLowerCase();

  if (normalizedLowerBaseUrl.endsWith(`/${normalizedLowerProvider}`)) {
    return trimmedBaseUrl;
  }

  if (normalizedLowerBaseUrl.endsWith('/gemini')) {
    return `${trimmedBaseUrl.slice(0, -'/gemini'.length)}/${normalizedProviderSegment}`;
  }

  return `${trimmedBaseUrl}/${normalizedProviderSegment}`;
};
