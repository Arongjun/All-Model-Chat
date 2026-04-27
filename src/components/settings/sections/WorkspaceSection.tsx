import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeDollarSign,
  Building2,
  FileDown,
  KeyRound,
  RefreshCcw,
  ReceiptText,
  Search,
  ShieldCheck,
  TicketPercent,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  WorkspaceAdminDiagnosticsResponse,
  WorkspaceAdminStateResponse,
  WorkspaceDashboardResponse,
  WorkspaceSessionResponse,
  WorkspaceUsagePageResponse,
  WorkspaceUserSummary,
} from '../../../types';
import { SETTINGS_INPUT_CLASS } from '../../../constants/appConstants';
import { workspaceApi } from '../../../services/workspaceApi';

type WorkspaceState = {
  session: WorkspaceSessionResponse | null;
  dashboard: WorkspaceDashboardResponse | null;
  adminState: WorkspaceAdminStateResponse | null;
  diagnostics: WorkspaceAdminDiagnosticsResponse | null;
};

type PolicyDraft = {
  label: string;
  modelPattern: string;
  costCredits: string;
  description: string;
};

type UserDraft = {
  name: string;
  role: 'admin' | 'member';
  credits: string;
  disabled: boolean;
  allowancesText: string;
  password: string;
};

type AdjustmentForm = {
  userId: string;
  creditsDelta: string;
  allowanceDeltasText: string;
  reason: string;
};

type RechargeOrderForm = {
  userId: string;
  amountYuan: string;
  currency: string;
  credits: string;
  allowancesText: string;
  paymentMethod: 'manual' | 'wechat' | 'alipay' | 'bank_transfer' | 'stripe' | 'other';
  externalReference: string;
  note: string;
};

type UsageFilters = {
  page: number;
  pageSize: number;
  userId: string;
  status: string;
  source: string;
  operationType: string;
  search: string;
};

type ApiSettingsForm = Record<'gemini' | 'openai' | 'anthropic', {
  apiKey: string;
  apiBase: string;
  clearApiKey: boolean;
}>;

const inputClassName = `w-full rounded-xl border px-3 py-2.5 text-sm transition-colors ${SETTINGS_INPUT_CLASS}`;
const textareaClassName = `${inputClassName} min-h-24 resize-y`;
const primaryButtonClassName =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--theme-text-link)] px-4 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButtonClassName =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--theme-border-secondary)] px-4 py-2.5 text-sm font-medium text-[var(--theme-text-primary)] transition-colors hover:bg-[var(--theme-bg-tertiary)]';

function formatDate(value: string | null): string {
  if (!value) {
    return '未记录';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatAllowances(allowances: Record<string, number>): string {
  return Object.entries(allowances)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseAllowances(text: string): Record<string, number> {
  return Object.fromEntries(
    text
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map<[string, number]>((line) => {
        const [rawKey, rawValue] = line.split('=').map((part) => part.trim());
        const amount = Number.parseInt(rawValue || '0', 10);
        return [rawKey, Number.isNaN(amount) ? 0 : Math.max(amount, 0)];
      })
      .filter(([key, value]) => key.length > 0 && value > 0),
  );
}

function parseAllowanceDeltas(text: string): Record<string, number> {
  return Object.fromEntries(
    text
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map<[string, number]>((line) => {
        const [rawKey, rawValue] = line.split('=').map((part) => part.trim());
        const amount = Number.parseInt(rawValue || '0', 10);
        return [rawKey, Number.isNaN(amount) ? 0 : amount];
      })
      .filter(([key, value]) => key.length > 0 && value !== 0),
  );
}

function formatOperationType(value: string): string {
  if (value === 'order_recharge') {
    return '订单充值';
  }

  switch (value) {
    case 'image_generation':
      return '生图';
    case 'live_token':
      return 'Live';
    case 'redeem':
      return '兑换';
    case 'invite_registration':
      return '邀请注册';
    case 'admin_adjustment':
      return '调账';
    default:
      return '模型请求';
  }
}

function formatUsageSource(value: string): string {
  if (value === 'order') {
    return '订单';
  }

  switch (value) {
    case 'credits':
      return '积分';
    case 'allowance':
      return '次数包';
    case 'admin':
      return '管理员';
    default:
      return '免费';
  }
}

function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: currency || 'CNY',
    }).format(amountCents / 100);
  } catch {
    return `${currency || 'CNY'} ${(amountCents / 100).toFixed(2)}`;
  }
}

function parseAmountCents(value: string): number {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? Math.max(Math.round(amount * 100), 0) : 0;
}

function formatPaymentMethod(value: string): string {
  switch (value) {
    case 'wechat':
      return '微信';
    case 'alipay':
      return '支付宝';
    case 'bank_transfer':
      return '银行转账';
    case 'stripe':
      return 'Stripe';
    case 'other':
      return '其他';
    default:
      return '手工确认';
  }
}

function formatRechargeOrderStatus(value: string): string {
  switch (value) {
    case 'paid':
      return '已到账';
    case 'cancelled':
      return '已取消';
    default:
      return '待确认';
  }
}

function createEmptyApiSettingsForm(): ApiSettingsForm {
  return {
    gemini: { apiKey: '', apiBase: '', clearApiKey: false },
    openai: { apiKey: '', apiBase: '', clearApiKey: false },
    anthropic: { apiKey: '', apiBase: '', clearApiKey: false },
  };
}

function formatApiConfigSource(value: string): string {
  switch (value) {
    case 'workspace':
      return '后台配置';
    case 'environment':
      return '环境变量';
    default:
      return '未配置';
  }
}

function formatOrderBenefits(credits: number, allowances: Record<string, number>): string {
  const parts = [
    credits > 0 ? `${credits} 积分` : '',
    ...Object.entries(allowances).map(([pattern, amount]) => `${pattern} ${amount} 次`),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '无额度';
}

function formatUsageDelta(record: WorkspaceDashboardResponse['recentUsage'][number]): string {
  const allowanceEntries = Object.entries(record.allowanceChanges ?? {});
  const parts = [
    record.creditsDelta !== 0 ? `${record.creditsDelta} 积分` : '',
    ...allowanceEntries.map(([pattern, amount]) => `${pattern} ${amount > 0 ? '+' : ''}${amount} 次`),
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(' / ');
  }

  if (record.allowanceDelta !== 0) {
    return `${record.allowanceDelta} 次`;
  }

  return '0';
}

function emptyWorkspaceState(): WorkspaceState {
  return {
    session: null,
    dashboard: null,
    adminState: null,
    diagnostics: null,
  };
}

function buildUserDraft(user: WorkspaceUserSummary): UserDraft {
  return {
    name: user.name,
    role: user.role,
    credits: String(user.credits),
    disabled: user.disabled,
    allowancesText: formatAllowances(user.modelAllowances),
    password: '',
  };
}

const SectionCard: React.FC<{
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}> = ({ icon: Icon, title, description, children }) => (
  <section className="rounded-3xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-secondary)] p-5 shadow-sm">
    <div className="mb-4 flex items-start gap-3">
      <div className="rounded-2xl bg-[var(--theme-bg-tertiary)] p-2.5">
        <Icon size={18} className="text-[var(--theme-text-link)]" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-[var(--theme-text-primary)]">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-[var(--theme-text-secondary)]">{description}</p>
      </div>
    </div>
    {children}
  </section>
);

export const WorkspaceSection: React.FC = () => {
  const [state, setState] = useState<WorkspaceState>(emptyWorkspaceState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [usagePage, setUsagePage] = useState<WorkspaceUsagePageResponse | null>(null);

  const [bootstrapForm, setBootstrapForm] = useState({ name: '', email: '', password: '' });
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [registerForm, setRegisterForm] = useState({ name: '', email: '', password: '', inviteCode: '' });
  const [redeemCode, setRedeemCode] = useState('');
  const [createUserForm, setCreateUserForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'member' as 'admin' | 'member',
    credits: '100',
    allowancesText: '',
  });
  const [redeemForm, setRedeemForm] = useState({
    code: '',
    description: '',
    credits: '100',
    maxRedemptions: '1',
    expiresAt: '',
    allowancesText: '',
  });
  const [inviteForm, setInviteForm] = useState({
    code: '',
    description: '',
    credits: '100',
    maxRedemptions: '1',
    expiresAt: '',
    allowancesText: '',
  });
  const [adjustmentForm, setAdjustmentForm] = useState<AdjustmentForm>({
    userId: '',
    creditsDelta: '0',
    allowanceDeltasText: '',
    reason: '',
  });
  const [rechargeOrderForm, setRechargeOrderForm] = useState<RechargeOrderForm>({
    userId: '',
    amountYuan: '99',
    currency: 'CNY',
    credits: '100',
    allowancesText: '',
    paymentMethod: 'manual',
    externalReference: '',
    note: '',
  });
  const [usageFilters, setUsageFilters] = useState<UsageFilters>({
    page: 1,
    pageSize: 20,
    userId: 'all',
    status: 'all',
    source: 'all',
    operationType: 'all',
    search: '',
  });
  const usageFiltersRef = useRef(usageFilters);
  const [apiSettingsForm, setApiSettingsForm] = useState<ApiSettingsForm>(createEmptyApiSettingsForm);
  const [policyDrafts, setPolicyDrafts] = useState<PolicyDraft[]>([]);
  const [userDrafts, setUserDrafts] = useState<Record<string, UserDraft>>({});

  useEffect(() => {
    usageFiltersRef.current = usageFilters;
  }, [usageFilters]);

  const loadWorkspaceState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const session = await workspaceApi.getSession();
      if (!session.bootstrapped || !session.currentUser) {
        setUsagePage(null);
        setState({
          session,
          dashboard: null,
          adminState: null,
          diagnostics: null,
        });
        return;
      }

      if (session.currentUser.role === 'admin') {
        const [adminState, nextUsagePage, diagnostics] = await Promise.all([
          workspaceApi.getAdminState(),
          workspaceApi.getAdminUsage(usageFiltersRef.current),
          workspaceApi.getAdminDiagnostics(),
        ]);
        setUsagePage(nextUsagePage);
        setState({
          session,
          dashboard: adminState,
          adminState,
          diagnostics,
        });
        return;
      }

      const dashboard = await workspaceApi.getDashboard();
      setUsagePage(null);
      setState({
        session,
        dashboard,
        adminState: null,
        diagnostics: null,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载工作站信息失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaceState();
  }, [loadWorkspaceState]);

  useEffect(() => {
    const policies = state.adminState?.policies ?? [];
    setPolicyDrafts(
      policies.map((policy) => ({
        label: policy.label,
        modelPattern: policy.modelPattern,
        costCredits: String(policy.costCredits),
        description: policy.description || '',
      })),
    );
  }, [state.adminState?.policies]);

  useEffect(() => {
    const providerSettings = state.diagnostics?.server.apiSettings ?? [];
    if (providerSettings.length === 0) {
      return;
    }

    setApiSettingsForm((prev) => {
      const next = { ...prev };
      providerSettings.forEach((providerSetting) => {
        next[providerSetting.provider] = {
          ...next[providerSetting.provider],
          apiBase: providerSetting.apiBase,
          clearApiKey: false,
        };
      });
      return next;
    });
  }, [state.diagnostics?.server.apiSettings]);

  useEffect(() => {
    const users = state.adminState?.users ?? [];
    setUserDrafts(
      Object.fromEntries(users.map((user) => [user.id, buildUserDraft(user)])),
    );
    setAdjustmentForm((prev) => {
      if (prev.userId || users.length === 0) {
        return prev;
      }
      return {
        ...prev,
        userId: users[0]?.id ?? '',
      };
    });
    setRechargeOrderForm((prev) => {
      if (prev.userId || users.length === 0) {
        return prev;
      }
      return {
        ...prev,
        userId: users[0]?.id ?? '',
      };
    });
  }, [state.adminState?.users]);

  const currentUser = state.session?.currentUser ?? null;
  const workspaceName =
    state.session?.workspaceName
    ?? state.dashboard?.workspaceName
    ?? state.adminState?.workspaceName
    ?? '阿荣AI工作站';
  const bootstrapped = state.session?.bootstrapped ?? false;
  const dashboard = state.adminState ?? state.dashboard;
  const isAdmin = currentUser?.role === 'admin' && !!state.adminState;
  const diagnostics = state.diagnostics;
  const recentUsage = dashboard?.recentUsage ?? [];
  const recentRechargeOrders = dashboard?.recentRechargeOrders ?? [];

  const allowanceCount = useMemo(
    () => Object.values(currentUser?.modelAllowances ?? {}).reduce((sum, value) => sum + value, 0),
    [currentUser?.modelAllowances],
  );

  const runAction = async (actionKey: string, action: () => Promise<void>) => {
    setBusyAction(actionKey);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败，请稍后重试。');
    } finally {
      setBusyAction(null);
    }
  };

  const renderUsageTable = (usageRows: WorkspaceDashboardResponse['recentUsage']) => (
    <div className="overflow-hidden rounded-2xl border border-[var(--theme-border-primary)]">
      <div className="grid grid-cols-[1.3fr_1fr_0.9fr_1fr] gap-3 bg-[var(--theme-bg-primary)] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--theme-text-tertiary)]">
        <span>模型</span>
        <span>扣费方式</span>
        <span>变化</span>
        <span>时间</span>
      </div>
      {usageRows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-[var(--theme-text-secondary)]">还没有使用记录。</div>
      ) : (
        usageRows.map((record) => (
          <div
            key={record.id}
            className="grid grid-cols-[1.3fr_1fr_0.9fr_1fr] gap-3 border-t border-[var(--theme-border-primary)] px-4 py-3 text-sm text-[var(--theme-text-primary)]"
          >
            <div>
              <div className="font-medium">{record.modelId}</div>
              <div className="text-xs text-[var(--theme-text-secondary)]">{record.note || record.requestPath}</div>
            </div>
            <div>{formatUsageSource(record.source)}</div>
            <div>{formatUsageDelta(record)}</div>
            <div className="text-xs text-[var(--theme-text-secondary)]">{formatDate(record.createdAt)}</div>
          </div>
        ))
      )}
    </div>
  );

  const renderRechargeOrders = (
    orders: WorkspaceDashboardResponse['recentRechargeOrders'],
    showAdminActions = false,
  ) => (
    <div className="overflow-hidden rounded-2xl border border-[var(--theme-border-primary)]">
      <div className="grid grid-cols-[1.1fr_0.9fr_1fr_1.2fr] gap-3 bg-[var(--theme-bg-primary)] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--theme-text-tertiary)]">
        <span>订单</span>
        <span>状态</span>
        <span>金额</span>
        <span>到账额度</span>
      </div>
      {orders.length === 0 ? (
        <div className="px-4 py-6 text-sm text-[var(--theme-text-secondary)]">还没有充值订单。</div>
      ) : (
        orders.map((order) => (
          <div
            key={order.id}
            className="grid gap-3 border-t border-[var(--theme-border-primary)] px-4 py-3 text-sm text-[var(--theme-text-primary)] md:grid-cols-[1.1fr_0.9fr_1fr_1.2fr]"
          >
            <div>
              <div className="font-medium">{order.orderNo}</div>
              <div className="text-xs text-[var(--theme-text-secondary)]">
                {order.userName} · {formatDate(order.createdAt)}
              </div>
              {order.externalReference ? (
                <div className="text-xs text-[var(--theme-text-secondary)]">外部单号：{order.externalReference}</div>
              ) : null}
            </div>
            <div>
              <div>{formatRechargeOrderStatus(order.status)}</div>
              <div className="text-xs text-[var(--theme-text-secondary)]">{formatPaymentMethod(order.paymentMethod)}</div>
              {order.confirmedByName ? (
                <div className="text-xs text-[var(--theme-text-secondary)]">确认：{order.confirmedByName}</div>
              ) : null}
            </div>
            <div>{formatMoney(order.amountCents, order.currency)}</div>
            <div>
              <div>{formatOrderBenefits(order.credits, order.modelAllowances)}</div>
              {order.note ? (
                <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">{order.note}</div>
              ) : null}
              {showAdminActions && order.status === 'pending' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction(`pay-order-${order.id}`, async () => {
                        await workspaceApi.markRechargeOrderPaid(order.id);
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    确认到账
                  </button>
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction(`cancel-order-${order.id}`, async () => {
                        await workspaceApi.cancelRechargeOrder(order.id);
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    取消订单
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-3xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-secondary)]">
        <div className="flex items-center gap-3 text-sm text-[var(--theme-text-secondary)]">
          <RefreshCcw size={16} className="animate-spin" />
          正在加载工作站配置...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-[var(--theme-border-primary)] bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.14),transparent_45%),var(--theme-bg-secondary)] p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--theme-bg-tertiary)] px-3 py-1 text-xs font-medium text-[var(--theme-text-link)]">
              <Building2 size={14} />
              多用户工作站底座
            </div>
            <h2 className="mt-3 text-2xl font-semibold text-[var(--theme-text-primary)]">{workspaceName}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--theme-text-secondary)]">
              这一层负责账号、登录态、积分、模型次数包、兑换码和后台管理。聊天能力还是原来的体验，但真正的额度控制已经收回到服务端。
            </p>
          </div>
          <button
            type="button"
            className={secondaryButtonClassName}
            onClick={() => {
              void runAction('refresh', loadWorkspaceState);
            }}
            disabled={busyAction !== null}
          >
            <RefreshCcw size={16} className={busyAction === 'refresh' ? 'animate-spin' : ''} />
            刷新状态
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--theme-text-primary)]">
          {error}
        </div>
      ) : null}

      {!bootstrapped ? (
        <SectionCard
          icon={ShieldCheck}
          title="初始化管理员"
          description="首次部署时，先创建你的管理员账号。创建完成后，系统会切换为真正的多用户工作站模式。"
        >
          <div className="grid gap-4 md:grid-cols-3">
            <input
              className={inputClassName}
              placeholder="管理员名称"
              value={bootstrapForm.name}
              onChange={(event) => setBootstrapForm((prev) => ({ ...prev, name: event.target.value }))}
            />
            <input
              className={inputClassName}
              placeholder="管理员邮箱"
              value={bootstrapForm.email}
              onChange={(event) => setBootstrapForm((prev) => ({ ...prev, email: event.target.value }))}
            />
            <input
              className={inputClassName}
              type="password"
              placeholder="管理员密码"
              value={bootstrapForm.password}
              onChange={(event) => setBootstrapForm((prev) => ({ ...prev, password: event.target.value }))}
            />
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-sm text-[var(--theme-text-secondary)]">
              建议密码至少 8 位。初始化后会自动登录当前管理员，并获得默认 500 积分用于调试。
            </p>
            <button
              type="button"
              className={primaryButtonClassName}
              disabled={busyAction !== null}
              onClick={() => {
                void runAction('bootstrap', async () => {
                  await workspaceApi.bootstrapAdmin(bootstrapForm);
                  setBootstrapForm({ name: '', email: '', password: '' });
                  await loadWorkspaceState();
                });
              }}
            >
              创建管理员
            </button>
          </div>
        </SectionCard>
      ) : !currentUser ? (
        <>
          <SectionCard
          icon={ShieldCheck}
          title="登录工作站"
          description="管理员和成员都通过服务端账号登录。登录后，Gemini、OpenAI-compatible、Anthropic-compatible 与生图请求都会自动带上工作站配额校验。"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <input
              className={inputClassName}
              placeholder="邮箱"
              value={loginForm.email}
              onChange={(event) => setLoginForm((prev) => ({ ...prev, email: event.target.value }))}
            />
            <input
              className={inputClassName}
              type="password"
              placeholder="密码"
              value={loginForm.password}
              onChange={(event) => setLoginForm((prev) => ({ ...prev, password: event.target.value }))}
            />
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-sm text-[var(--theme-text-secondary)]">
              如果你刚完成初始化，请直接用管理员账号登录。未来也可以给团队成员单独开账号和额度。
            </p>
            <button
              type="button"
              className={primaryButtonClassName}
              disabled={busyAction !== null}
              onClick={() => {
                void runAction('login', async () => {
                  await workspaceApi.login(loginForm);
                  setLoginForm({ email: '', password: '' });
                  await loadWorkspaceState();
                });
              }}
            >
              登录
            </button>
          </div>
          </SectionCard>

          <SectionCard
            icon={TicketPercent}
            title="邀请码注册"
            description="管理员生成邀请码后，新用户可以在这里自助注册。邀请码可以携带初始积分、模型次数包、有效期和人数上限。"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <input
                className={inputClassName}
                placeholder="你的名称"
                value={registerForm.name}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, name: event.target.value }))}
              />
              <input
                className={inputClassName}
                placeholder="邮箱"
                value={registerForm.email}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, email: event.target.value }))}
              />
              <input
                className={inputClassName}
                type="password"
                placeholder="设置密码，至少 6 位"
                value={registerForm.password}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, password: event.target.value }))}
              />
              <input
                className={inputClassName}
                placeholder="邀请码"
                value={registerForm.inviteCode}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, inviteCode: event.target.value }))}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-sm text-[var(--theme-text-secondary)]">
                注册成功后会自动登录，并立即获得邀请码里配置的积分和模型次数包。
              </p>
              <button
                type="button"
                className={primaryButtonClassName}
                disabled={busyAction !== null}
                onClick={() => {
                  void runAction('register-with-invite', async () => {
                    await workspaceApi.registerWithInvite(registerForm);
                    setRegisterForm({ name: '', email: '', password: '', inviteCode: '' });
                    await loadWorkspaceState();
                  });
                }}
              >
                注册并登录
              </button>
            </div>
          </SectionCard>
        </>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <SectionCard
              icon={BadgeDollarSign}
              title="积分余额"
              description="当模型没有单独次数包时，系统会按模型策略直接扣积分。"
            >
              <div className="text-3xl font-semibold text-[var(--theme-text-primary)]">{currentUser.credits}</div>
            </SectionCard>
            <SectionCard
              icon={TicketPercent}
              title="次数包余额"
              description="更适合图像模型。比如你可以单独给某个用户发 20 次 gpt-image 或 imagen 出图额度。"
            >
              <div className="text-3xl font-semibold text-[var(--theme-text-primary)]">{allowanceCount}</div>
            </SectionCard>
            <SectionCard
              icon={Users}
              title="当前身份"
              description="管理员可以直接管理用户、模型策略和兑换码；成员只能查看与兑换自己的额度。"
            >
              <div className="text-xl font-semibold text-[var(--theme-text-primary)]">
                {currentUser.name} · {currentUser.role === 'admin' ? '管理员' : '成员'}
              </div>
              <div className="mt-2 text-sm text-[var(--theme-text-secondary)]">
                最后登录：{formatDate(currentUser.lastLoginAt)}
              </div>
              <button
                type="button"
                className={`${secondaryButtonClassName} mt-4`}
                disabled={busyAction !== null}
                onClick={() => {
                  void runAction('logout', async () => {
                    await workspaceApi.logout();
                    await loadWorkspaceState();
                  });
                }}
              >
                退出登录
              </button>
            </SectionCard>
          </div>

          <SectionCard
            icon={TicketPercent}
            title="兑换码充值"
            description="支持按积分充值，也支持附带模型次数包。用户只需要输入兑换码，不需要你手动改数据库。"
          >
            <div className="flex flex-col gap-3 md:flex-row">
              <input
                className={inputClassName}
                placeholder="输入兑换码"
                value={redeemCode}
                onChange={(event) => setRedeemCode(event.target.value)}
              />
              <button
                type="button"
                className={primaryButtonClassName}
                disabled={busyAction !== null}
                onClick={() => {
                  void runAction('redeem', async () => {
                    await workspaceApi.redeemCode(redeemCode);
                    setRedeemCode('');
                    await loadWorkspaceState();
                  });
                }}
              >
                立即兑换
              </button>
            </div>
            {Object.keys(currentUser.modelAllowances).length > 0 ? (
              <div className="mt-4 rounded-2xl bg-[var(--theme-bg-primary)] px-4 py-3">
                <div className="text-sm font-medium text-[var(--theme-text-primary)]">当前次数包</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {Object.entries(currentUser.modelAllowances).map(([pattern, amount]) => (
                    <div key={pattern} className="rounded-xl border border-[var(--theme-border-primary)] px-3 py-2 text-sm">
                      <div className="font-medium text-[var(--theme-text-primary)]">{pattern}</div>
                      <div className="mt-1 text-[var(--theme-text-secondary)]">{amount} 次</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            icon={ReceiptText}
            title="我的充值记录"
            description="这里展示已经创建的充值订单和到账状态，方便你核对付款、积分和模型次数包是否一致。"
          >
            {renderRechargeOrders(recentRechargeOrders)}
          </SectionCard>

          <SectionCard
            icon={Building2}
            title="我的近期使用"
            description="这里记录的是服务端确认过的额度扣减结果，所以它可以真正作为运营和风控依据。"
          >
            {renderUsageTable(recentUsage)}
          </SectionCard>

          {isAdmin ? (
            <>
              <SectionCard
                icon={ShieldCheck}
                title="运维健康与数据备份"
                description="上线后先保证看得见、备得出、能迁移。这里汇总服务端状态、SQLite 文件信息和完整工作站备份。"
              >
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
                    <div className="text-xs text-[var(--theme-text-secondary)]">用户总数</div>
                    <div className="mt-2 text-2xl font-semibold text-[var(--theme-text-primary)]">
                      {diagnostics?.counts.users ?? state.adminState?.users.length ?? 0}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      管理员 {diagnostics?.counts.admins ?? 0} / 停用 {diagnostics?.counts.disabledUsers ?? 0}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
                    <div className="text-xs text-[var(--theme-text-secondary)]">SQLite 状态</div>
                    <div className="mt-2 text-lg font-semibold text-[var(--theme-text-primary)]">
                      {diagnostics?.storage.database.exists ? '已持久化' : '等待首次写入'}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      {formatFileSize(diagnostics?.storage.database.sizeBytes ?? 0)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
                    <div className="text-xs text-[var(--theme-text-secondary)]">订单与审计</div>
                    <div className="mt-2 text-2xl font-semibold text-[var(--theme-text-primary)]">
                      {diagnostics?.counts.usageRecords ?? 0}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      待确认订单 {diagnostics?.counts.pendingRechargeOrders ?? 0}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
                    <div className="text-xs text-[var(--theme-text-secondary)]">模型密钥</div>
                    <div className="mt-2 text-sm font-semibold text-[var(--theme-text-primary)]">
                      Gemini {diagnostics?.server.geminiApiConfigured ? '已配置' : '未配置'}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      OpenAI {diagnostics?.server.openaiApiConfigured ? '已配置' : '未配置'}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      Anthropic {diagnostics?.server.anthropicApiConfigured ? '已配置' : '未配置'}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] px-4 py-3 text-sm text-[var(--theme-text-secondary)]">
                  <div className="font-medium text-[var(--theme-text-primary)]">数据文件</div>
                  <div className="mt-1 break-all">
                    {diagnostics?.storage.database.filePath ?? '暂无诊断信息'}
                  </div>
                  <div className="mt-2">
                    最近检测：{formatDate(diagnostics?.generatedAt ?? null)}，Node {diagnostics?.server.nodeVersion ?? '-'}，
                    运行 {diagnostics?.server.uptimeSeconds ?? 0} 秒
                  </div>
                  <div className="mt-2 text-amber-600">
                    完整备份包含账号密码哈希、API 配置、积分、次数包、订单和审计数据，请只保存到可信位置。
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap justify-end gap-3">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('refresh-diagnostics', async () => {
                        const nextDiagnostics = await workspaceApi.getAdminDiagnostics();
                        setState((prev) => ({ ...prev, diagnostics: nextDiagnostics }));
                      });
                    }}
                  >
                    <RefreshCcw size={16} className={busyAction === 'refresh-diagnostics' ? 'animate-spin' : ''} />
                    刷新诊断
                  </button>
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('download-backup', async () => {
                        const backupJson = await workspaceApi.exportAdminBackupJson();
                        const blob = new Blob([backupJson], { type: 'application/json;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement('a');
                        anchor.href = url;
                        anchor.download = `arong-workspace-backup-${new Date().toISOString().slice(0, 10)}.json`;
                        anchor.click();
                        URL.revokeObjectURL(url);
                      });
                    }}
                  >
                    <FileDown size={16} />
                    下载完整备份
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                icon={KeyRound}
                title="模型 API 配置"
                description="环境变量适合首启兜底，后台配置适合日常运维。保存后会写入 SQLite 并立即用于服务端代理请求；密钥只显示尾号，不会回显明文。"
              >
                <div className="grid gap-4 lg:grid-cols-3">
                  {(diagnostics?.server.apiSettings ?? []).map((providerSetting) => {
                    const providerForm = apiSettingsForm[providerSetting.provider];
                    return (
                      <div
                        key={providerSetting.provider}
                        className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-[var(--theme-text-primary)]">
                              {providerSetting.label}
                            </div>
                            <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                              密钥来源：{formatApiConfigSource(providerSetting.apiKeySource)}
                              {providerSetting.apiKeyPreview ? ` (${providerSetting.apiKeyPreview})` : ''}
                            </div>
                          </div>
                          <span className={`rounded-full px-2.5 py-1 text-xs ${
                            providerSetting.apiKeyConfigured
                              ? 'bg-emerald-500/10 text-emerald-600'
                              : 'bg-amber-500/10 text-amber-600'
                          }`}>
                            {providerSetting.apiKeyConfigured ? '可用' : '缺密钥'}
                          </span>
                        </div>

                        <label className="mt-4 block text-xs font-medium text-[var(--theme-text-secondary)]">
                          新 API Key
                          <input
                            className={`${inputClassName} mt-1`}
                            type="password"
                            placeholder={providerSetting.apiKeyConfigured ? '留空则保持当前密钥' : '填写后立即生效'}
                            value={providerForm.apiKey}
                            onChange={(event) => {
                              const value = event.target.value;
                              setApiSettingsForm((prev) => ({
                                ...prev,
                                [providerSetting.provider]: {
                                  ...prev[providerSetting.provider],
                                  apiKey: value,
                                  clearApiKey: false,
                                },
                              }));
                            }}
                          />
                        </label>

                        <label className="mt-3 block text-xs font-medium text-[var(--theme-text-secondary)]">
                          Base URL
                          <input
                            className={`${inputClassName} mt-1`}
                            placeholder="https://..."
                            value={providerForm.apiBase}
                            onChange={(event) => {
                              const value = event.target.value;
                              setApiSettingsForm((prev) => ({
                                ...prev,
                                [providerSetting.provider]: {
                                  ...prev[providerSetting.provider],
                                  apiBase: value,
                                },
                              }));
                            }}
                          />
                        </label>

                        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--theme-text-secondary)]">
                          <span>Base 来源：{formatApiConfigSource(providerSetting.apiBaseSource)}</span>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={providerForm.clearApiKey}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setApiSettingsForm((prev) => ({
                                  ...prev,
                                  [providerSetting.provider]: {
                                    ...prev[providerSetting.provider],
                                    apiKey: '',
                                    clearApiKey: checked,
                                  },
                                }));
                              }}
                            />
                            清空后台密钥
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] px-4 py-3 text-sm text-[var(--theme-text-secondary)]">
                  后台配置和环境变量不是“互相覆盖文件”的同步，而是运行时双源合并：后台配置优先；后台为空时自动回退环境变量。一键导入环境变量会在服务端把当前容器环境里的 Key/Base 写入 SQLite，不会把密钥明文发给浏览器。
                </div>

                <div className="mt-4 flex flex-wrap justify-end gap-3">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('import-api-env', async () => {
                        await workspaceApi.importAdminApiSettingsFromEnvironment();
                        const nextDiagnostics = await workspaceApi.getAdminDiagnostics();
                        setState((prev) => ({ ...prev, diagnostics: nextDiagnostics }));
                      });
                    }}
                  >
                    <RefreshCcw size={16} className={busyAction === 'import-api-env' ? 'animate-spin' : ''} />
                    从环境变量导入
                  </button>
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('save-api-settings', async () => {
                        await workspaceApi.updateAdminApiSettings({
                          providers: Object.fromEntries(
                            Object.entries(apiSettingsForm).map(([provider, form]) => [
                              provider,
                              {
                                apiBase: form.apiBase,
                                ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
                                ...(form.clearApiKey ? { clearApiKey: true } : {}),
                              },
                            ]),
                          ),
                        });
                        setApiSettingsForm((prev) => Object.fromEntries(
                          Object.entries(prev).map(([provider, form]) => [
                            provider,
                            { ...form, apiKey: '', clearApiKey: false },
                          ]),
                        ) as ApiSettingsForm);
                        const nextDiagnostics = await workspaceApi.getAdminDiagnostics();
                        setState((prev) => ({ ...prev, diagnostics: nextDiagnostics }));
                      });
                    }}
                  >
                    保存 API 配置
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                icon={TicketPercent}
                title="邀请码注册工厂"
                description="给新用户自助注册使用。邀请码和充值兑换码分开管理，可以配置注册送的积分、模型次数包、有效期和最多注册人数。"
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <input
                    className={inputClassName}
                    placeholder="邀请码，留空自动生成"
                    value={inviteForm.code}
                    onChange={(event) => setInviteForm((prev) => ({ ...prev, code: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="说明，比如内测用户"
                    value={inviteForm.description}
                    onChange={(event) => setInviteForm((prev) => ({ ...prev, description: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="注册送积分"
                    value={inviteForm.credits}
                    onChange={(event) => setInviteForm((prev) => ({ ...prev, credits: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="最多注册人数"
                    value={inviteForm.maxRedemptions}
                    onChange={(event) =>
                      setInviteForm((prev) => ({ ...prev, maxRedemptions: event.target.value }))
                    }
                  />
                  <input
                    className={inputClassName}
                    placeholder="过期时间，可留空"
                    value={inviteForm.expiresAt}
                    onChange={(event) => setInviteForm((prev) => ({ ...prev, expiresAt: event.target.value }))}
                  />
                  <textarea
                    className={textareaClassName}
                    placeholder={'注册送次数包，按行填写\nimagen-4.0-*=10\ngpt-image-*=5'}
                    value={inviteForm.allowancesText}
                    onChange={(event) =>
                      setInviteForm((prev) => ({ ...prev, allowancesText: event.target.value }))
                    }
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('create-invite-code', async () => {
                        await workspaceApi.createInviteCode({
                          code: inviteForm.code || null,
                          description: inviteForm.description || null,
                          role: 'member',
                          credits: Number.parseInt(inviteForm.credits || '0', 10) || 0,
                          maxRedemptions: Number.parseInt(inviteForm.maxRedemptions || '1', 10) || 1,
                          expiresAt: inviteForm.expiresAt || null,
                          modelAllowances: parseAllowances(inviteForm.allowancesText),
                        });
                        setInviteForm({
                          code: '',
                          description: '',
                          credits: '100',
                          maxRedemptions: '1',
                          expiresAt: '',
                          allowancesText: '',
                        });
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    生成邀请码
                  </button>
                </div>

                <div className="mt-6 space-y-3">
                  {(state.adminState?.inviteCodes ?? []).map((code) => (
                    <div
                      key={code.id}
                      className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold text-[var(--theme-text-primary)]">{code.code}</div>
                          <div className="text-sm text-[var(--theme-text-secondary)]">
                            {code.description} · 注册 {code.redeemedCount}/{code.maxRedemptions}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-[var(--theme-bg-tertiary)] px-3 py-1 text-xs text-[var(--theme-text-secondary)]">
                            {code.active ? '可用' : '已停用'}
                          </span>
                          <button
                            type="button"
                            className={secondaryButtonClassName}
                            disabled={busyAction !== null}
                            onClick={() => {
                              void runAction(`toggle-invite-${code.id}`, async () => {
                                await workspaceApi.updateInviteCode(code.id, { active: !code.active });
                                await loadWorkspaceState();
                              });
                            }}
                          >
                            {code.active ? '停用' : '启用'}
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-[var(--theme-text-secondary)] md:grid-cols-3">
                        <span>注册送积分：{code.credits}</span>
                        <span>身份：{code.role === 'admin' ? '管理员' : '成员'}</span>
                        <span>过期：{formatDate(code.expiresAt)}</span>
                      </div>
                      {Object.keys(code.modelAllowances).length > 0 ? (
                        <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-[var(--theme-bg-tertiary)] p-3 text-xs text-[var(--theme-text-secondary)]">
                          {formatAllowances(code.modelAllowances)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                  {(state.adminState?.inviteCodes ?? []).length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[var(--theme-border-primary)] px-4 py-6 text-center text-sm text-[var(--theme-text-secondary)]">
                      还没有邀请码。生成一个后，新用户就能在登录页自助注册了。
                    </div>
                  ) : null}
                </div>
              </SectionCard>

              <SectionCard
                icon={Users}
                title="用户管理"
                description="管理员可以给每个成员发独立积分，或者直接发某个模型的次数包，比如 `gpt-image-*` 或 `imagen-4.0-*`。"
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <input
                    className={inputClassName}
                    placeholder="成员名称"
                    value={createUserForm.name}
                    onChange={(event) => setCreateUserForm((prev) => ({ ...prev, name: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="成员邮箱"
                    value={createUserForm.email}
                    onChange={(event) => setCreateUserForm((prev) => ({ ...prev, email: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="成员密码"
                    type="password"
                    value={createUserForm.password}
                    onChange={(event) => setCreateUserForm((prev) => ({ ...prev, password: event.target.value }))}
                  />
                  <select
                    className={inputClassName}
                    value={createUserForm.role}
                    onChange={(event) =>
                      setCreateUserForm((prev) => ({ ...prev, role: event.target.value as 'admin' | 'member' }))
                    }
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                  <input
                    className={inputClassName}
                    placeholder="初始积分"
                    value={createUserForm.credits}
                    onChange={(event) => setCreateUserForm((prev) => ({ ...prev, credits: event.target.value }))}
                  />
                  <textarea
                    className={textareaClassName}
                    placeholder={'次数包，按行填写\nimagen-4.0-*=10\ngpt-image-*=5'}
                    value={createUserForm.allowancesText}
                    onChange={(event) =>
                      setCreateUserForm((prev) => ({ ...prev, allowancesText: event.target.value }))
                    }
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('create-user', async () => {
                        await workspaceApi.createUser({
                          name: createUserForm.name,
                          email: createUserForm.email,
                          password: createUserForm.password,
                          role: createUserForm.role,
                          credits: Number.parseInt(createUserForm.credits || '0', 10) || 0,
                          modelAllowances: parseAllowances(createUserForm.allowancesText),
                        });
                        setCreateUserForm({
                          name: '',
                          email: '',
                          password: '',
                          role: 'member',
                          credits: '100',
                          allowancesText: '',
                        });
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    新增用户
                  </button>
                </div>

                <div className="mt-6 space-y-4">
                  {(state.adminState?.users ?? []).map((user) => {
                    const draft = userDrafts[user.id] ?? buildUserDraft(user);
                    return (
                      <div
                        key={user.id}
                        className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4"
                      >
                        <div className="grid gap-4 md:grid-cols-3">
                          <input
                            className={inputClassName}
                            value={draft.name}
                            onChange={(event) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [user.id]: { ...draft, name: event.target.value },
                              }))
                            }
                          />
                          <select
                            className={inputClassName}
                            value={draft.role}
                            onChange={(event) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [user.id]: { ...draft, role: event.target.value as 'admin' | 'member' },
                              }))
                            }
                          >
                            <option value="member">成员</option>
                            <option value="admin">管理员</option>
                          </select>
                          <input
                            className={inputClassName}
                            value={draft.credits}
                            onChange={(event) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [user.id]: { ...draft, credits: event.target.value },
                              }))
                            }
                          />
                          <textarea
                            className={textareaClassName}
                            value={draft.allowancesText}
                            onChange={(event) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [user.id]: { ...draft, allowancesText: event.target.value },
                              }))
                            }
                          />
                          <input
                            className={inputClassName}
                            type="password"
                            placeholder="留空则不修改密码"
                            value={draft.password}
                            onChange={(event) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [user.id]: { ...draft, password: event.target.value },
                              }))
                            }
                          />
                          <label className="flex items-center gap-2 rounded-xl border border-[var(--theme-border-secondary)] px-3 py-2.5 text-sm text-[var(--theme-text-primary)]">
                            <input
                              type="checkbox"
                              checked={draft.disabled}
                              onChange={(event) =>
                                setUserDrafts((prev) => ({
                                  ...prev,
                                  [user.id]: { ...draft, disabled: event.target.checked },
                                }))
                              }
                            />
                            停用该账号
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--theme-text-secondary)]">
                          <span>{user.email}</span>
                          <span>创建于 {formatDate(user.createdAt)}</span>
                          <span>最后登录 {formatDate(user.lastLoginAt)}</span>
                        </div>
                        <div className="mt-4 flex justify-end">
                          <button
                            type="button"
                            className={secondaryButtonClassName}
                            disabled={busyAction !== null}
                            onClick={() => {
                              void runAction(`save-user-${user.id}`, async () => {
                                await workspaceApi.updateUser(user.id, {
                                  name: draft.name,
                                  role: draft.role,
                                  credits: Number.parseInt(draft.credits || '0', 10) || 0,
                                  modelAllowances: parseAllowances(draft.allowancesText),
                                  disabled: draft.disabled,
                                  password: draft.password || undefined,
                                });
                                await loadWorkspaceState();
                              });
                            }}
                          >
                            保存用户
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>

              <SectionCard
                icon={ReceiptText}
                title="充值订单与收款确认"
                description="适合线下收款、企业转账或客服代下单：先创建待确认订单，钱到账后再一键入账，系统会同步生成审计流水。"
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <select
                    className={inputClassName}
                    value={rechargeOrderForm.userId}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, userId: event.target.value }))
                    }
                  >
                    {(state.adminState?.users ?? []).map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} · {user.email}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClassName}
                    placeholder="订单金额，如 99"
                    value={rechargeOrderForm.amountYuan}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, amountYuan: event.target.value }))
                    }
                  />
                  <select
                    className={inputClassName}
                    value={rechargeOrderForm.paymentMethod}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({
                        ...prev,
                        paymentMethod: event.target.value as RechargeOrderForm['paymentMethod'],
                      }))
                    }
                  >
                    <option value="manual">手工确认</option>
                    <option value="wechat">微信</option>
                    <option value="alipay">支付宝</option>
                    <option value="bank_transfer">银行转账</option>
                    <option value="stripe">Stripe</option>
                    <option value="other">其他</option>
                  </select>
                  <input
                    className={inputClassName}
                    placeholder="到账积分，如 100"
                    value={rechargeOrderForm.credits}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, credits: event.target.value }))
                    }
                  />
                  <input
                    className={inputClassName}
                    placeholder="外部单号/转账备注，可选"
                    value={rechargeOrderForm.externalReference}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, externalReference: event.target.value }))
                    }
                  />
                  <input
                    className={inputClassName}
                    placeholder="币种"
                    value={rechargeOrderForm.currency}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, currency: event.target.value.toUpperCase() }))
                    }
                  />
                  <textarea
                    className={`${textareaClassName} md:col-span-3`}
                    placeholder={'模型次数包，可选\nimagen-4.0-*=10\ngpt-image-*=5'}
                    value={rechargeOrderForm.allowancesText}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, allowancesText: event.target.value }))
                    }
                  />
                  <input
                    className={`${inputClassName} md:col-span-3`}
                    placeholder="内部备注，可选"
                    value={rechargeOrderForm.note}
                    onChange={(event) =>
                      setRechargeOrderForm((prev) => ({ ...prev, note: event.target.value }))
                    }
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null || !rechargeOrderForm.userId}
                    onClick={() => {
                      void runAction('create-recharge-order', async () => {
                        await workspaceApi.createRechargeOrder({
                          userId: rechargeOrderForm.userId,
                          amountCents: parseAmountCents(rechargeOrderForm.amountYuan),
                          currency: rechargeOrderForm.currency || 'CNY',
                          credits: Number.parseInt(rechargeOrderForm.credits || '0', 10) || 0,
                          modelAllowances: parseAllowances(rechargeOrderForm.allowancesText),
                          paymentMethod: rechargeOrderForm.paymentMethod,
                          externalReference: rechargeOrderForm.externalReference || null,
                          note: rechargeOrderForm.note || null,
                        });
                        setRechargeOrderForm((prev) => ({
                          ...prev,
                          amountYuan: '99',
                          credits: '100',
                          allowancesText: '',
                          externalReference: '',
                          note: '',
                        }));
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    创建待确认订单
                  </button>
                </div>
                <div className="mt-5">
                  {renderRechargeOrders(state.adminState?.rechargeOrders ?? [], true)}
                </div>
              </SectionCard>

              <SectionCard
                icon={BadgeDollarSign}
                title="手工调账"
                description="给客户补偿、扣回误发额度、线下收款后充值，都应该走这里。系统会生成不可隐藏的调账记录，方便以后对账。"
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <select
                    className={inputClassName}
                    value={adjustmentForm.userId}
                    onChange={(event) =>
                      setAdjustmentForm((prev) => ({ ...prev, userId: event.target.value }))
                    }
                  >
                    {(state.adminState?.users ?? []).map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} · {user.email}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClassName}
                    placeholder="积分变化，如 100 或 -20"
                    value={adjustmentForm.creditsDelta}
                    onChange={(event) =>
                      setAdjustmentForm((prev) => ({ ...prev, creditsDelta: event.target.value }))
                    }
                  />
                  <input
                    className={inputClassName}
                    placeholder="原因，如 线下充值/售后补偿"
                    value={adjustmentForm.reason}
                    onChange={(event) =>
                      setAdjustmentForm((prev) => ({ ...prev, reason: event.target.value }))
                    }
                  />
                  <textarea
                    className={`${textareaClassName} md:col-span-3`}
                    placeholder={'次数包变化，支持正负数\nimagen-4.0-*=10\ngpt-image-*=-2'}
                    value={adjustmentForm.allowanceDeltasText}
                    onChange={(event) =>
                      setAdjustmentForm((prev) => ({ ...prev, allowanceDeltasText: event.target.value }))
                    }
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null || !adjustmentForm.userId}
                    onClick={() => {
                      void runAction('adjust-balance', async () => {
                        await workspaceApi.adjustUserBalance(adjustmentForm.userId, {
                          creditsDelta: Number.parseInt(adjustmentForm.creditsDelta || '0', 10) || 0,
                          modelAllowanceDeltas: parseAllowanceDeltas(adjustmentForm.allowanceDeltasText),
                          reason: adjustmentForm.reason || null,
                        });
                        setAdjustmentForm((prev) => ({
                          ...prev,
                          creditsDelta: '0',
                          allowanceDeltasText: '',
                          reason: '',
                        }));
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    提交调账
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                icon={BadgeDollarSign}
                title="模型计费策略"
                description="这里决定某个模型走“次数包”还是“积分”。只要模式命中，就会优先扣次数包，不够再扣积分。"
              >
                <div className="space-y-4">
                  {policyDrafts.map((policy, index) => (
                    <div
                      key={`${policy.modelPattern}-${index}`}
                      className="grid gap-3 rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4 md:grid-cols-[1fr_1fr_120px]"
                    >
                      <input
                        className={inputClassName}
                        placeholder="策略名称"
                        value={policy.label}
                        onChange={(event) =>
                          setPolicyDrafts((prev) =>
                            prev.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, label: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <input
                        className={inputClassName}
                        placeholder="模型模式，如 imagen-4.0-*"
                        value={policy.modelPattern}
                        onChange={(event) =>
                          setPolicyDrafts((prev) =>
                            prev.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, modelPattern: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <input
                        className={inputClassName}
                        placeholder="单次积分"
                        value={policy.costCredits}
                        onChange={(event) =>
                          setPolicyDrafts((prev) =>
                            prev.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, costCredits: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <textarea
                        className={`${textareaClassName} md:col-span-3`}
                        placeholder="备注"
                        value={policy.description}
                        onChange={(event) =>
                          setPolicyDrafts((prev) =>
                            prev.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, description: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap justify-between gap-3">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    onClick={() =>
                      setPolicyDrafts((prev) => [
                        ...prev,
                        { label: '', modelPattern: '', costCredits: '0', description: '' },
                      ])
                    }
                  >
                    新增策略
                  </button>
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('save-policies', async () => {
                        await workspaceApi.replacePolicies({
                          policies: policyDrafts.map((policy) => ({
                            label: policy.label,
                            modelPattern: policy.modelPattern,
                            costCredits: Number.parseInt(policy.costCredits || '0', 10) || 0,
                            description: policy.description || null,
                          })),
                        });
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    保存策略
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                icon={TicketPercent}
                title="兑换码工厂"
                description="适合做充值、活动赠送或客户补偿。兑换码既能发积分，也能发指定模型的次数包。"
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <input
                    className={inputClassName}
                    placeholder="兑换码，如 ARONG-100"
                    value={redeemForm.code}
                    onChange={(event) => setRedeemForm((prev) => ({ ...prev, code: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="说明"
                    value={redeemForm.description}
                    onChange={(event) => setRedeemForm((prev) => ({ ...prev, description: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="赠送积分"
                    value={redeemForm.credits}
                    onChange={(event) => setRedeemForm((prev) => ({ ...prev, credits: event.target.value }))}
                  />
                  <input
                    className={inputClassName}
                    placeholder="最大兑换人数"
                    value={redeemForm.maxRedemptions}
                    onChange={(event) =>
                      setRedeemForm((prev) => ({ ...prev, maxRedemptions: event.target.value }))
                    }
                  />
                  <input
                    className={inputClassName}
                    placeholder="过期时间，可留空"
                    value={redeemForm.expiresAt}
                    onChange={(event) => setRedeemForm((prev) => ({ ...prev, expiresAt: event.target.value }))}
                  />
                  <textarea
                    className={textareaClassName}
                    placeholder={'附带次数包，按行填写\nimagen-4.0-*=10\ngpt-image-*=5'}
                    value={redeemForm.allowancesText}
                    onChange={(event) =>
                      setRedeemForm((prev) => ({ ...prev, allowancesText: event.target.value }))
                    }
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className={primaryButtonClassName}
                    disabled={busyAction !== null}
                    onClick={() => {
                      void runAction('create-code', async () => {
                        await workspaceApi.createRedeemCode({
                          code: redeemForm.code,
                          description: redeemForm.description || null,
                          credits: Number.parseInt(redeemForm.credits || '0', 10) || 0,
                          maxRedemptions: Number.parseInt(redeemForm.maxRedemptions || '1', 10) || 1,
                          expiresAt: redeemForm.expiresAt || null,
                          modelAllowances: parseAllowances(redeemForm.allowancesText),
                        });
                        setRedeemForm({
                          code: '',
                          description: '',
                          credits: '100',
                          maxRedemptions: '1',
                          expiresAt: '',
                          allowancesText: '',
                        });
                        await loadWorkspaceState();
                      });
                    }}
                  >
                    生成兑换码
                  </button>
                </div>

                <div className="mt-6 space-y-3">
                  {(state.adminState?.redeemCodes ?? []).map((code) => (
                    <div
                      key={code.id}
                      className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="font-semibold text-[var(--theme-text-primary)]">{code.code}</div>
                          <div className="text-sm text-[var(--theme-text-secondary)]">{code.description}</div>
                        </div>
                        <div className="text-sm text-[var(--theme-text-secondary)]">
                          {code.credits} 积分 · 已兑 {code.redeemedCount}/{code.maxRedemptions}
                        </div>
                      </div>
                      {Object.keys(code.modelAllowances).length > 0 ? (
                        <div className="mt-2 text-xs text-[var(--theme-text-secondary)]">
                          次数包：{formatAllowances(code.modelAllowances).replace(/\n/g, ' | ')}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard
                icon={Search}
                title="账务审计与导出"
                description="按用户、类型、状态筛选全站记录。客服排查、财务对账、活动复盘都可以从这里直接导出 CSV。"
              >
                <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
                  <input
                    className={inputClassName}
                    placeholder="搜索用户、模型、备注"
                    value={usageFilters.search}
                    onChange={(event) =>
                      setUsageFilters((prev) => ({ ...prev, search: event.target.value, page: 1 }))
                    }
                  />
                  <select
                    className={inputClassName}
                    value={usageFilters.userId}
                    onChange={(event) =>
                      setUsageFilters((prev) => ({ ...prev, userId: event.target.value, page: 1 }))
                    }
                  >
                    <option value="all">全部用户</option>
                    {(state.adminState?.users ?? []).map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className={inputClassName}
                    value={usageFilters.operationType}
                    onChange={(event) =>
                      setUsageFilters((prev) => ({ ...prev, operationType: event.target.value, page: 1 }))
                    }
                  >
                    <option value="all">全部业务</option>
                    <option value="model_request">模型请求</option>
                    <option value="image_generation">生图</option>
                    <option value="redeem">兑换</option>
                    <option value="order_recharge">订单充值</option>
                    <option value="admin_adjustment">调账</option>
                  </select>
                  <select
                    className={inputClassName}
                    value={usageFilters.status}
                    onChange={(event) =>
                      setUsageFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))
                    }
                  >
                    <option value="all">全部状态</option>
                    <option value="success">成功</option>
                    <option value="pending">处理中</option>
                    <option value="refunded">已退款</option>
                    <option value="redeemed">已兑换</option>
                    <option value="adjusted">已调账</option>
                  </select>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-[var(--theme-text-secondary)]">
                    共 {usagePage?.total ?? 0} 条，当前第 {usagePage?.page ?? 1}/{usagePage?.totalPages ?? 1} 页
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={secondaryButtonClassName}
                      disabled={busyAction !== null}
                      onClick={() => {
                        void runAction('load-usage', async () => {
                          setUsagePage(await workspaceApi.getAdminUsage(usageFilters));
                        });
                      }}
                    >
                      <Search size={16} />
                      查询
                    </button>
                    <button
                      type="button"
                      className={secondaryButtonClassName}
                      disabled={busyAction !== null}
                      onClick={() => {
                        void runAction('export-usage', async () => {
                          const csv = await workspaceApi.exportAdminUsageCsv(usageFilters);
                          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                          const url = URL.createObjectURL(blob);
                          const anchor = document.createElement('a');
                          anchor.href = url;
                          anchor.download = `arong-workspace-usage-${Date.now()}.csv`;
                          anchor.click();
                          URL.revokeObjectURL(url);
                        });
                      }}
                    >
                      <FileDown size={16} />
                      导出 CSV
                    </button>
                  </div>
                </div>
                <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--theme-border-primary)]">
                  <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-3 bg-[var(--theme-bg-primary)] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--theme-text-tertiary)]">
                    <span>用户</span>
                    <span>业务</span>
                    <span>模型/事件</span>
                    <span>变化</span>
                    <span>时间</span>
                  </div>
                  {(usagePage?.items ?? []).length === 0 ? (
                    <div className="px-4 py-6 text-sm text-[var(--theme-text-secondary)]">暂无匹配记录。</div>
                  ) : (
                    (usagePage?.items ?? []).map((record) => (
                      <div
                        key={record.id}
                        className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-3 border-t border-[var(--theme-border-primary)] px-4 py-3 text-sm text-[var(--theme-text-primary)]"
                      >
                        <span>{record.userName}</span>
                        <span>
                          {formatOperationType(record.operationType)} · {formatUsageSource(record.source)}
                          <span className="block text-xs text-[var(--theme-text-secondary)]">{record.status}</span>
                        </span>
                        <span>
                          {record.modelId}
                          <span className="block text-xs text-[var(--theme-text-secondary)]">
                            {record.note || record.requestPath}
                          </span>
                        </span>
                        <span>{formatUsageDelta(record)}</span>
                        <span className="text-xs text-[var(--theme-text-secondary)]">{formatDate(record.createdAt)}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busyAction !== null || (usagePage?.page ?? 1) <= 1}
                    onClick={() => {
                      void runAction('usage-prev', async () => {
                        const nextFilters = { ...usageFilters, page: Math.max(usageFilters.page - 1, 1) };
                        setUsageFilters(nextFilters);
                        setUsagePage(await workspaceApi.getAdminUsage(nextFilters));
                      });
                    }}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busyAction !== null || (usagePage?.page ?? 1) >= (usagePage?.totalPages ?? 1)}
                    onClick={() => {
                      void runAction('usage-next', async () => {
                        const nextFilters = { ...usageFilters, page: usageFilters.page + 1 };
                        setUsageFilters(nextFilters);
                        setUsagePage(await workspaceApi.getAdminUsage(nextFilters));
                      });
                    }}
                  >
                    下一页
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                icon={Building2}
                title="全站最近使用"
                description="这是管理员视角的最近扣费记录，适合排查某个用户为什么额度消耗过快。"
              >
                {renderUsageTable(state.adminState?.recentWorkspaceUsage ?? [])}
              </SectionCard>
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
