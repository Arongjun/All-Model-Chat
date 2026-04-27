import type {
  WorkspaceAdminStateResponse,
  WorkspaceAdminDiagnosticsResponse,
  WorkspaceAdminApiSettingsResponse,
  WorkspaceDashboardResponse,
  WorkspaceSessionResponse,
  WorkspaceUsagePageResponse,
} from '../types';

const WORKSPACE_API_PREFIX = '/api/workspace';

type JsonBody = Record<string, unknown>;

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${WORKSPACE_API_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    payload = await response.json();
  }

  if (!response.ok) {
    const errorMessage =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error?: unknown }).error ?? 'Workspace request failed.')
        : 'Workspace request failed.';
    throw new Error(errorMessage);
  }

  return payload as T;
}

async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(`${WORKSPACE_API_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.headers ?? {}),
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(body || 'Workspace request failed.');
  }

  return body;
}

function buildUsageQueryString(query: {
  page?: number;
  pageSize?: number;
  userId?: string;
  status?: string;
  source?: string;
  operationType?: string;
  search?: string;
} = {}): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      params.set(key, String(value));
    }
  });
  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

function postJson<T>(path: string, body: JsonBody): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function patchJson<T>(path: string, body: JsonBody): Promise<T> {
  return requestJson<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function putJson<T>(path: string, body: JsonBody): Promise<T> {
  return requestJson<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export const workspaceApi = {
  getBootstrapStatus(): Promise<WorkspaceSessionResponse> {
    return requestJson<WorkspaceSessionResponse>('/bootstrap');
  },

  bootstrapAdmin(body: { name: string; email: string; password: string }): Promise<WorkspaceSessionResponse> {
    return postJson<WorkspaceSessionResponse>('/bootstrap', body);
  },

  login(body: { email: string; password: string }): Promise<WorkspaceSessionResponse> {
    return postJson<WorkspaceSessionResponse>('/session/login', body);
  },

  registerWithInvite(body: {
    name: string;
    email: string;
    password: string;
    inviteCode: string;
  }): Promise<WorkspaceSessionResponse> {
    return postJson<WorkspaceSessionResponse>('/session/register', body);
  },

  logout(): Promise<{ success: boolean }> {
    return postJson<{ success: boolean }>('/session/logout', {});
  },

  getSession(): Promise<WorkspaceSessionResponse> {
    return requestJson<WorkspaceSessionResponse>('/session');
  },

  getDashboard(): Promise<WorkspaceDashboardResponse> {
    return requestJson<WorkspaceDashboardResponse>('/dashboard');
  },

  redeemCode(code: string): Promise<WorkspaceDashboardResponse> {
    return postJson<WorkspaceDashboardResponse>('/redeem', { code });
  },

  getAdminState(): Promise<WorkspaceAdminStateResponse> {
    return requestJson<WorkspaceAdminStateResponse>('/admin/state');
  },

  getAdminDiagnostics(): Promise<WorkspaceAdminDiagnosticsResponse> {
    return requestJson<WorkspaceAdminDiagnosticsResponse>('/admin/diagnostics');
  },

  exportAdminBackupJson(): Promise<string> {
    return requestText('/admin/backup.json');
  },

  updateAdminApiSettings(body: {
    providers: Partial<Record<'gemini' | 'openai' | 'anthropic', {
      apiKey?: string | null;
      apiBase?: string | null;
      clearApiKey?: boolean;
    }>>;
  }): Promise<WorkspaceAdminApiSettingsResponse> {
    return putJson<WorkspaceAdminApiSettingsResponse>('/admin/api-settings', body);
  },

  importAdminApiSettingsFromEnvironment(): Promise<WorkspaceAdminApiSettingsResponse> {
    return postJson<WorkspaceAdminApiSettingsResponse>('/admin/api-settings/import-environment', {});
  },

  getAdminUsage(query: {
    page?: number;
    pageSize?: number;
    userId?: string;
    status?: string;
    source?: string;
    operationType?: string;
    search?: string;
  } = {}): Promise<WorkspaceUsagePageResponse> {
    return requestJson<WorkspaceUsagePageResponse>(`/admin/usage${buildUsageQueryString(query)}`);
  },

  exportAdminUsageCsv(query: {
    userId?: string;
    status?: string;
    source?: string;
    operationType?: string;
    search?: string;
  } = {}): Promise<string> {
    return requestText(`/admin/usage.csv${buildUsageQueryString(query)}`);
  },

  createUser(body: {
    name: string;
    email: string;
    password: string;
    role: 'admin' | 'member';
    credits: number;
    modelAllowances: Record<string, number>;
  }): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>('/admin/users', body);
  },

  updateUser(
    userId: string,
    body: {
      name?: string;
      role?: 'admin' | 'member';
      credits?: number;
      modelAllowances?: Record<string, number>;
      disabled?: boolean;
      password?: string;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return patchJson<WorkspaceAdminStateResponse>(`/admin/users/${encodeURIComponent(userId)}`, body);
  },

  adjustUserBalance(
    userId: string,
    body: {
      creditsDelta: number;
      modelAllowanceDeltas: Record<string, number>;
      reason?: string | null;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>(
      `/admin/users/${encodeURIComponent(userId)}/adjust-balance`,
      body,
    );
  },

  createRechargeOrder(body: {
    userId: string;
    amountCents: number;
    currency: string;
    credits: number;
    modelAllowances: Record<string, number>;
    paymentMethod: 'manual' | 'wechat' | 'alipay' | 'bank_transfer' | 'stripe' | 'other';
    externalReference?: string | null;
    note?: string | null;
  }): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>('/admin/recharge-orders', body);
  },

  markRechargeOrderPaid(orderId: string): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>(
      `/admin/recharge-orders/${encodeURIComponent(orderId)}/mark-paid`,
      {},
    );
  },

  cancelRechargeOrder(orderId: string): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>(
      `/admin/recharge-orders/${encodeURIComponent(orderId)}/cancel`,
      {},
    );
  },

  replacePolicies(body: {
    policies: Array<{
      label: string;
      modelPattern: string;
      costCredits: number;
      description?: string | null;
    }>;
  }): Promise<WorkspaceAdminStateResponse> {
    return putJson<WorkspaceAdminStateResponse>('/admin/model-policies', body);
  },

  createRedeemCode(body: {
    code: string;
    description?: string | null;
    credits: number;
    maxRedemptions: number;
    expiresAt?: string | null;
    modelAllowances: Record<string, number>;
  }): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>('/admin/redeem-codes', body);
  },

  createInviteCode(body: {
    code?: string | null;
    description?: string | null;
    role: 'admin' | 'member';
    credits: number;
    maxRedemptions: number;
    expiresAt?: string | null;
    modelAllowances: Record<string, number>;
  }): Promise<WorkspaceAdminStateResponse> {
    return postJson<WorkspaceAdminStateResponse>('/admin/invite-codes', body);
  },

  updateInviteCode(
    inviteCodeId: string,
    body: {
      active?: boolean;
    },
  ): Promise<WorkspaceAdminStateResponse> {
    return patchJson<WorkspaceAdminStateResponse>(`/admin/invite-codes/${encodeURIComponent(inviteCodeId)}`, body);
  },
};
