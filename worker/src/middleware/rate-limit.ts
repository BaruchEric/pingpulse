import { Context, Next } from "hono";
import type { Env } from "@/index";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const ip = c.req.header("CF-Connecting-IP") || "unknown";
    const path = new URL(c.req.url).pathname;
    const key = `rl:${ip}:${path}`;
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - config.windowMs
    ).toISOString();

    const row = await c.env.DB.prepare(
      "SELECT count, window_start FROM rate_limits WHERE key = ?"
    )
      .bind(key)
      .first<{ count: number; window_start: string }>();

    if (row && row.window_start > windowStart) {
      if (row.count >= config.maxRequests) {
        return c.json({ error: "Rate limit exceeded" }, 429);
      }
      await c.env.DB.prepare(
        "UPDATE rate_limits SET count = count + 1 WHERE key = ?"
      )
        .bind(key)
        .run();
    } else {
      await c.env.DB.prepare(
        "INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)"
      )
        .bind(key, now.toISOString())
        .run();
    }

    await next();
  };
}
