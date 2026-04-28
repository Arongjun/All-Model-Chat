import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RefreshCcw, Trash2 } from 'lucide-react';
import type {
  WorkspaceCloudAdminAttachmentSummary,
  WorkspaceCloudAdminSessionSummary,
  WorkspaceCloudCleanupResult,
  WorkspaceCloudRetentionSettings,
  WorkspacePageResponse,
  WorkspaceUserSummary,
} from '../../../../types';
import { SETTINGS_INPUT_CLASS } from '../../../../constants/appConstants';
import { workspaceApi } from '../../../../services/workspaceApi';

const inputClassName = `w-full rounded-xl border px-3 py-2.5 text-sm transition-colors ${SETTINGS_INPUT_CLASS}`;
const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClassName = `${buttonBase} bg-[var(--theme-text-link)] text-white hover:opacity-90`;
const secondaryButtonClassName = `${buttonBase} border border-[var(--theme-border-secondary)] text-[var(--theme-text-primary)] hover:bg-[var(--theme-bg-tertiary)]`;
const dangerButtonClassName = `${buttonBase} border border-red-300 text-red-600 hover:bg-red-50`;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface CloudGovernancePanelProps {
  users: WorkspaceUserSummary[];
}

export const CloudGovernancePanel: React.FC<CloudGovernancePanelProps> = ({ users }) => {
  const [selectedUserId, setSelectedUserId] = useState('');
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<WorkspacePageResponse<WorkspaceCloudAdminSessionSummary> | null>(null);
  const [attachments, setAttachments] = useState<WorkspacePageResponse<WorkspaceCloudAdminAttachmentSummary> | null>(null);
  const [viewedSession, setViewedSession] = useState<WorkspaceCloudAdminSessionSummary | null>(null);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(new Set());
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<Set<string>>(new Set());
  const [retention, setRetention] = useState<WorkspaceCloudRetentionSettings | null>(null);
  const [cleanupResult, setCleanupResult] = useState<WorkspaceCloudCleanupResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userNameById = useMemo(
    () => new Map(users.map((user) => [user.id, `${user.name} (${user.email})`])),
    [users],
  );

  const loadGovernanceData = useCallback(async () => {
    setError(null);
    const [nextSessions, nextAttachments, nextRetention] = await Promise.all([
      workspaceApi.getAdminCloudSessions({ userId: selectedUserId || undefined, search: search || undefined }),
      workspaceApi.getAdminCloudAttachments({ userId: selectedUserId || undefined, search: search || undefined }),
      workspaceApi.getCloudRetentionSettings(),
    ]);
    setSessions(nextSessions);
    setAttachments(nextAttachments);
    setRetention(nextRetention);
    setSelectedSessionKeys(new Set());
    setSelectedAttachmentIds(new Set());
  }, [search, selectedUserId]);

  useEffect(() => {
    void loadGovernanceData().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '加载云端记录失败');
    });
  }, [loadGovernanceData]);

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const selectedSessions = useMemo(
    () => (sessions?.items ?? []).filter((session) => selectedSessionKeys.has(`${session.userId}:${session.id}`)),
    [selectedSessionKeys, sessions],
  );

  const retentionPayload = useCallback(() => ({
    enabled: retention?.enabled ?? false,
    maxAttachmentAgeDays: retention?.maxAttachmentAgeDays ?? 30,
    maxTotalAttachmentBytes: retention?.maxTotalAttachmentBytes ?? 0,
  }), [retention]);

  const cleanupPayload = useCallback(() => ({
    maxAttachmentAgeDays: retention?.maxAttachmentAgeDays ?? 30,
    maxTotalAttachmentBytes: retention?.maxTotalAttachmentBytes ?? 0,
  }), [retention]);

  return (
    <section className="rounded-3xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-secondary)] p-5 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--theme-bg-tertiary)] p-2.5">
          <Database size={18} className="text-[var(--theme-text-link)]" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-[var(--theme-text-primary)]">云端记录与存储治理</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--theme-text-secondary)]">
            管理员可以查看、定位和批量删除用户云端会话与附件，并配置清理策略控制 S3 存储费用。
          </p>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <select className={inputClassName} value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
          <option value="">全部用户</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.name} · {user.email}</option>
          ))}
        </select>
        <input
          className={inputClassName}
          placeholder="搜索会话标题、附件名或 ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className={secondaryButtonClassName}
          disabled={busy !== null}
          onClick={() => void runAction('refresh-cloud-governance', loadGovernanceData)}
        >
          <RefreshCcw size={16} className={busy === 'refresh-cloud-governance' ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="font-semibold text-[var(--theme-text-primary)]">云端会话</h4>
              <p className="text-xs text-[var(--theme-text-secondary)]">共 {sessions?.total ?? 0} 条，当前页 {sessions?.items.length ?? 0} 条</p>
            </div>
            <button
              type="button"
              className={dangerButtonClassName}
              disabled={busy !== null || selectedSessions.length === 0}
              onClick={() => void runAction('delete-cloud-sessions', async () => {
                if (!window.confirm(`确定删除选中的 ${selectedSessions.length} 个云端会话吗？关联附件也会一起清理。`)) {
                  return;
                }
                await workspaceApi.deleteAdminCloudSessions(selectedSessions.map((session) => ({
                  userId: session.userId,
                  id: session.id,
                })));
                await loadGovernanceData();
              })}
            >
              <Trash2 size={15} />
              批量删会话
            </button>
          </div>
          <div className="mt-3 max-h-96 space-y-2 overflow-auto pr-1">
            {(sessions?.items ?? []).map((session) => {
              const key = `${session.userId}:${session.id}`;
              return (
                <div key={key} className="block rounded-xl border border-[var(--theme-border-primary)] p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <input
                      aria-label={`选择会话 ${session.title}`}
                      type="checkbox"
                      checked={selectedSessionKeys.has(key)}
                      onChange={(event) => {
                        setSelectedSessionKeys((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-[var(--theme-text-primary)]">{session.title}</div>
                      <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                        {userNameById.get(session.userId) ?? session.userId} · {formatDate(session.updatedAt)}
                      </div>
                      <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                        附件 {session.attachmentCount} 个 · {formatFileSize(session.attachmentBytes)}
                      </div>
                      <button
                        type="button"
                        className="mt-2 text-xs font-medium text-[var(--theme-text-link)]"
                        onClick={() => {
                          void runAction(`view-session-${session.id}`, async () => {
                            const response = await workspaceApi.getAdminCloudSession(session.userId, session.id);
                            setViewedSession(response.session);
                          });
                        }}
                      >
                        查看对话内容
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {(sessions?.items.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--theme-border-primary)] p-4 text-center text-sm text-[var(--theme-text-secondary)]">
                暂无云端会话。
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="font-semibold text-[var(--theme-text-primary)]">对象存储附件</h4>
              <p className="text-xs text-[var(--theme-text-secondary)]">共 {attachments?.total ?? 0} 个，当前页 {attachments?.items.length ?? 0} 个</p>
            </div>
            <button
              type="button"
              className={dangerButtonClassName}
              disabled={busy !== null || selectedAttachmentIds.size === 0}
              onClick={() => void runAction('delete-cloud-attachments', async () => {
                if (!window.confirm(`确定删除选中的 ${selectedAttachmentIds.size} 个云端文件吗？删除后用户聊天里对应附件也会移除。`)) {
                  return;
                }
                await workspaceApi.deleteAdminCloudAttachments([...selectedAttachmentIds]);
                await loadGovernanceData();
              })}
            >
              <Trash2 size={15} />
              批量删文件
            </button>
          </div>
          <div className="mt-3 max-h-96 space-y-2 overflow-auto pr-1">
            {(attachments?.items ?? []).map((attachment) => (
              <div key={attachment.id} className="block rounded-xl border border-[var(--theme-border-primary)] p-3 text-sm">
                <div className="flex items-start gap-2">
                  <input
                    aria-label={`选择文件 ${attachment.name}`}
                    type="checkbox"
                    checked={selectedAttachmentIds.has(attachment.id)}
                    onChange={(event) => {
                      setSelectedAttachmentIds((prev) => {
                        const next = new Set(prev);
                        if (event.target.checked) next.add(attachment.id);
                        else next.delete(attachment.id);
                        return next;
                      });
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--theme-text-primary)]">{attachment.name}</div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      {formatFileSize(attachment.size)} · {attachment.type || 'application/octet-stream'}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                      {userNameById.get(attachment.userId) ?? attachment.userId} · {formatDate(attachment.createdAt)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {(attachments?.items.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--theme-border-primary)] p-4 text-center text-sm text-[var(--theme-text-secondary)]">
                暂无云端附件。
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {viewedSession ? (
        <div className="mt-5 rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-[var(--theme-text-primary)]">正在查看：{viewedSession.title}</h4>
              <p className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                {userNameById.get(viewedSession.userId) ?? viewedSession.userId} · {formatDate(viewedSession.updatedAt)}
              </p>
            </div>
            <button type="button" className={secondaryButtonClassName} onClick={() => setViewedSession(null)}>
              关闭查看
            </button>
          </div>
          <div className="mt-4 max-h-[28rem] space-y-3 overflow-auto pr-1">
            {(viewedSession.messages ?? []).map((message, index) => {
              const record = message as {
                id?: string;
                role?: string;
                content?: string;
                files?: Array<{ name?: string; size?: number; cloudAttachmentId?: string }>;
              };
              return (
                <div key={record.id ?? index} className="rounded-xl bg-[var(--theme-bg-tertiary)] p-3 text-sm">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-text-secondary)]">
                    {record.role === 'model' ? 'AI' : '用户'}
                  </div>
                  <div className="whitespace-pre-wrap text-[var(--theme-text-primary)]">
                    {record.content || '（无文本内容）'}
                  </div>
                  {record.files?.length ? (
                    <div className="mt-2 space-y-1 text-xs text-[var(--theme-text-secondary)]">
                      {record.files.map((file, fileIndex) => (
                        <div
                          key={`${file.cloudAttachmentId ?? file.name ?? fileIndex}`}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span>
                            附件：{file.name ?? '未命名'} · {formatFileSize(file.size ?? 0)}
                            {file.cloudAttachmentId ? ` · ${file.cloudAttachmentId}` : ''}
                          </span>
                          {file.cloudAttachmentId ? (
                            <button
                              type="button"
                              className="text-red-600"
                              disabled={busy !== null}
                              onClick={() => void runAction(`delete-viewed-file-${file.cloudAttachmentId}`, async () => {
                                if (!file.cloudAttachmentId) return;
                                if (!window.confirm(`确定删除文件“${file.name ?? '未命名'}”吗？`)) {
                                  return;
                                }
                                await workspaceApi.deleteAdminCloudAttachments([file.cloudAttachmentId]);
                                const response = await workspaceApi.getAdminCloudSession(viewedSession.userId, viewedSession.id);
                                setViewedSession(response.session);
                                await loadGovernanceData();
                              })}
                            >
                              删除该文件
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-5 rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
        <h4 className="font-semibold text-[var(--theme-text-primary)]">自动清理策略</h4>
        <p className="mt-1 text-sm text-[var(--theme-text-secondary)]">
          建议先“试算”，确认会删除多少文件和容量，再执行清理。
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <label className="flex items-center gap-2 rounded-xl border border-[var(--theme-border-primary)] px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={retention?.enabled ?? false}
              onChange={(event) => setRetention((prev) => ({
                enabled: event.target.checked,
                maxAttachmentAgeDays: prev?.maxAttachmentAgeDays ?? 30,
                maxTotalAttachmentBytes: prev?.maxTotalAttachmentBytes ?? 0,
                updatedAt: prev?.updatedAt ?? null,
              }))}
            />
            启用策略
          </label>
          <input
            className={inputClassName}
            placeholder="超过多少天清理，例如 30"
            value={retention?.maxAttachmentAgeDays ?? 30}
            onChange={(event) => setRetention((prev) => ({
              enabled: prev?.enabled ?? false,
              maxAttachmentAgeDays: Number.parseInt(event.target.value || '0', 10) || 0,
              maxTotalAttachmentBytes: prev?.maxTotalAttachmentBytes ?? 0,
              updatedAt: prev?.updatedAt ?? null,
            }))}
          />
          <input
            className={inputClassName}
            placeholder="总容量上限 GB，0 不限制"
            value={retention ? Math.round(retention.maxTotalAttachmentBytes / 1024 / 1024 / 1024) : 0}
            onChange={(event) => setRetention((prev) => ({
              enabled: prev?.enabled ?? false,
              maxAttachmentAgeDays: prev?.maxAttachmentAgeDays ?? 30,
              maxTotalAttachmentBytes: (Number.parseInt(event.target.value || '0', 10) || 0) * 1024 * 1024 * 1024,
              updatedAt: prev?.updatedAt ?? null,
            }))}
          />
          <button
            type="button"
            className={primaryButtonClassName}
            disabled={busy !== null || !retention}
            onClick={() => void runAction('save-retention', async () => {
              if (!retention) return;
              setRetention(await workspaceApi.updateCloudRetentionSettings(retentionPayload()));
            })}
          >
            保存策略
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            className={secondaryButtonClassName}
            disabled={busy !== null || !retention}
            onClick={() => void runAction('dry-run-cleanup', async () => {
              if (!retention) return;
              setCleanupResult(await workspaceApi.runCloudAttachmentCleanup({ ...cleanupPayload(), dryRun: true }));
            })}
          >
            试算清理
          </button>
          <button
            type="button"
            className={dangerButtonClassName}
            disabled={busy !== null || !retention}
            onClick={() => void runAction('execute-cleanup', async () => {
              if (!retention) return;
              if (!window.confirm('确定执行对象存储清理吗？建议先点“试算清理”确认影响范围。')) {
                return;
              }
              setCleanupResult(await workspaceApi.runCloudAttachmentCleanup({ ...cleanupPayload(), dryRun: false }));
              await loadGovernanceData();
            })}
          >
            执行清理
          </button>
        </div>
        {cleanupResult ? (
          <div className="mt-3 rounded-xl bg-[var(--theme-bg-tertiary)] p-3 text-sm text-[var(--theme-text-secondary)]">
            匹配 {cleanupResult.matchedCount} 个 / {formatFileSize(cleanupResult.matchedBytes)}；
            已删除 {cleanupResult.deletedCount} 个 / {formatFileSize(cleanupResult.deletedBytes)}
            {cleanupResult.dryRun ? '（试算未删除）' : ''}{cleanupResult.skippedReason ? `；${cleanupResult.skippedReason}` : ''}
          </div>
        ) : null}
      </div>
    </section>
  );
};
