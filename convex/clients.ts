import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { clientConfigValidator } from "./schema";
import { withDefaults, pickAllowedConfig, DEFAULT_CLIENT_CONFIG } from "./lib/config";
import { latestClientVersion } from "./lib/crypto";

export async function getClientDoc(
  ctx: QueryCtx,
  clientId: string,
): Promise<Doc<"clients"> | null> {
  return ctx.db
    .query("clients")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .unique();
}

function publicClient(c: Doc<"clients">) {
  return {
    id: c.clientId,
    name: c.name,
    location: c.location,
    client_version: c.clientVersion || "",
    config: c.config,
    created_at: c.createdAt,
    last_seen: c.lastSeen,
  };
}

export const listWithStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const clients = await ctx.db.query("clients").collect();
    clients.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const result = await Promise.all(
      clients.map(async (c) => {
        const recentPings = await ctx.db
          .query("pingResults")
          .withIndex("by_client_ts", (q) => q.eq("clientId", c.clientId))
          .order("desc")
          .take(10);

        let avg_rtt_ms: number | null = null;
        let loss_pct: number | null = null;
        if (recentPings.length > 0) {
          avg_rtt_ms =
            recentPings.reduce((sum, p) => sum + p.rttMs, 0) / recentPings.length;
          const lost = recentPings.filter((p) => p.status !== "ok").length;
          loss_pct = (lost / recentPings.length) * 100;
        }

        const lastSpeed = await ctx.db
          .query("speedTests")
          .withIndex("by_client_ts", (q) => q.eq("clientId", c.clientId))
          .order("desc")
          .first();

        return {
          ...publicClient(c),
          stats: {
            avg_rtt_ms,
            loss_pct,
            last_speed_test: lastSpeed
              ? {
                  download_mbps: lastSpeed.downloadMbps,
                  upload_mbps: lastSpeed.uploadMbps,
                  timestamp: lastSpeed.timestamp,
                }
              : null,
          },
        };
      }),
    );

    return { clients: result, latest_client_version: latestClientVersion() };
  },
});

export const getOne = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return null;
    return publicClient(c);
  },
});

// Returns just the secret hash for client-secret authentication.
export const getSecretHash = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const c = await getClientDoc(ctx, clientId);
    return c ? { secretHash: c.secretHash } : null;
  },
});

export const update = internalMutation({
  args: {
    clientId: v.string(),
    name: v.optional(v.string()),
    location: v.optional(v.string()),
    config: v.optional(v.any()),
  },
  handler: async (ctx, { clientId, name, location, config }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return { ok: false, notFound: true as const };

    const patch: Partial<Doc<"clients">> = {};
    if (name !== undefined) patch.name = name;
    if (location !== undefined) patch.location = location;
    let mergedConfig = c.config;
    if (config !== undefined) {
      mergedConfig = withDefaults({
        ...c.config,
        ...pickAllowedConfig(config as Record<string, unknown>),
      });
      patch.config = mergedConfig;
    }

    if (Object.keys(patch).length === 0) {
      return { ok: false, nothingToUpdate: true as const };
    }

    await ctx.db.patch(c._id, patch);
    return { ok: true as const, config: mergedConfig };
  },
});

export const setConfig = internalMutation({
  args: { clientId: v.string(), config: clientConfigValidator },
  handler: async (ctx, { clientId, config }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return { ok: false };
    await ctx.db.patch(c._id, { config });
    return { ok: true };
  },
});

async function cascadeDelete(ctx: MutationCtx, clientId: string): Promise<boolean> {
  const c = await getClientDoc(ctx, clientId);
  if (!c) return false;

  const tables = ["pingResults", "speedTests", "alerts"] as const;
  for (const table of tables) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_client_ts", (q) => q.eq("clientId", clientId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }

  const probes = await ctx.db
    .query("clientProbeResults")
    .withIndex("by_client_ts", (q) => q.eq("clientId", clientId))
    .collect();
  for (const row of probes) await ctx.db.delete(row._id);

  const outages = await ctx.db
    .query("outages")
    .withIndex("by_client_start", (q) => q.eq("clientId", clientId))
    .collect();
  for (const row of outages) await ctx.db.delete(row._id);

  const commands = await ctx.db
    .query("commands")
    .withIndex("by_client", (q) => q.eq("clientId", clientId))
    .collect();
  for (const row of commands) await ctx.db.delete(row._id);

  await ctx.db.delete(c._id);
  return true;
}

export const remove = internalMutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const deleted = await cascadeDelete(ctx, clientId);
    return { deleted };
  },
});

export const requireClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const c = await getClientDoc(ctx, clientId);
    return c ? { id: c.clientId } : null;
  },
});

// Clients seen within the given ISO cutoff. Used by maintenance crons.
export const listActiveSince = internalQuery({
  args: { since: v.string() },
  handler: async (ctx, { since }) => {
    const clients = await ctx.db
      .query("clients")
      .withIndex("by_lastSeen", (q) => q.gte("lastSeen", since))
      .collect();
    return clients.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      config: withDefaults(c.config),
      lastSeen: c.lastSeen,
    }));
  },
});

// Deletes up to `limit` raw records older than the cutoffs for one client.
// Returns how many of each were removed so the caller can loop until drained.
export const purgeOldRecords = internalMutation({
  args: {
    clientId: v.string(),
    cutoffIso: v.string(),
    cutoffMs: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { clientId, cutoffIso, cutoffMs, limit }) => {
    const oldPings = await ctx.db
      .query("pingResults")
      .withIndex("by_client_ts", (q) =>
        q.eq("clientId", clientId).lt("timestamp", cutoffIso),
      )
      .order("asc")
      .take(limit);
    for (const p of oldPings) await ctx.db.delete(p._id);

    const oldProbes = await ctx.db
      .query("clientProbeResults")
      .withIndex("by_client_ts", (q) =>
        q.eq("clientId", clientId).lt("timestamp", cutoffMs),
      )
      .order("asc")
      .take(limit);
    for (const p of oldProbes) await ctx.db.delete(p._id);

    return { pings: oldPings.length, probes: oldProbes.length };
  },
});

// Used to seed default config onto any client missing fields after a config
// schema change. Returns the resolved config without persisting.
export function resolveConfig(c: Doc<"clients"> | null) {
  return c ? withDefaults(c.config) : DEFAULT_CLIENT_CONFIG;
}
