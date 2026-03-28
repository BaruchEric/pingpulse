import type { Context, Next } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  prefix?: string;
}

const counters = new Map<string, { count: number; windowStart: number }>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

/** Reset all rate-limit counters (useful for tests). */
export function resetRateLimits(): void {
  counters.clear();
}

export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<AppEnv>, next: Next) => {
    const ip = c.req.header("CF-Connecting-IP") || "unknown";
    const prefix = config.prefix || "global";
    const key = `rl:${prefix}:${ip}`;
    const now = Date.now();

    // Periodic sweep of expired entries to prevent unbounded growth
    if (now - lastSweep > SWEEP_INTERVAL_MS) {
      lastSweep = now;
      for (const [k, v] of counters) {
        if (now - v.windowStart > config.windowMs) counters.delete(k);
      }
    }

    let entry = counters.get(key);
    if (!entry || now - entry.windowStart > config.windowMs) {
      entry = { count: 1, windowStart: now };
      counters.set(key, entry);
    } else {
      entry.count++;
    }

    if (entry.count > config.maxRequests) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    await next();
  };
}
