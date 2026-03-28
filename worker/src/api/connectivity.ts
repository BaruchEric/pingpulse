import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { clientSecretAuth } from "@/middleware/client-auth";
import { dispatchAlert } from "@/services/alert-dispatch";

interface ConnectivityEvent {
  event: "disconnected" | "connected";
  timestamp: number; // unix millis
  reason?: string;
}

interface ConnectivityBatch {
  events: ConnectivityEvent[];
}

export const connectivityRoutes = new Hono<AppEnv>();

connectivityRoutes.post("/:clientId/connectivity", clientSecretAuth, async (c) => {
  const clientId = c.req.param("clientId");
  const batch: ConnectivityBatch = await c.req.json();

  if (!Array.isArray(batch.events) || batch.events.length === 0) {
    return c.json({ error: "No events provided" }, 400);
  }

  if (batch.events.length > 200) {
    return c.json({ error: "Too many events, max 200" }, 400);
  }

  const clientRow = await c.env.DB.prepare(
    "SELECT name, config_json FROM clients WHERE id = ?"
  )
    .bind(clientId)
    .first<{ name: string; config_json: string }>();

  if (!clientRow) {
    return c.json({ error: "Client not found" }, 404);
  }

  const config = JSON.parse(clientRow.config_json || "{}");

  // Sort events chronologically and pair disconnected→connected
  const events = [...batch.events].sort((a, b) => a.timestamp - b.timestamp);
  let outagesCreated = 0;
  let pendingDisconnect: ConnectivityEvent | null = null;

  for (const evt of events) {
    if (evt.event === "disconnected") {
      pendingDisconnect = evt;
    } else if (evt.event === "connected" && pendingDisconnect) {
      const startTs = new Date(pendingDisconnect.timestamp).toISOString();
      const endTs = new Date(evt.timestamp).toISOString();
      const durationS = (evt.timestamp - pendingDisconnect.timestamp) / 1000;

      // Skip very short blips (< grace period) — these aren't real outages
      const graceS = config.down_alert_grace_seconds ?? 60;
      if (durationS < graceS) {
        pendingDisconnect = null;
        continue;
      }

      // Avoid duplicates: check for existing outage within ±30s of start
      const windowStart = new Date(pendingDisconnect.timestamp - 30_000).toISOString();
      const windowEnd = new Date(pendingDisconnect.timestamp + 30_000).toISOString();
      const existing = await c.env.DB.prepare(
        "SELECT id FROM outages WHERE client_id = ? AND start_ts >= ? AND start_ts <= ?"
      )
        .bind(clientId, windowStart, windowEnd)
        .first();

      if (!existing) {
        const outageId = crypto.randomUUID();
        await c.env.DB.prepare(
          "INSERT INTO outages (id, client_id, start_ts, end_ts, duration_s) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(outageId, clientId, startTs, endTs, durationS)
          .run();

        // Check if server already sent an alert for this window
        const alertExists = await c.env.DB.prepare(
          "SELECT id FROM alerts WHERE client_id = ? AND type = 'client_down' AND timestamp >= ? AND timestamp <= ?"
        )
          .bind(clientId, windowStart, endTs)
          .first();

        // Send retrospective alert if server-side detection missed it
        if (!alertExists && config.notifications_enabled !== false) {
          const alertId = crypto.randomUUID();
          const alertTs = new Date().toISOString();
          await c.env.DB.prepare(
            "INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, ?, 'client_down', 'warning', ?, ?, ?)"
          )
            .bind(alertId, clientId, durationS, graceS, alertTs)
            .run();

          try {
            const result = await dispatchAlert(c.env, {
              alert_id: alertId,
              client_id: clientId,
              client_name: clientRow.name,
              type: "client_down",
              severity: "warning",
              value: durationS,
              threshold: graceS,
              timestamp: alertTs,
              message: `Client-reported outage: ${startTs} \u2014 ${endTs} (${Math.round(durationS)}s)\nReason: ${pendingDisconnect.reason ?? "unknown"}`,
              config,
            });

            await c.env.DB.prepare(
              "UPDATE alerts SET delivered_email = ?, delivered_telegram = ? WHERE id = ?"
            )
              .bind(
                result.email ? 1 : -1,
                result.telegram ? 1 : -1,
                alertId
              )
              .run();
          } catch {
            // Alert dispatch failure should not prevent processing remaining events
          }
        }
        outagesCreated++;
      }
      pendingDisconnect = null;
    }
  }

  return c.json({ ok: true, outages_created: outagesCreated });
});
