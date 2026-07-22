'use client';

const PENDING_INGEST_KEY = 'animacut.pendingIngest.v1';
const DATABASE_NAME = 'animacut-pending-ingest';
const STORE_NAME = 'files';
const FILE_KEY = 'pending-video';

export type PendingIngest =
  | { type: 'youtube'; sourceUrl: string; createdAt: number }
  | { type: 'upload'; fileName: string; createdAt: number };

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not save the selected video.'));
  });
}

async function writePendingFile(file: File) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(file, FILE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the selected video.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save the selected video.'));
    });
  } finally {
    database.close();
  }
}

async function readPendingFile() {
  const database = await openDatabase();
  try {
    return await new Promise<File | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(FILE_KEY);
      request.onsuccess = () => resolve(request.result instanceof File ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Could not restore the selected video.'));
    });
  } finally {
    database.close();
  }
}

async function deletePendingFile() {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(FILE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function savePendingYouTubeIngest(sourceUrl: string) {
  const pending: PendingIngest = { type: 'youtube', sourceUrl, createdAt: Date.now() };
  localStorage.setItem(PENDING_INGEST_KEY, JSON.stringify(pending));
}

export async function savePendingUploadIngest(file: File) {
  await writePendingFile(file);
  const pending: PendingIngest = { type: 'upload', fileName: file.name, createdAt: Date.now() };
  localStorage.setItem(PENDING_INGEST_KEY, JSON.stringify(pending));
}

export function getPendingIngest(): PendingIngest | null {
  const raw = localStorage.getItem(PENDING_INGEST_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingIngest;
    if (pending.type !== 'youtube' && pending.type !== 'upload') return null;
    return pending;
  } catch {
    return null;
  }
}

export { readPendingFile };

export async function clearPendingIngest() {
  localStorage.removeItem(PENDING_INGEST_KEY);
  await deletePendingFile().catch(() => undefined);
}
