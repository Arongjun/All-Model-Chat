import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Plus, Trash2 } from 'lucide-react';
import type { WorkspaceSystemScenario, WorkspaceUserSummary } from '../../../../types';
import { SETTINGS_INPUT_CLASS } from '../../../../constants/appConstants';
import { workspaceApi } from '../../../../services/workspaceApi';

const inputClassName = `w-full rounded-xl border px-3 py-2.5 text-sm transition-colors ${SETTINGS_INPUT_CLASS}`;
const textareaClassName = `${inputClassName} min-h-28 resize-y`;
const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClassName = `${buttonBase} bg-[var(--theme-text-link)] text-white hover:opacity-90`;
const secondaryButtonClassName = `${buttonBase} border border-[var(--theme-border-secondary)] text-[var(--theme-text-primary)] hover:bg-[var(--theme-bg-tertiary)]`;
const dangerButtonClassName = `${buttonBase} border border-red-300 text-red-600 hover:bg-red-50`;

type ScenarioForm = {
  id: string;
  title: string;
  systemInstruction: string;
  visibilityMode: WorkspaceSystemScenario['visibilityMode'];
  allowedUserIds: string[];
  active: boolean;
  sortOrder: string;
};

const emptyForm: ScenarioForm = {
  id: '',
  title: '',
  systemInstruction: '',
  visibilityMode: 'all',
  allowedUserIds: [],
  active: true,
  sortOrder: '100',
};

function toForm(scenario: WorkspaceSystemScenario): ScenarioForm {
  return {
    id: scenario.id,
    title: scenario.title,
    systemInstruction: scenario.systemInstruction ?? '',
    visibilityMode: scenario.visibilityMode,
    allowedUserIds: scenario.allowedUserIds,
    active: scenario.active,
    sortOrder: String(scenario.sortOrder),
  };
}

function getVisibilityLabel(value: WorkspaceSystemScenario['visibilityMode']): string {
  switch (value) {
    case 'admins':
      return '仅管理员';
    case 'members':
      return '登录成员';
    case 'users':
      return '指定用户';
    default:
      return '所有人';
  }
}

interface SystemScenariosAdminPanelProps {
  users: WorkspaceUserSummary[];
}

export const SystemScenariosAdminPanel: React.FC<SystemScenariosAdminPanelProps> = ({ users }) => {
  const [scenarios, setScenarios] = useState<WorkspaceSystemScenario[]>([]);
  const [form, setForm] = useState<ScenarioForm>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editingScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === form.id) ?? null,
    [form.id, scenarios],
  );

  const loadScenarios = useCallback(async () => {
    setError(null);
    const response = await workspaceApi.getAdminSystemScenarios();
    setScenarios(response.scenarios);
  }, []);

  useEffect(() => {
    void loadScenarios().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '加载系统预设失败');
    });
  }, [loadScenarios]);

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

  const saveScenario = async () => {
    const payload: Partial<WorkspaceSystemScenario> = {
      title: form.title,
      systemInstruction: form.systemInstruction,
      messages: editingScenario?.messages ?? [],
      visibilityMode: form.visibilityMode,
      allowedUserIds: form.visibilityMode === 'users' ? form.allowedUserIds : [],
      active: form.active,
      sortOrder: Number.parseInt(form.sortOrder || '100', 10) || 100,
    };

    if (editingScenario) {
      await workspaceApi.updateSystemScenario(editingScenario.id, payload);
    } else {
      await workspaceApi.createSystemScenario(payload);
    }
    setForm(emptyForm);
    await loadScenarios();
  };

  return (
    <section className="rounded-3xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-secondary)] p-5 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--theme-bg-tertiary)] p-2.5">
          <BookOpen size={18} className="text-[var(--theme-text-link)]" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-[var(--theme-text-primary)]">系统预设场景运营</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--theme-text-secondary)]">
            管理员可统一维护工作站内置提示词，并控制全部成员、管理员或指定用户可见。
          </p>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {scenarios.map((scenario) => (
            <div
              key={scenario.id}
              className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-[var(--theme-text-primary)]">{scenario.title}</div>
                  <div className="mt-1 text-xs text-[var(--theme-text-secondary)]">
                    {getVisibilityLabel(scenario.visibilityMode)} · 排序 {scenario.sortOrder} · {scenario.active ? '启用' : '停用'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={secondaryButtonClassName} onClick={() => setForm(toForm(scenario))}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className={dangerButtonClassName}
                    disabled={busy !== null}
                    onClick={() => void runAction(`delete-scenario-${scenario.id}`, async () => {
                      if (!window.confirm(`确定删除系统预设“${scenario.title}”吗？`)) {
                        return;
                      }
                      await workspaceApi.deleteSystemScenario(scenario.id);
                      if (form.id === scenario.id) setForm(emptyForm);
                      await loadScenarios();
                    })}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </div>
              <div className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm text-[var(--theme-text-secondary)]">
                {scenario.systemInstruction || '未填写系统提示词'}
              </div>
            </div>
          ))}
          {scenarios.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--theme-border-primary)] p-6 text-center text-sm text-[var(--theme-text-secondary)]">
              还没有服务端系统预设。创建后，用户会在场景面板里看到自己有权限访问的预设。
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-[var(--theme-border-primary)] bg-[var(--theme-bg-primary)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="font-semibold text-[var(--theme-text-primary)]">
              {editingScenario ? '编辑预设' : '新增预设'}
            </h4>
            <button type="button" className={secondaryButtonClassName} onClick={() => setForm(emptyForm)}>
              <Plus size={15} />
              新建
            </button>
          </div>
          <div className="space-y-3">
            <input
              className={inputClassName}
              placeholder="场景名称"
              value={form.title}
              onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
            />
            <textarea
              className={textareaClassName}
              placeholder="系统提示词，例如：你是一个专业的短视频脚本策划助手..."
              value={form.systemInstruction}
              onChange={(event) => setForm((prev) => ({ ...prev, systemInstruction: event.target.value }))}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                className={inputClassName}
                value={form.visibilityMode}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    visibilityMode: event.target.value as WorkspaceSystemScenario['visibilityMode'],
                  }))
                }
              >
                <option value="all">所有人可见</option>
                <option value="members">登录成员可见</option>
                <option value="admins">仅管理员可见</option>
                <option value="users">指定用户可见</option>
              </select>
              <input
                className={inputClassName}
                placeholder="排序，数字越小越靠前"
                value={form.sortOrder}
                onChange={(event) => setForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--theme-text-secondary)]">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => setForm((prev) => ({ ...prev, active: event.target.checked }))}
              />
              启用这个预设
            </label>
            {form.visibilityMode === 'users' ? (
              <div className="max-h-40 space-y-2 overflow-auto rounded-xl border border-[var(--theme-border-primary)] p-3">
                {users.map((user) => (
                  <label key={user.id} className="flex items-center gap-2 text-sm text-[var(--theme-text-secondary)]">
                    <input
                      type="checkbox"
                      checked={form.allowedUserIds.includes(user.id)}
                      onChange={(event) => {
                        setForm((prev) => ({
                          ...prev,
                          allowedUserIds: event.target.checked
                            ? [...prev.allowedUserIds, user.id]
                            : prev.allowedUserIds.filter((id) => id !== user.id),
                        }));
                      }}
                    />
                    {user.name} · {user.email}
                  </label>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              className={primaryButtonClassName}
              disabled={busy !== null || !form.title.trim()}
              onClick={() => void runAction('save-system-scenario', saveScenario)}
            >
              保存预设
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
