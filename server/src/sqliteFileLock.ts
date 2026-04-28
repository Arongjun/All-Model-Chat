import path from 'node:path';

const sqliteFileQueues = new Map<string, Promise<void>>();

export async function withSqliteFileLock<T>(
  databaseFilePath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lockKey = path.resolve(process.cwd(), databaseFilePath);
  const previousTail = sqliteFileQueues.get(lockKey) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const nextTail = previousTail.catch(() => undefined).then(() => currentLock);

  sqliteFileQueues.set(lockKey, nextTail);
  await previousTail.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (sqliteFileQueues.get(lockKey) === nextTail) {
      sqliteFileQueues.delete(lockKey);
    }
  }
}
