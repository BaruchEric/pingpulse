import type { Context, Next } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  prefix?: string;
}

export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<AppEnv>, next: Next) => {
    const ip = c.req.header("CF-Connecting-IP") || "unknown";
    const prefix = config.prefix || "global";
    const key = `rl:${prefix}:${ip}`;
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - config.windowMs
    ).toISOString();

    // Single upsert: reset if window expired, otherwise increment
    const result = await c.env.DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
       RETURNING count`
    )
      .bind(key, now.toISOString(), windowStart, windowStart, now.toISOString())
      .first<{ count: number }>();

    if (result && result.count >= config.maxRequests) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    await next();
  };
}
