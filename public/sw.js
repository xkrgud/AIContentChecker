const CACHE_NAME = 'ai-content-checker-v2';
const STATIC_ASSETS = ['/', '/manifest.webmanifest', '/icon.svg'];
const SHARE_DB_NAME = 'ai-content-checker-share-db';
const SHARE_STORE_NAME = 'shared-items';

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARE_STORE_NAME)) {
        db.createObjectStore(SHARE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSharedItem(record) {
  const db = await openShareDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE_NAME, 'readwrite');
      tx.objectStore(SHARE_STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function handleShareTargetPost(request) {
  try {
    const formData = await request.formData();
    const title = typeof formData.get('title') === 'string' ? formData.get('title').trim() : '';
    const text = typeof formData.get('text') === 'string' ? formData.get('text').trim() : '';
    const url = typeof formData.get('url') === 'string' ? formData.get('url').trim() : '';

    let sharedFile = null;
    const mediaEntries = formData.getAll('media');
    for (const entry of mediaEntries) {
      if (entry && typeof entry === 'object' && 'size' in entry && entry.size > 0) {
        sharedFile = entry;
        break;
      }
    }
    if (!sharedFile) {
      for (const [, entry] of formData.entries()) {
        if (entry && typeof entry === 'object' && 'size' in entry && entry.size > 0) {
          sharedFile = entry;
          break;
        }
      }
    }

    const shareId = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (sharedFile || title || text || url) {
      await saveSharedItem({
        id: shareId,
        file: sharedFile || undefined,
        fileName: sharedFile && 'name' in sharedFile ? sharedFile.name : undefined,
        mimeType: sharedFile && 'type' in sharedFile ? sharedFile.type : undefined,
        title: title || undefined,
        text: text || undefined,
        url: url || undefined,
        createdAt: Date.now(),
      });
    }

    const redirectUrl = new URL('/', self.location.origin);
    redirectUrl.searchParams.set('shareId', shareId);
    if (url) redirectUrl.searchParams.set('url', url);
    if (title) redirectUrl.searchParams.set('title', title);
    if (text) redirectUrl.searchParams.set('text', text);

    return Response.redirect(redirectUrl.toString(), 303);
  } catch {
    return Response.redirect('/', 303);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (
    event.request.method === 'POST' &&
    url.origin === self.location.origin &&
    (url.pathname === '/share-target' || url.pathname === '/')
  ) {
    event.respondWith(handleShareTargetPost(event.request));
    return;
  }

  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((cached) => cached || caches.match('/'))
    )
  );
});
