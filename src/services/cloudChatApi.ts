import type { ChatGroup, SavedChatSession, UploadedFile } from '../types';
import { logService } from './logService';

const CLOUD_CHAT_API_PREFIX = '/api/workspace/cloud-chat';

interface CloudAttachmentResponse {
  attachment: {
    id: string;
    fileId: string | null;
    sessionId: string | null;
    messageId: string | null;
    name: string;
    type: string;
    size: number;
    storageKey: string;
    createdAt: string;
  };
}

interface CloudSessionResponse {
  session: SavedChatSession;
}

interface CloudSessionsResponse {
  sessions: SavedChatSession[];
}

interface CloudGroupsResponse {
  groups: ChatGroup[];
}

interface CloudChatStatusResponse {
  authenticated: boolean;
  enabled: boolean;
  objectStorage: {
    enabled: boolean;
    configured: boolean;
  };
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  options: { optionalAuth?: boolean } = {},
): Promise<T | null> {
  const isBlobBody = typeof Blob !== 'undefined' && init.body instanceof Blob;
  const response = await fetch(`${CLOUD_CHAT_API_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(isBlobBody ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });

  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    if (options.optionalAuth && (response.status === 401 || response.status === 403 || response.status === 404)) {
      return null;
    }

    const errorMessage =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error || 'Cloud chat request failed.')
        : 'Cloud chat request failed.';
    throw new Error(errorMessage);
  }

  return payload as T;
}

function sanitizeFileForCloud(file: UploadedFile): UploadedFile {
  const next = { ...file };
  delete next.rawFile;
  delete next.dataUrl;
  delete next.abortController;
  delete next.uploadSpeed;
  return next;
}

function sanitizeSessionForCloud(session: SavedChatSession): SavedChatSession {
  const safeSettings = {
    ...(session.settings ?? {}),
  } as SavedChatSession['settings'] & Record<string, unknown>;
  delete safeSettings.lockedApiKey;

  return {
    ...session,
    settings: safeSettings,
    messages: (Array.isArray(session.messages) ? session.messages : []).map((message) => ({
      ...message,
      files: message.files?.map(sanitizeFileForCloud),
    })),
  };
}

async function uploadAttachment(
  file: UploadedFile,
  sessionId: string,
  messageId: string,
): Promise<UploadedFile> {
  if (!file.rawFile || file.cloudAttachmentId) {
    return file;
  }

  const body = file.rawFile;
  const response = await requestJson<CloudAttachmentResponse>('/attachments', {
    method: 'POST',
    headers: {
      'content-type': file.type || body.type || 'application/octet-stream',
      'x-file-id': encodeURIComponent(file.id),
      'x-session-id': encodeURIComponent(sessionId),
      'x-message-id': encodeURIComponent(messageId),
      'x-file-name': encodeURIComponent(file.name),
    },
    body,
  }, { optionalAuth: true });

  if (!response) {
    return {
      ...file,
      cloudSyncState: 'local_only',
      cloudSyncError: 'Cloud chat is not available for the current login state.',
    };
  }

  const cloudFields = {
    cloudAttachmentId: response.attachment.id,
    cloudStorageKey: response.attachment.storageKey,
    cloudSyncState: 'synced' as const,
    cloudSyncError: undefined,
  };

  Object.assign(file, cloudFields);
  return { ...file, ...cloudFields };
}

async function prepareSessionForCloud(session: SavedChatSession): Promise<SavedChatSession> {
  const nextMessages = await Promise.all(
    session.messages.map(async (message) => {
      if (!message.files?.length) {
        return message;
      }

      const nextFiles = await Promise.all(
        message.files.map(async (file) => {
          try {
            return sanitizeFileForCloud(await uploadAttachment(file, session.id, message.id));
          } catch (error) {
            logService.warn('Failed to sync attachment to object storage', {
              fileName: file.name,
              error,
            });
            return sanitizeFileForCloud({
              ...file,
              cloudSyncState: 'failed',
              cloudSyncError: error instanceof Error ? error.message : 'Attachment sync failed.',
            });
          }
        }),
      );

      return { ...message, files: nextFiles };
    }),
  );

  return sanitizeSessionForCloud({ ...session, messages: nextMessages });
}

export function mergeCloudFileMetadata(
  localSession: SavedChatSession,
  cloudSession: SavedChatSession,
): SavedChatSession {
  const cloudMessages = new Map(cloudSession.messages.map((message) => [message.id, message]));

  return {
    ...localSession,
    messages: localSession.messages.map((message) => {
      const cloudMessage = cloudMessages.get(message.id);
      if (!cloudMessage?.files?.length || !message.files?.length) {
        return message;
      }

      const cloudFiles = new Map(cloudMessage.files.map((file) => [file.id, file]));
      return {
        ...message,
        files: message.files.map((file) => {
          const cloudFile = cloudFiles.get(file.id);
          return cloudFile?.cloudAttachmentId
            ? {
              ...file,
              cloudAttachmentId: cloudFile.cloudAttachmentId,
              cloudStorageKey: cloudFile.cloudStorageKey,
              cloudSyncState: cloudFile.cloudSyncState ?? 'synced',
              cloudSyncError: cloudFile.cloudSyncError,
            }
            : file;
        }),
      };
    }),
  };
}

async function hydrateCloudFile(file: UploadedFile): Promise<UploadedFile> {
  if (!file.cloudAttachmentId || file.rawFile) {
    return file;
  }

  const response = await fetch(
    `${CLOUD_CHAT_API_PREFIX}/attachments/${encodeURIComponent(file.cloudAttachmentId)}`,
    { credentials: 'same-origin' },
  );

  if (!response.ok) {
    return {
      ...file,
      cloudSyncState: 'failed',
      cloudSyncError: `Cloud attachment download failed with HTTP ${response.status}.`,
    };
  }

  const blob = await response.blob();
  const fallbackName = file.name || 'attachment';
  const fallbackType = file.type || blob.type || 'application/octet-stream';
  const rawFile = typeof File !== 'undefined'
    ? new File([blob], fallbackName, { type: fallbackType })
    : Object.assign(blob, {
      name: fallbackName,
      lastModified: Date.now(),
    }) as File;

  return {
    ...file,
    rawFile,
    dataUrl: URL.createObjectURL(rawFile),
    size: file.size || rawFile.size,
    uploadState: 'active',
    cloudSyncState: 'synced',
    cloudSyncError: undefined,
  };
}

export async function hydrateCloudSessionFiles(session: SavedChatSession): Promise<SavedChatSession> {
  const messages = await Promise.all(
    session.messages.map(async (message) => ({
      ...message,
      files: message.files?.length
        ? await Promise.all(message.files.map(hydrateCloudFile))
        : message.files,
    })),
  );

  return { ...session, messages };
}

export const cloudChatApi = {
  async getStatus(): Promise<CloudChatStatusResponse | null> {
    return requestJson<CloudChatStatusResponse>('/status', {}, { optionalAuth: true });
  },

  async listSessions(): Promise<SavedChatSession[] | null> {
    const response = await requestJson<CloudSessionsResponse>('/sessions', {}, { optionalAuth: true });
    return response?.sessions ?? null;
  },

  async listGroups(): Promise<ChatGroup[] | null> {
    const response = await requestJson<CloudGroupsResponse>('/groups', {}, { optionalAuth: true });
    return response?.groups ?? null;
  },

  async saveGroups(groups: ChatGroup[]): Promise<ChatGroup[] | null> {
    const response = await requestJson<CloudGroupsResponse>(
      '/groups',
      {
        method: 'PUT',
        body: JSON.stringify({ groups }),
      },
      { optionalAuth: true },
    );
    return response?.groups ?? null;
  },

  async getSession(sessionId: string): Promise<SavedChatSession | null> {
    const response = await requestJson<CloudSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {},
      { optionalAuth: true },
    );
    return response?.session ? hydrateCloudSessionFiles(response.session) : null;
  },

  async saveSession(session: SavedChatSession): Promise<SavedChatSession | null> {
    const preparedSession = await prepareSessionForCloud(session);
    const response = await requestJson<CloudSessionResponse>(
      `/sessions/${encodeURIComponent(session.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ session: preparedSession }),
      },
      { optionalAuth: true },
    );
    return response?.session ?? null;
  },

  async deleteSession(sessionId: string): Promise<void> {
    await requestJson<{ success: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
      { optionalAuth: true },
    );
  },
};
