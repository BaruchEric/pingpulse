import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export const MUTED_UNTIL = "muted_until";
export const DEFAULT_CLIENT = "default_client";

async function readSetting(ctx: QueryCtx, key: string): Promise<string | null> {
  const row = await ctx.db
    .query("botSettings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row?.value ?? null;
}

async function writeSetting(ctx: MutationCtx, key: string, value: string): Promise<void> {
  const row = await ctx.db
    .query("botSettings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  const updatedAt = new Date().toISOString();
  if (row) {
    await ctx.db.patch(row._id, { value, updatedAt });
  } else {
    await ctx.db.insert("botSettings", { key, value, updatedAt });
  }
}

export const getMuteUntil = internalQuery({
  args: {},
  handler: async (ctx) => {
    const value = await readSetting(ctx, MUTED_UNTIL);
    if (!value) return null;
    const until = parseInt(value, 10);
    if (until <= Date.now()) return null;
    return until;
  },
});

export const setMute = internalMutation({
  args: { until: v.number() },
  handler: async (ctx, { until }) => {
    await writeSetting(ctx, MUTED_UNTIL, String(until));
    return { ok: true };
  },
});

export const clearMute = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("botSettings")
      .withIndex("by_key", (q) => q.eq("key", MUTED_UNTIL))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return { ok: true };
  },
});

export const getDefaultClient = internalQuery({
  args: {},
  handler: async (ctx) => readSetting(ctx, DEFAULT_CLIENT),
});

export const setDefaultClient = internalMutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    await writeSetting(ctx, DEFAULT_CLIENT, clientId);
    return { ok: true };
  },
});

// Removes the mute flag once it has expired. Called from the maintenance cron.
export const cleanupExpiredMute = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("botSettings")
      .withIndex("by_key", (q) => q.eq("key", MUTED_UNTIL))
      .unique();
    if (row && parseInt(row.value, 10) <= Date.now()) {
      await ctx.db.delete(row._id);
    }
  },
});
