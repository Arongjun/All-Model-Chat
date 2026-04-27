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
  };
}
