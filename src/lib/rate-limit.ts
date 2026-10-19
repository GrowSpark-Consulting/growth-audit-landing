export interface RateLimiter {
  /** Returns false once `limit` calls were made for `key` within the window. */
  take(key: string, now?: number): boolean;
}

/** In-memory fixed-window limiter. Per server instance, so it is a best-effort guard only. */
export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    take(key, now = Date.now()) {
      if (hits.size > 5_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + options.windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= options.limit;
    },
  };
}
