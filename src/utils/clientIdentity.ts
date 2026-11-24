export const BROWSER_CLIENT_ID_STORAGE_KEY = 'ai_content_checker_browser_id_v1';

const VALID_CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

let inMemoryFallbackClientId: string | null = null;

export function isValidBrowserClientId(rawId?: string | null): rawId is string {
  return typeof rawId === 'string' && VALID_CLIENT_ID_PATTERN.test(rawId.trim());
}

export function generateBrowserClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `br-${globalThis.crypto.randomUUID()}`;
  }
  const randA = Math.random().toString(36).slice(2, 10);
  const randB = Math.random().toString(36).slice(2, 10);
  return `br-${Date.now().toString(36)}-${randA}${randB}`;
}

export function getOrCreateBrowserClientId(
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
): string {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;

  if (targetStorage) {
    try {
      const existing = targetStorage.getItem(BROWSER_CLIENT_ID_STORAGE_KEY);
      if (isValidBrowserClientId(existing)) {
        return existing.trim();
      }
      const created = generateBrowserClientId();
      targetStorage.setItem(BROWSER_CLIENT_ID_STORAGE_KEY, created);
      return created;
    } catch {
      // Storage blocked (e.g. private browsing) -> fall back to stable in-memory ID for session
    }
  }

  if (!inMemoryFallbackClientId) {
    inMemoryFallbackClientId = generateBrowserClientId();
  }
  return inMemoryFallbackClientId;
}
