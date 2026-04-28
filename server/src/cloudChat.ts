import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type ObjectStorageEnvConfig,
  type ObjectStorageObject,
  type ObjectStoragePersistedSettings,
  type ObjectStorageSettingsSummary,
  S3CompatibleObjectStorageClient,
  isObjectStorageConfigured,
  mergeObjectStorageSettings,
  summarizeObjectStorageSettings,
} from './objectStorage.js';
import { withSqliteFileLock } from './sqliteFileLock.js';
import { WorkspaceError } from './workspace.js';

const nodeRequire = createRequire(import.meta.url);
const CLOUD_SETTINGS_KEY = 'object_storage';
const CLOUD_RETENTION_SETTINGS_KEY = 'cloud_chat_retention';
const SYSTEM_SCENARIOS_SEEDED_KEY = 'system_scenarios_seeded';

const DEFAULT_SYSTEM_SCENARIOS: Array<Pick<
  SystemScenarioPayload,
  'id' | 'title' | 'systemInstruction' | 'messages' | 'visibilityMode' | 'allowedUserIds' | 'active' | 'sortOrder'
>> = [
  {
    id: 'system-reasoner',
    title: '深度推理助手',
    systemInstruction: '你是一个严谨的推理和规划助手。回答前先梳理关键约束，优先给出清晰、可执行、可验证的方案。',
    messages: [],
    visibilityMode: 'all',
    allowedUserIds: [],
    active: true,
    sortOrder: 10,
  },
  {
    id: 'system-succinct',
    title: '简洁直答',
    systemInstruction: '请用尽量少的文字直接回答核心问题。避免无必要的铺垫、重复和追问。',
    messages: [],
    visibilityMode: 'all',
    allowedUserIds: [],
    active: true,
    sortOrder: 20,
  },
  {
    id: 'system-socratic',
    title: '苏格拉底导师',
    systemInstruction: '你是一位耐心的苏格拉底式导师。通过问题、提示和分步引导帮助用户自己发现答案。',
    messages: [],
    visibilityMode: 'all',
    allowedUserIds: [],
    active: true,
    sortOrder: 30,
  },
  {
    id: 'system-formal',
    title: '正式专业写作',
    systemInstruction: '请使用正式、专业、结构清晰的表达方式。保持准确、克制、礼貌，适合商务或专业场景。',
    messages: [],
    visibilityMode: 'all',
    allowedUserIds: [],
    active: true,
    sortOrder: 40,
  },
];

type SqliteValue = number | string | Uint8Array | null;

interface SqliteExecResult {
  columns: string[];
  values: SqliteValue[][];
}

interface SqliteDatabase {
  exec(sql: string, params?: SqliteValue[] | Record<string, SqliteValue> | null): SqliteExecResult[];
  export(): Uint8Array;
  close(): void;
}

interface SqliteModule {
  Database: new (data?: ArrayLike<number> | null) => SqliteDatabase;
}

type InitSqlJs = (config?: { locateFile?: (fileName: string) => string }) => Promise<SqliteModule>;

export interface CloudUploadedFileMetadata {
  id: string;
  name: string;
  type: string;
  size: number;
  cloudAttachmentId?: string;
  cloudStorageKey?: string;
  [key: string]: unknown;
}

export interface CloudChatMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string | number;
  files?: CloudUploadedFileMetadata[];
  [key: string]: unknown;
}

export interface CloudChatSessionPayload {
  id: string;
  title: string;
  timestamp: number;
  messages: CloudChatMessagePayload[];
  settings: Record<string, unknown>;
  isPinned?: boolean;
  groupId?: string | null;
}

export interface CloudChatGroupPayload {
  id: string;
  title: string;
  timestamp: number;
  isPinned?: boolean;
  isExpanded?: boolean;
}

export interface CloudChatStatusResponse {
  authenticated: boolean;
  enabled: boolean;
  objectStorage: Pick<ObjectStorageSettingsSummary, 'enabled' | 'configured'>;
}

export interface CloudAttachmentSummary {
  id: string;
  fileId: string | null;
  sessionId: string | null;
  messageId: string | null;
  name: string;
  type: string;
  size: number;
  storageKey: string;
  createdAt: string;
}

export interface CloudAdminSessionSummary extends CloudChatSessionPayload {
  userId: string;
  updatedAt: string;
  createdAt: string;
  attachmentCount: number;
  attachmentBytes: number;
}

export interface CloudAdminAttachmentSummary extends CloudAttachmentSummary {
  userId: string;
  deletedAt: string | null;
}

export interface CloudAdminPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CloudChatRetentionSettings {
  enabled: boolean;
  maxAttachmentAgeDays: number;
  maxTotalAttachmentBytes: number;
  updatedAt: string | null;
}

export interface CloudCleanupResult {
  dryRun: boolean;
  matchedCount: number;
  matchedBytes: number;
  deletedCount: number;
  deletedBytes: number;
  skippedReason: string | null;
}

export interface SystemScenarioPayload {
  id: string;
  title: string;
  systemInstruction?: string;
  messages: Array<{ id: string; role: 'user' | 'model'; content: string }>;
  visibilityMode: 'all' | 'members' | 'admins' | 'users';
  allowedUserIds: string[];
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  managedBy: 'system';
}

export interface UpdateObjectStorageSettingsInput {
  enabled?: boolean;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  clearSecretAccessKey?: boolean;
  forcePathStyle?: boolean;
  publicBaseUrl?: string | null;
  prefix?: string | null;
}

interface AdminListQuery {
  userId?: string | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

interface AttachmentListQuery extends AdminListQuery {
  sessionId?: string | null;
}

interface CleanupOptions {
  dryRun?: boolean;
  maxAttachmentAgeDays?: number;
  maxTotalAttachmentBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: SqliteValue | undefined): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: SqliteValue | undefined): CloudChatMessagePayload[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as CloudChatMessagePayload[]) : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: SqliteValue | undefined): string[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function normalizeNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePage(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 1), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizePageSize(value: unknown, fallback = 20, max = 100): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sanitizeFileName(name: string): string {
  const sanitized = name
    .normalize('NFKD')
    .replace(/[^\w.\-\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return sanitized || 'attachment';
}

function sanitizeStoragePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function sanitizeFilePayload(file: CloudUploadedFileMetadata): CloudUploadedFileMetadata {
  const next = { ...file };
  delete next.rawFile;
  delete next.dataUrl;
  delete next.abortController;
  delete next.uploadSpeed;

  return {
    ...next,
    id: readString(file.id, randomUUID()),
    name: readString(file.name, 'attachment'),
    type: readString(file.type, 'application/octet-stream'),
    size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
    cloudAttachmentId: normalizeNullableText(file.cloudAttachmentId) ?? undefined,
    cloudStorageKey: normalizeNullableText(file.cloudStorageKey) ?? undefined,
  };
}

function sanitizeMessagePayload(message: CloudChatMessagePayload): CloudChatMessagePayload {
  return {
    ...message,
    id: readString(message.id, randomUUID()),
    role: readString(message.role, 'user'),
    content: readString(message.content),
    files: Array.isArray(message.files)
      ? message.files.filter(isRecord).map((file) => sanitizeFilePayload(file as CloudUploadedFileMetadata))
      : undefined,
  };
}

function sanitizeSettingsPayload(settings: unknown): Record<string, unknown> {
  if (!isRecord(settings)) {
    return {};
  }

  const { lockedApiKey, apiKey, openAiApiKey, anthropicApiKey, ...safeSettings } = settings;
  void lockedApiKey;
  void apiKey;
  void openAiApiKey;
  void anthropicApiKey;
  return safeSettings;
}

function sanitizeSessionPayload(session: CloudChatSessionPayload): CloudChatSessionPayload {
  if (!isRecord(session)) {
    throw new WorkspaceError(400, 'Cloud chat session payload must be an object.');
  }

  const id = readString(session.id).trim();
  if (!id) {
    throw new WorkspaceError(400, 'Cloud chat session id is required.');
  }

  return {
    id,
    title: readString(session.title, 'New Chat').slice(0, 200),
    timestamp: Number.isFinite(Number(session.timestamp)) ? Number(session.timestamp) : Date.now(),
    settings: sanitizeSettingsPayload(session.settings),
    messages: Array.isArray(session.messages)
      ? session.messages.filter(isRecord).map((message) => sanitizeMessagePayload(message as CloudChatMessagePayload))
      : [],
    isPinned: Boolean(session.isPinned),
    groupId: normalizeNullableText(session.groupId),
  };
}

function sanitizeGroupPayload(group: CloudChatGroupPayload): CloudChatGroupPayload {
  if (!isRecord(group)) {
    throw new WorkspaceError(400, 'Cloud chat group payload must be an object.');
  }

  const id = readString(group.id).trim();
  if (!id) {
    throw new WorkspaceError(400, 'Cloud chat group id is required.');
  }

  return {
    id,
    title: readString(group.title, 'Untitled').slice(0, 200),
    timestamp: Number.isFinite(Number(group.timestamp)) ? Number(group.timestamp) : Date.now(),
    isPinned: Boolean(group.isPinned),
    isExpanded: group.isExpanded !== false,
  };
}

function normalizeVisibilityMode(value: unknown): SystemScenarioPayload['visibilityMode'] {
  return value === 'admins' || value === 'members' || value === 'users' ? value : 'all';
}

function sanitizeScenarioMessages(value: unknown): SystemScenarioPayload['messages'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((message) => ({
      id: readString(message.id, randomUUID()),
      role: message.role === 'model' ? 'model' as const : 'user' as const,
      content: readString(message.content).slice(0, 20000),
    }))
    .filter((message) => message.content.trim().length > 0);
}

function sanitizeSystemScenarioPayload(
  scenario: Partial<SystemScenarioPayload>,
  existing?: SystemScenarioPayload | null,
): SystemScenarioPayload {
  const now = new Date().toISOString();
  const id = readString(scenario.id, existing?.id ?? randomUUID()).trim() || randomUUID();
  const title = readString(scenario.title, existing?.title ?? '').trim();

  if (!title) {
    throw new WorkspaceError(400, 'System scenario title is required.');
  }

  const visibilityMode = normalizeVisibilityMode(scenario.visibilityMode ?? existing?.visibilityMode);
  const allowedUserIds = Array.isArray(scenario.allowedUserIds)
    ? scenario.allowedUserIds.filter((userId): userId is string => typeof userId === 'string' && userId.trim().length > 0)
    : existing?.allowedUserIds ?? [];

  return {
    id,
    title: title.slice(0, 200),
    systemInstruction: readString(
      scenario.systemInstruction,
      existing?.systemInstruction ?? '',
    ).slice(0, 100000),
    messages: sanitizeScenarioMessages(scenario.messages ?? existing?.messages ?? []),
    visibilityMode,
    allowedUserIds: visibilityMode === 'users' ? Array.from(new Set(allowedUserIds)) : [],
    active: typeof scenario.active === 'boolean' ? scenario.active : existing?.active ?? true,
    sortOrder: normalizeNonNegativeInteger(scenario.sortOrder, existing?.sortOrder ?? 100),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    managedBy: 'system',
  };
}

function rowToObject(columns: string[], values: SqliteValue[]): Record<string, SqliteValue> {
  return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]));
}

export class CloudChatService {
  private sqliteModulePromise: Promise<SqliteModule> | null = null;
  private lastAutomaticCleanupAt = 0;
  private automaticCleanupRunning = false;

  constructor(
    private readonly databaseFilePath: string,
    private readonly envObjectStorageConfig: ObjectStorageEnvConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async getStatus(authenticated: boolean): Promise<CloudChatStatusResponse> {
    void this.maybeRunAutomaticCleanup();
    const objectStorage = await this.getObjectStorageSummary();
    return {
      authenticated,
      enabled: authenticated,
      objectStorage: {
        enabled: objectStorage.enabled,
        configured: objectStorage.configured,
      },
    };
  }

  async getObjectStorageSummary(): Promise<ObjectStorageSettingsSummary> {
    return this.withDatabase(async (db) => {
      const persisted = this.readPersistedObjectStorageSettings(db);
      return summarizeObjectStorageSettings(
        mergeObjectStorageSettings(this.envObjectStorageConfig, persisted),
        this.resolveObjectStorageSource(persisted),
      );
    }, { write: false });
  }

  async updateObjectStorageSettings(input: UpdateObjectStorageSettingsInput): Promise<ObjectStorageSettingsSummary> {
    return this.withDatabase(async (db) => {
      const current = this.readPersistedObjectStorageSettings(db) ?? {};
      const next: ObjectStoragePersistedSettings = { ...current };

      if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
      if (input.endpoint !== undefined) next.endpoint = normalizeNullableText(input.endpoint) ?? '';
      if (input.region !== undefined) next.region = normalizeNullableText(input.region) ?? '';
      if (input.bucket !== undefined) next.bucket = normalizeNullableText(input.bucket) ?? '';
      if (input.accessKeyId !== undefined) next.accessKeyId = normalizeNullableText(input.accessKeyId) ?? '';
      if (input.secretAccessKey !== undefined && normalizeNullableText(input.secretAccessKey)) {
        next.secretAccessKey = normalizeNullableText(input.secretAccessKey) ?? '';
      }
      if (input.clearSecretAccessKey) next.secretAccessKey = '';
      if (typeof input.forcePathStyle === 'boolean') next.forcePathStyle = input.forcePathStyle;
      if (input.publicBaseUrl !== undefined) next.publicBaseUrl = normalizeNullableText(input.publicBaseUrl);
      if (input.prefix !== undefined) next.prefix = normalizeNullableText(input.prefix) ?? '';

      db.exec(
        `INSERT OR REPLACE INTO cloud_runtime_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)`,
        [CLOUD_SETTINGS_KEY, JSON.stringify(next), new Date().toISOString()],
      );

      return summarizeObjectStorageSettings(
        mergeObjectStorageSettings(this.envObjectStorageConfig, next),
        'admin',
      );
    }, { write: true });
  }

  async listSessions(userId: string): Promise<CloudChatSessionPayload[]> {
    return this.withDatabase(async (db) =>
      this.getRows(
        db,
        `SELECT * FROM cloud_chat_sessions
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY is_pinned DESC, timestamp DESC, updated_at DESC`,
        [userId],
      ).map((row) => this.rowToSession(row, { metadataOnly: true })),
    { write: false });
  }

  async getSession(userId: string, sessionId: string): Promise<CloudChatSessionPayload | null> {
    return this.withDatabase(async (db) => {
      const rows = this.getRows(
        db,
        `SELECT * FROM cloud_chat_sessions
         WHERE user_id = ? AND id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [userId, sessionId],
      );
      return rows.length > 0 ? this.rowToSession(rows[0], { metadataOnly: false }) : null;
    }, { write: false });
  }

  async saveSession(userId: string, session: CloudChatSessionPayload): Promise<CloudChatSessionPayload> {
    const sanitized = sanitizeSessionPayload(session);
    return this.withDatabase(async (db) => {
      const now = new Date().toISOString();
      const existingRows = this.getRows(
        db,
        'SELECT created_at FROM cloud_chat_sessions WHERE user_id = ? AND id = ? LIMIT 1',
        [userId, sanitized.id],
      );
      const createdAt = typeof existingRows[0]?.created_at === 'string' ? existingRows[0].created_at : now;

      db.exec(
        `INSERT OR REPLACE INTO cloud_chat_sessions (
          id, user_id, title, timestamp, settings_json, messages_json,
          is_pinned, group_id, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          sanitized.id,
          userId,
          sanitized.title,
          sanitized.timestamp,
          JSON.stringify(sanitized.settings),
          JSON.stringify(sanitized.messages),
          sanitized.isPinned ? 1 : 0,
          sanitized.groupId ?? null,
          createdAt,
          now,
        ],
      );
      this.attachKnownSessionFiles(db, userId, sanitized);
      return sanitized;
    }, { write: true });
  }

  async deleteSession(userId: string, sessionId: string): Promise<void> {
    const attachmentKeys = await this.withDatabase(async (db) => {
      const now = new Date().toISOString();
      const attachments = this.getRows(
        db,
        `SELECT storage_key FROM cloud_chat_attachments
         WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL`,
        [userId, sessionId],
      )
        .map((row) => typeof row.storage_key === 'string' ? row.storage_key : '')
        .filter(Boolean);

      db.exec(
        'UPDATE cloud_chat_sessions SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?',
        [now, now, userId, sessionId],
      );
      db.exec(
        'UPDATE cloud_chat_attachments SET deleted_at = ? WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL',
        [now, userId, sessionId],
      );
      return attachments;
    }, { write: true });

    if (attachmentKeys.length === 0) {
      return;
    }

    const runtimeSettings = await this.getRuntimeObjectStorageSettings();
    if (!isObjectStorageConfigured(runtimeSettings)) {
      return;
    }

    const client = new S3CompatibleObjectStorageClient(runtimeSettings, this.fetchImpl);
    await Promise.all(
      attachmentKeys.map((storageKey) =>
        client.deleteObject(storageKey).catch(() => undefined),
      ),
    );
  }

  async listAdminSessions(query: AdminListQuery = {}): Promise<CloudAdminPage<CloudAdminSessionSummary>> {
    return this.withDatabase(async (db) => {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const conditions = ['s.deleted_at IS NULL'];
      const params: SqliteValue[] = [];

      if (query.userId?.trim()) {
        conditions.push('s.user_id = ?');
        params.push(query.userId.trim());
      }

      if (query.search?.trim()) {
        conditions.push('(s.title LIKE ? OR s.id LIKE ?)');
        const search = `%${query.search.trim()}%`;
        params.push(search, search);
      }

      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = Number(this.getRows(
        db,
        `SELECT COUNT(*) AS total FROM cloud_chat_sessions s ${whereSql}`,
        params,
      )[0]?.total ?? 0);
      const rows = this.getRows(
        db,
        `SELECT
          s.*,
          COUNT(a.id) AS attachment_count,
          COALESCE(SUM(a.size), 0) AS attachment_bytes
         FROM cloud_chat_sessions s
         LEFT JOIN cloud_chat_attachments a
           ON a.user_id = s.user_id
          AND a.session_id = s.id
          AND a.deleted_at IS NULL
         ${whereSql}
         GROUP BY s.user_id, s.id
         ORDER BY s.updated_at DESC, s.timestamp DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize],
      );

      return this.toPage(
        rows.map((row) => ({
          ...this.rowToSession(row, { metadataOnly: true }),
          userId: String(row.user_id ?? ''),
          createdAt: String(row.created_at ?? ''),
          updatedAt: String(row.updated_at ?? ''),
          attachmentCount: Number(row.attachment_count ?? 0),
          attachmentBytes: Number(row.attachment_bytes ?? 0),
        })),
        total,
        page,
        pageSize,
      );
    }, { write: false });
  }

  async getAdminSession(userId: string, sessionId: string): Promise<CloudAdminSessionSummary | null> {
    return this.withDatabase(async (db) => {
      const rows = this.getRows(
        db,
        `SELECT
          s.*,
          COUNT(a.id) AS attachment_count,
          COALESCE(SUM(a.size), 0) AS attachment_bytes
         FROM cloud_chat_sessions s
         LEFT JOIN cloud_chat_attachments a
           ON a.user_id = s.user_id
          AND a.session_id = s.id
          AND a.deleted_at IS NULL
         WHERE s.user_id = ? AND s.id = ? AND s.deleted_at IS NULL
         GROUP BY s.user_id, s.id
         LIMIT 1`,
        [userId, sessionId],
      );
      if (rows.length === 0) {
        return null;
      }
      const row = rows[0];
      return {
        ...this.rowToSession(row, { metadataOnly: false }),
        userId: String(row.user_id ?? ''),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        attachmentCount: Number(row.attachment_count ?? 0),
        attachmentBytes: Number(row.attachment_bytes ?? 0),
      };
    }, { write: false });
  }

  async deleteAdminSessions(sessions: Array<{ userId: string; id: string }>): Promise<{ deletedCount: number }> {
    let deletedCount = 0;
    for (const session of sessions) {
      if (!session.userId || !session.id) {
        continue;
      }
      await this.deleteSession(session.userId, session.id);
      deletedCount += 1;
    }
    return { deletedCount };
  }

  async listAdminAttachments(query: AttachmentListQuery = {}): Promise<CloudAdminPage<CloudAdminAttachmentSummary>> {
    return this.withDatabase(async (db) => {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const conditions = ['deleted_at IS NULL'];
      const params: SqliteValue[] = [];

      if (query.userId?.trim()) {
        conditions.push('user_id = ?');
        params.push(query.userId.trim());
      }
      if (query.sessionId?.trim()) {
        conditions.push('session_id = ?');
        params.push(query.sessionId.trim());
      }
      if (query.search?.trim()) {
        conditions.push('(name LIKE ? OR id LIKE ?)');
        const search = `%${query.search.trim()}%`;
        params.push(search, search);
      }

      const whereSql = `WHERE ${conditions.join(' AND ')}`;
      const total = Number(this.getRows(
        db,
        `SELECT COUNT(*) AS total FROM cloud_chat_attachments ${whereSql}`,
        params,
      )[0]?.total ?? 0);
      const rows = this.getRows(
        db,
        `SELECT * FROM cloud_chat_attachments
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize],
      );

      return this.toPage(rows.map((row) => this.rowToAdminAttachment(row)), total, page, pageSize);
    }, { write: false });
  }

  async deleteAdminAttachments(attachmentIds: string[]): Promise<{ deletedCount: number; deletedBytes: number }> {
    const ids = Array.from(new Set(attachmentIds.filter((id) => id.trim().length > 0)));
    if (ids.length === 0) {
      return { deletedCount: 0, deletedBytes: 0 };
    }

    const deleted = await this.markAttachmentsDeleted(ids);
    await this.deleteStorageObjects(deleted.map((attachment) => attachment.storageKey));
    return {
      deletedCount: deleted.length,
      deletedBytes: deleted.reduce((total, attachment) => total + attachment.size, 0),
    };
  }

  async getRetentionSettings(): Promise<CloudChatRetentionSettings> {
    return this.withDatabase(async (db) => this.readRetentionSettings(db), { write: false });
  }

  async updateRetentionSettings(input: Partial<CloudChatRetentionSettings>): Promise<CloudChatRetentionSettings> {
    return this.withDatabase(async (db) => {
      const current = this.readRetentionSettings(db);
      const next: CloudChatRetentionSettings = {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
        maxAttachmentAgeDays: normalizeNonNegativeInteger(
          input.maxAttachmentAgeDays,
          current.maxAttachmentAgeDays,
        ),
        maxTotalAttachmentBytes: normalizeNonNegativeInteger(
          input.maxTotalAttachmentBytes,
          current.maxTotalAttachmentBytes,
        ),
        updatedAt: new Date().toISOString(),
      };
      db.exec(
        `INSERT OR REPLACE INTO cloud_runtime_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)`,
        [CLOUD_RETENTION_SETTINGS_KEY, JSON.stringify(next), next.updatedAt],
      );
      return next;
    }, { write: true });
  }

  async cleanupAttachments(options: CleanupOptions = {}): Promise<CloudCleanupResult> {
    const settings = await this.getRetentionSettings();
    const dryRun = options.dryRun !== false;
    const maxAttachmentAgeDays = normalizeNonNegativeInteger(
      options.maxAttachmentAgeDays,
      settings.maxAttachmentAgeDays,
    );
    const maxTotalAttachmentBytes = normalizeNonNegativeInteger(
      options.maxTotalAttachmentBytes,
      settings.maxTotalAttachmentBytes,
    );

    if (!settings.enabled && options.maxAttachmentAgeDays === undefined && options.maxTotalAttachmentBytes === undefined) {
      return {
        dryRun,
        matchedCount: 0,
        matchedBytes: 0,
        deletedCount: 0,
        deletedBytes: 0,
        skippedReason: '自动清理未启用；可以手动填写条件后试跑或执行。',
      };
    }

    const candidates = await this.withDatabase(async (db) => {
      const rows = this.getRows(
        db,
        `SELECT * FROM cloud_chat_attachments
         WHERE deleted_at IS NULL
         ORDER BY created_at ASC`,
      ).map((row) => this.rowToAdminAttachment(row));

      const cutoff = maxAttachmentAgeDays > 0
        ? Date.now() - maxAttachmentAgeDays * 24 * 60 * 60 * 1000
        : null;
      const oldAttachments = cutoff
        ? rows.filter((attachment) => Date.parse(attachment.createdAt || '') <= cutoff)
        : [];

      if (maxTotalAttachmentBytes <= 0) {
        return oldAttachments;
      }

      const totalBytes = rows.reduce((total, attachment) => total + attachment.size, 0);
      let bytesToTrim = Math.max(totalBytes - maxTotalAttachmentBytes, 0);
      const selected = new Map(oldAttachments.map((attachment) => [attachment.id, attachment]));

      for (const attachment of rows) {
        if (bytesToTrim <= 0) {
          break;
        }
        selected.set(attachment.id, attachment);
        bytesToTrim -= attachment.size;
      }

      return [...selected.values()];
    }, { write: false });

    const matchedBytes = candidates.reduce((total, attachment) => total + attachment.size, 0);
    if (dryRun || candidates.length === 0) {
      return {
        dryRun,
        matchedCount: candidates.length,
        matchedBytes,
        deletedCount: 0,
        deletedBytes: 0,
        skippedReason: dryRun ? null : '没有匹配到需要清理的附件。',
      };
    }

    const deleted = await this.markAttachmentsDeleted(candidates.map((attachment) => attachment.id));
    await this.deleteStorageObjects(deleted.map((attachment) => attachment.storageKey));

    return {
      dryRun,
      matchedCount: candidates.length,
      matchedBytes,
      deletedCount: deleted.length,
      deletedBytes: deleted.reduce((total, attachment) => total + attachment.size, 0),
      skippedReason: null,
    };
  }

  async listGroups(userId: string): Promise<CloudChatGroupPayload[]> {
    return this.withDatabase(async (db) =>
      this.getRows(
        db,
        `SELECT * FROM cloud_chat_groups
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY is_pinned DESC, timestamp DESC, updated_at DESC`,
        [userId],
      ).map((row) => this.rowToGroup(row)),
    { write: false });
  }

  async replaceGroups(userId: string, groups: CloudChatGroupPayload[]): Promise<CloudChatGroupPayload[]> {
    const sanitizedGroups = Array.isArray(groups)
      ? groups.filter(isRecord).map((group) => sanitizeGroupPayload(group as CloudChatGroupPayload))
      : [];

    return this.withDatabase(async (db) => {
      const now = new Date().toISOString();
      db.exec('UPDATE cloud_chat_groups SET deleted_at = ?, updated_at = ? WHERE user_id = ?', [now, now, userId]);

      sanitizedGroups.forEach((group) => {
        db.exec(
          `INSERT OR REPLACE INTO cloud_chat_groups (
            id, user_id, title, timestamp, is_pinned, is_expanded, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(
            (SELECT created_at FROM cloud_chat_groups WHERE user_id = ? AND id = ?),
            ?
          ), ?, NULL)`,
          [
            group.id,
            userId,
            group.title,
            group.timestamp,
            group.isPinned ? 1 : 0,
            group.isExpanded === false ? 0 : 1,
            userId,
            group.id,
            now,
            now,
          ],
        );
      });

      return sanitizedGroups;
    }, { write: true });
  }

  async uploadAttachment(
    userId: string,
    input: {
      fileId?: string | null;
      sessionId?: string | null;
      messageId?: string | null;
      name: string;
      type: string;
      size: number;
      body: Buffer;
    },
  ): Promise<CloudAttachmentSummary> {
    const runtimeSettings = await this.getRuntimeObjectStorageSettings();
    if (!isObjectStorageConfigured(runtimeSettings)) {
      throw new WorkspaceError(503, 'Object storage is not configured. Configure it in Settings -> Account & Quota first.');
    }

    const id = randomUUID();
    const storagePrefix = sanitizeStoragePrefix(runtimeSettings.prefix);
    const storageKey = `${storagePrefix}/users/${userId}/attachments/${id}-${sanitizeFileName(input.name)}`;
    const client = new S3CompatibleObjectStorageClient(runtimeSettings, this.fetchImpl);
    await client.putObject(storageKey, input.body, input.type || 'application/octet-stream');

    const createdAt = new Date().toISOString();
    await this.withDatabase(async (db) => {
      db.exec(
        `INSERT INTO cloud_chat_attachments (
          id, user_id, session_id, message_id, file_id, name, type, size, storage_key, created_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          id,
          userId,
          normalizeNullableText(input.sessionId),
          normalizeNullableText(input.messageId),
          normalizeNullableText(input.fileId),
          input.name,
          input.type || 'application/octet-stream',
          input.size,
          storageKey,
          createdAt,
        ],
      );
    }, { write: true });

    return {
      id,
      fileId: normalizeNullableText(input.fileId),
      sessionId: normalizeNullableText(input.sessionId),
      messageId: normalizeNullableText(input.messageId),
      name: input.name,
      type: input.type || 'application/octet-stream',
      size: input.size,
      storageKey,
      createdAt,
    };
  }

  async downloadAttachment(userId: string, attachmentId: string): Promise<ObjectStorageObject & CloudAttachmentSummary> {
    const attachment = await this.withDatabase(async (db) => {
      const rows = this.getRows(
        db,
        `SELECT * FROM cloud_chat_attachments
         WHERE user_id = ? AND id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [userId, attachmentId],
      );
      return rows.length > 0 ? this.rowToAttachment(rows[0]) : null;
    }, { write: false });

    if (!attachment) {
      throw new WorkspaceError(404, 'Cloud attachment was not found.');
    }

    const runtimeSettings = await this.getRuntimeObjectStorageSettings();
    if (!isObjectStorageConfigured(runtimeSettings)) {
      throw new WorkspaceError(503, 'Object storage is not configured.');
    }

    const object = await new S3CompatibleObjectStorageClient(runtimeSettings, this.fetchImpl)
      .getObject(attachment.storageKey);

    return {
      ...attachment,
      ...object,
      contentType: object.contentType || attachment.type,
    };
  }

  async listVisibleSystemScenarios(
    user: { id: string; role: 'admin' | 'member' } | null,
  ): Promise<SystemScenarioPayload[]> {
    return this.withDatabase(async (db) =>
      this.getRows(
        db,
        `SELECT * FROM system_scenarios
         WHERE active = 1
         ORDER BY sort_order ASC, updated_at DESC`,
      )
        .map((row) => this.rowToSystemScenario(row))
        .filter((scenario) => this.canUserSeeScenario(scenario, user)),
    { write: false });
  }

  async listAdminSystemScenarios(): Promise<SystemScenarioPayload[]> {
    return this.withDatabase(async (db) =>
      this.getRows(
        db,
        'SELECT * FROM system_scenarios ORDER BY sort_order ASC, updated_at DESC',
      ).map((row) => this.rowToSystemScenario(row)),
    { write: false });
  }

  async upsertSystemScenario(input: Partial<SystemScenarioPayload>): Promise<SystemScenarioPayload> {
    return this.withDatabase(async (db) => {
      const existing = input.id ? this.getSystemScenarioById(db, input.id) : null;
      const scenario = sanitizeSystemScenarioPayload(input, existing);
      db.exec(
        `INSERT OR REPLACE INTO system_scenarios (
          id, title, system_instruction, messages_json, visibility_mode,
          allowed_user_ids_json, active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scenario.id,
          scenario.title,
          scenario.systemInstruction ?? '',
          JSON.stringify(scenario.messages),
          scenario.visibilityMode,
          JSON.stringify(scenario.allowedUserIds),
          scenario.active ? 1 : 0,
          scenario.sortOrder,
          scenario.createdAt,
          scenario.updatedAt,
        ],
      );
      return scenario;
    }, { write: true });
  }

  async deleteSystemScenario(id: string): Promise<void> {
    await this.withDatabase(async (db) => {
      db.exec('DELETE FROM system_scenarios WHERE id = ?', [id]);
    }, { write: true });
  }

  private async maybeRunAutomaticCleanup(): Promise<void> {
    const now = Date.now();
    if (this.automaticCleanupRunning || now - this.lastAutomaticCleanupAt < 24 * 60 * 60 * 1000) {
      return;
    }

    this.lastAutomaticCleanupAt = now;
    this.automaticCleanupRunning = true;
    try {
      const settings = await this.getRetentionSettings();
      if (settings.enabled) {
        await this.cleanupAttachments({ dryRun: false });
      }
    } catch {
      // Cleanup should never block chat availability.
    } finally {
      this.automaticCleanupRunning = false;
    }
  }

  private async getRuntimeObjectStorageSettings() {
    return this.withDatabase(async (db) =>
      mergeObjectStorageSettings(this.envObjectStorageConfig, this.readPersistedObjectStorageSettings(db)),
    { write: false });
  }

  private readPersistedObjectStorageSettings(db: SqliteDatabase): ObjectStoragePersistedSettings | null {
    const rows = this.getRows(
      db,
      'SELECT value_json FROM cloud_runtime_settings WHERE key = ? LIMIT 1',
      [CLOUD_SETTINGS_KEY],
    );
    if (rows.length === 0 || typeof rows[0].value_json !== 'string') {
      return null;
    }

    try {
      const parsed = JSON.parse(rows[0].value_json) as unknown;
      return isRecord(parsed) ? parsed as ObjectStoragePersistedSettings : null;
    } catch {
      return null;
    }
  }

  private readRetentionSettings(db: SqliteDatabase): CloudChatRetentionSettings {
    const fallback: CloudChatRetentionSettings = {
      enabled: false,
      maxAttachmentAgeDays: 30,
      maxTotalAttachmentBytes: 0,
      updatedAt: null,
    };
    const rows = this.getRows(
      db,
      'SELECT value_json FROM cloud_runtime_settings WHERE key = ? LIMIT 1',
      [CLOUD_RETENTION_SETTINGS_KEY],
    );
    if (rows.length === 0 || typeof rows[0].value_json !== 'string') {
      return fallback;
    }

    try {
      const parsed = JSON.parse(rows[0].value_json) as Partial<CloudChatRetentionSettings>;
      return {
        enabled: parsed.enabled === true,
        maxAttachmentAgeDays: normalizeNonNegativeInteger(parsed.maxAttachmentAgeDays, fallback.maxAttachmentAgeDays),
        maxTotalAttachmentBytes: normalizeNonNegativeInteger(parsed.maxTotalAttachmentBytes, fallback.maxTotalAttachmentBytes),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    } catch {
      return fallback;
    }
  }

  private resolveObjectStorageSource(
    persisted: ObjectStoragePersistedSettings | null,
  ): ObjectStorageSettingsSummary['source'] {
    if (persisted) {
      return 'admin';
    }
    return this.envObjectStorageConfig.endpoint || this.envObjectStorageConfig.bucket ? 'environment' : 'none';
  }

  private attachKnownSessionFiles(
    db: SqliteDatabase,
    userId: string,
    session: CloudChatSessionPayload,
  ): void {
    session.messages.forEach((message) => {
      message.files?.forEach((file) => {
        if (!file.cloudAttachmentId) {
          return;
        }
        db.exec(
          `UPDATE cloud_chat_attachments
           SET session_id = ?, message_id = ?, file_id = ?
           WHERE user_id = ? AND id = ?`,
          [session.id, message.id, file.id, userId, file.cloudAttachmentId],
        );
      });
    });
  }

  private async markAttachmentsDeleted(attachmentIds: string[]): Promise<CloudAdminAttachmentSummary[]> {
    const ids = Array.from(new Set(attachmentIds.filter(Boolean)));
    if (ids.length === 0) {
      return [];
    }

    return this.withDatabase(async (db) => {
      const placeholders = ids.map(() => '?').join(',');
      const attachments = this.getRows(
        db,
        `SELECT * FROM cloud_chat_attachments
         WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        ids,
      ).map((row) => this.rowToAdminAttachment(row));
      if (attachments.length === 0) {
        return [];
      }

      const now = new Date().toISOString();
      db.exec(
        `UPDATE cloud_chat_attachments
         SET deleted_at = ?
         WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        [now, ...ids],
      );
      this.removeDeletedAttachmentReferences(db, attachments, now);
      return attachments;
    }, { write: true });
  }

  private async deleteStorageObjects(storageKeys: string[]): Promise<void> {
    const keys = Array.from(new Set(storageKeys.filter(Boolean)));
    if (keys.length === 0) {
      return;
    }

    const runtimeSettings = await this.getRuntimeObjectStorageSettings();
    if (!isObjectStorageConfigured(runtimeSettings)) {
      return;
    }

    const client = new S3CompatibleObjectStorageClient(runtimeSettings, this.fetchImpl);
    await Promise.all(keys.map((storageKey) => client.deleteObject(storageKey).catch(() => undefined)));
  }

  private removeDeletedAttachmentReferences(
    db: SqliteDatabase,
    attachments: CloudAdminAttachmentSummary[],
    updatedAt: string,
  ): void {
    const attachmentsBySession = new Map<string, CloudAdminAttachmentSummary[]>();
    attachments.forEach((attachment) => {
      if (!attachment.sessionId) {
        return;
      }
      const key = `${attachment.userId}:${attachment.sessionId}`;
      attachmentsBySession.set(key, [...(attachmentsBySession.get(key) ?? []), attachment]);
    });

    attachmentsBySession.forEach((sessionAttachments) => {
      const firstAttachment = sessionAttachments[0];
      if (!firstAttachment?.sessionId) {
        return;
      }

      const rows = this.getRows(
        db,
        `SELECT messages_json FROM cloud_chat_sessions
         WHERE user_id = ? AND id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [firstAttachment.userId, firstAttachment.sessionId],
      );
      if (rows.length === 0) {
        return;
      }

      const attachmentIds = new Set(sessionAttachments.map((attachment) => attachment.id).filter(Boolean));
      const fileIds = new Set(
        sessionAttachments
          .map((attachment) => attachment.fileId)
          .filter((fileId): fileId is string => typeof fileId === 'string' && fileId.length > 0),
      );
      const storageKeys = new Set(sessionAttachments.map((attachment) => attachment.storageKey).filter(Boolean));
      let changed = false;
      const messages = parseJsonArray(rows[0].messages_json).map((message) => {
        if (!Array.isArray(message.files)) {
          return message;
        }

        const files = message.files.filter((file) =>
          !attachmentIds.has(file.cloudAttachmentId ?? '')
          && !fileIds.has(file.id)
          && !storageKeys.has(file.cloudStorageKey ?? ''),
        );
        if (files.length === message.files.length) {
          return message;
        }

        changed = true;
        return { ...message, files: files.length > 0 ? files : undefined };
      });

      if (!changed) {
        return;
      }

      db.exec(
        `UPDATE cloud_chat_sessions
         SET messages_json = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
        [JSON.stringify(messages), updatedAt, firstAttachment.userId, firstAttachment.sessionId],
      );
    });
  }

  private toPage<T>(items: T[], total: number, page: number, pageSize: number): CloudAdminPage<T> {
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }

  private rowToSession(
    row: Record<string, SqliteValue>,
    options: { metadataOnly: boolean },
  ): CloudChatSessionPayload {
    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? 'New Chat'),
      timestamp: Number(row.timestamp ?? Date.now()),
      settings: parseJsonRecord(row.settings_json),
      messages: options.metadataOnly ? [] : parseJsonArray(row.messages_json),
      isPinned: Number(row.is_pinned ?? 0) === 1,
      groupId: typeof row.group_id === 'string' ? row.group_id : null,
    };
  }

  private rowToAttachment(row: Record<string, SqliteValue>): CloudAttachmentSummary {
    return {
      id: String(row.id ?? ''),
      fileId: typeof row.file_id === 'string' ? row.file_id : null,
      sessionId: typeof row.session_id === 'string' ? row.session_id : null,
      messageId: typeof row.message_id === 'string' ? row.message_id : null,
      name: String(row.name ?? 'attachment'),
      type: String(row.type ?? 'application/octet-stream'),
      size: Number(row.size ?? 0),
      storageKey: String(row.storage_key ?? ''),
      createdAt: String(row.created_at ?? ''),
    };
  }

  private rowToAdminAttachment(row: Record<string, SqliteValue>): CloudAdminAttachmentSummary {
    return {
      ...this.rowToAttachment(row),
      userId: String(row.user_id ?? ''),
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  private rowToGroup(row: Record<string, SqliteValue>): CloudChatGroupPayload {
    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? 'Untitled'),
      timestamp: Number(row.timestamp ?? Date.now()),
      isPinned: Number(row.is_pinned ?? 0) === 1,
      isExpanded: Number(row.is_expanded ?? 1) !== 0,
    };
  }

  private rowToSystemScenario(row: Record<string, SqliteValue>): SystemScenarioPayload {
    const messages = parseJsonArray(row.messages_json)
      .map((message) => ({
        id: readString(message.id, randomUUID()),
        role: message.role === 'model' ? 'model' as const : 'user' as const,
        content: readString(message.content),
      }))
      .filter((message) => message.content.trim().length > 0);

    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? ''),
      systemInstruction: typeof row.system_instruction === 'string' ? row.system_instruction : '',
      messages,
      visibilityMode: normalizeVisibilityMode(row.visibility_mode),
      allowedUserIds: parseStringArray(row.allowed_user_ids_json),
      active: Number(row.active ?? 1) === 1,
      sortOrder: Number(row.sort_order ?? 100),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      managedBy: 'system',
    };
  }

  private getSystemScenarioById(db: SqliteDatabase, id: string): SystemScenarioPayload | null {
    const rows = this.getRows(db, 'SELECT * FROM system_scenarios WHERE id = ? LIMIT 1', [id]);
    return rows.length > 0 ? this.rowToSystemScenario(rows[0]) : null;
  }

  private canUserSeeScenario(
    scenario: SystemScenarioPayload,
    user: { id: string; role: 'admin' | 'member' } | null,
  ): boolean {
    if (!scenario.active) {
      return false;
    }
    switch (scenario.visibilityMode) {
      case 'admins':
        return user?.role === 'admin';
      case 'members':
        return user?.role === 'member' || user?.role === 'admin';
      case 'users':
        return !!user && scenario.allowedUserIds.includes(user.id);
      default:
        return true;
    }
  }

  private async withDatabase<T>(
    operation: (db: SqliteDatabase) => Promise<T> | T,
    options: { write: boolean },
  ): Promise<T> {
    return withSqliteFileLock(this.databaseFilePath, async () => {
      await mkdir(path.dirname(this.databaseFilePath), { recursive: true });
      const db = await this.openDatabase();
      try {
        this.ensureSchema(db);
        const result = await operation(db);
        if (options.write) {
          await writeFile(this.databaseFilePath, Buffer.from(db.export()));
        }
        return result;
      } finally {
        db.close();
      }
    });
  }

  private async getSqliteModule(): Promise<SqliteModule> {
    if (!this.sqliteModulePromise) {
      const sqlJsModule = nodeRequire('sql.js') as InitSqlJs | { default: InitSqlJs };
      const initSqlJs = 'default' in sqlJsModule ? sqlJsModule.default : sqlJsModule;
      this.sqliteModulePromise = initSqlJs({
        locateFile: (fileName) => nodeRequire.resolve(`sql.js/dist/${fileName}`),
      });
    }
    return this.sqliteModulePromise;
  }

  private async openDatabase(): Promise<SqliteDatabase> {
    const sqlite = await this.getSqliteModule();
    try {
      const fileContents = await readFile(this.databaseFilePath);
      return new sqlite.Database(fileContents);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return new sqlite.Database();
      }
      throw error;
    }
  }

  private ensureSchema(db: SqliteDatabase): void {
    this.migrateLegacySessionPrimaryKey(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_chat_sessions (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        settings_json TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        is_pinned INTEGER NOT NULL,
        group_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_chat_sessions_user_updated
        ON cloud_chat_sessions (user_id, deleted_at, is_pinned, timestamp, updated_at);

      CREATE TABLE IF NOT EXISTS cloud_chat_groups (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_pinned INTEGER NOT NULL,
        is_expanded INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_chat_groups_user_updated
        ON cloud_chat_groups (user_id, deleted_at, is_pinned, timestamp, updated_at);

      CREATE TABLE IF NOT EXISTS cloud_chat_attachments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        file_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_chat_attachments_user_session
        ON cloud_chat_attachments (user_id, session_id, message_id);

      CREATE TABLE IF NOT EXISTS cloud_runtime_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_scenarios (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        system_instruction TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        visibility_mode TEXT NOT NULL,
        allowed_user_ids_json TEXT NOT NULL,
        active INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_system_scenarios_visibility
        ON system_scenarios (active, visibility_mode, sort_order, updated_at);
    `);
    this.seedDefaultSystemScenarios(db);
  }

  private seedDefaultSystemScenarios(db: SqliteDatabase): void {
    const seededRows = this.getRows(
      db,
      'SELECT value_json FROM cloud_runtime_settings WHERE key = ? LIMIT 1',
      [SYSTEM_SCENARIOS_SEEDED_KEY],
    );
    if (seededRows.length > 0) {
      return;
    }

    const now = new Date().toISOString();
    DEFAULT_SYSTEM_SCENARIOS.forEach((scenario) => {
      db.exec(
        `INSERT OR IGNORE INTO system_scenarios (
          id, title, system_instruction, messages_json, visibility_mode,
          allowed_user_ids_json, active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scenario.id,
          scenario.title,
          scenario.systemInstruction ?? '',
          JSON.stringify(scenario.messages),
          scenario.visibilityMode,
          JSON.stringify(scenario.allowedUserIds),
          scenario.active ? 1 : 0,
          scenario.sortOrder,
          now,
          now,
        ],
      );
    });
    db.exec(
      `INSERT OR REPLACE INTO cloud_runtime_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)`,
      [SYSTEM_SCENARIOS_SEEDED_KEY, JSON.stringify({ seededAt: now }), now],
    );
  }

  private migrateLegacySessionPrimaryKey(db: SqliteDatabase): void {
    const columns = this.getRows(db, 'PRAGMA table_info(cloud_chat_sessions)');
    if (columns.length === 0) {
      return;
    }

    const idColumn = columns.find((column) => column.name === 'id');
    const userIdColumn = columns.find((column) => column.name === 'user_id');
    const hasUserScopedPrimaryKey = Number(idColumn?.pk ?? 0) > 0 && Number(userIdColumn?.pk ?? 0) > 0;
    if (hasUserScopedPrimaryKey) {
      return;
    }

    const legacyTableName = `cloud_chat_sessions_legacy_${Date.now()}`;
    db.exec(`ALTER TABLE cloud_chat_sessions RENAME TO ${legacyTableName}`);
    db.exec(`
      CREATE TABLE cloud_chat_sessions (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        settings_json TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        is_pinned INTEGER NOT NULL,
        group_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (user_id, id)
      );
      INSERT OR REPLACE INTO cloud_chat_sessions (
        id, user_id, title, timestamp, settings_json, messages_json,
        is_pinned, group_id, created_at, updated_at, deleted_at
      )
      SELECT
        id, user_id, title, timestamp, settings_json, messages_json,
        is_pinned, group_id, created_at, updated_at, deleted_at
      FROM ${legacyTableName};
      DROP TABLE ${legacyTableName};
    `);
  }

  private getRows(
    db: SqliteDatabase,
    sql: string,
    params: SqliteValue[] | Record<string, SqliteValue> | null = null,
  ): Record<string, SqliteValue>[] {
    const results = db.exec(sql, params);
    return results.flatMap((result) =>
      result.values.map((valueRow) => rowToObject(result.columns, valueRow)),
    );
  }
}
