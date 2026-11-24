import { isValidBrowserClientId } from './clientIdentity.ts';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface AnalyzeRateLimitDecision extends RateLimitDecision {
  limitedBy: 'browser' | 'ip' | null;
  browserRemaining: number;
  ipRemaining: number;
}

export interface IpRateLimiter {
  consume: (ip: string, now?: number) => RateLimitDecision;
  reset: () => void;
}

export interface AnalyzeRateLimiter {
  consume: (input: {
    clientId?: string | null;
    ip?: string | null;
    now?: number;
  }) => AnalyzeRateLimitDecision;
  reset: () => void;
}

export function normalizeClientIp(rawIp?: string | null): string {
  if (!rawIp) return 'unknown';
  const firstHop = rawIp.split(',')[0]?.trim() ?? '';
  if (!firstHop) return 'unknown';
  if (firstHop.startsWith('::ffff:')) {
    return firstHop.slice(7);
  }
  return firstHop;
}

function createSlidingWindowStore(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, number[]>();

  const pruneStaleEntries = (now: number) => {
    if (buckets.size < 500) return;
    const cutoff = now - windowMs;
    for (const [key, timestamps] of buckets.entries()) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, active);
      }
    }
  };

  const inspect = (key: string, now: number): RateLimitDecision => {
    const cutoff = now - windowMs;
    const existing = buckets.get(key) ?? [];
    const active = existing.filter((t) => t > cutoff);

    if (active.length >= maxRequests) {
      const oldestActive = active[0] ?? now;
      const retryAfterMs = Math.max(1000, oldestActive + windowMs - now);
      buckets.set(key, active);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    buckets.set(key, active);
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - active.length),
      retryAfterSeconds: 0,
    };
  };

  const record = (key: string, now: number): number => {
    const cutoff = now - windowMs;
    const existing = buckets.get(key) ?? [];
    const active = existing.filter((t) => t > cutoff);
    active.push(now);
    buckets.set(key, active);
    pruneStaleEntries(now);
    return Math.max(0, maxRequests - active.length);
  };

  const clear = () => {
    buckets.clear();
  };

  return { inspect, record, clear };
}

export function createIpRateLimiter(options?: {
  maxRequests?: number;
  windowMs?: number;
}): IpRateLimiter {
  const maxRequests = options?.maxRequests ?? 5;
  const windowMs = options?.windowMs ?? 60_000;
  const store = createSlidingWindowStore(maxRequests, windowMs);

  return {
    consume(ip: string, now = Date.now()): RateLimitDecision {
      const normalizedIp = normalizeClientIp(ip);
      const check = store.inspect(normalizedIp, now);
      if (!check.allowed) {
        return check;
      }
      const remaining = store.record(normalizedIp, now);
      return {
        allowed: true,
        remaining,
        retryAfterSeconds: 0,
      };
    },
    reset() {
      store.clear();
    },
  };
}

export function createAnalyzeRateLimiter(options?: {
  browserMaxRequests?: number;
  ipMaxRequests?: number;
  windowMs?: number;
}): AnalyzeRateLimiter {
  const browserMaxRequests = options?.browserMaxRequests ?? 5;
  const ipMaxRequests = options?.ipMaxRequests ?? 60;
  const windowMs = options?.windowMs ?? 60_000;

  const browserStore = createSlidingWindowStore(browserMaxRequests, windowMs);
  const ipStore = createSlidingWindowStore(ipMaxRequests, windowMs);

  return {
    consume({ clientId, ip, now = Date.now() }): AnalyzeRateLimitDecision {
      const normalizedIp = normalizeClientIp(ip);
      const trimmedClientId = typeof clientId === 'string' ? clientId.trim() : '';
      const browserKey = isValidBrowserClientId(trimmedClientId)
        ? `browser:${trimmedClientId}`
        : `fallback-ip:${normalizedIp}`;
      const ipKey = `ip:${normalizedIp}`;

      const browserCheck = browserStore.inspect(browserKey, now);
      if (!browserCheck.allowed) {
        const ipCheck = ipStore.inspect(ipKey, now);
        return {
          allowed: false,
          limitedBy: 'browser',
          remaining: 0,
          browserRemaining: 0,
          ipRemaining: ipCheck.remaining,
          retryAfterSeconds: browserCheck.retryAfterSeconds,
        };
      }

      const ipCheck = ipStore.inspect(ipKey, now);
      if (!ipCheck.allowed) {
        return {
          allowed: false,
          limitedBy: 'ip',
          remaining: 0,
          browserRemaining: browserCheck.remaining,
          ipRemaining: 0,
          retryAfterSeconds: ipCheck.retryAfterSeconds,
        };
      }

      const browserRemaining = browserStore.record(browserKey, now);
      const ipRemaining = ipStore.record(ipKey, now);

      return {
        allowed: true,
        limitedBy: null,
        remaining: Math.min(browserRemaining, ipRemaining),
        browserRemaining,
        ipRemaining,
        retryAfterSeconds: 0,
      };
    },
    reset() {
      browserStore.clear();
      ipStore.clear();
    },
  };
}
