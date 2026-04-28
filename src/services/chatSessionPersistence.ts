import type { ChatGroup, SavedChatSession } from '../types';
import { dbService } from '../utils/db';
import { cloudChatApi, mergeCloudFileMetadata } from './cloudChatApi';
import { logService } from './logService';

export async function getSessionMetadataFromCloudOrLocal(): Promise<SavedChatSession[]> {
  const [localSessions, cloudSessions] = await Promise.all([
    dbService.getAllSessionMetadata(),
    cloudChatApi.listSessions().catch((error) => {
      logService.warn('Cloud chat metadata sync skipped', { error });
      return null;
    }),
  ]);

  if (!cloudSessions) {
    return localSessions;
  }

  return cloudSessions;
}

export async function getGroupsFromCloudOrLocal(): Promise<ChatGroup[]> {
  const [localGroups, cloudGroups] = await Promise.all([
    dbService.getAllGroups(),
    cloudChatApi.listGroups().catch((error) => {
      logService.warn('Cloud chat group sync skipped', { error });
      return null;
    }),
  ]);

  if (!cloudGroups) {
    return localGroups;
  }

  await dbService.setAllGroups(cloudGroups).catch((error) => {
    logService.warn('Failed to refresh local cloud group cache', { error });
  });
  return cloudGroups;
}

export async function getSessionFromCloudOrLocal(sessionId: string): Promise<SavedChatSession | null> {
  const cloudSession = await cloudChatApi.getSession(sessionId).catch((error) => {
    logService.warn('Cloud chat session load skipped', { sessionId, error });
    return null;
  });

  if (cloudSession) {
    await dbService.saveSession(cloudSession).catch((error) => {
      logService.warn('Failed to refresh local cloud chat cache', { sessionId, error });
    });
    return cloudSession;
  }

  return dbService.getSession(sessionId);
}

export async function saveGroupsToLocalAndCloud(groups: ChatGroup[]): Promise<ChatGroup[]> {
  await dbService.setAllGroups(groups);
  const cloudGroups = await cloudChatApi.saveGroups(groups).catch((error) => {
    logService.warn('Cloud chat group save skipped', { error });
    return null;
  });
  return cloudGroups ?? groups;
}

export async function saveSessionToLocalAndCloud(session: SavedChatSession): Promise<SavedChatSession> {
  await dbService.saveSession(session);
  const cloudSession = await cloudChatApi.saveSession(session).catch((error) => {
    logService.warn('Cloud chat session save skipped', { sessionId: session.id, error });
    return null;
  });

  if (!cloudSession) {
    return session;
  }

  const mergedSession = mergeCloudFileMetadata(session, cloudSession);
  await dbService.saveSession(mergedSession).catch((error) => {
    logService.warn('Failed to persist cloud attachment metadata locally', { sessionId: session.id, error });
  });
  return mergedSession;
}

export async function deleteSessionFromLocalAndCloud(sessionId: string): Promise<void> {
  await Promise.all([
    dbService.deleteSession(sessionId),
    cloudChatApi.deleteSession(sessionId).catch((error) => {
      logService.warn('Cloud chat session delete skipped', { sessionId, error });
    }),
  ]);
}
