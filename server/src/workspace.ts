import { randomBytes, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { withSqliteFileLock } from './sqliteFileLock.js';

const scrypt = promisify(scryptCallback);
const nodeRequire = createRequire(import.meta.url);

type WorkspaceRole = 'admin' | 'member';
type UsageSource = 'credits' | 'allowance' | 'free' | 'admin' | 'order';
type UsageStatus = 'pending' | 'success' | 'refunded' | 'redeemed' | 'adjusted';
export type WorkspaceApiProvider = 'gemini' | 'openai' | 'anthropic';
export type UsageOperationType =
  | 'model_request'
  | 'image_generation'
  | 'live_token'
  | 'redeem'
  | 'invite_registration'
  | 'admin_adjustment'
  | 'order_recharge';
type WorkspaceRechargeOrderStatus = 'pending' | 'paid' | 'cancelled';
type WorkspacePaymentMethod = 'manual' | 'wechat' | 'alipay' | 'bank_transfer' | 'stripe' | 'other';

export interface WorkspaceApiProviderSetting {
  provider: WorkspaceApiProvider;
  apiKey: string | null;
  apiBase: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export type WorkspaceApiProviderSettings = Record<WorkspaceApiProvider, WorkspaceApiProviderSetting>;

export interface WorkspaceApiProviderSettingUpdate {
  apiKey?: string | null;
  apiBase?: string | null;
}

export interface WorkspaceUserSummary {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  credits: number;
  modelAllowances: Record<string, number>;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface WorkspaceUsageSummary {
  id: string;
  userId: string;
  userName: string;
  modelId: string;
  requestPath: string;
  operationType: UsageOperationType;
  source: UsageSource;
  status: UsageStatus;
  creditsDelta: number;
  allowancePattern: string | null;
  allowanceDelta: number;
  allowanceChanges: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  note: string | null;
}

export interface WorkspaceUsagePageResponse {
  items: WorkspaceUsageSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface WorkspaceUsageQuery {
  page?: number;
  pageSize?: number;
  userId?: string | null;
  status?: UsageStatus | 'all' | null;
  source?: UsageSource | 'all' | null;
  operationType?: UsageOperationType | 'all' | null;
  search?: string | null;
}

export interface WorkspaceModelPolicy {
  id: string;
  label: string;
  modelPattern: string;
  costCredits: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRedeemCodeSummary {
  id: string;
  code: string;
  description: string;
  credits: number;
  modelAllowances: Record<string, number>;
  maxRedemptions: number;
  redeemedCount: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface WorkspaceInviteCodeSummary {
  id: string;
  code: string;
  description: string;
  role: WorkspaceRole;
  credits: number;
  modelAllowances: Record<string, number>;
  maxRedemptions: number;
  redeemedCount: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface WorkspaceRechargeOrderSummary {
  id: string;
  orderNo: string;
  userId: string;
  userName: string;
  createdByUserId: string;
  createdByName: string;
  confirmedByUserId: string | null;
  confirmedByName: string | null;
  status: WorkspaceRechargeOrderStatus;
  paymentMethod: WorkspacePaymentMethod;
  amountCents: number;
  currency: string;
  credits: number;
  modelAllowances: Record<string, number>;
  externalReference: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
}

interface WorkspaceBootstrapStatus {
  bootstrapped: boolean;
  workspaceName: string;
}

interface WorkspaceSessionResponse extends WorkspaceBootstrapStatus {
  currentUser: WorkspaceUserSummary | null;
}

interface WorkspaceDashboardResponse extends WorkspaceSessionResponse {
  policies: WorkspaceModelPolicy[];
  recentUsage: WorkspaceUsageSummary[];
  recentRechargeOrders: WorkspaceRechargeOrderSummary[];
}

interface WorkspaceAdminStateResponse extends WorkspaceDashboardResponse {
  users: WorkspaceUserSummary[];
  redeemCodes: WorkspaceRedeemCodeSummary[];
  inviteCodes: WorkspaceInviteCodeSummary[];
  recentWorkspaceUsage: WorkspaceUsageSummary[];
  rechargeOrders: WorkspaceRechargeOrderSummary[];
}

export interface WorkspaceStorageFileSnapshot {
  filePath: string | null;
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  error?: string;
}

export interface WorkspaceAdminDiagnosticsResponse extends WorkspaceSessionResponse {
  currentUser: WorkspaceUserSummary;
  generatedAt: string;
  storage: {
    type: 'sqlite';
    database: WorkspaceStorageFileSnapshot;
    legacyJson: WorkspaceStorageFileSnapshot;
    sessionTtlHours: number;
  };
  counts: {
    users: number;
    admins: number;
    members: number;
    disabledUsers: number;
    activeSessions: number;
    modelPolicies: number;
    redeemCodes: number;
    activeRedeemCodes: number;
    redemptions: number;
    inviteCodes: number;
    activeInviteCodes: number;
    inviteRegistrations: number;
    rechargeOrders: number;
    pendingRechargeOrders: number;
    paidRechargeOrders: number;
    cancelledRechargeOrders: number;
    usageRecords: number;
    pendingUsageRecords: number;
    refundedUsageRecords: number;
  };
}

export interface WorkspaceAdminBackupExport {
  kind: 'arong-workspace-backup';
  schemaVersion: 1;
  exportedAt: string;
  workspaceName: string;
  containsSensitiveAuthData: true;
  sessionsExported: false;
  notes: string[];
  data: WorkspaceState;
}

export interface WorkspaceServiceConfig {
  databaseFilePath: string;
  legacyJsonFilePath?: string;
  sessionTtlHours: number;
  storage?: WorkspaceStateStorage;
}

export interface WorkspaceState {
  workspace: {
    name: string;
    createdAt: string;
  };
  apiSettings: WorkspaceApiProviderSettings;
  users: WorkspaceUserRecord[];
  sessions: WorkspaceSessionRecord[];
  modelPolicies: WorkspaceModelPolicy[];
  redeemCodes: WorkspaceRedeemCodeRecord[];
  redemptions: WorkspaceRedemptionRecord[];
  inviteCodes: WorkspaceInviteCodeRecord[];
  inviteRedemptions: WorkspaceInviteRedemptionRecord[];
  rechargeOrders: WorkspaceRechargeOrderRecord[];
  usageRecords: WorkspaceUsageRecord[];
}

export interface WorkspaceStateStorage {
  readState(): Promise<Partial<WorkspaceState> | null>;
  writeState(state: WorkspaceState): Promise<void>;
  mutateState?<T>(
    createDefaultState: () => WorkspaceState,
    normalizeState: (input: Partial<WorkspaceState>) => WorkspaceState,
    mutation: (state: WorkspaceState) => Promise<T> | T,
  ): Promise<T>;
}

interface WorkspaceUserRecord {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  passwordHash: string;
  passwordSalt: string;
  credits: number;
  modelAllowances: Record<string, number>;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface WorkspaceSessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface WorkspaceRedeemCodeRecord {
  id: string;
  code: string;
  description: string;
  credits: number;
  modelAllowances: Record<string, number>;
  maxRedemptions: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
}

interface WorkspaceRedemptionRecord {
  id: string;
  codeId: string;
  userId: string;
  createdAt: string;
}

interface WorkspaceInviteCodeRecord {
  id: string;
  code: string;
  description: string;
  role: WorkspaceRole;
  credits: number;
  modelAllowances: Record<string, number>;
  maxRedemptions: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
}

interface WorkspaceInviteRedemptionRecord {
  id: string;
  inviteCodeId: string;
  userId: string;
  createdAt: string;
}

interface WorkspaceRechargeOrderRecord {
  id: string;
  orderNo: string;
  userId: string;
  createdByUserId: string;
  confirmedByUserId: string | null;
  status: WorkspaceRechargeOrderStatus;
  paymentMethod: WorkspacePaymentMethod;
  amountCents: number;
  currency: string;
  credits: number;
  modelAllowances: Record<string, number>;
  externalReference: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
}

interface WorkspaceUsageRecord {
  id: string;
  userId: string;
  modelId: string;
  requestPath: string;
  operationType: UsageOperationType;
  source: UsageSource;
  status: UsageStatus;
  creditsDelta: number;
  allowancePattern: string | null;
  allowanceDelta: number;
  allowanceChanges: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  note: string | null;
}

interface UserAuthResult {
  user: WorkspaceUserRecord;
  sessionToken: string;
}

interface ReserveUsageResult {
  bootstrapped: boolean;
  usageRecordId: string | null;
  currentUser: WorkspaceUserSummary | null;
}

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

export class WorkspaceError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.statusCode = statusCode;
  }
}

const DEFAULT_WORKSPACE_NAME = '阿荣AI工作站';
const SESSION_COOKIE_NAME = 'arong_workspace_session';
const MAX_USAGE_RECORDS = 5000;
const MAX_REDEMPTION_RECORDS = 1000;
const MAX_INVITE_REDEMPTION_RECORDS = 1000;
const MAX_RECHARGE_ORDERS = 1000;
const DEFAULT_USAGE_PAGE_SIZE = 50;
const MAX_USAGE_PAGE_SIZE = 200;
const API_PROVIDERS: WorkspaceApiProvider[] = ['gemini', 'openai', 'anthropic'];
const SUPPORTED_OPENAI_IMAGE_MODEL_IDS = ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2'] as const;

const DEFAULT_MODEL_POLICIES: WorkspaceModelPolicy[] = [
  createPolicy('GPT Chat Family', 'gpt-*', 8, 'OpenAI-compatible GPT 文本对话'),
  createPolicy('OpenAI Reasoning Family', 'o*', 12, 'OpenAI-compatible 推理模型'),
  createPolicy('DeepSeek Chat Family', 'deepseek-*', 6, 'DeepSeek / 兼容网关文本对话'),
  createPolicy('Qwen Chat Family', 'qwen-*', 6, '通义千问 / 兼容网关文本对话'),
  createPolicy('Claude Compatible Family', 'claude-*', 8, 'Claude / Anthropic-compatible 文本对话'),
  createPolicy('Kimi Compatible Family', 'kimi-*', 6, 'Kimi / 兼容网关文本对话'),
  createPolicy('Moonshot Compatible Family', 'moonshot-*', 6, 'Moonshot / 兼容网关文本对话'),
  createPolicy('GLM Compatible Family', 'glm-*', 6, '智谱 GLM / 兼容网关文本对话'),
  createPolicy('Gemini 3.1 Flash Image', 'gemini-3.1-flash-image-preview', 25, '图像对话与编辑'),
  createPolicy('Gemini 2.5 Flash Image', 'gemini-2.5-flash-image*', 20, '轻量级图像生成'),
  createPolicy('Imagen 4 Fast', 'imagen-4.0-fast-generate-001', 35, '快速出图'),
  createPolicy('Imagen 4 Standard', 'imagen-4.0-generate-001', 60, '标准出图'),
  createPolicy('Imagen 4 Ultra', 'imagen-4.0-ultra-generate-001', 120, '高质量出图'),
  ...SUPPORTED_OPENAI_IMAGE_MODEL_IDS.map((modelId) =>
    createPolicy(modelId, modelId, 80, 'OpenAI-compatible GPT 图像生成'),
  ),
  createPolicy('Default Model Request', '*', 1, '未单独配置策略的模型请求'),
];

function createPolicy(
  label: string,
  modelPattern: string,
  costCredits: number,
  description: string,
): WorkspaceModelPolicy {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    label,
    modelPattern,
    costCredits,
    description,
    createdAt: now,
    updatedAt: now,
  };
}

function createDefaultWorkspaceState(): WorkspaceState {
  return {
    workspace: {
      name: DEFAULT_WORKSPACE_NAME,
      createdAt: new Date().toISOString(),
    },
    apiSettings: createDefaultApiProviderSettings(),
    users: [],
    sessions: [],
    modelPolicies: DEFAULT_MODEL_POLICIES.map((policy) => ({ ...policy })),
    redeemCodes: [],
    redemptions: [],
    inviteCodes: [],
    inviteRedemptions: [],
    rechargeOrders: [],
    usageRecords: [],
  };
}

function createDefaultApiProviderSettings(): WorkspaceApiProviderSettings {
  return Object.fromEntries(
    API_PROVIDERS.map((provider) => [
      provider,
      {
        provider,
        apiKey: null,
        apiBase: null,
        updatedAt: null,
        updatedByUserId: null,
      },
    ]),
  ) as WorkspaceApiProviderSettings;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeApiProvider(value: unknown): WorkspaceApiProvider | null {
  return value === 'gemini' || value === 'openai' || value === 'anthropic' ? value : null;
}

function normalizeApiProviderSettings(value: unknown): WorkspaceApiProviderSettings {
  const defaults = createDefaultApiProviderSettings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults;
  }

  for (const provider of API_PROVIDERS) {
    const rawSetting = (value as Partial<Record<WorkspaceApiProvider, Partial<WorkspaceApiProviderSetting>>>)[provider];
    if (!rawSetting || typeof rawSetting !== 'object') {
      continue;
    }

    defaults[provider] = {
      provider,
      apiKey: normalizeOptionalText(rawSetting.apiKey),
      apiBase: normalizeOptionalText(rawSetting.apiBase),
      updatedAt: normalizeOptionalText(rawSetting.updatedAt),
      updatedByUserId: normalizeOptionalText(rawSetting.updatedByUserId),
    };
  }

  return defaults;
}

function normalizePositiveInteger(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeModelPolicy(policy: Partial<WorkspaceModelPolicy>): WorkspaceModelPolicy {
  const now = new Date().toISOString();
  return {
    id: policy.id || randomUUID(),
    label: policy.label || '未命名策略',
    modelPattern: policy.modelPattern || '*',
    costCredits: normalizePositiveInteger(policy.costCredits, 0),
    description: normalizeOptionalText(policy.description),
    createdAt: policy.createdAt || now,
    updatedAt: policy.updatedAt || now,
  };
}

function createSupportedOpenAiImagePoliciesFromLegacy(policy: WorkspaceModelPolicy): WorkspaceModelPolicy[] {
  const now = new Date().toISOString();
  return SUPPORTED_OPENAI_IMAGE_MODEL_IDS.map((modelId) => ({
    ...policy,
    id: `${policy.id}-${modelId}`,
    label: modelId,
    modelPattern: modelId,
    description: policy.description || 'OpenAI-compatible GPT 图像生成',
    updatedAt: now,
  }));
}

function normalizeModelPolicies(value: unknown, defaultPolicies: WorkspaceModelPolicy[]): WorkspaceModelPolicy[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaultPolicies;
  }

  const policies: WorkspaceModelPolicy[] = [];
  for (const rawPolicy of value) {
    const policy = normalizeModelPolicy(rawPolicy as Partial<WorkspaceModelPolicy>);
    const label = policy.label.trim().toLowerCase();
    const modelPattern = policy.modelPattern.trim().toLowerCase();

    if (label === 'dall-e image family' && modelPattern === 'dall-e-*') {
      continue;
    }

    if (label === 'gpt image family' && modelPattern === 'gpt-image-*') {
      policies.push(...createSupportedOpenAiImagePoliciesFromLegacy(policy));
      continue;
    }

    policies.push(policy);
  }

  return policies.length > 0 ? policies : defaultPolicies;
}

function normalizeSignedInteger(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function normalizeModelAllowances(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }

    const normalizedValue = normalizePositiveInteger(rawValue, 0);
    if (normalizedValue > 0) {
      result[trimmedKey] = normalizedValue;
    }
  }

  return result;
}

function normalizeModelAllowanceDeltas(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }

    const normalizedValue = normalizeSignedInteger(rawValue, 0);
    if (normalizedValue !== 0) {
      result[trimmedKey] = normalizedValue;
    }
  }

  return result;
}

function mergeAllowances(
  current: Record<string, number>,
  incoming: Record<string, number>,
): Record<string, number> {
  const next = { ...current };
  for (const [pattern, amount] of Object.entries(incoming)) {
    next[pattern] = Math.max((next[pattern] ?? 0) + amount, 0);
    if (next[pattern] === 0) {
      delete next[pattern];
    }
  }
  return next;
}

function sanitizeCode(rawCode: string): string {
  return rawCode.trim().toUpperCase().replace(/\s+/g, '-');
}

function maskNote(note: string | null): string | null {
  return note && note.trim() ? note.trim() : null;
}

function normalizeCurrency(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return normalized || 'CNY';
}

function normalizePaymentMethod(value: unknown): WorkspacePaymentMethod {
  if (
    value === 'manual'
    || value === 'wechat'
    || value === 'alipay'
    || value === 'bank_transfer'
    || value === 'stripe'
    || value === 'other'
  ) {
    return value;
  }

  return 'manual';
}

function normalizeRechargeOrderStatus(value: unknown): WorkspaceRechargeOrderStatus {
  if (value === 'pending' || value === 'paid' || value === 'cancelled') {
    return value;
  }

  return 'pending';
}

function createOrderNo(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `AR${timestamp}${randomBytes(3).toString('hex').toUpperCase()}`;
}

function normalizeOperationType(value: unknown): UsageOperationType {
  if (
    value === 'model_request'
    || value === 'image_generation'
    || value === 'live_token'
    || value === 'redeem'
    || value === 'invite_registration'
    || value === 'admin_adjustment'
    || value === 'order_recharge'
  ) {
    return value;
  }

  return 'model_request';
}

function normalizeUsageSource(value: unknown): UsageSource {
  if (
    value === 'credits'
    || value === 'allowance'
    || value === 'free'
    || value === 'admin'
    || value === 'order'
  ) {
    return value;
  }

  return 'free';
}

function normalizeUsageStatus(value: unknown): UsageStatus {
  if (
    value === 'pending'
    || value === 'success'
    || value === 'refunded'
    || value === 'redeemed'
    || value === 'adjusted'
  ) {
    return value;
  }

  return 'success';
}

function escapeCsvValue(value: unknown): string {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toUserSummary(user: WorkspaceUserRecord): WorkspaceUserSummary {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    credits: user.credits,
    modelAllowances: { ...user.modelAllowances },
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function toUsageSummary(record: WorkspaceUsageRecord, userName: string): WorkspaceUsageSummary {
  return {
    ...record,
    userName,
    operationType: record.operationType ?? 'model_request',
    allowanceChanges: { ...(record.allowanceChanges ?? {}) },
  };
}

function toInviteCodeSummary(
  code: WorkspaceInviteCodeRecord,
  redemptions: WorkspaceInviteRedemptionRecord[],
): WorkspaceInviteCodeSummary {
  return {
    id: code.id,
    code: code.code,
    description: code.description,
    role: code.role,
    credits: code.credits,
    modelAllowances: { ...code.modelAllowances },
    maxRedemptions: code.maxRedemptions,
    redeemedCount: redemptions.filter((item) => item.inviteCodeId === code.id).length,
    active: code.active,
    expiresAt: code.expiresAt,
    createdAt: code.createdAt,
  };
}

function toRechargeOrderSummary(
  order: WorkspaceRechargeOrderRecord,
  users: WorkspaceUserRecord[],
): WorkspaceRechargeOrderSummary {
  const targetUser = users.find((user) => user.id === order.userId);
  const creator = users.find((user) => user.id === order.createdByUserId);
  const confirmer = order.confirmedByUserId
    ? users.find((user) => user.id === order.confirmedByUserId)
    : null;

  return {
    ...order,
    userName: targetUser?.name ?? 'Unknown',
    createdByName: creator?.name ?? 'Unknown',
    confirmedByName: confirmer?.name ?? null,
    modelAllowances: { ...order.modelAllowances },
  };
}

function matchesModelPattern(modelId: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return modelId.startsWith(pattern.slice(0, -1));
  }
  return modelId === pattern;
}

function getPolicySortScore(policy: WorkspaceModelPolicy): number {
  return policy.modelPattern.endsWith('*') ? policy.modelPattern.length - 1 : policy.modelPattern.length + 1000;
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) {
          return [part, ''];
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      }),
  );
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const hashBuffer = (await scrypt(password, salt, 64)) as Buffer;
  return hashBuffer.toString('hex');
}

async function verifyPassword(password: string, passwordHash: string, salt: string): Promise<boolean> {
  const actual = Buffer.from(passwordHash, 'hex');
  const expected = (await scrypt(password, salt, actual.length)) as Buffer;
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export class SqliteWorkspaceStateStorage implements WorkspaceStateStorage {
  private readonly databaseFilePath: string;
  private readonly legacyJsonFilePath: string | null;
  private sqliteModulePromise: Promise<SqliteModule> | null = null;

  constructor(databaseFilePath: string, legacyJsonFilePath?: string | null) {
    this.databaseFilePath = databaseFilePath;
    this.legacyJsonFilePath = legacyJsonFilePath ?? null;
  }

  async readState(): Promise<Partial<WorkspaceState> | null> {
    const db = await this.openDatabase();
    try {
      this.ensureSchema(db);
      const workspaceRows = this.getRows(db, 'SELECT name, created_at FROM workspace_meta WHERE id = 1 LIMIT 1');
      if (workspaceRows.length > 0) {
        return this.readStructuredState(db, workspaceRows[0]);
      }
    } finally {
      db.close();
    }

    const legacyState = await this.readLegacyJsonState();
    if (legacyState) {
      await this.writeState(normalizeWorkspaceState(legacyState));
      return legacyState;
    }

    return null;
  }

  async writeState(state: WorkspaceState): Promise<void> {
    await mkdir(path.dirname(this.databaseFilePath), { recursive: true });
    const db = await this.openDatabase();
    try {
      this.ensureSchema(db);
      this.replaceStructuredState(db, state);
      await writeFile(this.databaseFilePath, Buffer.from(db.export()));
    } finally {
      db.close();
    }
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_settings (
        provider TEXT PRIMARY KEY,
        api_key TEXT,
        api_base TEXT,
        updated_at TEXT,
        updated_by_user_id TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        credits INTEGER NOT NULL,
        model_allowances_json TEXT NOT NULL,
        disabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_policies (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        model_pattern TEXT NOT NULL,
        cost_credits INTEGER NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS redeem_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        credits INTEGER NOT NULL,
        model_allowances_json TEXT NOT NULL,
        max_redemptions INTEGER NOT NULL,
        active INTEGER NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS redemptions (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        role TEXT NOT NULL,
        credits INTEGER NOT NULL,
        model_allowances_json TEXT NOT NULL,
        max_redemptions INTEGER NOT NULL,
        active INTEGER NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_redemptions (
        id TEXT PRIMARY KEY,
        invite_code_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recharge_orders (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        confirmed_by_user_id TEXT,
        status TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        credits INTEGER NOT NULL,
        model_allowances_json TEXT NOT NULL,
        external_reference TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paid_at TEXT,
        cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        request_path TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        credits_delta INTEGER NOT NULL,
        allowance_pattern TEXT,
        allowance_delta INTEGER NOT NULL,
        allowance_changes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_records_user_created ON usage_records (user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created ON recharge_orders (user_id, created_at);
    `);
  }

  private readStructuredState(
    db: SqliteDatabase,
    workspaceRow: Record<string, SqliteValue>,
  ): Partial<WorkspaceState> {
    return {
      workspace: {
        name: String(workspaceRow.name ?? ''),
        createdAt: String(workspaceRow.created_at ?? ''),
      },
      apiSettings: this.readApiProviderSettings(db),
      users: this.getRows(db, 'SELECT * FROM users ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        email: String(row.email ?? ''),
        role: row.role === 'admin' ? 'admin' : 'member',
        passwordHash: String(row.password_hash ?? ''),
        passwordSalt: String(row.password_salt ?? ''),
        credits: Number(row.credits ?? 0),
        modelAllowances: this.parseJsonRecord(row.model_allowances_json),
        disabled: Number(row.disabled ?? 0) === 1,
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        lastLoginAt: typeof row.last_login_at === 'string' ? row.last_login_at : null,
      })),
      sessions: this.getRows(db, 'SELECT * FROM sessions ORDER BY created_at, token').map((row) => ({
        token: String(row.token ?? ''),
        userId: String(row.user_id ?? ''),
        createdAt: String(row.created_at ?? ''),
        expiresAt: String(row.expires_at ?? ''),
      })),
      modelPolicies: this.getRows(db, 'SELECT * FROM model_policies ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        label: String(row.label ?? ''),
        modelPattern: String(row.model_pattern ?? ''),
        costCredits: Number(row.cost_credits ?? 0),
        description: typeof row.description === 'string' ? row.description : null,
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
      })),
      redeemCodes: this.getRows(db, 'SELECT * FROM redeem_codes ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        code: String(row.code ?? ''),
        description: String(row.description ?? ''),
        credits: Number(row.credits ?? 0),
        modelAllowances: this.parseJsonRecord(row.model_allowances_json),
        maxRedemptions: Number(row.max_redemptions ?? 1),
        active: Number(row.active ?? 1) === 1,
        expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
        createdAt: String(row.created_at ?? ''),
      })),
      redemptions: this.getRows(db, 'SELECT * FROM redemptions ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        codeId: String(row.code_id ?? ''),
        userId: String(row.user_id ?? ''),
        createdAt: String(row.created_at ?? ''),
      })),
      inviteCodes: this.getRows(db, 'SELECT * FROM invite_codes ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        code: String(row.code ?? ''),
        description: String(row.description ?? ''),
        role: row.role === 'admin' ? 'admin' : 'member',
        credits: Number(row.credits ?? 0),
        modelAllowances: this.parseJsonRecord(row.model_allowances_json),
        maxRedemptions: Number(row.max_redemptions ?? 1),
        active: Number(row.active ?? 1) === 1,
        expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
        createdAt: String(row.created_at ?? ''),
      })),
      inviteRedemptions: this.getRows(db, 'SELECT * FROM invite_redemptions ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        inviteCodeId: String(row.invite_code_id ?? ''),
        userId: String(row.user_id ?? ''),
        createdAt: String(row.created_at ?? ''),
      })),
      rechargeOrders: this.getRows(db, 'SELECT * FROM recharge_orders ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        orderNo: String(row.order_no ?? ''),
        userId: String(row.user_id ?? ''),
        createdByUserId: String(row.created_by_user_id ?? ''),
        confirmedByUserId: typeof row.confirmed_by_user_id === 'string' ? row.confirmed_by_user_id : null,
        status: normalizeRechargeOrderStatus(row.status),
        paymentMethod: normalizePaymentMethod(row.payment_method),
        amountCents: Number(row.amount_cents ?? 0),
        currency: String(row.currency ?? 'CNY'),
        credits: Number(row.credits ?? 0),
        modelAllowances: this.parseJsonRecord(row.model_allowances_json),
        externalReference: typeof row.external_reference === 'string' ? row.external_reference : null,
        note: typeof row.note === 'string' ? row.note : null,
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        paidAt: typeof row.paid_at === 'string' ? row.paid_at : null,
        cancelledAt: typeof row.cancelled_at === 'string' ? row.cancelled_at : null,
      })),
      usageRecords: this.getRows(db, 'SELECT * FROM usage_records ORDER BY created_at, id').map((row) => ({
        id: String(row.id ?? ''),
        userId: String(row.user_id ?? ''),
        modelId: String(row.model_id ?? ''),
        requestPath: String(row.request_path ?? ''),
        operationType: normalizeOperationType(row.operation_type),
        source: normalizeUsageSource(row.source),
        status: normalizeUsageStatus(row.status),
        creditsDelta: Number(row.credits_delta ?? 0),
        allowancePattern: typeof row.allowance_pattern === 'string' ? row.allowance_pattern : null,
        allowanceDelta: Number(row.allowance_delta ?? 0),
        allowanceChanges: this.parseJsonRecord(row.allowance_changes_json),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        note: typeof row.note === 'string' ? row.note : null,
      })),
    };
  }

  private readApiProviderSettings(db: SqliteDatabase): WorkspaceApiProviderSettings {
    const settings = createDefaultApiProviderSettings();
    this.getRows(db, 'SELECT * FROM api_settings ORDER BY provider').forEach((row) => {
      const provider = normalizeApiProvider(row.provider);
      if (!provider) {
        return;
      }

      settings[provider] = {
        provider,
        apiKey: normalizeOptionalText(row.api_key),
        apiBase: normalizeOptionalText(row.api_base),
        updatedAt: normalizeOptionalText(row.updated_at),
        updatedByUserId: normalizeOptionalText(row.updated_by_user_id),
      };
    });

    return settings;
  }

  private replaceStructuredState(db: SqliteDatabase, state: WorkspaceState): void {
    db.exec('BEGIN TRANSACTION');
    try {
      [
        'usage_records',
        'recharge_orders',
        'invite_redemptions',
        'invite_codes',
        'redemptions',
        'redeem_codes',
        'model_policies',
        'sessions',
        'users',
        'api_settings',
        'workspace_meta',
      ].forEach((tableName) => {
        db.exec(`DELETE FROM ${tableName}`);
      });

      db.exec('INSERT INTO workspace_meta (id, name, created_at) VALUES (1, ?, ?)', [
        state.workspace.name,
        state.workspace.createdAt,
      ]);
      API_PROVIDERS.forEach((provider) => {
        const setting = state.apiSettings[provider] ?? createDefaultApiProviderSettings()[provider];
        db.exec(
          `INSERT INTO api_settings (
            provider, api_key, api_base, updated_at, updated_by_user_id
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            provider,
            setting.apiKey,
            setting.apiBase,
            setting.updatedAt,
            setting.updatedByUserId,
          ],
        );
      });
      state.users.forEach((user) => {
        db.exec(
          `INSERT INTO users (
            id, name, email, role, password_hash, password_salt, credits, model_allowances_json,
            disabled, created_at, updated_at, last_login_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            user.id,
            user.name,
            user.email,
            user.role,
            user.passwordHash,
            user.passwordSalt,
            user.credits,
            JSON.stringify(user.modelAllowances),
            user.disabled ? 1 : 0,
            user.createdAt,
            user.updatedAt,
            user.lastLoginAt,
          ],
        );
      });
      state.sessions.forEach((session) => {
        db.exec('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
          session.token,
          session.userId,
          session.createdAt,
          session.expiresAt,
        ]);
      });
      state.modelPolicies.forEach((policy) => {
        db.exec(
          `INSERT INTO model_policies (
            id, label, model_pattern, cost_credits, description, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            policy.id,
            policy.label,
            policy.modelPattern,
            policy.costCredits,
            policy.description,
            policy.createdAt,
            policy.updatedAt,
          ],
        );
      });
      state.redeemCodes.forEach((code) => {
        db.exec(
          `INSERT INTO redeem_codes (
            id, code, description, credits, model_allowances_json, max_redemptions,
            active, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code.id,
            code.code,
            code.description,
            code.credits,
            JSON.stringify(code.modelAllowances),
            code.maxRedemptions,
            code.active ? 1 : 0,
            code.expiresAt,
            code.createdAt,
          ],
        );
      });
      state.redemptions.forEach((redemption) => {
        db.exec('INSERT INTO redemptions (id, code_id, user_id, created_at) VALUES (?, ?, ?, ?)', [
          redemption.id,
          redemption.codeId,
          redemption.userId,
          redemption.createdAt,
        ]);
      });
      state.inviteCodes.forEach((code) => {
        db.exec(
          `INSERT INTO invite_codes (
            id, code, description, role, credits, model_allowances_json, max_redemptions,
            active, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code.id,
            code.code,
            code.description,
            code.role,
            code.credits,
            JSON.stringify(code.modelAllowances),
            code.maxRedemptions,
            code.active ? 1 : 0,
            code.expiresAt,
            code.createdAt,
          ],
        );
      });
      state.inviteRedemptions.forEach((redemption) => {
        db.exec(
          'INSERT INTO invite_redemptions (id, invite_code_id, user_id, created_at) VALUES (?, ?, ?, ?)',
          [
            redemption.id,
            redemption.inviteCodeId,
            redemption.userId,
            redemption.createdAt,
          ],
        );
      });
      state.rechargeOrders.forEach((order) => {
        db.exec(
          `INSERT INTO recharge_orders (
            id, order_no, user_id, created_by_user_id, confirmed_by_user_id, status,
            payment_method, amount_cents, currency, credits, model_allowances_json,
            external_reference, note, created_at, updated_at, paid_at, cancelled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            order.id,
            order.orderNo,
            order.userId,
            order.createdByUserId,
            order.confirmedByUserId,
            order.status,
            order.paymentMethod,
            order.amountCents,
            order.currency,
            order.credits,
            JSON.stringify(order.modelAllowances),
            order.externalReference,
            order.note,
            order.createdAt,
            order.updatedAt,
            order.paidAt,
            order.cancelledAt,
          ],
        );
      });
      state.usageRecords.forEach((record) => {
        db.exec(
          `INSERT INTO usage_records (
            id, user_id, model_id, request_path, operation_type, source, status, credits_delta,
            allowance_pattern, allowance_delta, allowance_changes_json, created_at, updated_at, note
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.userId,
            record.modelId,
            record.requestPath,
            record.operationType,
            record.source,
            record.status,
            record.creditsDelta,
            record.allowancePattern,
            record.allowanceDelta,
            JSON.stringify(record.allowanceChanges),
            record.createdAt,
            record.updatedAt,
            record.note,
          ],
        );
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private getRows(db: SqliteDatabase, sql: string): Array<Record<string, SqliteValue>> {
    const result = db.exec(sql)[0];
    if (!result) {
      return [];
    }
    return result.values.map((values) => Object.fromEntries(
      result.columns.map((column, index) => [column, values[index] ?? null]),
    ));
  }

  private parseJsonRecord(value: unknown): Record<string, number> {
    if (typeof value !== 'string') {
      return {};
    }
    try {
      return normalizeModelAllowanceDeltas(JSON.parse(value));
    } catch {
      return {};
    }
  }

  private async readLegacyJsonState(): Promise<Partial<WorkspaceState> | null> {
    if (!this.legacyJsonFilePath) {
      return null;
    }

    try {
      const fileContents = await readFile(this.legacyJsonFilePath, 'utf8');
      return JSON.parse(fileContents) as Partial<WorkspaceState>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

export function normalizeWorkspaceState(input: Partial<WorkspaceState>): WorkspaceState {
  const defaultState = createDefaultWorkspaceState();
  return {
    workspace: {
      name: input.workspace?.name?.trim() || defaultState.workspace.name,
      createdAt: input.workspace?.createdAt || defaultState.workspace.createdAt,
    },
    apiSettings: normalizeApiProviderSettings(input.apiSettings),
    users: Array.isArray(input.users) ? input.users.map((user) => ({
      ...user,
      credits: normalizePositiveInteger(user.credits, 0),
      modelAllowances: normalizeModelAllowances(user.modelAllowances),
      disabled: !!user.disabled,
      lastLoginAt: user.lastLoginAt ?? null,
    })) : [],
    sessions: Array.isArray(input.sessions) ? input.sessions : [],
    modelPolicies: normalizeModelPolicies(input.modelPolicies, defaultState.modelPolicies),
    redeemCodes: Array.isArray(input.redeemCodes)
      ? input.redeemCodes.map((code) => ({
        ...code,
        credits: normalizePositiveInteger(code.credits, 0),
        modelAllowances: normalizeModelAllowances(code.modelAllowances),
        maxRedemptions: Math.max(normalizePositiveInteger(code.maxRedemptions, 1), 1),
        active: code.active !== false,
        expiresAt: code.expiresAt ?? null,
      }))
      : [],
    redemptions: Array.isArray(input.redemptions) ? input.redemptions : [],
    inviteCodes: Array.isArray(input.inviteCodes)
      ? input.inviteCodes.map((code) => ({
        ...code,
        role: code.role === 'admin' ? 'admin' : 'member',
        credits: normalizePositiveInteger(code.credits, 0),
        modelAllowances: normalizeModelAllowances(code.modelAllowances),
        maxRedemptions: Math.max(normalizePositiveInteger(code.maxRedemptions, 1), 1),
        active: code.active !== false,
        expiresAt: code.expiresAt ?? null,
      }))
      : [],
    inviteRedemptions: Array.isArray(input.inviteRedemptions)
      ? input.inviteRedemptions.slice(-MAX_INVITE_REDEMPTION_RECORDS)
      : [],
    rechargeOrders: Array.isArray(input.rechargeOrders)
      ? input.rechargeOrders.slice(-MAX_RECHARGE_ORDERS).map((order) => ({
        ...order,
        orderNo: order.orderNo || createOrderNo(),
        confirmedByUserId: order.confirmedByUserId ?? null,
        status: normalizeRechargeOrderStatus(order.status),
        paymentMethod: normalizePaymentMethod(order.paymentMethod),
        amountCents: normalizePositiveInteger(order.amountCents, 0),
        currency: normalizeCurrency(order.currency),
        credits: normalizePositiveInteger(order.credits, 0),
        modelAllowances: normalizeModelAllowances(order.modelAllowances),
        externalReference: normalizeOptionalText(order.externalReference),
        note: normalizeOptionalText(order.note),
        paidAt: order.paidAt ?? null,
        cancelledAt: order.cancelledAt ?? null,
      }))
      : [],
    usageRecords: Array.isArray(input.usageRecords)
      ? input.usageRecords.slice(-MAX_USAGE_RECORDS).map((record) => ({
        ...record,
        operationType: normalizeOperationType(record.operationType),
        source: normalizeUsageSource(record.source),
        status: normalizeUsageStatus(record.status),
        creditsDelta: normalizeSignedInteger(record.creditsDelta, 0),
        allowancePattern: record.allowancePattern ?? null,
        allowanceDelta: normalizeSignedInteger(record.allowanceDelta, 0),
        allowanceChanges: normalizeModelAllowanceDeltas(
          record.allowanceChanges
          ?? (record.allowancePattern && record.allowanceDelta
            ? { [record.allowancePattern]: record.allowanceDelta }
            : {}),
        ),
        note: record.note ?? null,
      }))
      : [],
  };
}

export class WorkspaceService {
  private readonly storage: WorkspaceStateStorage;
  private readonly databaseFilePath: string;
  private readonly legacyJsonFilePath: string | null;
  private readonly sessionTtlHours: number;
  private readonly sessionTtlMs: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(config: WorkspaceServiceConfig) {
    const databaseFilePath = path.resolve(process.cwd(), config.databaseFilePath);
    const legacyJsonFilePath = config.legacyJsonFilePath
      ? path.resolve(process.cwd(), config.legacyJsonFilePath)
      : undefined;
    this.databaseFilePath = databaseFilePath;
    this.legacyJsonFilePath = legacyJsonFilePath ?? null;
    this.sessionTtlHours = config.sessionTtlHours;
    this.storage = config.storage ?? new SqliteWorkspaceStateStorage(databaseFilePath, legacyJsonFilePath);
    this.sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1000;
  }

  getSessionCookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  buildSessionCookie(token: string): string {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
      this.sessionTtlMs / 1000,
    )}`;
  }

  buildExpiredSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
  }

  getSessionTokenFromCookieHeader(cookieHeader: string | undefined): string | null {
    const cookies = parseCookieHeader(cookieHeader);
    return cookies[SESSION_COOKIE_NAME] ?? null;
  }

  async getBootstrapStatus(): Promise<WorkspaceBootstrapStatus> {
    const state = await this.readState();
    return {
      bootstrapped: state.users.length > 0,
      workspaceName: state.workspace.name,
    };
  }

  async bootstrapAdmin(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<WorkspaceSessionResponse & { sessionToken: string }> {
    return this.mutate(async (state) => {
      if (state.users.length > 0) {
        throw new WorkspaceError(409, '工作站已初始化，请直接登录。');
      }

      const authResult = await this.createUserAndSession(state, {
        ...input,
        role: 'admin',
        credits: 500,
        modelAllowances: {},
      });

      return {
        bootstrapped: true,
        workspaceName: state.workspace.name,
        currentUser: toUserSummary(authResult.user),
        sessionToken: authResult.sessionToken,
      };
    });
  }

  async login(input: {
    email: string;
    password: string;
  }): Promise<WorkspaceSessionResponse & { sessionToken: string }> {
    return this.mutate(async (state) => {
      if (state.users.length === 0) {
        throw new WorkspaceError(409, '工作站还未初始化，请先创建管理员账号。');
      }

      const email = normalizeEmail(input.email);
      const password = input.password.trim();
      if (!email || !password) {
        throw new WorkspaceError(400, '请输入邮箱和密码。');
      }

      const user = state.users.find((candidate) => candidate.email === email);
      if (!user) {
        throw new WorkspaceError(401, '账号或密码错误。');
      }

      if (user.disabled) {
        throw new WorkspaceError(403, '该账号已被停用，请联系管理员。');
      }

      const isValidPassword = await verifyPassword(password, user.passwordHash, user.passwordSalt);
      if (!isValidPassword) {
        throw new WorkspaceError(401, '账号或密码错误。');
      }

      const sessionToken = randomBytes(32).toString('hex');
      const now = new Date().toISOString();
      state.sessions = this.pruneSessions(state.sessions).concat({
        token: sessionToken,
        userId: user.id,
        createdAt: now,
        expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      });
      user.lastLoginAt = now;
      user.updatedAt = now;

      return {
        bootstrapped: true,
        workspaceName: state.workspace.name,
        currentUser: toUserSummary(user),
        sessionToken,
      };
    });
  }

  async registerWithInvite(input: {
    name: string;
    email: string;
    password: string;
    inviteCode: string;
  }): Promise<WorkspaceSessionResponse & { sessionToken: string }> {
    return this.mutate(async (state) => {
      if (state.users.length === 0) {
        throw new WorkspaceError(409, '工作站还未初始化，请先创建管理员账号。');
      }

      const normalizedCode = sanitizeCode(input.inviteCode);
      if (!normalizedCode) {
        throw new WorkspaceError(400, '请输入邀请码。');
      }

      const inviteCode = state.inviteCodes.find((candidate) => candidate.code === normalizedCode);
      if (!inviteCode) {
        throw new WorkspaceError(404, '邀请码不存在。');
      }

      if (!inviteCode.active) {
        throw new WorkspaceError(400, '邀请码已停用。');
      }

      if (inviteCode.expiresAt && Date.parse(inviteCode.expiresAt) < Date.now()) {
        throw new WorkspaceError(400, '邀请码已过期。');
      }

      const redeemedCount = state.inviteRedemptions.filter((item) => item.inviteCodeId === inviteCode.id).length;
      if (redeemedCount >= inviteCode.maxRedemptions) {
        throw new WorkspaceError(400, '邀请码已被用完。');
      }

      const authResult = await this.createUserAndSession(state, {
        name: input.name,
        email: input.email,
        password: input.password,
        role: inviteCode.role,
        credits: inviteCode.credits,
        modelAllowances: inviteCode.modelAllowances,
      });

      const now = new Date().toISOString();
      state.inviteRedemptions = state.inviteRedemptions
        .concat({
          id: randomUUID(),
          inviteCodeId: inviteCode.id,
          userId: authResult.user.id,
          createdAt: now,
        })
        .slice(-MAX_INVITE_REDEMPTION_RECORDS);

      state.usageRecords = state.usageRecords
        .concat({
          id: randomUUID(),
          userId: authResult.user.id,
          modelId: `invite:${inviteCode.code}`,
          requestPath: '/api/workspace/session/register',
          operationType: 'invite_registration',
          source: 'free',
          status: 'redeemed',
          creditsDelta: inviteCode.credits,
          allowancePattern: null,
          allowanceDelta: 0,
          allowanceChanges: { ...inviteCode.modelAllowances },
          createdAt: now,
          updatedAt: now,
          note: maskNote(inviteCode.description),
        })
        .slice(-MAX_USAGE_RECORDS);

      return {
        bootstrapped: true,
        workspaceName: state.workspace.name,
        currentUser: toUserSummary(authResult.user),
        sessionToken: authResult.sessionToken,
      };
    });
  }

  async logout(sessionToken: string | null): Promise<void> {
    if (!sessionToken) {
      return;
    }

    await this.mutate((state) => {
      state.sessions = this.pruneSessions(state.sessions).filter((session) => session.token !== sessionToken);
    });
  }

  async getSession(sessionToken: string | null): Promise<WorkspaceSessionResponse> {
    const state = await this.readState();
    const bootstrapped = state.users.length > 0;
    if (!bootstrapped || !sessionToken) {
      return {
        bootstrapped,
        workspaceName: state.workspace.name,
        currentUser: null,
      };
    }

    const user = this.getUserBySessionToken(state, sessionToken);
    return {
      bootstrapped,
      workspaceName: state.workspace.name,
      currentUser: user ? toUserSummary(user) : null,
    };
  }

  async getDashboard(sessionToken: string | null): Promise<WorkspaceDashboardResponse> {
    const state = await this.readState();
    const user = this.requireAuthenticatedUser(state, sessionToken);
    const recentUsage = this.getUsageSummariesForUser(state, user.id, 20);

    return {
      bootstrapped: true,
      workspaceName: state.workspace.name,
      currentUser: toUserSummary(user),
      policies: state.modelPolicies.map((policy) => ({ ...policy })),
      recentUsage,
      recentRechargeOrders: this.getRechargeOrderSummariesForUser(state, user.id, 10),
    };
  }

  async redeemCode(
    sessionToken: string | null,
    input: {
      code: string;
    },
  ): Promise<WorkspaceDashboardResponse> {
    return this.mutate((state) => {
      const user = this.requireAuthenticatedUser(state, sessionToken);
      const normalizedCode = sanitizeCode(input.code);
      if (!normalizedCode) {
        throw new WorkspaceError(400, '请输入兑换码。');
      }

      const redeemCode = state.redeemCodes.find((candidate) => candidate.code === normalizedCode);
      if (!redeemCode) {
        throw new WorkspaceError(404, '兑换码不存在。');
      }

      if (!redeemCode.active) {
        throw new WorkspaceError(400, '兑换码已停用。');
      }

      if (redeemCode.expiresAt && Date.parse(redeemCode.expiresAt) < Date.now()) {
        throw new WorkspaceError(400, '兑换码已过期。');
      }

      const redeemedCount = state.redemptions.filter((item) => item.codeId === redeemCode.id).length;
      if (redeemedCount >= redeemCode.maxRedemptions) {
        throw new WorkspaceError(400, '兑换码已被用完。');
      }

      const alreadyRedeemed = state.redemptions.some(
        (item) => item.codeId === redeemCode.id && item.userId === user.id,
      );
      if (alreadyRedeemed) {
        throw new WorkspaceError(400, '你已经兑换过这个码了。');
      }

      const now = new Date().toISOString();
      user.credits += redeemCode.credits;
      user.modelAllowances = mergeAllowances(user.modelAllowances, redeemCode.modelAllowances);
      user.updatedAt = now;
      state.redemptions = state.redemptions
        .concat({
          id: randomUUID(),
          codeId: redeemCode.id,
          userId: user.id,
          createdAt: now,
        })
        .slice(-MAX_REDEMPTION_RECORDS);

      state.usageRecords = state.usageRecords
        .concat({
          id: randomUUID(),
          userId: user.id,
          modelId: `redeem:${redeemCode.code}`,
          requestPath: '/api/workspace/redeem',
          operationType: 'redeem',
          source: 'free',
          status: 'redeemed',
          creditsDelta: redeemCode.credits,
          allowancePattern: null,
          allowanceDelta: 0,
          allowanceChanges: { ...redeemCode.modelAllowances },
          createdAt: now,
          updatedAt: now,
          note: maskNote(redeemCode.description),
        })
        .slice(-MAX_USAGE_RECORDS);

      return {
        bootstrapped: true,
        workspaceName: state.workspace.name,
        currentUser: toUserSummary(user),
        policies: state.modelPolicies.map((policy) => ({ ...policy })),
        recentUsage: this.getUsageSummariesForUser(state, user.id, 20),
        recentRechargeOrders: this.getRechargeOrderSummariesForUser(state, user.id, 10),
      };
    });
  }

  async getAdminState(sessionToken: string | null): Promise<WorkspaceAdminStateResponse> {
    const state = await this.readState();
    const adminUser = this.requireAdminUser(state, sessionToken);

    return {
      bootstrapped: true,
      workspaceName: state.workspace.name,
      currentUser: toUserSummary(adminUser),
      policies: state.modelPolicies.map((policy) => ({ ...policy })),
      recentUsage: this.getUsageSummariesForUser(state, adminUser.id, 20),
      recentRechargeOrders: this.getRechargeOrderSummariesForUser(state, adminUser.id, 10),
      users: state.users.map(toUserSummary),
      redeemCodes: state.redeemCodes.map((code) => ({
        id: code.id,
        code: code.code,
        description: code.description,
        credits: code.credits,
        modelAllowances: { ...code.modelAllowances },
        maxRedemptions: code.maxRedemptions,
        redeemedCount: state.redemptions.filter((item) => item.codeId === code.id).length,
        active: code.active,
        expiresAt: code.expiresAt,
        createdAt: code.createdAt,
      })),
      inviteCodes: state.inviteCodes.map((code) => toInviteCodeSummary(code, state.inviteRedemptions)),
      recentWorkspaceUsage: this.getUsageSummaries(state, 50),
      rechargeOrders: this.getRechargeOrderSummaries(state, 50),
    };
  }

  async getAdminUsagePage(
    sessionToken: string | null,
    query: WorkspaceUsageQuery = {},
  ): Promise<WorkspaceUsagePageResponse> {
    const state = await this.readState();
    this.requireAdminUser(state, sessionToken);
    return this.buildUsagePageResponse(state, query);
  }

  async exportAdminUsageCsv(
    sessionToken: string | null,
    query: WorkspaceUsageQuery = {},
  ): Promise<string> {
    const state = await this.readState();
    this.requireAdminUser(state, sessionToken);
    const rows = this.getFilteredUsageSummaries(state, query);
    const header = [
      'id',
      'userId',
      'userName',
      'operationType',
      'modelId',
      'source',
      'status',
      'creditsDelta',
      'allowancePattern',
      'allowanceDelta',
      'allowanceChanges',
      'requestPath',
      'note',
      'createdAt',
      'updatedAt',
    ];

    return [
      header.join(','),
      ...rows.map((row) => [
        row.id,
        row.userId,
        row.userName,
        row.operationType,
        row.modelId,
        row.source,
        row.status,
        row.creditsDelta,
        row.allowancePattern ?? '',
        row.allowanceDelta,
        JSON.stringify(row.allowanceChanges),
        row.requestPath,
        row.note ?? '',
        row.createdAt,
        row.updatedAt,
      ].map(escapeCsvValue).join(',')),
    ].join('\n');
  }

  async getAdminDiagnostics(sessionToken: string | null): Promise<WorkspaceAdminDiagnosticsResponse> {
    const state = await this.readState();
    const admin = this.requireAdminUser(state, sessionToken);
    const activeSessions = this.pruneSessions(state.sessions);
    const now = Date.now();

    return {
      bootstrapped: true,
      workspaceName: state.workspace.name,
      currentUser: toUserSummary(admin),
      generatedAt: new Date().toISOString(),
      storage: {
        type: 'sqlite',
        database: await this.getStorageFileSnapshot(this.databaseFilePath),
        legacyJson: await this.getStorageFileSnapshot(this.legacyJsonFilePath),
        sessionTtlHours: this.sessionTtlHours,
      },
      counts: {
        users: state.users.length,
        admins: state.users.filter((user) => user.role === 'admin').length,
        members: state.users.filter((user) => user.role === 'member').length,
        disabledUsers: state.users.filter((user) => user.disabled).length,
        activeSessions: activeSessions.length,
        modelPolicies: state.modelPolicies.length,
        redeemCodes: state.redeemCodes.length,
        activeRedeemCodes: state.redeemCodes.filter(
          (code) => code.active && (!code.expiresAt || Date.parse(code.expiresAt) > now),
        ).length,
        redemptions: state.redemptions.length,
        inviteCodes: state.inviteCodes.length,
        activeInviteCodes: state.inviteCodes.filter(
          (code) => code.active && (!code.expiresAt || Date.parse(code.expiresAt) > now),
        ).length,
        inviteRegistrations: state.inviteRedemptions.length,
        rechargeOrders: state.rechargeOrders.length,
        pendingRechargeOrders: state.rechargeOrders.filter((order) => order.status === 'pending').length,
        paidRechargeOrders: state.rechargeOrders.filter((order) => order.status === 'paid').length,
        cancelledRechargeOrders: state.rechargeOrders.filter((order) => order.status === 'cancelled').length,
        usageRecords: state.usageRecords.length,
        pendingUsageRecords: state.usageRecords.filter((record) => record.status === 'pending').length,
        refundedUsageRecords: state.usageRecords.filter((record) => record.status === 'refunded').length,
      },
    };
  }

  async getRuntimeApiSettings(): Promise<WorkspaceApiProviderSettings> {
    const state = await this.readState();
    return normalizeApiProviderSettings(state.apiSettings);
  }

  async updateAdminApiSettings(
    sessionToken: string | null,
    updates: Partial<Record<WorkspaceApiProvider, WorkspaceApiProviderSettingUpdate>>,
  ): Promise<WorkspaceApiProviderSettings> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const currentSettings = normalizeApiProviderSettings(state.apiSettings);
      const now = new Date().toISOString();

      API_PROVIDERS.forEach((provider) => {
        const update = updates[provider];
        if (!update) {
          return;
        }

        const nextSetting = { ...currentSettings[provider] };
        if ('apiKey' in update) {
          nextSetting.apiKey = normalizeOptionalText(update.apiKey);
        }
        if ('apiBase' in update) {
          nextSetting.apiBase = normalizeOptionalText(update.apiBase);
        }

        nextSetting.updatedAt = now;
        nextSetting.updatedByUserId = admin.id;
        currentSettings[provider] = nextSetting;
      });

      state.apiSettings = currentSettings;
      return normalizeApiProviderSettings(state.apiSettings);
    });
  }

  async exportAdminBackupJson(sessionToken: string | null): Promise<string> {
    const state = await this.readState();
    this.requireAdminUser(state, sessionToken);

    const backup: WorkspaceAdminBackupExport = {
      kind: 'arong-workspace-backup',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      workspaceName: state.workspace.name,
      containsSensitiveAuthData: true,
      sessionsExported: false,
      notes: [
        'This backup includes password hashes, billing data, and workspace API settings. Store it in a trusted location.',
        'Active login sessions are intentionally omitted. Users will need to sign in again after restore.',
      ],
      data: {
        ...state,
        sessions: [],
      },
    };

    return JSON.stringify(backup, null, 2);
  }

  async createUser(
    sessionToken: string | null,
    input: {
      name: string;
      email: string;
      password: string;
      role?: WorkspaceRole;
      credits?: number;
      modelAllowances?: Record<string, number>;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate(async (state) => {
      this.requireAdminUser(state, sessionToken);
      await this.createUserAndSession(state, {
        name: input.name,
        email: input.email,
        password: input.password,
        role: input.role ?? 'member',
        credits: normalizePositiveInteger(input.credits, 0),
        modelAllowances: normalizeModelAllowances(input.modelAllowances),
      }, false);

      const admin = this.requireAdminUser(state, sessionToken);
      return this.buildAdminStateResponse(state, admin);
    });
  }

  async updateUser(
    sessionToken: string | null,
    userId: string,
    input: {
      name?: string;
      role?: WorkspaceRole;
      credits?: number;
      modelAllowances?: Record<string, number>;
      disabled?: boolean;
      password?: string;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate(async (state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) {
        throw new WorkspaceError(404, '用户不存在。');
      }

      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new WorkspaceError(400, '用户名不能为空。');
        }
        user.name = name;
      }

      if (input.role) {
        user.role = input.role;
      }

      if (input.credits !== undefined) {
        user.credits = normalizePositiveInteger(input.credits, user.credits);
      }

      if (input.modelAllowances !== undefined) {
        user.modelAllowances = normalizeModelAllowances(input.modelAllowances);
      }

      if (typeof input.disabled === 'boolean') {
        user.disabled = input.disabled;
      }

      if (typeof input.password === 'string' && input.password.trim()) {
        const nextPassword = input.password.trim();
        if (nextPassword.length < 6) {
          throw new WorkspaceError(400, '密码至少需要 6 位。');
        }
        const newSalt = randomBytes(16).toString('hex');
        user.passwordSalt = newSalt;
        user.passwordHash = await hashPassword(nextPassword, newSalt);
      }

      user.updatedAt = new Date().toISOString();

      if (user.disabled) {
        state.sessions = state.sessions.filter((session) => session.userId !== user.id);
      }

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async adjustUserBalance(
    sessionToken: string | null,
    userId: string,
    input: {
      creditsDelta?: number;
      modelAllowanceDeltas?: Record<string, number>;
      reason?: string | null;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) {
        throw new WorkspaceError(404, '用户不存在。');
      }

      const creditsDelta = normalizeSignedInteger(input.creditsDelta, 0);
      const allowanceChanges = normalizeModelAllowanceDeltas(input.modelAllowanceDeltas);
      const hasAllowanceChange = Object.keys(allowanceChanges).length > 0;
      if (creditsDelta === 0 && !hasAllowanceChange) {
        throw new WorkspaceError(400, '请输入要调整的积分或次数包变化。');
      }

      if (creditsDelta < 0 && user.credits + creditsDelta < 0) {
        throw new WorkspaceError(400, '积分扣减后不能小于 0。');
      }

      const nextAllowances = { ...user.modelAllowances };
      for (const [pattern, delta] of Object.entries(allowanceChanges)) {
        const nextValue = (nextAllowances[pattern] ?? 0) + delta;
        if (nextValue < 0) {
          throw new WorkspaceError(400, `次数包 ${pattern} 扣减后不能小于 0。`);
        }
        if (nextValue === 0) {
          delete nextAllowances[pattern];
        } else {
          nextAllowances[pattern] = nextValue;
        }
      }

      const now = new Date().toISOString();
      user.credits += creditsDelta;
      user.modelAllowances = nextAllowances;
      user.updatedAt = now;

      state.usageRecords = state.usageRecords
        .concat({
          id: randomUUID(),
          userId: user.id,
          modelId: 'admin-adjustment',
          requestPath: `/api/workspace/admin/users/${user.id}/adjust-balance`,
          operationType: 'admin_adjustment',
          source: 'admin',
          status: 'adjusted',
          creditsDelta,
          allowancePattern: null,
          allowanceDelta: 0,
          allowanceChanges,
          createdAt: now,
          updatedAt: now,
          note: maskNote(input.reason ?? null) ?? `管理员 ${admin.name} 手工调账`,
        })
        .slice(-MAX_USAGE_RECORDS);

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async createRechargeOrder(
    sessionToken: string | null,
    input: {
      userId: string;
      amountCents?: number;
      currency?: string;
      credits?: number;
      modelAllowances?: Record<string, number>;
      paymentMethod?: WorkspacePaymentMethod;
      externalReference?: string | null;
      note?: string | null;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const user = state.users.find((candidate) => candidate.id === input.userId);
      if (!user) {
        throw new WorkspaceError(404, '用户不存在。');
      }

      const credits = normalizePositiveInteger(input.credits, 0);
      const modelAllowances = normalizeModelAllowances(input.modelAllowances);
      const amountCents = normalizePositiveInteger(input.amountCents, 0);
      if (credits === 0 && Object.keys(modelAllowances).length === 0) {
        throw new WorkspaceError(400, '充值订单至少需要包含积分或次数包。');
      }
      if (amountCents <= 0) {
        throw new WorkspaceError(400, '充值订单金额必须大于 0。');
      }

      const now = new Date().toISOString();
      state.rechargeOrders = state.rechargeOrders
        .concat({
          id: randomUUID(),
          orderNo: createOrderNo(),
          userId: user.id,
          createdByUserId: admin.id,
          confirmedByUserId: null,
          status: 'pending',
          paymentMethod: normalizePaymentMethod(input.paymentMethod),
          amountCents,
          currency: normalizeCurrency(input.currency),
          credits,
          modelAllowances,
          externalReference: normalizeOptionalText(input.externalReference),
          note: normalizeOptionalText(input.note),
          createdAt: now,
          updatedAt: now,
          paidAt: null,
          cancelledAt: null,
        })
        .slice(-MAX_RECHARGE_ORDERS);

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async markRechargeOrderPaid(
    sessionToken: string | null,
    orderId: string,
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const order = state.rechargeOrders.find((candidate) => candidate.id === orderId);
      if (!order) {
        throw new WorkspaceError(404, '充值订单不存在。');
      }
      if (order.status !== 'pending') {
        throw new WorkspaceError(400, '只有待确认订单可以确认到账。');
      }

      const user = state.users.find((candidate) => candidate.id === order.userId);
      if (!user) {
        throw new WorkspaceError(404, '订单关联用户不存在。');
      }

      const now = new Date().toISOString();
      user.credits += order.credits;
      user.modelAllowances = mergeAllowances(user.modelAllowances, order.modelAllowances);
      user.updatedAt = now;

      order.status = 'paid';
      order.confirmedByUserId = admin.id;
      order.paidAt = now;
      order.updatedAt = now;

      state.usageRecords = state.usageRecords
        .concat({
          id: randomUUID(),
          userId: user.id,
          modelId: `order:${order.orderNo}`,
          requestPath: `/api/workspace/admin/recharge-orders/${order.id}/mark-paid`,
          operationType: 'order_recharge',
          source: 'order',
          status: 'success',
          creditsDelta: order.credits,
          allowancePattern: null,
          allowanceDelta: 0,
          allowanceChanges: { ...order.modelAllowances },
          createdAt: now,
          updatedAt: now,
          note: maskNote(order.note) ?? `充值订单 ${order.orderNo} 已确认到账`,
        })
        .slice(-MAX_USAGE_RECORDS);

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async cancelRechargeOrder(
    sessionToken: string | null,
    orderId: string,
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const order = state.rechargeOrders.find((candidate) => candidate.id === orderId);
      if (!order) {
        throw new WorkspaceError(404, '充值订单不存在。');
      }
      if (order.status !== 'pending') {
        throw new WorkspaceError(400, '只有待确认订单可以取消。');
      }

      const now = new Date().toISOString();
      order.status = 'cancelled';
      order.updatedAt = now;
      order.cancelledAt = now;

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async replaceModelPolicies(
    sessionToken: string | null,
    input: {
      policies: Array<{
        label: string;
        modelPattern: string;
        costCredits: number;
        description?: string | null;
      }>;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const now = new Date().toISOString();
      const nextPolicies = input.policies
        .map((policy) => {
          const label = policy.label.trim();
          const modelPattern = policy.modelPattern.trim();
          if (!label || !modelPattern) {
            return null;
          }

          const nextPolicy: WorkspaceModelPolicy = {
            id: randomUUID(),
            label,
            modelPattern,
            costCredits: normalizePositiveInteger(policy.costCredits, 0),
            description: normalizeOptionalText(policy.description),
            createdAt: now,
            updatedAt: now,
          };

          return nextPolicy;
        })
        .filter((policy): policy is WorkspaceModelPolicy => policy !== null);

      if (nextPolicies.length === 0) {
        throw new WorkspaceError(400, '请至少保留一条模型策略。');
      }

      state.modelPolicies = nextPolicies;
      return this.buildAdminStateResponse(state, admin);
    });
  }

  async createRedeemCode(
    sessionToken: string | null,
    input: {
      code: string;
      description?: string | null;
      credits?: number;
      maxRedemptions?: number;
      expiresAt?: string | null;
      modelAllowances?: Record<string, number>;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const normalizedCode = sanitizeCode(input.code);
      if (!normalizedCode) {
        throw new WorkspaceError(400, '兑换码不能为空。');
      }

      if (
        state.redeemCodes.some((candidate) => candidate.code === normalizedCode)
        || state.inviteCodes.some((candidate) => candidate.code === normalizedCode)
      ) {
        throw new WorkspaceError(409, '兑换码已存在，请换一个。');
      }

      const now = new Date().toISOString();
      state.redeemCodes.push({
        id: randomUUID(),
        code: normalizedCode,
        description: normalizeOptionalText(input.description) ?? '兑换码',
        credits: normalizePositiveInteger(input.credits, 0),
        modelAllowances: normalizeModelAllowances(input.modelAllowances),
        maxRedemptions: Math.max(normalizePositiveInteger(input.maxRedemptions, 1), 1),
        active: true,
        expiresAt: normalizeOptionalText(input.expiresAt),
        createdAt: now,
      });

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async createInviteCode(
    sessionToken: string | null,
    input: {
      code?: string | null;
      description?: string | null;
      role?: WorkspaceRole;
      credits?: number;
      maxRedemptions?: number;
      expiresAt?: string | null;
      modelAllowances?: Record<string, number>;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const codeExists = (code: string) =>
        state.inviteCodes.some((candidate) => candidate.code === code)
        || state.redeemCodes.some((candidate) => candidate.code === code);
      let normalizedCode = sanitizeCode(input.code ?? '');
      if (!normalizedCode) {
        do {
          normalizedCode = `INVITE-${randomBytes(4).toString('hex').toUpperCase()}`;
        } while (codeExists(normalizedCode));
      }

      if (codeExists(normalizedCode)) {
        throw new WorkspaceError(409, '邀请码或兑换码已存在，请换一个。');
      }

      const now = new Date().toISOString();
      state.inviteCodes.push({
        id: randomUUID(),
        code: normalizedCode,
        description: normalizeOptionalText(input.description) ?? '邀请码注册',
        role: input.role === 'admin' ? 'admin' : 'member',
        credits: normalizePositiveInteger(input.credits, 0),
        modelAllowances: normalizeModelAllowances(input.modelAllowances),
        maxRedemptions: Math.max(normalizePositiveInteger(input.maxRedemptions, 1), 1),
        active: true,
        expiresAt: normalizeOptionalText(input.expiresAt),
        createdAt: now,
      });

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async updateInviteCode(
    sessionToken: string | null,
    inviteCodeId: string,
    input: {
      active?: boolean;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return this.mutate((state) => {
      const admin = this.requireAdminUser(state, sessionToken);
      const inviteCode = state.inviteCodes.find((candidate) => candidate.id === inviteCodeId);
      if (!inviteCode) {
        throw new WorkspaceError(404, '邀请码不存在。');
      }

      if (typeof input.active === 'boolean') {
        inviteCode.active = input.active;
      }

      return this.buildAdminStateResponse(state, admin);
    });
  }

  async reserveUsageForProxy(
    sessionToken: string | null,
    modelId: string,
    requestPath: string,
    operationType: UsageOperationType = 'model_request',
  ): Promise<ReserveUsageResult> {
    return this.mutate((state) => {
      if (state.users.length === 0) {
        return {
          bootstrapped: false,
          usageRecordId: null,
          currentUser: null,
        };
      }

      const user = this.requireAuthenticatedUser(state, sessionToken);
      const policy = this.findMatchingPolicy(state.modelPolicies, modelId);
      const now = new Date().toISOString();

      let source: UsageSource = 'free';
      let creditsDelta = 0;
      let allowancePattern: string | null = null;
      let allowanceDelta = 0;

      if (policy && policy.costCredits > 0) {
        const matchingAllowance = this.findMatchingAllowance(user.modelAllowances, modelId, policy.modelPattern);
        if (matchingAllowance) {
          source = 'allowance';
          allowancePattern = matchingAllowance;
          allowanceDelta = -1;
          user.modelAllowances[matchingAllowance] = Math.max((user.modelAllowances[matchingAllowance] ?? 0) - 1, 0);
          if (user.modelAllowances[matchingAllowance] === 0) {
            delete user.modelAllowances[matchingAllowance];
          }
        } else if (user.credits >= policy.costCredits) {
          source = 'credits';
          creditsDelta = -policy.costCredits;
          user.credits -= policy.costCredits;
        } else {
          throw new WorkspaceError(
            402,
            `额度不足，模型 ${policy.label} 需要 ${policy.costCredits} 积分，当前仅剩 ${user.credits}。`,
          );
        }
      }

      user.updatedAt = now;
      const usageRecordId = randomUUID();
      state.usageRecords = state.usageRecords
        .concat({
          id: usageRecordId,
          userId: user.id,
          modelId,
          requestPath,
          operationType,
          source,
          status: 'pending',
          creditsDelta,
          allowancePattern,
          allowanceDelta,
          allowanceChanges: allowancePattern && allowanceDelta !== 0 ? { [allowancePattern]: allowanceDelta } : {},
          createdAt: now,
          updatedAt: now,
          note: policy ? policy.label : '未命中计费策略',
        })
        .slice(-MAX_USAGE_RECORDS);

      return {
        bootstrapped: true,
        usageRecordId,
        currentUser: toUserSummary(user),
      };
    });
  }

  async finalizeUsageReservation(
    usageRecordId: string | null,
    outcome: {
      success: boolean;
      note?: string;
    },
  ): Promise<void> {
    if (!usageRecordId) {
      return;
    }

    await this.mutate((state) => {
      const record = state.usageRecords.find((candidate) => candidate.id === usageRecordId);
      if (!record || record.status !== 'pending') {
        return;
      }

      const user = state.users.find((candidate) => candidate.id === record.userId);
      if (!user) {
        record.status = 'refunded';
        record.updatedAt = new Date().toISOString();
        record.note = maskNote(outcome.note ?? null) ?? record.note;
        return;
      }

      const now = new Date().toISOString();
      if (outcome.success) {
        record.status = 'success';
        record.updatedAt = now;
        record.note = maskNote(outcome.note ?? null) ?? record.note;
        return;
      }

      if (record.creditsDelta < 0) {
        user.credits += Math.abs(record.creditsDelta);
      }
      if (record.allowancePattern && record.allowanceDelta < 0) {
        user.modelAllowances = mergeAllowances(user.modelAllowances, {
          [record.allowancePattern]: Math.abs(record.allowanceDelta),
        });
      }

      user.updatedAt = now;
      record.status = 'refunded';
      record.updatedAt = now;
      record.note = maskNote(outcome.note ?? null) ?? record.note;
    });
  }

  extractModelIdFromGeminiPath(pathname: string): string | null {
    const match = pathname.match(/\/models\/([^/:?]+):/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private async createUserAndSession(
    state: WorkspaceState,
    input: {
      name: string;
      email: string;
      password: string;
      role: WorkspaceRole;
      credits: number;
      modelAllowances: Record<string, number>;
    },
    createSession = true,
  ): Promise<UserAuthResult> {
    const name = input.name.trim();
    const email = normalizeEmail(input.email);
    const password = input.password.trim();
    if (!name) {
      throw new WorkspaceError(400, '用户名不能为空。');
    }
    if (!email) {
      throw new WorkspaceError(400, '邮箱不能为空。');
    }
    if (!password || password.length < 6) {
      throw new WorkspaceError(400, '密码至少需要 6 位。');
    }
    if (state.users.some((candidate) => candidate.email === email)) {
      throw new WorkspaceError(409, '该邮箱已经存在。');
    }

    const passwordSalt = randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, passwordSalt);
    const now = new Date().toISOString();
    const user: WorkspaceUserRecord = {
      id: randomUUID(),
      name,
      email,
      role: input.role,
      passwordHash,
      passwordSalt,
      credits: input.credits,
      modelAllowances: normalizeModelAllowances(input.modelAllowances),
      disabled: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: createSession ? now : null,
    };
    state.users.push(user);

    const sessionToken = createSession ? randomBytes(32).toString('hex') : '';
    if (createSession) {
      state.sessions = this.pruneSessions(state.sessions).concat({
        token: sessionToken,
        userId: user.id,
        createdAt: now,
        expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      });
    }

    return {
      user,
      sessionToken,
    };
  }

  private buildAdminStateResponse(
    state: WorkspaceState,
    adminUser: WorkspaceUserRecord,
  ): WorkspaceAdminStateResponse {
    return {
      bootstrapped: true,
      workspaceName: state.workspace.name,
      currentUser: toUserSummary(adminUser),
      policies: state.modelPolicies.map((policy) => ({ ...policy })),
      recentUsage: this.getUsageSummariesForUser(state, adminUser.id, 20),
      recentRechargeOrders: this.getRechargeOrderSummariesForUser(state, adminUser.id, 10),
      users: state.users.map(toUserSummary),
      redeemCodes: state.redeemCodes.map((code) => ({
        id: code.id,
        code: code.code,
        description: code.description,
        credits: code.credits,
        modelAllowances: { ...code.modelAllowances },
        maxRedemptions: code.maxRedemptions,
        redeemedCount: state.redemptions.filter((item) => item.codeId === code.id).length,
        active: code.active,
        expiresAt: code.expiresAt,
        createdAt: code.createdAt,
      })),
      inviteCodes: state.inviteCodes.map((code) => toInviteCodeSummary(code, state.inviteRedemptions)),
      recentWorkspaceUsage: this.getUsageSummaries(state, 50),
      rechargeOrders: this.getRechargeOrderSummaries(state, 50),
    };
  }

  private getUsageSummariesForUser(
    state: WorkspaceState,
    userId: string,
    limit: number,
  ): WorkspaceUsageSummary[] {
    return state.usageRecords
      .filter((record) => record.userId === userId)
      .slice(-limit)
      .reverse()
      .map((record) => {
        const user = state.users.find((candidate) => candidate.id === record.userId);
        return toUsageSummary(record, user?.name ?? 'Unknown');
      });
  }

  private getUsageSummaries(state: WorkspaceState, limit: number): WorkspaceUsageSummary[] {
    return state.usageRecords
      .slice(-limit)
      .reverse()
      .map((record) => {
        const user = state.users.find((candidate) => candidate.id === record.userId);
        return toUsageSummary(record, user?.name ?? 'Unknown');
      });
  }

  private getRechargeOrderSummariesForUser(
    state: WorkspaceState,
    userId: string,
    limit: number,
  ): WorkspaceRechargeOrderSummary[] {
    return state.rechargeOrders
      .filter((order) => order.userId === userId)
      .slice(-limit)
      .reverse()
      .map((order) => toRechargeOrderSummary(order, state.users));
  }

  private getRechargeOrderSummaries(state: WorkspaceState, limit: number): WorkspaceRechargeOrderSummary[] {
    return state.rechargeOrders
      .slice(-limit)
      .reverse()
      .map((order) => toRechargeOrderSummary(order, state.users));
  }

  private async getStorageFileSnapshot(filePath: string | null): Promise<WorkspaceStorageFileSnapshot> {
    if (!filePath) {
      return {
        filePath: null,
        exists: false,
        sizeBytes: 0,
        updatedAt: null,
      };
    }

    try {
      const fileStat = await stat(filePath);
      return {
        filePath,
        exists: fileStat.isFile(),
        sizeBytes: fileStat.isFile() ? fileStat.size : 0,
        updatedAt: fileStat.mtime.toISOString(),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        filePath,
        exists: false,
        sizeBytes: 0,
        updatedAt: null,
        ...(code && code !== 'ENOENT'
          ? { error: error instanceof Error ? error.message : 'Unable to read storage file metadata.' }
          : {}),
      };
    }
  }

  private getFilteredUsageSummaries(
    state: WorkspaceState,
    query: WorkspaceUsageQuery,
  ): WorkspaceUsageSummary[] {
    const normalizedSearch = query.search?.trim().toLowerCase() ?? '';

    return state.usageRecords
      .slice()
      .reverse()
      .map((record) => {
        const user = state.users.find((candidate) => candidate.id === record.userId);
        return toUsageSummary(record, user?.name ?? 'Unknown');
      })
      .filter((record) => {
        if (query.userId && query.userId !== 'all' && record.userId !== query.userId) {
          return false;
        }
        if (query.status && query.status !== 'all' && record.status !== query.status) {
          return false;
        }
        if (query.source && query.source !== 'all' && record.source !== query.source) {
          return false;
        }
        if (query.operationType && query.operationType !== 'all' && record.operationType !== query.operationType) {
          return false;
        }
        if (!normalizedSearch) {
          return true;
        }

        return [
          record.userName,
          record.modelId,
          record.requestPath,
          record.note ?? '',
          record.operationType,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      });
  }

  private buildUsagePageResponse(
    state: WorkspaceState,
    query: WorkspaceUsageQuery,
  ): WorkspaceUsagePageResponse {
    const page = Math.max(normalizePositiveInteger(query.page, 1), 1);
    const pageSize = Math.min(
      Math.max(normalizePositiveInteger(query.pageSize, DEFAULT_USAGE_PAGE_SIZE), 1),
      MAX_USAGE_PAGE_SIZE,
    );
    const filteredRows = this.getFilteredUsageSummaries(state, query);
    const total = filteredRows.length;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, totalPages);
    const startIndex = (safePage - 1) * pageSize;

    return {
      items: filteredRows.slice(startIndex, startIndex + pageSize),
      total,
      page: safePage,
      pageSize,
      totalPages,
    };
  }

  private findMatchingPolicy(
    policies: WorkspaceModelPolicy[],
    modelId: string,
  ): WorkspaceModelPolicy | null {
    return [...policies]
      .sort((left, right) => getPolicySortScore(right) - getPolicySortScore(left))
      .find((policy) => matchesModelPattern(modelId, policy.modelPattern))
      ?? null;
  }

  private findMatchingAllowance(
    allowances: Record<string, number>,
    modelId: string,
    preferredPattern: string,
  ): string | null {
    if ((allowances[modelId] ?? 0) > 0) {
      return modelId;
    }

    if ((allowances[preferredPattern] ?? 0) > 0) {
      return preferredPattern;
    }

    return Object.entries(allowances)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[0].length - left[0].length)
      .find(([pattern]) => matchesModelPattern(modelId, pattern))
      ?.[0] ?? null;
  }

  private getUserBySessionToken(
    state: WorkspaceState,
    sessionToken: string,
  ): WorkspaceUserRecord | null {
    const sessions = this.pruneSessions(state.sessions);
    const session = sessions.find((candidate) => candidate.token === sessionToken);
    if (!session) {
      return null;
    }

    return state.users.find((candidate) => candidate.id === session.userId && !candidate.disabled) ?? null;
  }

  private requireAuthenticatedUser(
    state: WorkspaceState,
    sessionToken: string | null,
  ): WorkspaceUserRecord {
    if (!sessionToken) {
      throw new WorkspaceError(401, '请先登录后再聊天。打开左侧菜单底部「设置」→「账号与额度」登录；没有账号可用邀请码注册。');
    }

    const user = this.getUserBySessionToken(state, sessionToken);
    if (!user) {
      throw new WorkspaceError(401, '登录状态已过期。请到「设置」→「账号与额度」重新登录。');
    }

    if (user.disabled) {
      throw new WorkspaceError(403, '该账号已被停用。');
    }

    return user;
  }

  private requireAdminUser(
    state: WorkspaceState,
    sessionToken: string | null,
  ): WorkspaceUserRecord {
    const user = this.requireAuthenticatedUser(state, sessionToken);
    if (user.role !== 'admin') {
      throw new WorkspaceError(403, '只有管理员可以执行这个操作。');
    }
    return user;
  }

  private pruneSessions(sessions: WorkspaceSessionRecord[]): WorkspaceSessionRecord[] {
    const now = Date.now();
    return sessions.filter((session) => Date.parse(session.expiresAt) > now);
  }

  private async mutate<T>(mutation: (state: WorkspaceState) => Promise<T> | T): Promise<T> {
    return withSqliteFileLock(this.databaseFilePath, async () => {
      if (this.storage.mutateState) {
        return this.storage.mutateState(
          createDefaultWorkspaceState,
          normalizeWorkspaceState,
          async (state) => {
            state.sessions = this.pruneSessions(state.sessions);
            return mutation(state);
          },
        );
      }

      let resolveQueue: () => void = () => {};
      const nextQueue = new Promise<void>((resolve) => {
        resolveQueue = resolve;
      });
      const previousQueue = this.mutationQueue;
      this.mutationQueue = previousQueue.then(() => nextQueue);

      await previousQueue;

      try {
        const state = await this.readState();
        state.sessions = this.pruneSessions(state.sessions);
        const result = await mutation(state);
        await this.writeState(state);
        return result;
      } finally {
        resolveQueue();
      }
    });
  }

  private async readState(): Promise<WorkspaceState> {
    const persistedState = await this.storage.readState();
    if (!persistedState) {
      const defaultState = createDefaultWorkspaceState();
      await this.writeState(defaultState);
      return defaultState;
    }

    return this.normalizeState(persistedState);
  }

  private async writeState(state: WorkspaceState): Promise<void> {
    await this.storage.writeState(state);
  }

  private normalizeState(input: Partial<WorkspaceState>): WorkspaceState {
    const defaultState = createDefaultWorkspaceState();
    return {
      workspace: {
        name: input.workspace?.name?.trim() || defaultState.workspace.name,
        createdAt: input.workspace?.createdAt || defaultState.workspace.createdAt,
      },
      apiSettings: normalizeApiProviderSettings(input.apiSettings),
      users: Array.isArray(input.users) ? input.users.map((user) => ({
        ...user,
        credits: normalizePositiveInteger(user.credits, 0),
        modelAllowances: normalizeModelAllowances(user.modelAllowances),
        disabled: !!user.disabled,
        lastLoginAt: user.lastLoginAt ?? null,
      })) : [],
      sessions: Array.isArray(input.sessions) ? input.sessions : [],
      modelPolicies: normalizeModelPolicies(input.modelPolicies, defaultState.modelPolicies),
      redeemCodes: Array.isArray(input.redeemCodes)
        ? input.redeemCodes.map((code) => ({
          ...code,
          credits: normalizePositiveInteger(code.credits, 0),
          modelAllowances: normalizeModelAllowances(code.modelAllowances),
          maxRedemptions: Math.max(normalizePositiveInteger(code.maxRedemptions, 1), 1),
          active: code.active !== false,
          expiresAt: code.expiresAt ?? null,
        }))
        : [],
      redemptions: Array.isArray(input.redemptions) ? input.redemptions : [],
      inviteCodes: Array.isArray(input.inviteCodes)
        ? input.inviteCodes.map((code) => ({
          ...code,
          role: code.role === 'admin' ? 'admin' : 'member',
          credits: normalizePositiveInteger(code.credits, 0),
          modelAllowances: normalizeModelAllowances(code.modelAllowances),
          maxRedemptions: Math.max(normalizePositiveInteger(code.maxRedemptions, 1), 1),
          active: code.active !== false,
          expiresAt: code.expiresAt ?? null,
        }))
        : [],
      inviteRedemptions: Array.isArray(input.inviteRedemptions)
        ? input.inviteRedemptions.slice(-MAX_INVITE_REDEMPTION_RECORDS)
        : [],
      rechargeOrders: Array.isArray(input.rechargeOrders)
        ? input.rechargeOrders.slice(-MAX_RECHARGE_ORDERS).map((order) => ({
          ...order,
          orderNo: order.orderNo || createOrderNo(),
          confirmedByUserId: order.confirmedByUserId ?? null,
          status: normalizeRechargeOrderStatus(order.status),
          paymentMethod: normalizePaymentMethod(order.paymentMethod),
          amountCents: normalizePositiveInteger(order.amountCents, 0),
          currency: normalizeCurrency(order.currency),
          credits: normalizePositiveInteger(order.credits, 0),
          modelAllowances: normalizeModelAllowances(order.modelAllowances),
          externalReference: normalizeOptionalText(order.externalReference),
          note: normalizeOptionalText(order.note),
          paidAt: order.paidAt ?? null,
          cancelledAt: order.cancelledAt ?? null,
        }))
        : [],
      usageRecords: Array.isArray(input.usageRecords)
        ? input.usageRecords.slice(-MAX_USAGE_RECORDS).map((record) => ({
          ...record,
          operationType: normalizeOperationType(record.operationType),
          source: normalizeUsageSource(record.source),
          status: normalizeUsageStatus(record.status),
          creditsDelta: normalizeSignedInteger(record.creditsDelta, 0),
          allowancePattern: record.allowancePattern ?? null,
          allowanceDelta: normalizeSignedInteger(record.allowanceDelta, 0),
          allowanceChanges: normalizeModelAllowanceDeltas(
            record.allowanceChanges
            ?? (record.allowancePattern && record.allowanceDelta
              ? { [record.allowancePattern]: record.allowanceDelta }
              : {}),
          ),
          note: record.note ?? null,
        }))
        : [],
    };
  }
}
