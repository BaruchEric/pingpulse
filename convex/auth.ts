import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { DEFAULT_CLIENT_CONFIG } from "./lib/config";

export const getAdminPasswordHash = internalQuery({
  args: {},
  handler: async (ctx) => {
    const admin = await ctx.db.query("admin").first();
    return admin ? { passwordHash: admin.passwordHash } : null;
  },
});

export const setAdminPasswordHash = internalMutation({
  args: { passwordHash: v.string() },
  handler: async (ctx, { passwordHash }) => {
    const existing = await ctx.db.query("admin").first();
    if (existing) {
      await ctx.db.patch(existing._id, { passwordHash });
    } else {
      await ctx.db.insert("admin", {
        passwordHash,
        createdAt: new Date().toISOString(),
      });
    }
    return { ok: true };
  },
});

// One-time bootstrap: sets the admin password only if no admin exists yet.
// Run with: npx convex run auth:bootstrap '{"passwordHash":"<sha256-hex>"}'
// (Use the dashboard login or the /api/auth/bootstrap HTTP route in practice.)
export const bootstrap = mutation({
  args: { passwordHash: v.string() },
  handler: async (ctx, { passwordHash }) => {
    const existing = await ctx.db.query("admin").first();
    if (existing) return { ok: false, reason: "already_initialized" };
    await ctx.db.insert("admin", {
      passwordHash,
      createdAt: new Date().toISOString(),
    });
    return { ok: true };
  },
});

export const createRegistrationToken = internalMutation({
  args: { tokenHash: v.string(), expiresAt: v.string() },
  handler: async (ctx, { tokenHash, expiresAt }) => {
    await ctx.db.insert("registrationTokens", {
      tokenHash,
      createdAt: new Date().toISOString(),
      expiresAt,
      usedAt: null,
      usedByClientId: null,
    });
    return { ok: true };
  },
});

export const registerClient = internalMutation({
  args: {
    tokenHash: v.string(),
    name: v.string(),
    location: v.string(),
    clientId: v.string(),
    secretHash: v.string(),
  },
  handler: async (ctx, { tokenHash, name, location, clientId, secretHash }) => {
    const tokenRow = await ctx.db
      .query("registrationTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();

    if (!tokenRow) return { error: "invalid" as const };
    if (tokenRow.usedAt) return { error: "used" as const };
    if (new Date(tokenRow.expiresAt) < new Date())
      return { error: "expired" as const };

    const now = new Date().toISOString();
    await ctx.db.patch(tokenRow._id, { usedAt: now, usedByClientId: clientId });
    await ctx.db.insert("clients", {
      clientId,
      name,
      location,
      secretHash,
      config: DEFAULT_CLIENT_CONFIG,
      createdAt: now,
      lastSeen: now,
      clientVersion: "",
      paused: false,
      simulationLatencyMs: 0,
      simulationLossPct: 0,
      disconnectedAt: null,
      currentOutageId: null,
      adminDisconnectUntil: null,
    });

    return { ok: true as const, client_id: clientId };
  },
});
