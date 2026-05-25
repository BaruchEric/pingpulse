import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Fixed-window rate limiter backed by the rateLimits table. Replaces the
// Worker's in-memory Map (which wouldn't be shared across Convex instances).
export const check = internalMutation({
  args: { key: v.string(), maxRequests: v.number(), windowMs: v.number() },
  handler: async (ctx, { key, maxRequests, windowMs }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();

    if (!row || now - row.windowStart > windowMs) {
      if (row) {
        await ctx.db.patch(row._id, { count: 1, windowStart: now });
      } else {
        await ctx.db.insert("rateLimits", { key, count: 1, windowStart: now });
      }
      return { allowed: true };
    }

    await ctx.db.patch(row._id, { count: row.count + 1 });
    return { allowed: row.count + 1 <= maxRequests };
  },
});

export const cleanup = internalMutation({
  args: { olderThanMs: v.number() },
  handler: async (ctx, { olderThanMs }) => {
    const cutoff = Date.now() - olderThanMs;
    const stale = await ctx.db
      .query("rateLimits")
      .filter((q) => q.lt(q.field("windowStart"), cutoff))
      .take(1000);
    for (const row of stale) await ctx.db.delete(row._id);
    return { removed: stale.length };
  },
});
