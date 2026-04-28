export interface ApiServerConfig {
  port: number;
  geminiApiBase: string;
  geminiApiKey?: string;
  openaiApiBase: string;
  openaiApiKey?: string;
  anthropicApiBase: string;
  anthropicApiKey?: string;
  allowedOrigins: string[];
  workspaceDatabaseFilePath: string;
  workspaceLegacyJsonFilePath?: string;
  workspaceSessionTtlHours: number;
  objectStorageEnabled: boolean;
  objectStorageEndpoint?: string;
  objectStorageRegion?: string;
  objectStorageBucket?: string;
  objectStorageAccessKeyId?: string;
  objectStorageSecretAccessKey?: string;
  objectStorageForcePathStyle: boolean;
  objectStoragePublicBaseUrl?: string;
  objectStoragePrefix?: string;
}

interface EnvLike {
  [key: string]: string | undefined;
}

const DEFAULT_PORT = 3001;
const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const DEFAULT_WORKSPACE_DATABASE_FILE = 'server/data/arong-workspace.sqlite';
const DEFAULT_WORKSPACE_LEGACY_JSON_FILE = 'server/data/arong-workspace.json';
const DEFAULT_WORKSPACE_SESSION_TTL_HOURS = 24 * 14;

function parsePort(port: string | undefined): number {
  if (!port) {
    return DEFAULT_PORT;
  }

  const parsed = Number.parseInt(port, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_PORT;
  }

  return parsed;
}

function parseAllowedOrigins(rawOrigins: string | undefined): string[] {
  if (!rawOrigins) {
    return [];
  }

  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(rawValue: string | undefined, fallback = false): boolean {
  if (!rawValue) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(rawValue.trim().toLowerCase());
}

export function loadConfig(env: EnvLike = process.env): ApiServerConfig {
  return {
    port: parsePort(env.PORT),
    geminiApiBase: env.GEMINI_API_BASE?.trim() || DEFAULT_GEMINI_API_BASE,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    openaiApiBase: env.OPENAI_API_BASE?.trim() || DEFAULT_OPENAI_API_BASE,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    anthropicApiBase: env.ANTHROPIC_API_BASE?.trim() || DEFAULT_ANTHROPIC_API_BASE,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    workspaceDatabaseFilePath: env.WORKSPACE_DATABASE_FILE?.trim() || DEFAULT_WORKSPACE_DATABASE_FILE,
    workspaceLegacyJsonFilePath: env.WORKSPACE_LEGACY_JSON_FILE?.trim() || DEFAULT_WORKSPACE_LEGACY_JSON_FILE,
    workspaceSessionTtlHours: parsePositiveInteger(
      env.WORKSPACE_SESSION_TTL_HOURS,
      DEFAULT_WORKSPACE_SESSION_TTL_HOURS,
    ),
    objectStorageEnabled: parseBoolean(env.OBJECT_STORAGE_ENABLED, false),
    objectStorageEndpoint: env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined,
    objectStorageRegion: env.OBJECT_STORAGE_REGION?.trim() || undefined,
    objectStorageBucket: env.OBJECT_STORAGE_BUCKET?.trim() || undefined,
    objectStorageAccessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || undefined,
    objectStorageSecretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || undefined,
    objectStorageForcePathStyle: parseBoolean(env.OBJECT_STORAGE_FORCE_PATH_STYLE, true),
    objectStoragePublicBaseUrl: env.OBJECT_STORAGE_PUBLIC_BASE_URL?.trim() || undefined,
    objectStoragePrefix: env.OBJECT_STORAGE_PREFIX?.trim() || undefined,
  };
}
