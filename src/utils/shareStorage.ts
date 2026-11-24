const SHARE_DB_NAME = 'ai-content-checker-share-db';
const SHARE_STORE_NAME = 'shared-items';
const SHARE_DB_VERSION = 1;

export interface SharedMediaRecord {
  id: string;
  file?: Blob;
  fileName?: string;
  mimeType?: string;
  title?: string;
  text?: string;
  url?: string;
  createdAt: number;
}

export interface ConsumedSharePayload {
  file?: File;
  title?: string;
  text?: string;
  url?: string;
}

function openShareDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(SHARE_DB_NAME, SHARE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARE_STORE_NAME)) {
        db.createObjectStore(SHARE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open share DB'));
  });
}

export async function saveSharedMediaRecord(record: SharedMediaRecord): Promise<void> {
  const db = await openShareDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE_NAME, 'readwrite');
      tx.objectStore(SHARE_STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save share record'));
    });
  } finally {
    db.close();
  }
}

export async function consumeSharedMediaRecord(shareId?: string): Promise<ConsumedSharePayload | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase | null = null;
  try {
    db = await openShareDatabase();
    const record = await new Promise<SharedMediaRecord | null>((resolve, reject) => {
      const tx = db!.transaction(SHARE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(SHARE_STORE_NAME);
      if (shareId) {
        const getReq = store.get(shareId);
        getReq.onsuccess = () => {
          const val = (getReq.result as SharedMediaRecord | undefined) ?? null;
          if (val) {
            store.delete(shareId);
          }
          resolve(val);
        };
        getReq.onerror = () => reject(getReq.error);
      } else {
        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
          const list = (getAllReq.result as SharedMediaRecord[] | undefined) ?? [];
          if (list.length === 0) {
            resolve(null);
            return;
          }
          list.sort((a, b) => b.createdAt - a.createdAt);
          const latest = list[0];
          store.delete(latest.id);
          resolve(latest);
        };
        getAllReq.onerror = () => reject(getAllReq.error);
      }
    });

    if (!record) return null;

    let file: File | undefined;
    if (record.file) {
      if (record.file instanceof File) {
        file = record.file;
      } else {
        file = new File(
          [record.file],
          record.fileName || 'shared-video.mp4',
          { type: record.mimeType || record.file.type || 'video/mp4' }
        );
      }
    }

    return {
      file,
      title: record.title,
      text: record.text,
      url: record.url,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
