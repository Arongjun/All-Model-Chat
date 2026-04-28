import http, { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { GoogleGenAI } from '@google/genai';
import type { ApiServerConfig } from './config.js';
import {
  CloudChatService,
  type CloudChatGroupPayload,
  type CloudChatSessionPayload,
  type SystemScenarioPayload,
} from './cloudChat.js';
import {
  WorkspaceError,
  WorkspaceService,
  type WorkspaceApiProvider,
  type WorkspaceApiProviderSettings,
  type UsageOperationType,
  type WorkspaceUsageQuery,
} from './workspace.js';

const GEMINI_PROXY_PREFIX = '/api/gemini';
const OPENAI_PROXY_PREFIX = '/api/openai';
const ANTHROPIC_PROXY_PREFIX = '/api/anthropic';
const OPENAI_IMAGE_PROXY_PATHS = new Set([
  `${OPENAI_PROXY_PREFIX}/images/generations`,
  `${OPENAI_PROXY_PREFIX}/v1/images/generations`,
]);
const OPENAI_CHAT_PROXY_PATHS = new Set([
  `${OPENAI_PROXY_PREFIX}/chat/completions`,
  `${OPENAI_PROXY_PREFIX}/v1/chat/completions`,
]);
const ANTHROPIC_MESSAGES_PROXY_PATHS = new Set([
  `${ANTHROPIC_PROXY_PREFIX}/messages`,
  `${ANTHROPIC_PROXY_PREFIX}/v1/messages`,
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const STRIPPED_PROXY_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'accept-encoding',
  'authorization',
  'content-length',
  'cookie',
  'host',
]);
const STRIPPED_PROXY_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-length',
]);

interface LiveTokenPayload {
  name?: string;
  token?: string;
}

interface CreateServerDependencies {
  fetchImpl?: typeof fetch;
  createLiveToken?: (apiKey: string) => Promise<LiveTokenPayload>;
  workspaceService?: WorkspaceService;
  cloudChatService?: CloudChatService;
}

type CreateServerConfig = Pick<
  ApiServerConfig,
  | 'geminiApiBase'
  | 'geminiApiKey'
  | 'openaiApiBase'
  | 'openaiApiKey'
  | 'workspaceSessionTtlHours'
> &
  Partial<
    Pick<
      ApiServerConfig,
      | 'allowedOrigins'
      | 'workspaceDatabaseFilePath'
      | 'workspaceLegacyJsonFilePath'
      | 'anthropicApiBase'
      | 'anthropicApiKey'
      | 'objectStorageEnabled'
      | 'objectStorageEndpoint'
      | 'objectStorageRegion'
      | 'objectStorageBucket'
      | 'objectStorageAccessKeyId'
      | 'objectStorageSecretAccessKey'
      | 'objectStorageForcePathStyle'
      | 'objectStoragePublicBaseUrl'
      | 'objectStoragePrefix'
    >
  > & {
    workspaceDataFilePath?: string;
  };

interface ResolvedServerConfig extends Omit<CreateServerConfig, 'anthropicApiBase'> {
  allowedOrigins: string[];
  anthropicApiBase: string;
}

type RechargePaymentMethod = 'manual' | 'wechat' | 'alipay' | 'bank_transfer' | 'stripe' | 'other';
type ProviderConfigSource = 'workspace' | 'environment' | 'none';

interface ResolvedProviderRuntimeConfig {
  apiBase: string;
  apiBaseSource: Exclude<ProviderConfigSource, 'none'>;
  apiKey?: string;
  apiKeyPreview: string | null;
  apiKeySource: ProviderConfigSource;
  configured: boolean;
}

interface AdminProviderRuntimeConfigSummary {
  provider: WorkspaceApiProvider;
  label: string;
  apiBase: string;
  apiBaseSource: Exclude<ProviderConfigSource, 'none'>;
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
  apiKeySource: ProviderConfigSource;
  workspaceOverrideConfigured: boolean;
  updatedAt: string | null;
}

type ProviderModelDiscoveryStatus = 'available' | 'not_configured' | 'error';

interface DiscoveredModelSummary {
  id: string;
  rawId: string;
  name: string;
  provider: WorkspaceApiProvider;
  source: 'api';
}

interface ProviderModelDiscoverySummary {
  provider: WorkspaceApiProvider;
  label: string;
  apiBase: string;
  apiKeySource: ProviderConfigSource;
  configured: boolean;
  status: ProviderModelDiscoveryStatus;
  models: DiscoveredModelSummary[];
  error?: string;
}

const SUPPORTED_OPENAI_IMAGE_MODEL_IDS = new Set(['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2']);
const EXCLUDED_OPENAI_MODEL_ID_PARTS = [
  'audio',
  'embedding',
  'moderation',
  'realtime',
  'rerank',
  'search',
  'transcribe',
  'tts',
  'whisper',
];

export async function createLiveTokenWithGemini(apiKey: string): Promise<LiveTokenPayload> {
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  return client.authTokens.create({ config: { uses: 1 } });
}

function getCorsHeaders(request: IncomingMessage, allowedOrigins: string[]): Record<string, string> {
  if (!allowedOrigins.length) {
    return {};
  }

  const origin = request.headers.origin;
  if (!origin) {
    return {};
  }

  const allowAll = allowedOrigins.includes('*');
  const isAllowed = allowAll || allowedOrigins.includes(origin);
  if (!isAllowed) {
    return {};
  }

  return {
    'access-control-allow-origin': allowAll ? '*' : origin,
    ...(allowAll ? {} : { 'access-control-allow-credentials': 'true' }),
    vary: 'Origin',
  };
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  allowedOrigins: string[],
  extraHeaders: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }

  const corsHeaders = getCorsHeaders(request, allowedOrigins);
  response.writeHead(statusCode, {
    ...corsHeaders,
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function sendText(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: string,
  allowedOrigins: string[],
  contentType = 'text/plain; charset=utf-8',
  extraHeaders: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }

  const corsHeaders = getCorsHeaders(request, allowedOrigins);
  response.writeHead(statusCode, {
    ...corsHeaders,
    ...extraHeaders,
    'content-type': contentType,
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawText = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawText) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkspaceError(400, 'Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError(400, 'Request body is not valid JSON.');
  }
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new WorkspaceError(413, `Request body is too large. Maximum allowed size is ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function getConnectionManagedHeaders(value: string | null | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(',')
      .map((headerName) => headerName.trim().toLowerCase())
      .filter((headerName) => headerName.length > 0),
  );
}

function normalizeOpenAiApiBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function normalizeAnthropicApiBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function maskApiKey(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function getProviderLabel(provider: WorkspaceApiProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI-compatible';
    case 'anthropic':
      return 'Anthropic-compatible';
    default:
      return 'Gemini';
  }
}

function getEnvironmentProviderConfig(
  config: ResolvedServerConfig,
  provider: WorkspaceApiProvider,
): { apiBase: string; apiKey?: string } {
  switch (provider) {
    case 'openai':
      return { apiBase: config.openaiApiBase, apiKey: config.openaiApiKey };
    case 'anthropic':
      return { apiBase: config.anthropicApiBase, apiKey: config.anthropicApiKey };
    default:
      return { apiBase: config.geminiApiBase, apiKey: config.geminiApiKey };
  }
}

function resolveProviderRuntimeConfig(
  config: ResolvedServerConfig,
  workspaceSettings: WorkspaceApiProviderSettings,
  provider: WorkspaceApiProvider,
): ResolvedProviderRuntimeConfig {
  const envConfig = getEnvironmentProviderConfig(config, provider);
  const workspaceSetting = workspaceSettings[provider];
  const workspaceApiKey = workspaceSetting?.apiKey?.trim();
  const workspaceApiBase = workspaceSetting?.apiBase?.trim();
  const envApiKey = envConfig.apiKey?.trim();

  const apiKey = workspaceApiKey || envApiKey || undefined;
  const apiBase = workspaceApiBase || envConfig.apiBase;

  return {
    apiBase,
    apiBaseSource: workspaceApiBase ? 'workspace' : 'environment',
    apiKey,
    apiKeyPreview: maskApiKey(apiKey),
    apiKeySource: workspaceApiKey ? 'workspace' : envApiKey ? 'environment' : 'none',
    configured: Boolean(apiKey),
  };
}

function buildAdminProviderRuntimeConfigSummaries(
  config: ResolvedServerConfig,
  workspaceSettings: WorkspaceApiProviderSettings,
): AdminProviderRuntimeConfigSummary[] {
  return (['gemini', 'openai', 'anthropic'] as WorkspaceApiProvider[]).map((provider) => {
    const resolved = resolveProviderRuntimeConfig(config, workspaceSettings, provider);
    const workspaceSetting = workspaceSettings[provider];
    return {
      provider,
      label: getProviderLabel(provider),
      apiBase: resolved.apiBase,
      apiBaseSource: resolved.apiBaseSource,
      apiKeyConfigured: resolved.configured,
      apiKeyPreview: resolved.apiKeyPreview,
      apiKeySource: resolved.apiKeySource,
      workspaceOverrideConfigured: Boolean(workspaceSetting?.apiKey?.trim() || workspaceSetting?.apiBase?.trim()),
      updatedAt: workspaceSetting?.updatedAt ?? null,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripKnownProviderPrefix(modelId: string): string {
  return modelId.trim().replace(/^(openai|anthropic):/i, '').trim();
}

function stripGeminiModelPrefix(modelId: string): string {
  return modelId.trim().replace(/^models\//i, '').trim();
}

function isSupportedOpenAiImageModel(modelId: string): boolean {
  return SUPPORTED_OPENAI_IMAGE_MODEL_IDS.has(stripKnownProviderPrefix(modelId).toLowerCase());
}

function shouldExposeOpenAiModel(modelId: string): boolean {
  const lowerId = stripKnownProviderPrefix(modelId).toLowerCase();

  if (isSupportedOpenAiImageModel(lowerId)) {
    return true;
  }

  if (lowerId.startsWith('gpt-image') || lowerId.startsWith('dall-e') || lowerId.includes('image')) {
    return false;
  }

  return !EXCLUDED_OPENAI_MODEL_ID_PARTS.some((part) => lowerId.includes(part));
}

function shouldExposeGeminiModel(model: Record<string, unknown>): boolean {
  const methods = Array.isArray(model.supportedGenerationMethods)
    ? model.supportedGenerationMethods.map(String)
    : [];

  if (methods.length === 0) {
    return true;
  }

  return methods.some((method) =>
    method === 'generateContent'
    || method === 'streamGenerateContent'
    || method === 'generateImages'
    || method === 'bidiGenerateContent',
  );
}

function createDiscoveredModel(
  provider: WorkspaceApiProvider,
  rawModelId: string,
  displayName?: string | null,
): DiscoveredModelSummary | null {
  const normalizedRawId = provider === 'gemini'
    ? stripGeminiModelPrefix(rawModelId)
    : stripKnownProviderPrefix(rawModelId);

  if (!normalizedRawId) {
    return null;
  }

  const id = provider === 'openai'
    ? isSupportedOpenAiImageModel(normalizedRawId)
      ? normalizedRawId
      : `openai:${normalizedRawId}`
    : provider === 'anthropic'
      ? `anthropic:${normalizedRawId}`
      : normalizedRawId;

  return {
    id,
    rawId: normalizedRawId,
    name: displayName?.trim() || normalizedRawId,
    provider,
    source: 'api',
  };
}

function parseGeminiModelPayload(payload: unknown): DiscoveredModelSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    return [];
  }

  return payload.models
    .filter(isRecord)
    .filter(shouldExposeGeminiModel)
    .map((model) => {
      const rawId = readString(model.name);
      if (!rawId) {
        return null;
      }
      return createDiscoveredModel('gemini', rawId, readString(model.displayName));
    })
    .filter((model): model is DiscoveredModelSummary => model !== null);
}

function parseOpenAiModelPayload(payload: unknown): DiscoveredModelSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .filter(isRecord)
    .map((model) => readString(model.id))
    .filter((modelId): modelId is string => !!modelId && shouldExposeOpenAiModel(modelId))
    .map((modelId) => createDiscoveredModel('openai', modelId, modelId))
    .filter((model): model is DiscoveredModelSummary => model !== null);
}

function parseAnthropicModelPayload(payload: unknown): DiscoveredModelSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .filter(isRecord)
    .map((model) => {
      const rawId = readString(model.id);
      if (!rawId) {
        return null;
      }
      return createDiscoveredModel('anthropic', rawId, readString(model.display_name) || readString(model.displayName));
    })
    .filter((model): model is DiscoveredModelSummary => model !== null);
}

async function getUpstreamErrorText(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (isRecord(payload)) {
      const error = payload.error;
      if (isRecord(error) && typeof error.message === 'string') {
        return error.message;
      }
      if (typeof payload.message === 'string') {
        return payload.message;
      }
    }
  } catch {
    // Fall back to text below.
  }

  try {
    const text = await response.text();
    return text.trim() || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function discoverProviderModels(
  config: ResolvedServerConfig,
  workspaceSettings: WorkspaceApiProviderSettings,
  provider: WorkspaceApiProvider,
  fetchImpl: typeof fetch,
): Promise<ProviderModelDiscoverySummary> {
  const providerConfig = resolveProviderRuntimeConfig(config, workspaceSettings, provider);
  const baseSummary = {
    provider,
    label: getProviderLabel(provider),
    apiBase: providerConfig.apiBase,
    apiKeySource: providerConfig.apiKeySource,
    configured: providerConfig.configured,
  };

  if (!providerConfig.apiKey) {
    return {
      ...baseSummary,
      status: 'not_configured',
      models: [],
    };
  }

  const listUrl = provider === 'gemini'
    ? `${providerConfig.apiBase.replace(/\/+$/, '')}/v1beta/models`
    : provider === 'anthropic'
      ? `${normalizeAnthropicApiBase(providerConfig.apiBase)}/v1/models`
      : `${normalizeOpenAiApiBase(providerConfig.apiBase)}/v1/models`;
  const headers = new Headers();
  if (provider === 'gemini') {
    headers.set('x-goog-api-key', providerConfig.apiKey);
  } else if (provider === 'anthropic') {
    headers.set('x-api-key', providerConfig.apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('authorization', `Bearer ${providerConfig.apiKey}`);
  }

  try {
    const upstreamResponse = await fetchImpl(listUrl, {
      method: 'GET',
      headers,
    });

    if (!upstreamResponse.ok) {
      return {
        ...baseSummary,
        status: 'error',
        models: [],
        error: await getUpstreamErrorText(upstreamResponse),
      };
    }

    const payload = await upstreamResponse.json();
    const models = provider === 'gemini'
      ? parseGeminiModelPayload(payload)
      : provider === 'anthropic'
        ? parseAnthropicModelPayload(payload)
        : parseOpenAiModelPayload(payload);

    return {
      ...baseSummary,
      status: 'available',
      models,
    };
  } catch (error) {
    return {
      ...baseSummary,
      status: 'error',
      models: [],
      error: error instanceof Error ? error.message : 'Unable to query provider models.',
    };
  }
}

async function discoverWorkspaceModels(
  config: ResolvedServerConfig,
  workspaceSettings: WorkspaceApiProviderSettings,
  fetchImpl: typeof fetch,
): Promise<{ generatedAt: string; providers: ProviderModelDiscoverySummary[]; models: DiscoveredModelSummary[] }> {
  const providers = await Promise.all(
    (['gemini', 'openai', 'anthropic'] as WorkspaceApiProvider[])
      .map((provider) => discoverProviderModels(config, workspaceSettings, provider, fetchImpl)),
  );
  const seenModelIds = new Set<string>();
  const models = providers.flatMap((provider) => provider.models).filter((model) => {
    const normalizedId = model.id.toLowerCase();
    if (seenModelIds.has(normalizedId)) {
      return false;
    }
    seenModelIds.add(normalizedId);
    return true;
  });

  return {
    generatedAt: new Date().toISOString(),
    providers,
    models,
  };
}

function buildProxyHeaders(
  request: IncomingMessage,
  authHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();
  const connectionManagedHeaders = getConnectionManagedHeaders(
    Array.isArray(request.headers.connection) ? request.headers.connection.join(',') : request.headers.connection,
  );

  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'undefined') {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (
      STRIPPED_PROXY_REQUEST_HEADERS.has(normalizedName) ||
      connectionManagedHeaders.has(normalizedName)
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(normalizedName, value.join(','));
      continue;
    }

    headers.set(normalizedName, value);
  }

  Object.entries(authHeaders).forEach(([name, value]) => {
    headers.set(name, value);
  });
  return headers;
}

function buildProxyResponseHeaders(
  request: IncomingMessage,
  upstreamResponse: Response,
  allowedOrigins: string[],
): Record<string, string> {
  const responseHeaders: Record<string, string> = {};
  const connectionManagedHeaders = getConnectionManagedHeaders(upstreamResponse.headers.get('connection'));

  upstreamResponse.headers.forEach((value, key) => {
    const normalizedName = key.toLowerCase();
    if (
      STRIPPED_PROXY_RESPONSE_HEADERS.has(normalizedName) ||
      connectionManagedHeaders.has(normalizedName)
    ) {
      return;
    }

    responseHeaders[normalizedName] = value;
  });

  Object.assign(responseHeaders, getCorsHeaders(request, allowedOrigins));
  return responseHeaders;
}

function getWorkspaceSessionToken(
  request: IncomingMessage,
  workspaceService: WorkspaceService,
): string | null {
  const cookieHeader = Array.isArray(request.headers.cookie)
    ? request.headers.cookie.join('; ')
    : request.headers.cookie;
  return workspaceService.getSessionTokenFromCookieHeader(cookieHeader);
}

async function ensureWorkspaceSessionIfRequired(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  workspaceService: WorkspaceService,
): Promise<boolean> {
  const sessionState = await workspaceService.getSession(getWorkspaceSessionToken(request, workspaceService));
  if (!sessionState.bootstrapped || sessionState.currentUser) {
    return true;
  }

  sendJson(
    request,
    response,
    401,
    { error: '请先登录后再聊天。打开左侧菜单底部「设置」→「账号与额度」登录；没有账号可用邀请码注册。' },
    config.allowedOrigins,
  );
  return false;
}

function getWorkspaceErrorStatus(error: unknown): number {
  return error instanceof WorkspaceError ? error.statusCode : 500;
}

function getWorkspaceErrorMessage(error: unknown): string {
  if (error instanceof WorkspaceError) {
    return error.message;
  }
  return error instanceof Error ? error.message : 'Workspace request failed.';
}

async function requireWorkspaceUser(
  request: IncomingMessage,
  workspaceService: WorkspaceService,
) {
  const session = await workspaceService.getSession(getWorkspaceSessionToken(request, workspaceService));
  if (!session.currentUser) {
    throw new WorkspaceError(
      401,
      '请先登录后再使用云端聊天记录。打开左侧菜单底部「设置」→「账号与额度」登录；没有账号可用邀请码注册。',
    );
  }
  return session.currentUser;
}

async function requireWorkspaceAdmin(
  request: IncomingMessage,
  workspaceService: WorkspaceService,
) {
  const adminState = await workspaceService.getAdminState(getWorkspaceSessionToken(request, workspaceService));
  return adminState.currentUser;
}

function decodeHeaderText(value: string | string[] | undefined, fallback: string): string {
  const rawValue = Array.isArray(value) ? value[0] : value;
  if (!rawValue) {
    return fallback;
  }

  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

function encodeContentDispositionFilename(fileName: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function getWorkspaceUsageQuery(searchParams: URLSearchParams): WorkspaceUsageQuery {
  const readOptional = (key: string): string | null => {
    const value = searchParams.get(key);
    return value && value.trim() ? value.trim() : null;
  };

  return {
    page: Number(searchParams.get('page') ?? 1),
    pageSize: Number(searchParams.get('pageSize') ?? 50),
    userId: readOptional('userId') ?? undefined,
    status: readOptional('status') as WorkspaceUsageQuery['status'],
    source: readOptional('source') as WorkspaceUsageQuery['source'],
    operationType: readOptional('operationType') as WorkspaceUsageQuery['operationType'],
    search: readOptional('search') ?? undefined,
  };
}

async function handleCloudChatRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  workspaceService: WorkspaceService,
  cloudChatService: CloudChatService,
): Promise<boolean> {
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  const path = requestUrl.pathname;
  const method = request.method || 'GET';
  const sendWorkspaceError = (error: unknown) => {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
  };

  try {
    if (method === 'GET' && path === '/api/workspace/cloud-chat/status') {
      const session = await workspaceService.getSession(getWorkspaceSessionToken(request, workspaceService));
      sendJson(
        request,
        response,
        200,
        await cloudChatService.getStatus(Boolean(session.currentUser)),
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/scenarios') {
      const session = await workspaceService.getSession(getWorkspaceSessionToken(request, workspaceService));
      sendJson(
        request,
        response,
        200,
        { scenarios: await cloudChatService.listVisibleSystemScenarios(session.currentUser) },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/object-storage') {
      await requireWorkspaceAdmin(request, workspaceService);
      sendJson(
        request,
        response,
        200,
        await cloudChatService.getObjectStorageSummary(),
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'PATCH' && path === '/api/workspace/admin/object-storage') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      const readOptionalText = (value: unknown): string | null | undefined =>
        typeof value === 'string' || value === null ? value : undefined;
      const summary = await cloudChatService.updateObjectStorageSettings({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        endpoint: readOptionalText(body.endpoint),
        region: readOptionalText(body.region),
        bucket: readOptionalText(body.bucket),
        accessKeyId: readOptionalText(body.accessKeyId),
        secretAccessKey: readOptionalText(body.secretAccessKey),
        clearSecretAccessKey: body.clearSecretAccessKey === true,
        forcePathStyle: typeof body.forcePathStyle === 'boolean' ? body.forcePathStyle : undefined,
        publicBaseUrl: readOptionalText(body.publicBaseUrl),
        prefix: readOptionalText(body.prefix),
      });
      sendJson(request, response, 200, summary, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/cloud-chat/sessions') {
      await requireWorkspaceAdmin(request, workspaceService);
      sendJson(
        request,
        response,
        200,
        await cloudChatService.listAdminSessions({
          userId: requestUrl.searchParams.get('userId'),
          search: requestUrl.searchParams.get('search'),
          page: Number(requestUrl.searchParams.get('page') ?? 1),
          pageSize: Number(requestUrl.searchParams.get('pageSize') ?? 20),
        }),
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    const adminSessionMatch = path.match(/^\/api\/workspace\/admin\/cloud-chat\/sessions\/([^/]+)\/([^/]+)$/);
    if (adminSessionMatch && method === 'GET') {
      await requireWorkspaceAdmin(request, workspaceService);
      const session = await cloudChatService.getAdminSession(
        decodeURIComponent(adminSessionMatch[1] || ''),
        decodeURIComponent(adminSessionMatch[2] || ''),
      );
      if (!session) {
        throw new WorkspaceError(404, 'Cloud chat session was not found.');
      }
      sendJson(request, response, 200, { session }, config.allowedOrigins, { 'cache-control': 'no-store' });
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/cloud-chat/sessions/delete') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      const result = await cloudChatService.deleteAdminSessions(
        Array.isArray(body.sessions)
          ? body.sessions
            .filter((item): item is { userId: string; id: string } =>
              !!item && typeof item === 'object'
              && typeof (item as { userId?: unknown }).userId === 'string'
              && typeof (item as { id?: unknown }).id === 'string',
            )
          : [],
      );
      sendJson(request, response, 200, result, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/cloud-chat/attachments') {
      await requireWorkspaceAdmin(request, workspaceService);
      sendJson(
        request,
        response,
        200,
        await cloudChatService.listAdminAttachments({
          userId: requestUrl.searchParams.get('userId'),
          sessionId: requestUrl.searchParams.get('sessionId'),
          search: requestUrl.searchParams.get('search'),
          page: Number(requestUrl.searchParams.get('page') ?? 1),
          pageSize: Number(requestUrl.searchParams.get('pageSize') ?? 20),
        }),
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/cloud-chat/attachments/delete') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      const result = await cloudChatService.deleteAdminAttachments(
        Array.isArray(body.attachmentIds)
          ? body.attachmentIds.filter((id): id is string => typeof id === 'string')
          : [],
      );
      sendJson(request, response, 200, result, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/cloud-chat/retention') {
      await requireWorkspaceAdmin(request, workspaceService);
      sendJson(request, response, 200, await cloudChatService.getRetentionSettings(), config.allowedOrigins);
      return true;
    }

    if (method === 'PATCH' && path === '/api/workspace/admin/cloud-chat/retention') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      sendJson(
        request,
        response,
        200,
        await cloudChatService.updateRetentionSettings({
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          maxAttachmentAgeDays: typeof body.maxAttachmentAgeDays === 'number'
            ? body.maxAttachmentAgeDays
            : undefined,
          maxTotalAttachmentBytes: typeof body.maxTotalAttachmentBytes === 'number'
            ? body.maxTotalAttachmentBytes
            : undefined,
        }),
        config.allowedOrigins,
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/cloud-chat/cleanup') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      sendJson(
        request,
        response,
        200,
        await cloudChatService.cleanupAttachments({
          dryRun: body.dryRun !== false,
          maxAttachmentAgeDays: typeof body.maxAttachmentAgeDays === 'number'
            ? body.maxAttachmentAgeDays
            : undefined,
          maxTotalAttachmentBytes: typeof body.maxTotalAttachmentBytes === 'number'
            ? body.maxTotalAttachmentBytes
            : undefined,
        }),
        config.allowedOrigins,
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/system-scenarios') {
      await requireWorkspaceAdmin(request, workspaceService);
      sendJson(
        request,
        response,
        200,
        { scenarios: await cloudChatService.listAdminSystemScenarios() },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/system-scenarios') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      const scenario = await cloudChatService.upsertSystemScenario(body as Partial<SystemScenarioPayload>);
      sendJson(request, response, 200, { scenario }, config.allowedOrigins);
      return true;
    }

    const adminScenarioMatch = path.match(/^\/api\/workspace\/admin\/system-scenarios\/([^/]+)$/);
    if (adminScenarioMatch && method === 'PUT') {
      await requireWorkspaceAdmin(request, workspaceService);
      const body = await readJsonBody(request);
      const scenario = await cloudChatService.upsertSystemScenario({
        ...(body as Partial<SystemScenarioPayload>),
        id: decodeURIComponent(adminScenarioMatch[1] || ''),
      });
      sendJson(request, response, 200, { scenario }, config.allowedOrigins);
      return true;
    }

    if (adminScenarioMatch && method === 'DELETE') {
      await requireWorkspaceAdmin(request, workspaceService);
      await cloudChatService.deleteSystemScenario(decodeURIComponent(adminScenarioMatch[1] || ''));
      sendJson(request, response, 200, { success: true }, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/cloud-chat/sessions') {
      const user = await requireWorkspaceUser(request, workspaceService);
      sendJson(
        request,
        response,
        200,
        { sessions: await cloudChatService.listSessions(user.id) },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/cloud-chat/groups') {
      const user = await requireWorkspaceUser(request, workspaceService);
      sendJson(
        request,
        response,
        200,
        { groups: await cloudChatService.listGroups(user.id) },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'PUT' && path === '/api/workspace/cloud-chat/groups') {
      const user = await requireWorkspaceUser(request, workspaceService);
      const body = await readJsonBody(request);
      const groups = await cloudChatService.replaceGroups(
        user.id,
        Array.isArray(body.groups) ? body.groups as CloudChatGroupPayload[] : [],
      );
      sendJson(request, response, 200, { groups }, config.allowedOrigins);
      return true;
    }

    const sessionMatch = path.match(/^\/api\/workspace\/cloud-chat\/sessions\/([^/]+)$/);
    if (sessionMatch && method === 'GET') {
      const user = await requireWorkspaceUser(request, workspaceService);
      const session = await cloudChatService.getSession(user.id, decodeURIComponent(sessionMatch[1] || ''));
      if (!session) {
        throw new WorkspaceError(404, 'Cloud chat session was not found.');
      }
      sendJson(
        request,
        response,
        200,
        { session },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (sessionMatch && method === 'PUT') {
      const user = await requireWorkspaceUser(request, workspaceService);
      const body = await readJsonBody(request);
      const session = await cloudChatService.saveSession(
        user.id,
        body.session as unknown as CloudChatSessionPayload,
      );
      sendJson(request, response, 200, { session }, config.allowedOrigins);
      return true;
    }

    if (sessionMatch && method === 'DELETE') {
      const user = await requireWorkspaceUser(request, workspaceService);
      await cloudChatService.deleteSession(user.id, decodeURIComponent(sessionMatch[1] || ''));
      sendJson(request, response, 200, { success: true }, config.allowedOrigins);
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/cloud-chat/attachments') {
      const user = await requireWorkspaceUser(request, workspaceService);
      const body = await readRawBody(request, 100 * 1024 * 1024);
      const attachment = await cloudChatService.uploadAttachment(user.id, {
        fileId: decodeHeaderText(request.headers['x-file-id'], ''),
        sessionId: decodeHeaderText(request.headers['x-session-id'], ''),
        messageId: decodeHeaderText(request.headers['x-message-id'], ''),
        name: decodeHeaderText(request.headers['x-file-name'], 'attachment'),
        type: decodeHeaderText(request.headers['content-type'], 'application/octet-stream'),
        size: body.length,
        body,
      });
      sendJson(request, response, 200, { attachment }, config.allowedOrigins);
      return true;
    }

    const attachmentMatch = path.match(/^\/api\/workspace\/cloud-chat\/attachments\/([^/]+)$/);
    if (attachmentMatch && method === 'GET') {
      const user = await requireWorkspaceUser(request, workspaceService);
      const attachment = await cloudChatService.downloadAttachment(
        user.id,
        decodeURIComponent(attachmentMatch[1] || ''),
      );
      response.writeHead(200, {
        ...getCorsHeaders(request, config.allowedOrigins),
        'cache-control': 'private, max-age=300',
        'content-type': attachment.contentType || attachment.type,
        'content-length': String(attachment.contentLength),
        'content-disposition': encodeContentDispositionFilename(attachment.name),
      });
      response.end(attachment.body);
      return true;
    }
  } catch (error) {
    sendWorkspaceError(error);
    return true;
  }

  return false;
}

function getRechargePaymentMethod(value: unknown): RechargePaymentMethod | undefined {
  return value === 'manual'
    || value === 'wechat'
    || value === 'alipay'
    || value === 'bank_transfer'
    || value === 'stripe'
    || value === 'other'
    ? value
    : undefined;
}

function getGeminiOperationType(modelId: string): UsageOperationType {
  const lowerModelId = modelId.toLowerCase();
  if (lowerModelId.includes('image') || lowerModelId.includes('imagen')) {
    return 'image_generation';
  }
  return 'model_request';
}

async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  workspaceService: WorkspaceService,
  cloudChatService: CloudChatService,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  const path = requestUrl.pathname;
  const method = request.method || 'GET';

  const cloudHandled = await handleCloudChatRequest(
    request,
    response,
    config,
    workspaceService,
    cloudChatService,
  );
  if (cloudHandled) {
    return true;
  }

  const sendWorkspaceError = (error: unknown) => {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
  };

  try {
    if (method === 'GET' && path === '/api/workspace/bootstrap') {
      const status = await workspaceService.getBootstrapStatus();
      sendJson(request, response, 200, status, config.allowedOrigins);
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/bootstrap') {
      const body = await readJsonBody(request);
      const result = await workspaceService.bootstrapAdmin({
        name: String(body.name ?? ''),
        email: String(body.email ?? ''),
        password: String(body.password ?? ''),
      });
      sendJson(
        request,
        response,
        200,
        {
          bootstrapped: result.bootstrapped,
          workspaceName: result.workspaceName,
          currentUser: result.currentUser,
        },
        config.allowedOrigins,
        { 'set-cookie': workspaceService.buildSessionCookie(result.sessionToken) },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/session/login') {
      const body = await readJsonBody(request);
      const result = await workspaceService.login({
        email: String(body.email ?? ''),
        password: String(body.password ?? ''),
      });
      sendJson(
        request,
        response,
        200,
        {
          bootstrapped: result.bootstrapped,
          workspaceName: result.workspaceName,
          currentUser: result.currentUser,
        },
        config.allowedOrigins,
        { 'set-cookie': workspaceService.buildSessionCookie(result.sessionToken) },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/session/register') {
      const body = await readJsonBody(request);
      const result = await workspaceService.registerWithInvite({
        name: String(body.name ?? ''),
        email: String(body.email ?? ''),
        password: String(body.password ?? ''),
        inviteCode: String(body.inviteCode ?? ''),
      });
      sendJson(
        request,
        response,
        200,
        {
          bootstrapped: result.bootstrapped,
          workspaceName: result.workspaceName,
          currentUser: result.currentUser,
        },
        config.allowedOrigins,
        { 'set-cookie': workspaceService.buildSessionCookie(result.sessionToken) },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/session/logout') {
      await workspaceService.logout(getWorkspaceSessionToken(request, workspaceService));
      sendJson(
        request,
        response,
        200,
        { success: true },
        config.allowedOrigins,
        { 'set-cookie': workspaceService.buildExpiredSessionCookie() },
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/session') {
      const sessionState = await workspaceService.getSession(getWorkspaceSessionToken(request, workspaceService));
      sendJson(request, response, 200, sessionState, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/dashboard') {
      const dashboard = await workspaceService.getDashboard(getWorkspaceSessionToken(request, workspaceService));
      sendJson(request, response, 200, dashboard, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/models') {
      const hasWorkspaceAccess = await ensureWorkspaceSessionIfRequired(
        request,
        response,
        config,
        workspaceService,
      );
      if (!hasWorkspaceAccess) {
        return true;
      }

      const workspaceApiSettings = await workspaceService.getRuntimeApiSettings();
      const discovery = await discoverWorkspaceModels(config, workspaceApiSettings, fetchImpl);
      sendJson(
        request,
        response,
        200,
        discovery,
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/redeem') {
      const body = await readJsonBody(request);
      const dashboard = await workspaceService.redeemCode(getWorkspaceSessionToken(request, workspaceService), {
        code: String(body.code ?? ''),
      });
      sendJson(request, response, 200, dashboard, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/state') {
      const adminState = await workspaceService.getAdminState(getWorkspaceSessionToken(request, workspaceService));
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/diagnostics') {
      const diagnostics = await workspaceService.getAdminDiagnostics(
        getWorkspaceSessionToken(request, workspaceService),
      );
      const workspaceApiSettings = await workspaceService.getRuntimeApiSettings();
      const providerSettings = buildAdminProviderRuntimeConfigSummaries(config, workspaceApiSettings);
      const geminiProvider = providerSettings.find((setting) => setting.provider === 'gemini');
      const openaiProvider = providerSettings.find((setting) => setting.provider === 'openai');
      const anthropicProvider = providerSettings.find((setting) => setting.provider === 'anthropic');
      sendJson(
        request,
        response,
        200,
        {
          ...diagnostics,
          server: {
            generatedAt: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            nodeVersion: process.version,
            geminiApiConfigured: geminiProvider?.apiKeyConfigured ?? false,
            openaiApiConfigured: openaiProvider?.apiKeyConfigured ?? false,
            anthropicApiConfigured: anthropicProvider?.apiKeyConfigured ?? false,
            geminiApiBase: geminiProvider?.apiBase ?? config.geminiApiBase,
            openaiApiBase: openaiProvider?.apiBase ?? config.openaiApiBase,
            anthropicApiBase: anthropicProvider?.apiBase ?? config.anthropicApiBase,
            apiSettings: providerSettings,
            allowedOrigins: config.allowedOrigins,
          },
        },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'PUT' && path === '/api/workspace/admin/api-settings') {
      const body = await readJsonBody(request);
      const rawProviders = body.providers && typeof body.providers === 'object'
        ? body.providers as Record<string, unknown>
        : {};
      await workspaceService.updateAdminApiSettings(
        getWorkspaceSessionToken(request, workspaceService),
        Object.fromEntries(
          (['gemini', 'openai', 'anthropic'] as WorkspaceApiProvider[])
            .map((provider): [WorkspaceApiProvider, { apiKey?: string | null; apiBase?: string | null }] | null => {
            const rawSetting = rawProviders[provider];
            const setting = rawSetting && typeof rawSetting === 'object'
              ? rawSetting as Record<string, unknown>
              : {};
            const update: { apiKey?: string | null; apiBase?: string | null } = {};

            if (setting.clearApiKey === true) {
              update.apiKey = null;
            } else if (typeof setting.apiKey === 'string' && setting.apiKey.trim()) {
              update.apiKey = setting.apiKey;
            }

            if ('apiBase' in setting) {
              update.apiBase = typeof setting.apiBase === 'string' ? setting.apiBase : null;
            }

            return Object.keys(update).length > 0 ? [provider, update] : null;
          })
            .filter((entry): entry is [WorkspaceApiProvider, { apiKey?: string | null; apiBase?: string | null }] =>
              entry !== null,
            ),
        ),
      );
      const workspaceApiSettings = await workspaceService.getRuntimeApiSettings();
      sendJson(
        request,
        response,
        200,
        { providers: buildAdminProviderRuntimeConfigSummaries(config, workspaceApiSettings) },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/api-settings/import-environment') {
      await workspaceService.updateAdminApiSettings(
        getWorkspaceSessionToken(request, workspaceService),
        {
          gemini: {
            apiKey: config.geminiApiKey ?? null,
            apiBase: config.geminiApiBase,
          },
          openai: {
            apiKey: config.openaiApiKey ?? null,
            apiBase: config.openaiApiBase,
          },
          anthropic: {
            apiKey: config.anthropicApiKey ?? null,
            apiBase: config.anthropicApiBase,
          },
        },
      );
      const workspaceApiSettings = await workspaceService.getRuntimeApiSettings();
      sendJson(
        request,
        response,
        200,
        { providers: buildAdminProviderRuntimeConfigSummaries(config, workspaceApiSettings) },
        config.allowedOrigins,
        { 'cache-control': 'no-store' },
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/backup.json') {
      const backupJson = await workspaceService.exportAdminBackupJson(
        getWorkspaceSessionToken(request, workspaceService),
      );
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      sendText(
        request,
        response,
        200,
        backupJson,
        config.allowedOrigins,
        'application/json; charset=utf-8',
        {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="arong-workspace-backup-${timestamp}.json"`,
        },
      );
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/usage') {
      const usagePage = await workspaceService.getAdminUsagePage(
        getWorkspaceSessionToken(request, workspaceService),
        getWorkspaceUsageQuery(requestUrl.searchParams),
      );
      sendJson(request, response, 200, usagePage, config.allowedOrigins);
      return true;
    }

    if (method === 'GET' && path === '/api/workspace/admin/usage.csv') {
      const csv = await workspaceService.exportAdminUsageCsv(
        getWorkspaceSessionToken(request, workspaceService),
        getWorkspaceUsageQuery(requestUrl.searchParams),
      );
      sendText(
        request,
        response,
        200,
        csv,
        config.allowedOrigins,
        'text/csv; charset=utf-8',
        { 'content-disposition': 'attachment; filename="arong-workspace-usage.csv"' },
      );
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/users') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.createUser(getWorkspaceSessionToken(request, workspaceService), {
        name: String(body.name ?? ''),
        email: String(body.email ?? ''),
        password: String(body.password ?? ''),
        role: body.role === 'admin' ? 'admin' : 'member',
        credits: typeof body.credits === 'number' ? body.credits : Number(body.credits ?? 0),
        modelAllowances: (body.modelAllowances ?? {}) as Record<string, number>,
      });
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    const updateUserMatch = path.match(/^\/api\/workspace\/admin\/users\/([^/]+)$/);
    if (updateUserMatch && method === 'PATCH') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.updateUser(
        getWorkspaceSessionToken(request, workspaceService),
        decodeURIComponent(updateUserMatch[1] || ''),
        {
          name: typeof body.name === 'string' ? body.name : undefined,
          role: body.role === 'admin' || body.role === 'member' ? body.role : undefined,
          credits: typeof body.credits === 'number' ? body.credits : Number(body.credits ?? NaN),
          modelAllowances: (body.modelAllowances ?? undefined) as Record<string, number> | undefined,
          disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
          password: typeof body.password === 'string' ? body.password : undefined,
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    const adjustUserMatch = path.match(/^\/api\/workspace\/admin\/users\/([^/]+)\/adjust-balance$/);
    if (adjustUserMatch && method === 'POST') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.adjustUserBalance(
        getWorkspaceSessionToken(request, workspaceService),
        decodeURIComponent(adjustUserMatch[1] || ''),
        {
          creditsDelta: typeof body.creditsDelta === 'number' ? body.creditsDelta : Number(body.creditsDelta ?? 0),
          modelAllowanceDeltas: (body.modelAllowanceDeltas ?? {}) as Record<string, number>,
          reason: typeof body.reason === 'string' ? body.reason : null,
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/recharge-orders') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.createRechargeOrder(
        getWorkspaceSessionToken(request, workspaceService),
        {
          userId: String(body.userId ?? ''),
          amountCents: typeof body.amountCents === 'number'
            ? body.amountCents
            : Number(body.amountCents ?? 0),
          currency: typeof body.currency === 'string' ? body.currency : 'CNY',
          credits: typeof body.credits === 'number' ? body.credits : Number(body.credits ?? 0),
          modelAllowances: (body.modelAllowances ?? {}) as Record<string, number>,
          paymentMethod: getRechargePaymentMethod(body.paymentMethod),
          externalReference: typeof body.externalReference === 'string' ? body.externalReference : null,
          note: typeof body.note === 'string' ? body.note : null,
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    const markRechargeOrderPaidMatch = path.match(/^\/api\/workspace\/admin\/recharge-orders\/([^/]+)\/mark-paid$/);
    if (markRechargeOrderPaidMatch && method === 'POST') {
      const adminState = await workspaceService.markRechargeOrderPaid(
        getWorkspaceSessionToken(request, workspaceService),
        decodeURIComponent(markRechargeOrderPaidMatch[1] || ''),
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    const cancelRechargeOrderMatch = path.match(/^\/api\/workspace\/admin\/recharge-orders\/([^/]+)\/cancel$/);
    if (cancelRechargeOrderMatch && method === 'POST') {
      const adminState = await workspaceService.cancelRechargeOrder(
        getWorkspaceSessionToken(request, workspaceService),
        decodeURIComponent(cancelRechargeOrderMatch[1] || ''),
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    if (method === 'PUT' && path === '/api/workspace/admin/model-policies') {
      const body = await readJsonBody(request);
      const policies = Array.isArray(body.policies) ? body.policies : [];
      const adminState = await workspaceService.replaceModelPolicies(
        getWorkspaceSessionToken(request, workspaceService),
        {
          policies: policies.map((policy) => ({
            label: String((policy as Record<string, unknown>).label ?? ''),
            modelPattern: String((policy as Record<string, unknown>).modelPattern ?? ''),
            costCredits: Number((policy as Record<string, unknown>).costCredits ?? 0),
            description: typeof (policy as Record<string, unknown>).description === 'string'
              ? String((policy as Record<string, unknown>).description)
              : null,
          })),
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/redeem-codes') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.createRedeemCode(
        getWorkspaceSessionToken(request, workspaceService),
        {
          code: String(body.code ?? ''),
          description: typeof body.description === 'string' ? body.description : null,
          credits: typeof body.credits === 'number' ? body.credits : Number(body.credits ?? 0),
          maxRedemptions: typeof body.maxRedemptions === 'number'
            ? body.maxRedemptions
            : Number(body.maxRedemptions ?? 1),
          expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
          modelAllowances: (body.modelAllowances ?? {}) as Record<string, number>,
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    if (method === 'POST' && path === '/api/workspace/admin/invite-codes') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.createInviteCode(
        getWorkspaceSessionToken(request, workspaceService),
        {
          code: typeof body.code === 'string' ? body.code : null,
          description: typeof body.description === 'string' ? body.description : null,
          role: body.role === 'admin' ? 'admin' : 'member',
          credits: typeof body.credits === 'number' ? body.credits : Number(body.credits ?? 0),
          maxRedemptions: typeof body.maxRedemptions === 'number'
            ? body.maxRedemptions
            : Number(body.maxRedemptions ?? 1),
          expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
          modelAllowances: (body.modelAllowances ?? {}) as Record<string, number>,
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }

    const updateInviteCodeMatch = path.match(/^\/api\/workspace\/admin\/invite-codes\/([^/]+)$/);
    if (updateInviteCodeMatch && method === 'PATCH') {
      const body = await readJsonBody(request);
      const adminState = await workspaceService.updateInviteCode(
        getWorkspaceSessionToken(request, workspaceService),
        decodeURIComponent(updateInviteCodeMatch[1] || ''),
        {
          active: typeof body.active === 'boolean' ? body.active : undefined,
        },
      );
      sendJson(request, response, 200, adminState, config.allowedOrigins);
      return true;
    }
  } catch (error) {
    sendWorkspaceError(error);
    return true;
  }

  return false;
}

async function proxyGeminiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  fetchImpl: typeof fetch,
  workspaceService: WorkspaceService,
): Promise<void> {
  const providerConfig = resolveProviderRuntimeConfig(
    config,
    await workspaceService.getRuntimeApiSettings(),
    'gemini',
  );
  if (!providerConfig.apiKey) {
    sendJson(request, response, 500, { error: 'Gemini API key is not configured.' }, config.allowedOrigins);
    return;
  }

  const requestUrl = new URL(request.url || '/', 'http://localhost');
  const modelId = workspaceService.extractModelIdFromGeminiPath(requestUrl.pathname) || 'gemini-api-request';
  let usageReservationId: string | null;

  try {
    const reservation = await workspaceService.reserveUsageForProxy(
      getWorkspaceSessionToken(request, workspaceService),
      modelId,
      requestUrl.pathname,
      getGeminiOperationType(modelId),
    );
    usageReservationId = reservation.usageRecordId;
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const upstreamPath = requestUrl.pathname.slice(GEMINI_PROXY_PREFIX.length) || '/';
  const targetBase = providerConfig.apiBase.replace(/\/$/, '');
  const upstreamUrl = `${targetBase}${upstreamPath}${requestUrl.search}`;
  const method = request.method || 'GET';
  const hasBody = !['GET', 'HEAD'].includes(method);
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  const requestInit: RequestInit & { duplex?: 'half' } = {
    method,
    headers: buildProxyHeaders(request, { 'x-goog-api-key': providerConfig.apiKey }),
    signal: abortController.signal,
  };

  if (hasBody) {
    requestInit.body = request as unknown as BodyInit;
    requestInit.duplex = 'half';
  }

  request.once('aborted', abortUpstream);
  response.once('close', abortUpstream);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(upstreamUrl, requestInit);
  } catch (error) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    await workspaceService.finalizeUsageReservation(usageReservationId, {
      success: false,
      note: error instanceof Error ? error.message : 'Gemini upstream request failed.',
    });
    if (abortController.signal.aborted) {
      if (!response.destroyed) {
        response.destroy();
      }
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(request, response, 502, { error: `Gemini upstream request failed: ${message}` }, config.allowedOrigins);
    return;
  }

  if (!upstreamResponse.ok) {
    await workspaceService.finalizeUsageReservation(usageReservationId, {
      success: false,
      note: `Gemini upstream returned ${upstreamResponse.status}`,
    });
  } else {
    await workspaceService.finalizeUsageReservation(usageReservationId, {
      success: true,
      note: `Gemini upstream returned ${upstreamResponse.status}`,
    });
  }

  response.writeHead(
    upstreamResponse.status,
    buildProxyResponseHeaders(request, upstreamResponse, config.allowedOrigins),
  );

  if (!upstreamResponse.body) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    response.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream), response);
  } catch (error) {
    if (!abortController.signal.aborted && !response.destroyed) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
  }
}

async function proxyOpenAiImagesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  fetchImpl: typeof fetch,
  workspaceService: WorkspaceService,
): Promise<void> {
  const providerConfig = resolveProviderRuntimeConfig(
    config,
    await workspaceService.getRuntimeApiSettings(),
    'openai',
  );
  if (!providerConfig.apiKey) {
    sendJson(request, response, 500, { error: 'OpenAI-compatible API key is not configured.' }, config.allowedOrigins);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const modelId = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : 'openai-image-request';
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  let usageReservationId: string | null;

  try {
    const reservation = await workspaceService.reserveUsageForProxy(
      getWorkspaceSessionToken(request, workspaceService),
      modelId,
      requestUrl.pathname,
      'image_generation',
    );
    usageReservationId = reservation.usageRecordId;
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  request.once('aborted', abortUpstream);
  response.once('close', abortUpstream);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(
      `${normalizeOpenAiApiBase(providerConfig.apiBase)}/v1/images/generations`,
      {
        method: request.method || 'POST',
        headers: buildProxyHeaders(request, {
          authorization: `Bearer ${providerConfig.apiKey}`,
        }),
        body: JSON.stringify(body),
        signal: abortController.signal,
      },
    );
  } catch (error) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    await workspaceService.finalizeUsageReservation(usageReservationId, {
      success: false,
      note: error instanceof Error ? error.message : 'OpenAI upstream request failed.',
    });
    if (abortController.signal.aborted) {
      if (!response.destroyed) {
        response.destroy();
      }
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(
      request,
      response,
      502,
      { error: `OpenAI upstream request failed: ${message}` },
      config.allowedOrigins,
    );
    return;
  }

  await workspaceService.finalizeUsageReservation(usageReservationId, {
    success: upstreamResponse.ok,
    note: `OpenAI upstream returned ${upstreamResponse.status}`,
  });

  response.writeHead(
    upstreamResponse.status,
    buildProxyResponseHeaders(request, upstreamResponse, config.allowedOrigins),
  );

  if (!upstreamResponse.body) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    response.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream), response);
  } catch (error) {
    if (!abortController.signal.aborted && !response.destroyed) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
  }
}

async function proxyOpenAiChatCompletionsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  fetchImpl: typeof fetch,
  workspaceService: WorkspaceService,
): Promise<void> {
  const providerConfig = resolveProviderRuntimeConfig(
    config,
    await workspaceService.getRuntimeApiSettings(),
    'openai',
  );
  if (!providerConfig.apiKey) {
    sendJson(request, response, 500, { error: 'OpenAI-compatible API key is not configured.' }, config.allowedOrigins);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const modelId = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : 'openai-chat-request';
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  let usageReservationId: string | null;

  try {
    const reservation = await workspaceService.reserveUsageForProxy(
      getWorkspaceSessionToken(request, workspaceService),
      modelId,
      requestUrl.pathname,
      'model_request',
    );
    usageReservationId = reservation.usageRecordId;
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  request.once('aborted', abortUpstream);
  response.once('close', abortUpstream);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(
      `${normalizeOpenAiApiBase(providerConfig.apiBase)}/v1/chat/completions`,
      {
        method: request.method || 'POST',
        headers: buildProxyHeaders(request, {
          authorization: `Bearer ${providerConfig.apiKey}`,
        }),
        body: JSON.stringify(body),
        signal: abortController.signal,
      },
    );
  } catch (error) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    await workspaceService.finalizeUsageReservation(usageReservationId, {
      success: false,
      note: error instanceof Error ? error.message : 'OpenAI-compatible chat upstream request failed.',
    });
    if (abortController.signal.aborted) {
      if (!response.destroyed) {
        response.destroy();
      }
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(
      request,
      response,
      502,
      { error: `OpenAI-compatible chat upstream request failed: ${message}` },
      config.allowedOrigins,
    );
    return;
  }

  await workspaceService.finalizeUsageReservation(usageReservationId, {
    success: upstreamResponse.ok,
    note: `OpenAI-compatible chat upstream returned ${upstreamResponse.status}`,
  });

  response.writeHead(
    upstreamResponse.status,
    buildProxyResponseHeaders(request, upstreamResponse, config.allowedOrigins),
  );

  if (!upstreamResponse.body) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    response.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream), response);
  } catch (error) {
    if (!abortController.signal.aborted && !response.destroyed) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
  }
}

async function proxyAnthropicMessagesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedServerConfig,
  fetchImpl: typeof fetch,
  workspaceService: WorkspaceService,
): Promise<void> {
  const providerConfig = resolveProviderRuntimeConfig(
    config,
    await workspaceService.getRuntimeApiSettings(),
    'anthropic',
  );
  if (!providerConfig.apiKey) {
    sendJson(request, response, 500, { error: 'Anthropic-compatible API key is not configured.' }, config.allowedOrigins);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const modelId = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : 'anthropic-message-request';
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  let usageReservationId: string | null;

  try {
    const reservation = await workspaceService.reserveUsageForProxy(
      getWorkspaceSessionToken(request, workspaceService),
      modelId,
      requestUrl.pathname,
      'model_request',
    );
    usageReservationId = reservation.usageRecordId;
  } catch (error) {
    sendJson(
      request,
      response,
      getWorkspaceErrorStatus(error),
      { error: getWorkspaceErrorMessage(error) },
      config.allowedOrigins,
    );
    return;
  }

  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  request.once('aborted', abortUpstream);
  response.once('close', abortUpstream);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(
      `${normalizeAnthropicApiBase(providerConfig.apiBase)}/v1/messages`,
      {
        method: request.method || 'POST',
        headers: buildProxyHeaders(request, {
          'x-api-key': providerConfig.apiKey,
          'anthropic-version': '2023-06-01',
        }),
        body: JSON.stringify(body),
        signal: abortController.signal,
      },
    );
  } catch (error) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    await workspaceService.finalizeUsageReservation(usageReservationId, {
      success: false,
      note: error instanceof Error ? error.message : 'Anthropic-compatible upstream request failed.',
    });
    if (abortController.signal.aborted) {
      if (!response.destroyed) {
        response.destroy();
      }
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(
      request,
      response,
      502,
      { error: `Anthropic-compatible upstream request failed: ${message}` },
      config.allowedOrigins,
    );
    return;
  }

  await workspaceService.finalizeUsageReservation(usageReservationId, {
    success: upstreamResponse.ok,
    note: `Anthropic-compatible upstream returned ${upstreamResponse.status}`,
  });

  response.writeHead(
    upstreamResponse.status,
    buildProxyResponseHeaders(request, upstreamResponse, config.allowedOrigins),
  );

  if (!upstreamResponse.body) {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
    response.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream), response);
  } catch (error) {
    if (!abortController.signal.aborted && !response.destroyed) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    request.off('aborted', abortUpstream);
    response.off('close', abortUpstream);
  }
}

export function createServer(
  config: CreateServerConfig,
  dependencies: CreateServerDependencies = {},
): http.Server {
  const resolvedConfig: ResolvedServerConfig = {
    ...config,
    allowedOrigins: config.allowedOrigins ?? [],
    anthropicApiBase: config.anthropicApiBase ?? 'https://api.anthropic.com',
  };

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const createLiveToken = dependencies.createLiveToken ?? createLiveTokenWithGemini;
  const workspaceService =
    dependencies.workspaceService
    ?? new WorkspaceService({
      databaseFilePath: config.workspaceDatabaseFilePath
        ?? config.workspaceDataFilePath
        ?? 'server/data/arong-workspace.sqlite',
      legacyJsonFilePath: config.workspaceLegacyJsonFilePath,
      sessionTtlHours: config.workspaceSessionTtlHours,
    });
  const workspaceDatabaseFilePath = config.workspaceDatabaseFilePath
    ?? config.workspaceDataFilePath
    ?? 'server/data/arong-workspace.sqlite';
  const cloudChatService = dependencies.cloudChatService ?? new CloudChatService(
    workspaceDatabaseFilePath,
    {
      enabled: config.objectStorageEnabled,
      endpoint: config.objectStorageEndpoint,
      region: config.objectStorageRegion,
      bucket: config.objectStorageBucket,
      accessKeyId: config.objectStorageAccessKeyId,
      secretAccessKey: config.objectStorageSecretAccessKey,
      forcePathStyle: config.objectStorageForcePathStyle,
      publicBaseUrl: config.objectStoragePublicBaseUrl,
      prefix: config.objectStoragePrefix,
    },
    fetchImpl,
  );

  return http.createServer(async (request, response) => {
    try {
      const corsHeaders = getCorsHeaders(request, resolvedConfig.allowedOrigins);
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      const path = requestUrl.pathname;
      const method = request.method || 'GET';

      if (method === 'OPTIONS') {
        response.writeHead(204, {
          ...corsHeaders,
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers':
            (request.headers['access-control-request-headers'] as string | undefined) || '*',
        });
        response.end();
        return;
      }

      if (path.startsWith('/api/workspace')) {
        const handled = await handleWorkspaceRequest(
          request,
          response,
          resolvedConfig,
          workspaceService,
          cloudChatService,
          fetchImpl,
        );
        if (handled) {
          return;
        }
      }

      if (method === 'GET' && path === '/health') {
        sendJson(
          request,
          response,
          200,
          {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
          },
          resolvedConfig.allowedOrigins,
        );
        return;
      }

      if (method === 'GET' && path === '/api/live-token') {
        response.setHeader('cache-control', 'no-store');

        const hasWorkspaceAccess = await ensureWorkspaceSessionIfRequired(
          request,
          response,
          resolvedConfig,
          workspaceService,
        );
        if (!hasWorkspaceAccess) {
          return;
        }

        const providerConfig = resolveProviderRuntimeConfig(
          resolvedConfig,
          await workspaceService.getRuntimeApiSettings(),
          'gemini',
        );

        if (!providerConfig.apiKey) {
          sendJson(
            request,
            response,
            500,
            { error: 'Gemini API key is not configured.' },
            resolvedConfig.allowedOrigins,
          );
          return;
        }

        try {
          const tokenPayload = await createLiveToken(providerConfig.apiKey);
          if (typeof tokenPayload.name === 'string' && tokenPayload.name.length > 0) {
            sendJson(request, response, 200, { name: tokenPayload.name }, resolvedConfig.allowedOrigins);
            return;
          }

          if (typeof tokenPayload.token === 'string' && tokenPayload.token.length > 0) {
            sendJson(request, response, 200, { token: tokenPayload.token }, resolvedConfig.allowedOrigins);
            return;
          }

          sendJson(
            request,
            response,
            502,
            { error: 'Live token service returned an unexpected payload.' },
            resolvedConfig.allowedOrigins,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          sendJson(
            request,
            response,
            502,
            { error: `Failed to create live token: ${message}` },
            resolvedConfig.allowedOrigins,
          );
        }
        return;
      }

      if (path === GEMINI_PROXY_PREFIX || path.startsWith(`${GEMINI_PROXY_PREFIX}/`)) {
        await proxyGeminiRequest(request, response, resolvedConfig, fetchImpl, workspaceService);
        return;
      }

      if (method === 'POST' && OPENAI_IMAGE_PROXY_PATHS.has(path)) {
        await proxyOpenAiImagesRequest(request, response, resolvedConfig, fetchImpl, workspaceService);
        return;
      }

      if (method === 'POST' && OPENAI_CHAT_PROXY_PATHS.has(path)) {
        await proxyOpenAiChatCompletionsRequest(request, response, resolvedConfig, fetchImpl, workspaceService);
        return;
      }

      if (method === 'POST' && ANTHROPIC_MESSAGES_PROXY_PATHS.has(path)) {
        await proxyAnthropicMessagesRequest(request, response, resolvedConfig, fetchImpl, workspaceService);
        return;
      }

      sendJson(request, response, 404, { error: 'Not found' }, resolvedConfig.allowedOrigins);
    } catch {
      sendJson(request, response, 500, { error: 'Internal server error' }, resolvedConfig.allowedOrigins);
    }
  });
}
