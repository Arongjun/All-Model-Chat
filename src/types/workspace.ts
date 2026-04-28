export type WorkspaceRole = 'admin' | 'member';
export type WorkspaceApiProvider = 'gemini' | 'openai' | 'anthropic';
export type WorkspaceApiProviderConfigSource = 'workspace' | 'environment' | 'none';
export type WorkspaceModelDiscoveryStatus = 'available' | 'not_configured' | 'error';

export interface WorkspaceAdminApiProviderSetting {
  provider: WorkspaceApiProvider;
  label: string;
  apiBase: string;
  apiBaseSource: Exclude<WorkspaceApiProviderConfigSource, 'none'>;
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
  apiKeySource: WorkspaceApiProviderConfigSource;
  workspaceOverrideConfigured: boolean;
  updatedAt: string | null;
}

export interface WorkspaceAdminApiSettingsResponse {
  providers: WorkspaceAdminApiProviderSetting[];
}

export interface WorkspaceObjectStorageSettingsResponse {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeyPreview: string | null;
  secretKeyConfigured: boolean;
  secretKeyPreview: string | null;
  forcePathStyle: boolean;
  publicBaseUrl: string | null;
  prefix: string;
  source: 'admin' | 'environment' | 'none';
}

export interface WorkspaceCloudAdminSessionSummary {
  id: string;
  userId: string;
  title: string;
  timestamp: number;
  messages: unknown[];
  settings: Record<string, unknown>;
  isPinned?: boolean;
  groupId?: string | null;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
  attachmentBytes: number;
}

export interface WorkspaceCloudAdminAttachmentSummary {
  id: string;
  userId: string;
  fileId: string | null;
  sessionId: string | null;
  messageId: string | null;
  name: string;
  type: string;
  size: number;
  storageKey: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface WorkspacePageResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface WorkspaceCloudRetentionSettings {
  enabled: boolean;
  maxAttachmentAgeDays: number;
  maxTotalAttachmentBytes: number;
  updatedAt: string | null;
}

export interface WorkspaceCloudCleanupResult {
  dryRun: boolean;
  matchedCount: number;
  matchedBytes: number;
  deletedCount: number;
  deletedBytes: number;
  skippedReason: string | null;
}

export interface WorkspaceSystemScenario {
  id: string;
  title: string;
  systemInstruction?: string;
  messages: Array<{ id: string; role: 'user' | 'model'; content: string }>;
  managedBy: 'system';
  visibilityMode: 'all' | 'members' | 'admins' | 'users';
  allowedUserIds: string[];
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDiscoveredModel {
  id: string;
  rawId: string;
  name: string;
  provider: WorkspaceApiProvider;
  source: 'api';
}

export interface WorkspaceProviderModelDiscovery {
  provider: WorkspaceApiProvider;
  label: string;
  apiBase: string;
  apiKeySource: WorkspaceApiProviderConfigSource;
  configured: boolean;
  status: WorkspaceModelDiscoveryStatus;
  models: WorkspaceDiscoveredModel[];
  error?: string;
}

export interface WorkspaceModelDiscoveryResponse {
  generatedAt: string;
  models: WorkspaceDiscoveredModel[];
  providers: WorkspaceProviderModelDiscovery[];
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
  operationType:
    | 'model_request'
    | 'image_generation'
    | 'live_token'
    | 'redeem'
    | 'invite_registration'
    | 'admin_adjustment'
    | 'order_recharge';
  source: 'credits' | 'allowance' | 'free' | 'admin' | 'order';
  status: 'pending' | 'success' | 'refunded' | 'redeemed' | 'adjusted';
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
  status: 'pending' | 'paid' | 'cancelled';
  paymentMethod: 'manual' | 'wechat' | 'alipay' | 'bank_transfer' | 'stripe' | 'other';
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

export interface WorkspaceSessionResponse {
  bootstrapped: boolean;
  workspaceName: string;
  currentUser: WorkspaceUserSummary | null;
}

export interface WorkspaceDashboardResponse extends WorkspaceSessionResponse {
  policies: WorkspaceModelPolicy[];
  recentUsage: WorkspaceUsageSummary[];
  recentRechargeOrders: WorkspaceRechargeOrderSummary[];
}

export interface WorkspaceAdminStateResponse extends WorkspaceDashboardResponse {
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
  server: {
    generatedAt: string;
    uptimeSeconds: number;
    nodeVersion: string;
    geminiApiConfigured: boolean;
    openaiApiConfigured: boolean;
    anthropicApiConfigured: boolean;
    geminiApiBase: string;
    openaiApiBase: string;
    anthropicApiBase: string;
    apiSettings: WorkspaceAdminApiProviderSetting[];
    allowedOrigins: string[];
  };
}
