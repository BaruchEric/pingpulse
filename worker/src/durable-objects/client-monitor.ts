import type { Env } from "@/index";
import type {
  ClientConfig,
  PingResult,
  SpeedTestResult,
  AlertRecord,
  WSMessage,
} from "@/types";
import { DEFAULT_CLIENT_CONFIG } from "@/types";
import { hashString } from "@/utils/hash";

interface PingInFlight {
  id: string;
  sent_ts: number;
}

export class ClientMonitor implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: WebSocket[] = [];
  private clientId: string | null = null;
  private config: ClientConfig = DEFAULT_CLIENT_CONFIG;
  private pingBuffer: PingResult[] = [];
  private recentRTTs: number[] = [];
  private runningJitter: number = 0;
  private pingsInFlight: Map<string, PingInFlight> = new Map();
  private lastFlush: number = Date.now();
  private disconnectedAt: number | null = null;
  private currentOutageId: string | null = null;
  private lastAlertTimes: Map<string, number> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/");
    this.clientId = pathParts[pathParts.length - 1] || null;

    // Internal API calls from cron/other workers
    if (url.pathname.endsWith("/trigger-speed-test")) {
      return this.handleSpeedTestTrigger();
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    // Authenticate
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const secret = authHeader.slice(7);
    const isValid = await this.validateSecret(secret);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Accept WebSocket
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.sessions.push(server);

    // Client connected — clear any disconnection state
    if (this.disconnectedAt) {
      await this.handleReconnect();
    }

    // Update last_seen
    await this.env.DB.prepare(
      "UPDATE clients SET last_seen = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), this.clientId)
      .run();

    // Load client config from DB
    const row = await this.env.DB.prepare(
      "SELECT config_json FROM clients WHERE id = ?"
    )
      .bind(this.clientId)
      .first<{ config_json: string }>();

    if (row) {
      this.config = { ...DEFAULT_CLIENT_CONFIG, ...JSON.parse(row.config_json) };
    }

    // Start ping alarm if not already running
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      await this.state.storage.setAlarm(
        Date.now() + this.config.ping_interval_s * 1000
      );
    }

    // Send current config to client
    server.send(
      JSON.stringify({
        type: "config_update",
        config: this.config,
      } satisfies WSMessage)
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return;

    try {
      const msg: WSMessage = JSON.parse(message);

      switch (msg.type) {
        case "pong":
          await this.handlePong(msg);
          break;
        case "ping":
          // Client-to-CF ping — echo back immediately
          ws.send(
            JSON.stringify({
              type: "pong",
              id: msg.id,
              ts: msg.ts,
              client_ts: Date.now(),
            } satisfies WSMessage)
          );
          break;
        case "speed_test_result":
          await this.handleSpeedTestResult(msg.result);
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    this.sessions = this.sessions.filter((s) => s !== ws);
    if (this.sessions.length === 0) {
      this.disconnectedAt = Date.now();
      await this.state.storage.setAlarm(
        Date.now() + this.config.grace_period_s * 1000
      );
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.sessions = this.sessions.filter((s) => s !== ws);
    if (this.sessions.length === 0) {
      this.disconnectedAt = Date.now();
      await this.state.storage.setAlarm(
        Date.now() + this.config.grace_period_s * 1000
      );
    }
  }

  async alarm(): Promise<void> {
    // Check if this is a disconnection grace period check
    if (this.disconnectedAt && this.sessions.length === 0) {
      const elapsed = Date.now() - this.disconnectedAt;
      if (elapsed >= this.config.grace_period_s * 1000) {
        await this.triggerAlert(
          "client_down",
          "critical",
          elapsed / 1000,
          this.config.grace_period_s
        );
        // Record outage start
        this.currentOutageId = crypto.randomUUID();
        await this.env.DB.prepare(
          "INSERT INTO outages (id, client_id, start_ts) VALUES (?, ?, ?)"
        )
          .bind(
            this.currentOutageId,
            this.clientId,
            new Date(this.disconnectedAt).toISOString()
          )
          .run();
      }
      return; // Don't schedule next ping — client is disconnected
    }

    // Normal ping alarm
    if (this.sessions.length > 0) {
      await this.sendPing();
      await this.maybeFlushBuffer();
      await this.state.storage.setAlarm(
        Date.now() + this.config.ping_interval_s * 1000
      );
    }
  }

  private async validateSecret(secret: string): Promise<boolean> {
    if (!this.clientId) return false;

    const hash = await hashString(secret);
    const row = await this.env.DB.prepare(
      "SELECT secret_hash FROM clients WHERE id = ?"
    )
      .bind(this.clientId)
      .first<{ secret_hash: string }>();

    return row?.secret_hash === hash;
  }

  private async sendPing(): Promise<void> {
    const pingId = crypto.randomUUID();
    const now = Date.now();

    this.pingsInFlight.set(pingId, { id: pingId, sent_ts: now });

    // Timeout after 10s — mark as timeout if no pong received
    setTimeout(() => {
      if (this.pingsInFlight.has(pingId)) {
        this.pingsInFlight.delete(pingId);
        this.pingBuffer.push({
          client_id: this.clientId!,
          timestamp: new Date(now).toISOString(),
          rtt_ms: -1,
          jitter_ms: 0,
          direction: "cf_to_client",
          status: "timeout",
        });
      }
    }, 10_000);

    const msg: WSMessage = { type: "ping", id: pingId, ts: now };
    for (const ws of this.sessions) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // WebSocket may be closing
      }
    }
  }

  private async handlePong(
    msg: WSMessage & { type: "pong" }
  ): Promise<void> {
    const inFlight = this.pingsInFlight.get(msg.id);
    if (!inFlight) return;

    this.pingsInFlight.delete(msg.id);
    const rtt = Date.now() - inFlight.sent_ts;

    // RFC 3550 jitter: J(i) = J(i-1) + (|D(i-1,i)| - J(i-1)) / 16
    if (this.recentRTTs.length > 0) {
      const lastRTT = this.recentRTTs[this.recentRTTs.length - 1];
      const diff = Math.abs(rtt - lastRTT);
      this.runningJitter =
        this.runningJitter + (diff - this.runningJitter) / 16;
    }
    const jitter = this.runningJitter;

    this.recentRTTs.push(rtt);
    if (this.recentRTTs.length > 100) this.recentRTTs.shift();

    const result: PingResult = {
      client_id: this.clientId!,
      timestamp: new Date().toISOString(),
      rtt_ms: rtt,
      jitter_ms: Math.round(jitter * 100) / 100,
      direction: "cf_to_client",
      status: "ok",
    };

    this.pingBuffer.push(result);

    // Check latency threshold
    if (rtt > this.config.alert_latency_threshold_ms) {
      await this.triggerAlert(
        "high_latency",
        "warning",
        rtt,
        this.config.alert_latency_threshold_ms
      );
    }

    // Check packet loss (over last 20 pings)
    const recentResults = this.pingBuffer.slice(-20);
    const timeouts = recentResults.filter(
      (r) => r.status === "timeout"
    ).length;
    const lossPct = (timeouts / recentResults.length) * 100;
    if (lossPct > this.config.alert_loss_threshold_pct) {
      await this.triggerAlert(
        "packet_loss",
        "warning",
        lossPct,
        this.config.alert_loss_threshold_pct
      );
    }
  }

  private async maybeFlushBuffer(): Promise<void> {
    const now = Date.now();
    const shouldFlush =
      this.pingBuffer.length >= 10 || now - this.lastFlush >= 60_000;

    if (!shouldFlush || this.pingBuffer.length === 0) return;

    const batch = this.pingBuffer.splice(0);
    this.lastFlush = now;

    // Batch insert to D1
    const stmt = this.env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    const stmts = batch.map((r) =>
      stmt.bind(
        crypto.randomUUID(),
        r.client_id,
        r.timestamp,
        r.rtt_ms,
        r.jitter_ms,
        r.direction,
        r.status
      )
    );

    await this.env.DB.batch(stmts);

    // Write to Analytics Engine
    for (const r of batch) {
      if (r.status === "ok") {
        this.env.METRICS.writeDataPoint({
          blobs: [r.client_id, "latency"],
          doubles: [r.rtt_ms],
        });
        this.env.METRICS.writeDataPoint({
          blobs: [r.client_id, "jitter"],
          doubles: [r.jitter_ms],
        });
      }
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.currentOutageId) {
      const now = new Date();
      const duration = this.disconnectedAt
        ? (now.getTime() - this.disconnectedAt) / 1000
        : 0;

      await this.env.DB.prepare(
        "UPDATE outages SET end_ts = ?, duration_s = ? WHERE id = ?"
      )
        .bind(now.toISOString(), duration, this.currentOutageId)
        .run();

      await this.triggerAlert("client_up", "info", duration, 0);
      this.currentOutageId = null;
    }
    this.disconnectedAt = null;
  }

  private async handleSpeedTestResult(
    result: SpeedTestResult
  ): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO speed_tests (id, client_id, timestamp, type, download_mbps, upload_mbps, payload_bytes, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        result.client_id,
        result.timestamp,
        result.type,
        result.download_mbps,
        result.upload_mbps,
        result.payload_bytes,
        result.duration_ms
      )
      .run();

    this.env.METRICS.writeDataPoint({
      blobs: [result.client_id, "download_mbps"],
      doubles: [result.download_mbps],
    });
    this.env.METRICS.writeDataPoint({
      blobs: [result.client_id, "upload_mbps"],
      doubles: [result.upload_mbps],
    });
  }

  private handleSpeedTestTrigger(): Response {
    for (const ws of this.sessions) {
      try {
        ws.send(
          JSON.stringify({
            type: "start_speed_test",
            test_type: "full",
          } satisfies WSMessage)
        );
      } catch {
        // ignore
      }
    }
    return new Response("OK");
  }

  private async triggerAlert(
    type: AlertRecord["type"],
    severity: AlertRecord["severity"],
    value: number,
    threshold: number
  ): Promise<void> {
    // Deduplication: 5-minute cooldown per alert type
    const lastTime = this.lastAlertTimes.get(type) || 0;
    if (Date.now() - lastTime < 5 * 60_000) return;
    this.lastAlertTimes.set(type, Date.now());

    const alertId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    await this.env.DB.prepare(
      "INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(alertId, this.clientId, type, severity, value, threshold, timestamp)
      .run();

    // Dispatch alert directly (same Worker, direct import)
    try {
      const { dispatchAlert } = await import("@/services/alert-dispatch");
      await dispatchAlert(this.env, {
        alert_id: alertId,
        client_id: this.clientId!,
        type,
        severity,
        value,
        threshold,
        timestamp,
      });
    } catch {
      // Best effort — alert is already stored in D1
    }
  }
}
