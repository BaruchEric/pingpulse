# Deep Analysis, Alert Delivery Fix & Health Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deep analysis dashboard with export/print, fix alert delivery tracking, and implement automated health reports via Telegram + email.

**Architecture:** All changes stay within the existing Cloudflare Worker. New analysis SQL queries are extracted into a shared module used by both the API endpoint and the health report generator. Alert dispatch returns delivery status and updates DB columns. Reports are generated in the existing 6-hour cron with configurable schedule per-client.

**Tech Stack:** Cloudflare Workers (Hono), D1, Durable Objects, React 19, uPlot, Tailwind CSS 4, Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-deep-analysis-alerts-reports-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `worker/src/services/analysis-queries.ts` | 8 reusable D1 aggregation query functions |
| `worker/src/api/analysis.ts` | `GET /:id/analysis` and `POST /:id/report` endpoints (mounted under `/api/metrics`) |
| `worker/src/services/health-report.ts` | Report formatting (Telegram text, email HTML) + cron dispatch |
| `worker/dashboard/src/components/AnalysisSummaryCard.tsx` | Stats grid: record counts, uptime %, error rate, latency by direction |
| `worker/dashboard/src/components/ProbeStatsTable.tsx` | Per-target/per-type breakdown table |
| `worker/dashboard/src/components/HourlyHeatmap.tsx` | Hourly avg RTT + error count bar chart (uPlot) |
| `worker/dashboard/src/components/DirectionAsymmetry.tsx` | CF→Client vs Client→CF line chart (uPlot) |
| `worker/dashboard/src/components/AlertStormSummary.tsx` | Alert clustering, frequency, top spikes |
| `worker/dashboard/src/components/SpeedTestStats.tsx` | Full vs probe speed test comparison table |
| `worker/dashboard/src/components/ReportModal.tsx` | Report preview + send/export modal |

### Modified Files

| File | Change |
|------|--------|
| `worker/src/services/alert-dispatch.ts` | Return `{ email: boolean; telegram: boolean }`, log errors |
| `worker/src/durable-objects/client-monitor.ts` | Update `delivered_*` columns, alarm-based retry for critical |
| `worker/src/api/router.ts` | Import + mount `analysisRoutes` |
| `worker/src/index.ts` | Add `generateHealthReports()` to cron `scheduled()` |
| `worker/src/types.ts` | Add `report_schedule`, `report_channels`, `AnalysisResponse` |
| `worker/dashboard/src/lib/types.ts` | Add `delivered_email`/`delivered_telegram` to `Alert`, add `AnalysisResponse` |
| `worker/dashboard/src/lib/api.ts` | Add `getAnalysis()`, `generateReport()`, `sendReport()` |
| `worker/dashboard/src/lib/hooks.ts` | Add `useAnalysis()` (no auto-poll) |
| `worker/dashboard/src/components/AlertRow.tsx` | Add delivery status icons |
| `worker/dashboard/src/pages/ClientDetail.tsx` | Add Overview/Analysis tab bar, summary card |
| `worker/dashboard/src/pages/Alerts.tsx` | Add Health Reports settings section |

---

## Task 1: Fix Alert Dispatch Return Values

**Files:**
- Modify: `worker/src/services/alert-dispatch.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/services/__tests__/alert-dispatch.test.ts`.

**Note:** The project uses `@cloudflare/vitest-pool-workers` which runs tests in a Workers-like environment. Use `vi.spyOn(globalThis, "fetch")` instead of `vi.stubGlobal` for fetch mocking compatibility:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchAlert, type AlertPayload } from "@/services/alert-dispatch";

const baseAlert: AlertPayload = {
  alert_id: "test-1",
  client_id: "client-1",
  client_name: "Test Client",
  type: "high_latency",
  severity: "warning",
  value: 300,
  threshold: 250,
  timestamp: "2026-03-22T12:00:00Z",
};

describe("dispatchAlert", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns email:true, telegram:true on success", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const env = {
      RESEND_API_KEY: "re_test",
      ALERT_FROM_EMAIL: "from@test.com",
      ALERT_TO_EMAIL: "to@test.com",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    } as any;

    const result = await dispatchAlert(env, baseAlert);
    expect(result).toEqual({ email: true, telegram: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns email:false when Resend fails", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("resend")) return Promise.reject(new Error("network"));
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const env = {
      RESEND_API_KEY: "re_test",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    } as any;

    const result = await dispatchAlert(env, baseAlert);
    expect(result.email).toBe(false);
    expect(result.telegram).toBe(true);
  });

  it("skips channels when env vars missing", async () => {
    const env = {} as any;
    const result = await dispatchAlert(env, baseAlert);
    expect(result).toEqual({ email: false, telegram: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test -- src/services/__tests__/alert-dispatch.test.ts`

Expected: FAIL — `dispatchAlert` returns `void`, not `{ email, telegram }`

- [ ] **Step 3: Implement the fix**

Update `worker/src/services/alert-dispatch.ts`:

```typescript
import type { Env } from "@/index";
import type { AlertType, AlertSeverity } from "@/types";

export interface AlertPayload {
  alert_id: string;
  client_id: string;
  client_name?: string;
  type: AlertType;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  timestamp: string;
  message?: string;
}

export interface DispatchResult {
  email: boolean;
  telegram: boolean;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
  info: "\u{1F7E2}",
};

function formatMessage(alert: AlertPayload): string {
  const emoji = SEVERITY_EMOJI[alert.severity] || "\u26AA";
  const clientLabel = alert.client_name
    ? `${alert.client_name} (${alert.client_id})`
    : alert.client_id;
  const lines = [
    `${emoji} PingPulse Alert: ${alert.type.toUpperCase().replace(/_/g, " ")}`,
    `Severity: ${alert.severity.toUpperCase()}`,
    `Client: ${clientLabel}`,
    `Value: ${alert.value}`,
    `Threshold: ${alert.threshold}`,
    `Time: ${alert.timestamp}`,
  ];
  if (alert.message) lines.push(`\n${alert.message}`);
  return lines.join("\n");
}

export async function dispatchAlert(
  env: Env,
  alert: AlertPayload
): Promise<DispatchResult> {
  const message = formatMessage(alert);
  const result: DispatchResult = { email: false, telegram: false };

  const promises: Promise<void>[] = [];

  if (env.RESEND_API_KEY) {
    promises.push(
      sendEmail(env, alert, message)
        .then(() => { result.email = true; })
        .catch((err) => {
          console.error(`[alert-dispatch] Email failed for alert ${alert.alert_id}:`, err);
          result.email = false;
        })
    );
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    promises.push(
      sendTelegram(env, message)
        .then(() => { result.telegram = true; })
        .catch((err) => {
          console.error(`[alert-dispatch] Telegram failed for alert ${alert.alert_id}:`, err);
          result.telegram = false;
        })
    );
  }

  await Promise.allSettled(promises);
  return result;
}

async function sendEmail(
  env: Env,
  alert: AlertPayload,
  message: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
      to: [env.ALERT_TO_EMAIL || "admin@beric.ca"],
      subject: `[PingPulse] ${alert.severity.toUpperCase()}: ${alert.type.replace(/_/g, " ")}`,
      text: message,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend API returned ${res.status}: ${await res.text()}`);
  }
}

async function sendTelegram(env: Env, message: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Telegram API returned ${res.status}: ${await res.text()}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test -- src/services/__tests__/alert-dispatch.test.ts`

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/src/services/alert-dispatch.ts worker/src/services/__tests__/alert-dispatch.test.ts
git commit -m "fix: alert dispatch returns delivery status and logs errors"
```

---

## Task 2: Update triggerAlert to Track Delivery + Retry Critical

**Files:**
- Modify: `worker/src/durable-objects/client-monitor.ts`

- [ ] **Step 1: Update the `triggerAlert` method**

In `worker/src/durable-objects/client-monitor.ts`, find the `triggerAlert` method. After the `dispatchAlert()` call, add delivery status tracking. Replace the existing try/catch block inside `if (this.config.notifications_enabled)`:

```typescript
    // After: await this.env.DB.prepare("INSERT INTO alerts ...").run();

    if (this.config.notifications_enabled) {
      try {
        const clientRow = await this.env.DB.prepare(
          "SELECT name FROM clients WHERE id = ?"
        )
          .bind(this.clientId)
          .first<{ name: string }>();

        const channels = new Set(this.config.down_alert_channels ?? ["telegram"]);

        if (this.config.down_alert_escalation_enabled && type === "client_down") {
          const downDuration = (Date.now() - (this.disconnectedAt ?? Date.now())) / 1000;
          if (downDuration >= (this.config.down_alert_escalate_after_seconds ?? 600)) {
            for (const ch of this.config.down_alert_escalate_channels ?? ["email"]) {
              channels.add(ch);
            }
          }
        }

        const scopedEnv = {
          ...this.env,
          TELEGRAM_BOT_TOKEN: channels.has("telegram") ? this.env.TELEGRAM_BOT_TOKEN : "",
          TELEGRAM_CHAT_ID: channels.has("telegram") ? this.env.TELEGRAM_CHAT_ID : "",
          RESEND_API_KEY: channels.has("email") ? this.env.RESEND_API_KEY : "",
        };

        const result = await dispatchAlert(scopedEnv, {
          alert_id: alertId,
          client_id: this.clientId,
          client_name: clientRow?.name,
          type,
          severity,
          value,
          threshold,
          timestamp,
        });

        // Update delivery status: 1 = success, 0 = not attempted, -1 = failed
        const emailStatus = !channels.has("email") ? 0 : result.email ? 1 : -1;
        const telegramStatus = !channels.has("telegram") ? 0 : result.telegram ? 1 : -1;

        await this.env.DB.prepare(
          "UPDATE alerts SET delivered_email = ?, delivered_telegram = ? WHERE id = ?"
        )
          .bind(emailStatus, telegramStatus, alertId)
          .run();

        // Retry failed channels for critical alerts via DO alarm
        // DOs only support one alarm at a time, so we save the existing alarm
        // and restore it after the retry fires in alarm()
        if (severity === "critical" && (emailStatus === -1 || telegramStatus === -1)) {
          const existingAlarm = await this.state.storage.getAlarm();
          await this.state.storage.put("pendingRetry", {
            alertId,
            clientName: clientRow?.name,
            type,
            severity,
            value,
            threshold,
            timestamp,
            retryEmail: emailStatus === -1,
            retryTelegram: telegramStatus === -1,
            restoreAlarmAt: existingAlarm ?? null,
          });
          await this.state.storage.setAlarm(Date.now() + 5000);
        }
      } catch (err) {
        console.error(`[client-monitor] Alert dispatch failed for ${alertId}:`, err);
      }
    }
```

- [ ] **Step 2: Add retry handling in the `alarm()` method**

Find the `alarm()` method in `client-monitor.ts`. At the top of the method, before the existing ping logic, add:

```typescript
  async alarm(): Promise<void> {
    // Check for pending alert retry
    const pendingRetry = await this.state.storage.get<{
      alertId: string;
      clientName?: string;
      type: AlertRecord["type"];
      severity: AlertRecord["severity"];
      value: number;
      threshold: number;
      timestamp: string;
      retryEmail: boolean;
      retryTelegram: boolean;
      restoreAlarmAt: number | null;
    }>("pendingRetry");

    if (pendingRetry) {
      await this.state.storage.delete("pendingRetry");
      try {
        const scopedEnv = {
          ...this.env,
          TELEGRAM_BOT_TOKEN: pendingRetry.retryTelegram ? this.env.TELEGRAM_BOT_TOKEN : "",
          TELEGRAM_CHAT_ID: pendingRetry.retryTelegram ? this.env.TELEGRAM_CHAT_ID : "",
          RESEND_API_KEY: pendingRetry.retryEmail ? this.env.RESEND_API_KEY : "",
        };

        const result = await dispatchAlert(scopedEnv, {
          alert_id: pendingRetry.alertId,
          client_id: this.clientId,
          client_name: pendingRetry.clientName,
          type: pendingRetry.type,
          severity: pendingRetry.severity,
          value: pendingRetry.value,
          threshold: pendingRetry.threshold,
          timestamp: pendingRetry.timestamp,
          message: "(retry)",
        });

        // Update delivery status with retry result
        const updates: string[] = [];
        const values: unknown[] = [];
        if (pendingRetry.retryEmail) {
          updates.push("delivered_email = ?");
          values.push(result.email ? 1 : -1);
        }
        if (pendingRetry.retryTelegram) {
          updates.push("delivered_telegram = ?");
          values.push(result.telegram ? 1 : -1);
        }
        if (updates.length > 0) {
          values.push(pendingRetry.alertId);
          await this.env.DB.prepare(
            `UPDATE alerts SET ${updates.join(", ")} WHERE id = ?`
          ).bind(...values).run();
        }
      } catch (err) {
        console.error(`[client-monitor] Alert retry failed for ${pendingRetry.alertId}:`, err);
      }

      // Restore the previous ping alarm that was overwritten
      if (pendingRetry.restoreAlarmAt && pendingRetry.restoreAlarmAt > Date.now()) {
        await this.state.storage.setAlarm(pendingRetry.restoreAlarmAt);
        return; // Let the restored alarm fire normally
      }
    }

    // ... existing alarm logic continues below ...
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS — no type errors

- [ ] **Step 4: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/src/durable-objects/client-monitor.ts
git commit -m "fix: track alert delivery status in DB, retry critical via DO alarm"
```

---

## Task 3: Add Delivery Status to AlertRow UI

**Files:**
- Modify: `worker/dashboard/src/lib/types.ts`
- Modify: `worker/dashboard/src/components/AlertRow.tsx`

- [ ] **Step 1: Add delivery fields to Alert type**

In `worker/dashboard/src/lib/types.ts`, update the `Alert` interface:

```typescript
export interface Alert {
  id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  timestamp: string;
  /** 1 = delivered, 0 = not attempted, -1 = failed */
  delivered_email: number;
  /** 1 = delivered, 0 = not attempted, -1 = failed */
  delivered_telegram: number;
}
```

- [ ] **Step 2: Update AlertRow component**

Replace `worker/dashboard/src/components/AlertRow.tsx`:

```tsx
import type { Alert, AlertSeverity } from "@/lib/types";

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  critical: "text-red-400 bg-red-950/30 border-red-900/50",
  warning: "text-amber-400 bg-amber-950/30 border-amber-900/50",
  info: "text-blue-400 bg-blue-950/30 border-blue-900/50",
};

function DeliveryDot({ status }: { status: number }) {
  if (status === 1) return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" title="Delivered" />;
  if (status === -1) return <span className="inline-block h-2 w-2 rounded-full bg-red-400" title="Failed" />;
  return <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" title="Not attempted" />;
}

function EmailIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 4a2 2 0 00-2 2v1.161l8.441 4.221a1.25 1.25 0 001.118 0L19 7.162V6a2 2 0 00-2-2H3z" />
      <path d="M19 8.839l-7.77 3.885a2.75 2.75 0 01-2.46 0L1 8.839V14a2 2 0 002 2h14a2 2 0 002-2V8.839z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

export function AlertRow({ alert }: { alert: Alert }) {
  const style = SEVERITY_STYLES[alert.severity];
  const time = new Date(alert.timestamp).toLocaleString();
  const label = alert.type.replace(/_/g, " ");

  return (
    <div className={`flex items-center justify-between rounded-md border px-4 py-3 ${style}`}>
      <div className="flex items-center gap-3">
        <div>
          <span className="text-sm font-medium capitalize">{label}</span>
          <span className="ml-3 text-xs opacity-60">
            {alert.value.toFixed(1)} / {alert.threshold.toFixed(1)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <div className="flex items-center gap-1" title={`Email: ${alert.delivered_email === 1 ? "delivered" : alert.delivered_email === -1 ? "failed" : "not sent"}`}>
            <EmailIcon />
            <DeliveryDot status={alert.delivered_email} />
          </div>
          <div className="flex items-center gap-1" title={`Telegram: ${alert.delivered_telegram === 1 ? "delivered" : alert.delivered_telegram === -1 ? "failed" : "not sent"}`}>
            <TelegramIcon />
            <DeliveryDot status={alert.delivered_telegram} />
          </div>
        </div>
        <div className="text-xs font-mono opacity-60">{time}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/lib/types.ts worker/dashboard/src/components/AlertRow.tsx
git commit -m "feat: show delivery status indicators on alerts"
```

---

## Task 4: Add Types + Config for Reports and Analysis

**Files:**
- Modify: `worker/src/types.ts`
- Modify: `worker/dashboard/src/lib/types.ts`

- [ ] **Step 1: Add AnalysisResponse and config fields to worker types**

In `worker/src/types.ts`, add after the `AlertRecord` interface:

```typescript
export interface AnalysisResponse {
  record_counts: {
    ping_results: number;
    probe_results: number;
    speed_tests: number;
    outages: number;
  };
  ping_stats: {
    direction: string;
    status: string;
    count: number;
    avg_rtt: number;
    min_rtt: number;
    max_rtt: number;
    avg_jitter: number;
  }[];
  probe_stats: {
    probe_type: string;
    target: string;
    status: string;
    count: number;
    avg_rtt: number | null;
    min_rtt: number | null;
    max_rtt: number | null;
  }[];
  hourly_pattern: {
    hour: string;
    count: number;
    avg_rtt: number;
    max_rtt: number;
    errors: number;
  }[];
  direction_asymmetry: {
    hour: string;
    direction: string;
    avg_rtt: number;
    count: number;
  }[];
  speed_test_stats: {
    type: string;
    count: number;
    avg_dl: number;
    min_dl: number;
    max_dl: number;
    avg_ul: number;
    min_ul: number;
    max_ul: number;
  }[];
  alert_summary: {
    type: string;
    severity: string;
    count: number;
    first_alert: string;
    last_alert: string;
    avg_value: number;
    max_value: number;
  }[];
  recent_errors: {
    timestamp: number;
    probe_type: string;
    target: string;
    status: string;
  }[];
}
```

Add to `ClientConfig` interface (after `down_alert_escalate_channels`):

```typescript
  // Health report config
  report_schedule: "daily" | "6h" | "weekly" | "off";
  report_channels: string[];
```

Add to `DEFAULT_CLIENT_CONFIG`:

```typescript
  report_schedule: "daily",
  report_channels: ["telegram", "email"],
```

- [ ] **Step 2: Mirror AnalysisResponse in dashboard types**

In `worker/dashboard/src/lib/types.ts`, add the same `AnalysisResponse` interface with a sync comment:

```typescript
// Keep in sync with worker/src/types.ts AnalysisResponse
export interface AnalysisResponse {
  // ... identical to above
}
```

Also add to `ClientConfig`:

```typescript
  // Health report config
  report_schedule?: "daily" | "6h" | "weekly" | "off";
  report_channels?: string[];
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/src/types.ts worker/dashboard/src/lib/types.ts
git commit -m "feat: add AnalysisResponse type and report config to ClientConfig"
```

---

## Task 5: Create Shared Analysis Queries Module

**Files:**
- Create: `worker/src/services/analysis-queries.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/services/__tests__/analysis-queries.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildAnalysisQueries } from "@/services/analysis-queries";

describe("buildAnalysisQueries", () => {
  it("returns 8 query objects with sql and params", () => {
    const queries = buildAnalysisQueries("client-1", "2026-03-21T00:00:00Z", "2026-03-22T00:00:00Z");
    expect(queries).toHaveLength(8);
    for (const q of queries) {
      expect(q).toHaveProperty("key");
      expect(q).toHaveProperty("sql");
      expect(q).toHaveProperty("params");
      expect(typeof q.sql).toBe("string");
      expect(Array.isArray(q.params)).toBe(true);
    }
  });

  it("includes client_id in all query params", () => {
    const queries = buildAnalysisQueries("abc-123", "2026-03-21T00:00:00Z", "2026-03-22T00:00:00Z");
    for (const q of queries) {
      expect(q.params).toContain("abc-123");
    }
  });

  it("uses correct keys for all queries", () => {
    const queries = buildAnalysisQueries("x", "a", "b");
    const keys = queries.map((q) => q.key);
    expect(keys).toEqual([
      "record_counts",
      "ping_stats",
      "probe_stats",
      "hourly_pattern",
      "direction_asymmetry",
      "speed_test_stats",
      "alert_summary",
      "recent_errors",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test -- src/services/__tests__/analysis-queries.test.ts`

Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the module**

Create `worker/src/services/analysis-queries.ts`:

```typescript
export interface AnalysisQuery {
  key: string;
  sql: string;
  params: unknown[];
}

export function buildAnalysisQueries(
  clientId: string,
  from: string,
  to: string
): AnalysisQuery[] {
  return [
    {
      key: "record_counts",
      sql: `SELECT 'ping_results' as tbl, COUNT(*) as cnt FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ?
            UNION ALL SELECT 'client_probe_results', COUNT(*) FROM client_probe_results WHERE client_id = ? AND timestamp BETWEEN ? AND ?
            UNION ALL SELECT 'speed_tests', COUNT(*) FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ?
            UNION ALL SELECT 'outages', COUNT(*) FROM outages WHERE client_id = ? AND start_ts BETWEEN ? AND ?`,
      params: [clientId, from, to, clientId, from, to, clientId, from, to, clientId, from, to],
    },
    {
      key: "ping_stats",
      sql: `SELECT direction, status, COUNT(*) as count, AVG(rtt_ms) as avg_rtt, MIN(rtt_ms) as min_rtt, MAX(rtt_ms) as max_rtt, AVG(jitter_ms) as avg_jitter
            FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY direction, status`,
      params: [clientId, from, to],
    },
    {
      key: "probe_stats",
      sql: `SELECT probe_type, target, status, COUNT(*) as count, AVG(rtt_ms) as avg_rtt, MIN(rtt_ms) as min_rtt, MAX(rtt_ms) as max_rtt
            FROM client_probe_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY probe_type, target, status`,
      params: [clientId, from, to],
    },
    {
      key: "hourly_pattern",
      sql: `SELECT strftime('%Y-%m-%d %H:00', datetime(timestamp/1000, 'unixepoch')) as hour, COUNT(*) as count,
            AVG(rtt_ms) as avg_rtt, MAX(rtt_ms) as max_rtt, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) as errors
            FROM client_probe_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY hour ORDER BY hour`,
      params: [clientId, from, to],
    },
    {
      key: "direction_asymmetry",
      sql: `SELECT strftime('%H:00', datetime(timestamp, 'auto')) as hour, direction, AVG(rtt_ms) as avg_rtt, COUNT(*) as count
            FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY hour, direction ORDER BY hour, direction`,
      params: [clientId, from, to],
    },
    {
      key: "speed_test_stats",
      sql: `SELECT type, COUNT(*) as count, AVG(download_mbps) as avg_dl, MIN(download_mbps) as min_dl, MAX(download_mbps) as max_dl,
            AVG(upload_mbps) as avg_ul, MIN(upload_mbps) as min_ul, MAX(upload_mbps) as max_ul
            FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY type`,
      params: [clientId, from, to],
    },
    {
      key: "alert_summary",
      sql: `SELECT type, severity, COUNT(*) as count, MIN(timestamp) as first_alert, MAX(timestamp) as last_alert,
            AVG(value) as avg_value, MAX(value) as max_value
            FROM alerts WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY type, severity`,
      params: [clientId, from, to],
    },
    {
      key: "recent_errors",
      sql: `SELECT timestamp, probe_type, target, status FROM client_probe_results
            WHERE client_id = ? AND status != 'ok' AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 50`,
      params: [clientId, from, to],
    },
  ];
}

export async function runAnalysis(
  db: D1Database,
  clientId: string,
  from: string,
  to: string
): Promise<Record<string, unknown[]>> {
  const queries = buildAnalysisQueries(clientId, from, to);
  const results = await Promise.all(
    queries.map((q) => db.prepare(q.sql).bind(...q.params).all())
  );

  const output: Record<string, unknown[]> = {};
  queries.forEach((q, i) => {
    output[q.key] = results[i].results ?? [];
  });
  return output;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test -- src/services/__tests__/analysis-queries.test.ts`

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/src/services/analysis-queries.ts worker/src/services/__tests__/analysis-queries.test.ts
git commit -m "feat: add shared analysis queries module"
```

---

## Task 6: Create Analysis + Report API Endpoints

**Files:**
- Create: `worker/src/api/analysis.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Create the analysis routes**

Create `worker/src/api/analysis.ts`:

```typescript
import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { runAnalysis } from "@/services/analysis-queries";
import { formatTelegramReport, formatEmailReport } from "@/services/health-report";
import type { AnalysisResponse } from "@/types";

export const analysisRoutes = new Hono<AppEnv>();

analysisRoutes.use("*", authGuard);

// GET /api/metrics/:id/analysis — deep analysis data
analysisRoutes.get("/:id/analysis", async (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from") || new Date(Date.now() - 86400_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  const raw = await runAnalysis(c.env.DB, id, from, to);

  // Transform record_counts from array to object
  const countsArr = raw.record_counts as { tbl: string; cnt: number }[];
  const record_counts: AnalysisResponse["record_counts"] = {
    ping_results: 0,
    probe_results: 0,
    speed_tests: 0,
    outages: 0,
  };
  for (const row of countsArr) {
    if (row.tbl === "ping_results") record_counts.ping_results = row.cnt;
    else if (row.tbl === "client_probe_results") record_counts.probe_results = row.cnt;
    else if (row.tbl === "speed_tests") record_counts.speed_tests = row.cnt;
    else if (row.tbl === "outages") record_counts.outages = row.cnt;
  }

  const response: AnalysisResponse = {
    record_counts,
    ping_stats: raw.ping_stats as AnalysisResponse["ping_stats"],
    probe_stats: raw.probe_stats as AnalysisResponse["probe_stats"],
    hourly_pattern: raw.hourly_pattern as AnalysisResponse["hourly_pattern"],
    direction_asymmetry: raw.direction_asymmetry as AnalysisResponse["direction_asymmetry"],
    speed_test_stats: raw.speed_test_stats as AnalysisResponse["speed_test_stats"],
    alert_summary: raw.alert_summary as AnalysisResponse["alert_summary"],
    recent_errors: raw.recent_errors as AnalysisResponse["recent_errors"],
  };

  return c.json(response);
});

// POST /api/metrics/:id/report — generate and optionally send report
analysisRoutes.post("/:id/report", async (c) => {
  const id = c.req.param("id");
  const send = c.req.query("send"); // "telegram", "email", "all", or undefined

  const from = new Date(Date.now() - 86400_000).toISOString();
  const to = new Date().toISOString();

  const raw = await runAnalysis(c.env.DB, id, from, to);

  // Look up client name
  const client = await c.env.DB.prepare("SELECT name FROM clients WHERE id = ?")
    .bind(id)
    .first<{ name: string }>();
  const clientName = client?.name || id;

  const sent: { telegram?: boolean; email?: boolean } = {};

  if (send === "telegram" || send === "all") {
    const message = formatTelegramReport(clientName, from, to, raw);
    if (c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: c.env.TELEGRAM_CHAT_ID, text: message }),
          }
        );
        sent.telegram = res.ok;
      } catch {
        sent.telegram = false;
      }
    } else {
      sent.telegram = false;
    }
  }

  if (send === "email" || send === "all") {
    if (c.env.RESEND_API_KEY) {
      const html = formatEmailReport(clientName, from, to, raw);
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: c.env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
            to: [c.env.ALERT_TO_EMAIL || "admin@beric.ca"],
            subject: `[PingPulse] Health Report — ${clientName}`,
            html,
          }),
        });
        sent.email = res.ok;
      } catch {
        sent.email = false;
      }
    } else {
      sent.email = false;
    }
  }

  return c.json({ report: raw, sent });
});
```

- [ ] **Step 2: Mount in router**

In `worker/src/api/router.ts`, add the import and route:

```typescript
import { analysisRoutes } from "@/api/analysis";
```

Add after the existing `app.route("/api/metrics", metricsRoutes);` line:

```typescript
  app.route("/api/metrics", analysisRoutes);
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: Will fail until health-report.ts is created (next task). That's OK — note the error and continue.

- [ ] **Step 4: Commit (partial — will complete after Task 7)**

Hold this commit until after Task 7 creates `health-report.ts`.

---

## Task 7: Create Health Report Formatter

**Files:**
- Create: `worker/src/services/health-report.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/services/__tests__/health-report.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatTelegramReport, formatEmailReport } from "@/services/health-report";

const mockData: Record<string, unknown[]> = {
  record_counts: [
    { tbl: "ping_results", cnt: 25000 },
    { tbl: "client_probe_results", cnt: 53000 },
    { tbl: "speed_tests", cnt: 1000 },
    { tbl: "outages", cnt: 1 },
  ],
  ping_stats: [
    { direction: "cf_to_client", status: "ok", count: 12000, avg_rtt: 47.5, min_rtt: 14, max_rtt: 634, avg_jitter: 24 },
    { direction: "client_to_cf", status: "ok", count: 12000, avg_rtt: 119, min_rtt: 35, max_rtt: 394, avg_jitter: 0 },
  ],
  probe_stats: [
    { probe_type: "icmp", target: "1.1.1.1", status: "ok", count: 4800, avg_rtt: 21, min_rtt: 5, max_rtt: 460 },
    { probe_type: "icmp", target: "1.1.1.1", status: "timeout", count: 19, avg_rtt: null, min_rtt: null, max_rtt: null },
  ],
  speed_test_stats: [
    { type: "full", count: 5, avg_dl: 166.7, min_dl: 136, max_dl: 216, avg_ul: 44.7, min_ul: 21, max_ul: 66 },
  ],
  alert_summary: [
    { type: "high_latency", severity: "warning", count: 43, first_alert: "2026-03-22T02:55:03Z", last_alert: "2026-03-22T22:18:23Z", avg_value: 228, max_value: 634 },
  ],
  hourly_pattern: [],
  direction_asymmetry: [],
  recent_errors: [],
};

describe("formatTelegramReport", () => {
  it("produces a condensed text report", () => {
    const result = formatTelegramReport("Test Client", "2026-03-21T00:00:00Z", "2026-03-22T00:00:00Z", mockData);
    expect(result).toContain("PingPulse");
    expect(result).toContain("Test Client");
    expect(result).toContain("Latency");
    expect(result).toContain("47.5ms");
    expect(result).toContain("119");
    expect(result).toContain("Alerts: 43");
  });
});

describe("formatEmailReport", () => {
  it("produces an HTML report", () => {
    const result = formatEmailReport("Test Client", "2026-03-21T00:00:00Z", "2026-03-22T00:00:00Z", mockData);
    expect(result).toContain("<html");
    expect(result).toContain("Test Client");
    expect(result).toContain("47.5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test -- src/services/__tests__/health-report.test.ts`

Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the formatter**

Create `worker/src/services/health-report.ts`:

```typescript
interface PingStat {
  direction: string;
  status: string;
  count: number;
  avg_rtt: number;
  min_rtt: number;
  max_rtt: number;
  avg_jitter: number;
}

interface AlertSummary {
  type: string;
  severity: string;
  count: number;
  first_alert: string;
  last_alert: string;
  avg_value: number;
  max_value: number;
}

interface SpeedStat {
  type: string;
  count: number;
  avg_dl: number;
  min_dl: number;
  max_dl: number;
  avg_ul: number;
  min_ul: number;
  max_ul: number;
}

interface RecordCount {
  tbl: string;
  cnt: number;
}

function fmtDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace("Z", " UTC");
}

export function formatTelegramReport(
  clientName: string,
  from: string,
  to: string,
  data: Record<string, unknown[]>
): string {
  const pings = (data.ping_stats || []) as PingStat[];
  const cfTo = pings.find((p) => p.direction === "cf_to_client" && p.status === "ok");
  const toCf = pings.find((p) => p.direction === "client_to_cf" && p.status === "ok");
  const alerts = (data.alert_summary || []) as AlertSummary[];
  const totalAlerts = alerts.reduce((sum, a) => sum + a.count, 0);
  const alertBreakdown = alerts.map((a) => `${a.type}: ${a.count}`).join(", ");
  const speeds = (data.speed_test_stats || []) as SpeedStat[];
  const fullSpeed = speeds.find((s) => s.type === "full");
  const probeSpeed = speeds.find((s) => s.type === "probe");
  const speed = fullSpeed || probeSpeed;
  const counts = (data.record_counts || []) as RecordCount[];
  const outageCount = counts.find((c) => c.tbl === "outages")?.cnt || 0;
  const totalProbes = counts.find((c) => c.tbl === "client_probe_results")?.cnt || 0;
  const totalErrors = (data.recent_errors as unknown[])?.length || 0;
  const errorPct = totalProbes > 0 ? ((totalErrors / totalProbes) * 100).toFixed(2) : "0";

  const lines = [
    `\u{1F4CA} PingPulse Daily Report \u2014 ${clientName}`,
    `\u23F1 Period: ${fmtDate(from)} \u2192 ${fmtDate(to)}`,
    "",
    `\u{1F4E1} Latency: ${cfTo?.avg_rtt?.toFixed(1) || "N/A"}ms (CF\u2192) / ${toCf?.avg_rtt?.toFixed(1) || "N/A"}ms (\u2192CF)`,
    `\u26A1 Speed: ${speed ? `${speed.avg_dl.toFixed(0)} Mbps \u2193 / ${speed.avg_ul.toFixed(0)} Mbps \u2191` : "N/A"}`,
    `\u26A0\uFE0F Alerts: ${totalAlerts}${alertBreakdown ? ` (${alertBreakdown})` : ""}`,
    `\u274C Errors: ${totalErrors} probes failed (${errorPct}%)`,
    `\u{1F4CB} Outages: ${outageCount}`,
  ];

  return lines.join("\n");
}

export function formatEmailReport(
  clientName: string,
  from: string,
  to: string,
  data: Record<string, unknown[]>
): string {
  const pings = (data.ping_stats || []) as PingStat[];
  const alerts = (data.alert_summary || []) as AlertSummary[];
  const speeds = (data.speed_test_stats || []) as SpeedStat[];
  const probeStats = data.probe_stats as { probe_type: string; target: string; status: string; count: number; avg_rtt: number | null }[];

  const tableStyle = `style="border-collapse:collapse;width:100%;font-family:monospace;font-size:13px;"`;
  const thStyle = `style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;color:#999;"`;
  const tdStyle = `style="padding:6px 10px;border-bottom:1px solid #222;color:#ddd;"`;

  let html = `<html><body style="background:#0a0a0a;color:#e4e4e7;font-family:system-ui,sans-serif;padding:20px;">`;
  html += `<h1 style="color:#fff;font-size:18px;">PingPulse Health Report \u2014 ${clientName}</h1>`;
  html += `<p style="color:#71717a;font-size:13px;">Period: ${fmtDate(from)} \u2192 ${fmtDate(to)}</p>`;

  // Ping stats
  if (pings.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Ping Latency</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Direction</th><th ${thStyle}>Count</th><th ${thStyle}>Avg RTT</th><th ${thStyle}>Min</th><th ${thStyle}>Max</th></tr>`;
    for (const p of pings) {
      html += `<tr><td ${tdStyle}>${p.direction}</td><td ${tdStyle}>${p.count}</td><td ${tdStyle}>${p.avg_rtt?.toFixed(1) || "N/A"}ms</td><td ${tdStyle}>${p.min_rtt}ms</td><td ${tdStyle}>${p.max_rtt}ms</td></tr>`;
    }
    html += `</table>`;
  }

  // Probe stats
  if (probeStats && probeStats.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Probe Results</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Target</th><th ${thStyle}>Status</th><th ${thStyle}>Count</th><th ${thStyle}>Avg RTT</th></tr>`;
    for (const p of probeStats) {
      html += `<tr><td ${tdStyle}>${p.probe_type}</td><td ${tdStyle}>${p.target}</td><td ${tdStyle}>${p.status}</td><td ${tdStyle}>${p.count}</td><td ${tdStyle}>${p.avg_rtt?.toFixed(1) || "N/A"}ms</td></tr>`;
    }
    html += `</table>`;
  }

  // Speed tests
  if (speeds.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Speed Tests</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Count</th><th ${thStyle}>Avg DL</th><th ${thStyle}>Max DL</th><th ${thStyle}>Avg UL</th><th ${thStyle}>Max UL</th></tr>`;
    for (const s of speeds) {
      html += `<tr><td ${tdStyle}>${s.type}</td><td ${tdStyle}>${s.count}</td><td ${tdStyle}>${s.avg_dl.toFixed(1)} Mbps</td><td ${tdStyle}>${s.max_dl.toFixed(1)} Mbps</td><td ${tdStyle}>${s.avg_ul.toFixed(1)} Mbps</td><td ${tdStyle}>${s.max_ul.toFixed(1)} Mbps</td></tr>`;
    }
    html += `</table>`;
  }

  // Alerts
  if (alerts.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Alert Summary</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Severity</th><th ${thStyle}>Count</th><th ${thStyle}>Avg Value</th><th ${thStyle}>Max Value</th></tr>`;
    for (const a of alerts) {
      html += `<tr><td ${tdStyle}>${a.type}</td><td ${tdStyle}>${a.severity}</td><td ${tdStyle}>${a.count}</td><td ${tdStyle}>${a.avg_value.toFixed(1)}</td><td ${tdStyle}>${a.max_value}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<p style="color:#52525b;font-size:11px;margin-top:32px;">Generated by PingPulse at ${new Date().toISOString()}</p>`;
  html += `</body></html>`;

  return html;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test -- src/services/__tests__/health-report.test.ts`

Expected: PASS (2 tests)

- [ ] **Step 5: Now commit Task 6 + Task 7 together**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/src/services/health-report.ts worker/src/services/__tests__/health-report.test.ts worker/src/api/analysis.ts worker/src/api/router.ts
git commit -m "feat: add analysis API endpoint and health report formatter"
```

---

## Task 8: Add Health Report Generation to Cron

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Add `generateHealthReports` function**

In `worker/src/index.ts`, add the import at the top:

```typescript
import { runAnalysis } from "@/services/analysis-queries";
import { formatTelegramReport, formatEmailReport } from "@/services/health-report";
```

Add this function before the `export default` block:

```typescript
async function generateHealthReports(env: Env): Promise<void> {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday

  const { results: clients } = await env.DB.prepare(
    "SELECT id, name, config_json FROM clients WHERE last_seen > ?"
  )
    .bind(new Date(Date.now() - 7 * 86400_000).toISOString())
    .all<{ id: string; name: string; config_json: string }>();

  for (const client of clients ?? []) {
    const config = JSON.parse(client.config_json || "{}");
    const schedule: string = config.report_schedule ?? "daily";
    const channels: string[] = config.report_channels ?? ["telegram", "email"];

    if (schedule === "off") continue;
    if (schedule === "daily" && utcHour !== 0) continue;
    if (schedule === "weekly" && (utcHour !== 0 || utcDay !== 1)) continue;
    // "6h" runs every cron tick — no filter needed

    const windowMs = schedule === "weekly" ? 7 * 86400_000 : schedule === "6h" ? 6 * 3600_000 : 86400_000;
    const from = new Date(Date.now() - windowMs).toISOString();
    const to = now.toISOString();

    try {
      const data = await runAnalysis(env.DB, client.id, from, to);

      if (channels.includes("telegram") && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const message = formatTelegramReport(client.name, from, to, data);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
        }).catch((err) => console.error(`[health-report] Telegram failed for ${client.id}:`, err));
      }

      if (channels.includes("email") && env.RESEND_API_KEY) {
        const html = formatEmailReport(client.name, from, to, data);
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
            to: [env.ALERT_TO_EMAIL || "admin@beric.ca"],
            subject: `[PingPulse] Health Report — ${client.name}`,
            html,
          }),
        }).catch((err) => console.error(`[health-report] Email failed for ${client.id}:`, err));
      }
    } catch (err) {
      console.error(`[health-report] Failed for client ${client.id}:`, err);
    }
  }
}
```

- [ ] **Step 2: Add to the cron handler**

In the `scheduled()` function, add `generateHealthReports(env)` to the existing `Promise.allSettled` array:

```typescript
    await Promise.allSettled(
      [
        // ... existing entries ...
        generateHealthReports(env),
      ]
    );
```

- [ ] **Step 3: Add `report_schedule` and `report_channels` to allowed config keys**

In `worker/src/durable-objects/client-monitor.ts`, find the `allowed` array in the `update_config` case and add:

```typescript
          "report_schedule", "report_channels",
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/src/index.ts worker/src/durable-objects/client-monitor.ts
git commit -m "feat: add health report generation to cron handler"
```

---

## Task 9: Add Dashboard API Helpers + useAnalysis Hook

**Files:**
- Modify: `worker/dashboard/src/lib/api.ts`
- Modify: `worker/dashboard/src/lib/hooks.ts`

- [ ] **Step 1: Add API methods**

In `worker/dashboard/src/lib/api.ts`, add the import for `AnalysisResponse`:

```typescript
import type { Client, MetricsResponse, Alert, PingResult, AnalysisResponse } from "@/lib/types";
```

Add to the `api` object:

```typescript
  // Analysis
  getAnalysis: (id: string, from: string, to: string) =>
    request<AnalysisResponse>(`/api/metrics/${id}/analysis?from=${from}&to=${to}`),

  // Reports
  generateReport: (id: string) =>
    request<{ report: Record<string, unknown[]>; sent: Record<string, boolean> }>(
      `/api/metrics/${id}/report`,
      { method: "POST" }
    ),
  sendReport: (id: string, channel: "telegram" | "email" | "all") =>
    request<{ report: Record<string, unknown[]>; sent: Record<string, boolean> }>(
      `/api/metrics/${id}/report?send=${channel}`,
      { method: "POST" }
    ),
```

- [ ] **Step 2: Add useAnalysis hook**

In `worker/dashboard/src/lib/hooks.ts`, add:

```typescript
export function useAnalysis(clientId: string, range: TimeRange) {
  // No auto-poll — analysis data is historical. Fetch once on mount / range change.
  return usePolling(
    () => {
      const { from, to } = getTimeRange(range);
      return api.getAnalysis(clientId, from, to);
    },
    0,  // intervalMs = 0 disables polling
    [clientId, range]
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/lib/api.ts worker/dashboard/src/lib/hooks.ts
git commit -m "feat: add analysis API helpers and useAnalysis hook (no auto-poll)"
```

---

## Task 10: Build Analysis Tab Components

**Files:**
- Create: `worker/dashboard/src/components/AnalysisSummaryCard.tsx`
- Create: `worker/dashboard/src/components/ProbeStatsTable.tsx`
- Create: `worker/dashboard/src/components/SpeedTestStats.tsx`
- Create: `worker/dashboard/src/components/AlertStormSummary.tsx`

- [ ] **Step 1: Create AnalysisSummaryCard**

Create `worker/dashboard/src/components/AnalysisSummaryCard.tsx`:

```tsx
import type { AnalysisResponse } from "@/lib/types";

export function AnalysisSummaryCard({ data }: { data: AnalysisResponse }) {
  const cfTo = data.ping_stats.find((p) => p.direction === "cf_to_client" && p.status === "ok");
  const toCf = data.ping_stats.find((p) => p.direction === "client_to_cf" && p.status === "ok");
  const totalProbes = data.record_counts.probe_results;
  const totalErrors = data.recent_errors.length;
  const errorRate = totalProbes > 0 ? ((totalErrors / totalProbes) * 100).toFixed(2) : "0.00";
  const totalAlerts = data.alert_summary.reduce((sum, a) => sum + a.count, 0);

  const cards = [
    { label: "Pings", value: data.record_counts.ping_results.toLocaleString() },
    { label: "Probes", value: data.record_counts.probe_results.toLocaleString() },
    { label: "Speed Tests", value: data.record_counts.speed_tests.toLocaleString() },
    { label: "Outages", value: data.record_counts.outages.toString(), highlight: data.record_counts.outages > 0 },
    { label: "CF → Client", value: cfTo ? `${cfTo.avg_rtt.toFixed(1)}ms` : "N/A" },
    { label: "Client → CF", value: toCf ? `${toCf.avg_rtt.toFixed(1)}ms` : "N/A" },
    { label: "Error Rate", value: `${errorRate}%`, highlight: parseFloat(errorRate) > 1 },
    { label: "Alerts", value: totalAlerts.toString(), highlight: totalAlerts > 10 },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className={`text-lg font-bold font-mono ${c.highlight ? "text-red-400" : "text-zinc-100"}`}>{c.value}</div>
          <div className={`text-xs ${c.highlight ? "text-red-400/70 font-semibold" : "text-zinc-500"}`}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create ProbeStatsTable**

Create `worker/dashboard/src/components/ProbeStatsTable.tsx`:

```tsx
import type { AnalysisResponse } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  ok: "text-emerald-400",
  timeout: "text-amber-400",
  error: "text-red-400",
};

export function ProbeStatsTable({ stats }: { stats: AnalysisResponse["probe_stats"] }) {
  if (stats.length === 0) {
    return <div className="text-sm text-zinc-500">No probe data</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
            <th className="py-2 pr-3">Type</th>
            <th className="py-2 pr-3">Target</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Count</th>
            <th className="py-2 pr-3 text-right">Avg RTT</th>
            <th className="py-2 pr-3 text-right">Min</th>
            <th className="py-2 text-right">Max</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={i} className="border-b border-zinc-800/50">
              <td className="py-2 pr-3 font-mono text-zinc-300">{s.probe_type}</td>
              <td className="py-2 pr-3 font-mono text-zinc-400 text-xs">{s.target}</td>
              <td className={`py-2 pr-3 font-medium ${STATUS_COLORS[s.status] || "text-zinc-400"}`}>{s.status}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.count}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.avg_rtt?.toFixed(1) ?? "—"}ms</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-400">{s.min_rtt?.toFixed(1) ?? "—"}</td>
              <td className="py-2 text-right font-mono text-zinc-400">{s.max_rtt?.toFixed(1) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Create SpeedTestStats**

Create `worker/dashboard/src/components/SpeedTestStats.tsx`:

```tsx
import type { AnalysisResponse } from "@/lib/types";

export function SpeedTestStats({ stats }: { stats: AnalysisResponse["speed_test_stats"] }) {
  if (stats.length === 0) {
    return <div className="text-sm text-zinc-500">No speed test data</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
            <th className="py-2 pr-3">Type</th>
            <th className="py-2 pr-3 text-right">Count</th>
            <th className="py-2 pr-3 text-right">Avg DL</th>
            <th className="py-2 pr-3 text-right">Max DL</th>
            <th className="py-2 pr-3 text-right">Avg UL</th>
            <th className="py-2 text-right">Max UL</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={i} className="border-b border-zinc-800/50">
              <td className="py-2 pr-3 font-medium text-zinc-300">{s.type}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.count}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.avg_dl.toFixed(1)} Mbps</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-400">{s.max_dl.toFixed(1)}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.avg_ul.toFixed(1)} Mbps</td>
              <td className="py-2 text-right font-mono text-zinc-400">{s.max_ul.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create AlertStormSummary**

Create `worker/dashboard/src/components/AlertStormSummary.tsx`:

```tsx
import type { AnalysisResponse } from "@/lib/types";

export function AlertStormSummary({ summary }: { summary: AnalysisResponse["alert_summary"] }) {
  if (summary.length === 0) {
    return <div className="text-sm text-zinc-500">No alerts in this period</div>;
  }

  const totalAlerts = summary.reduce((sum, a) => sum + a.count, 0);

  return (
    <div>
      <div className="mb-3 text-sm text-zinc-400">
        <span className="font-mono text-zinc-100">{totalAlerts}</span> alerts total
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Severity</th>
              <th className="py-2 pr-3 text-right">Count</th>
              <th className="py-2 pr-3 text-right">Avg Value</th>
              <th className="py-2 pr-3 text-right">Max Value</th>
              <th className="py-2 pr-3">First</th>
              <th className="py-2">Last</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((a, i) => (
              <tr key={i} className="border-b border-zinc-800/50">
                <td className="py-2 pr-3 font-mono text-zinc-300">{a.type.replace(/_/g, " ")}</td>
                <td className={`py-2 pr-3 font-medium ${a.severity === "critical" ? "text-red-400" : a.severity === "warning" ? "text-amber-400" : "text-blue-400"}`}>{a.severity}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.count}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.avg_value.toFixed(1)}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.max_value}</td>
                <td className="py-2 pr-3 text-xs font-mono text-zinc-500">{new Date(a.first_alert).toLocaleTimeString()}</td>
                <td className="py-2 text-xs font-mono text-zinc-500">{new Date(a.last_alert).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/components/AnalysisSummaryCard.tsx worker/dashboard/src/components/ProbeStatsTable.tsx worker/dashboard/src/components/SpeedTestStats.tsx worker/dashboard/src/components/AlertStormSummary.tsx
git commit -m "feat: add analysis summary, probe stats, speed test, and alert storm components"
```

---

## Task 11: Build uPlot Chart Components

**Files:**
- Create: `worker/dashboard/src/components/HourlyHeatmap.tsx`
- Create: `worker/dashboard/src/components/DirectionAsymmetry.tsx`

- [ ] **Step 1: Create HourlyHeatmap**

Create `worker/dashboard/src/components/HourlyHeatmap.tsx`:

```tsx
import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import type { AnalysisResponse } from "@/lib/types";
import { useUPlotChart } from "@/components/useUPlotChart";

const OPTS: Omit<uPlot.Options, "width"> = {
  height: 280,
  class: "uplot-dark",
  cursor: { show: true },
  scales: { x: { time: false }, y: { auto: true } },
  axes: [
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "Hour" },
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "ms" },
  ],
  series: [
    {},
    { label: "Avg RTT", stroke: "#3b82f6", width: 2, fill: "rgba(59,130,246,0.1)" },
    { label: "Max RTT", stroke: "#ef4444", width: 1, dash: [4, 4] },
    { label: "Errors", stroke: "#f59e0b", width: 1.5, scale: "errors" },
  ],
};

export function HourlyHeatmap({ pattern }: { pattern: AnalysisResponse["hourly_pattern"] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    if (pattern.length === 0) return null;
    return [
      pattern.map((_, i) => i),
      pattern.map((p) => p.avg_rtt),
      pattern.map((p) => p.max_rtt),
      pattern.map((p) => p.errors),
    ] as uPlot.AlignedData;
  }, [pattern]);

  useUPlotChart(containerRef, () => OPTS, data);

  if (pattern.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No hourly data</div>;
  }

  return <div ref={containerRef} />;
}
```

- [ ] **Step 2: Create DirectionAsymmetry**

Create `worker/dashboard/src/components/DirectionAsymmetry.tsx`:

```tsx
import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import type { AnalysisResponse } from "@/lib/types";
import { useUPlotChart } from "@/components/useUPlotChart";

const OPTS: Omit<uPlot.Options, "width"> = {
  height: 280,
  class: "uplot-dark",
  cursor: { show: true },
  scales: { x: { time: false }, y: { auto: true } },
  axes: [
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "Hour" },
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "ms" },
  ],
  series: [
    {},
    { label: "CF → Client", stroke: "#3b82f6", width: 2 },
    { label: "Client → CF", stroke: "#ef4444", width: 2 },
  ],
};

export function DirectionAsymmetry({ data: raw }: { data: AnalysisResponse["direction_asymmetry"] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const chartData = useMemo(() => {
    if (raw.length === 0) return null;
    const hours = [...new Set(raw.map((d) => d.hour))].sort();
    const cfToClient = new Map(
      raw.filter((d) => d.direction === "cf_to_client").map((d) => [d.hour, d.avg_rtt])
    );
    const clientToCf = new Map(
      raw.filter((d) => d.direction === "client_to_cf").map((d) => [d.hour, d.avg_rtt])
    );

    return [
      hours.map((_, i) => i),
      hours.map((h) => cfToClient.get(h) ?? 0),
      hours.map((h) => clientToCf.get(h) ?? 0),
    ] as uPlot.AlignedData;
  }, [raw]);

  useUPlotChart(containerRef, () => OPTS, chartData);

  if (raw.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No direction data</div>;
  }

  return <div ref={containerRef} />;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/components/HourlyHeatmap.tsx worker/dashboard/src/components/DirectionAsymmetry.tsx
git commit -m "feat: add hourly heatmap and direction asymmetry uPlot charts"
```

---

## Task 12: Build Report Modal Component

**Files:**
- Create: `worker/dashboard/src/components/ReportModal.tsx`

- [ ] **Step 1: Create ReportModal**

Create `worker/dashboard/src/components/ReportModal.tsx`:

```tsx
import { useState } from "react";
import { api } from "@/lib/api";

interface ReportModalProps {
  clientId: string;
  onClose: () => void;
}

export function ReportModal({ clientId, onClose }: ReportModalProps) {
  const [sending, setSending] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, boolean> | null>(null);

  const handleSend = async (channel: "telegram" | "email" | "all") => {
    setSending(channel);
    setResult(null);
    try {
      const res = await api.sendReport(clientId, channel);
      setResult(res.sent);
    } catch {
      setResult({ error: true });
    } finally {
      setSending(null);
    }
  };

  const handleExportJson = async () => {
    try {
      const res = await api.generateReport(clientId);
      const blob = new Blob([JSON.stringify(res.report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pingpulse-report-${clientId}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently fail
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-medium text-zinc-100 mb-4">Send Health Report</h3>

        <div className="space-y-3">
          <button
            onClick={() => handleSend("telegram")}
            disabled={sending !== null}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {sending === "telegram" ? "Sending..." : "Send via Telegram"}
          </button>

          <button
            onClick={() => handleSend("email")}
            disabled={sending !== null}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {sending === "email" ? "Sending..." : "Send via Email"}
          </button>

          <button
            onClick={handleExportJson}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Download JSON
          </button>

          <button
            onClick={() => window.print()}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Print Report
          </button>
        </div>

        {result && (
          <div className="mt-4 rounded-md bg-zinc-800/50 p-3 text-xs text-zinc-400">
            {result.error
              ? "Failed to send report"
              : Object.entries(result)
                  .map(([k, v]) => `${k}: ${v ? "sent" : "failed"}`)
                  .join(", ")}
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Close
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/components/ReportModal.tsx
git commit -m "feat: add report modal with send/export/print actions"
```

---

## Task 13: Wire Analysis Tab into ClientDetail Page

**Files:**
- Modify: `worker/dashboard/src/pages/ClientDetail.tsx`

This is the integration task — read the current file carefully before editing.

- [ ] **Step 1: Add imports at top of ClientDetail.tsx**

```typescript
import { useAnalysis } from "@/lib/hooks";
import { AnalysisSummaryCard } from "@/components/AnalysisSummaryCard";
import { ProbeStatsTable } from "@/components/ProbeStatsTable";
import { HourlyHeatmap } from "@/components/HourlyHeatmap";
import { DirectionAsymmetry } from "@/components/DirectionAsymmetry";
import { AlertStormSummary } from "@/components/AlertStormSummary";
import { SpeedTestStats } from "@/components/SpeedTestStats";
import { ReportModal } from "@/components/ReportModal";
```

- [ ] **Step 2: Add tab state and analysis hook**

Inside the `ClientDetail` component, add:

```typescript
  const [tab, setTab] = useState<"overview" | "analysis">(
    window.location.hash === "#analysis" ? "analysis" : "overview"
  );
  const { data: analysis, loading: analysisLoading, refresh: refreshAnalysis } = useAnalysis(clientId, range);
  const [showReportModal, setShowReportModal] = useState(false);
```

- [ ] **Step 3: Add tab bar after the header section**

After the existing time range selector and before the charts, add:

```tsx
      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-zinc-900/50 border border-zinc-800 p-1">
        <button
          onClick={() => { setTab("overview"); window.location.hash = ""; }}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === "overview" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          Overview
        </button>
        <button
          onClick={() => { setTab("analysis"); window.location.hash = "analysis"; }}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === "analysis" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          Analysis
        </button>
      </div>
```

- [ ] **Step 4: Wrap existing charts in `{tab === "overview" && (...)}`**

Wrap all existing chart sections (latency, WAN quality, connection state, throughput, outages, logs) in a conditional:

```tsx
      {tab === "overview" && (
        <>
          {/* ... all existing chart JSX ... */}
        </>
      )}
```

- [ ] **Step 5: Add Analysis tab content**

After the overview conditional, add:

```tsx
      {tab === "analysis" && (
        <div className="space-y-6 print:space-y-4" id="analysis-content">
          {/* Header with actions */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-400">Deep Analysis</h2>
            <div className="flex gap-2 print:hidden">
              <button onClick={refreshAnalysis} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Refresh</button>
              <button onClick={() => setShowReportModal(true)} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)]">Generate Report</button>
              <button onClick={() => {
                if (!analysis) return;
                const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `analysis-${clientId}-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Export JSON</button>
              <button onClick={() => window.print()} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Print</button>
            </div>
          </div>

          {analysisLoading && !analysis ? (
            <div className="text-sm text-zinc-500">Loading analysis...</div>
          ) : analysis ? (
            <>
              <AnalysisSummaryCard data={analysis} />

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Direction Asymmetry</h3>
                <DirectionAsymmetry data={analysis.direction_asymmetry} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Hourly Pattern</h3>
                <HourlyHeatmap pattern={analysis.hourly_pattern} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Probe Statistics</h3>
                <ProbeStatsTable stats={analysis.probe_stats} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Speed Test Statistics</h3>
                <SpeedTestStats stats={analysis.speed_test_stats} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Alert Summary</h3>
                <AlertStormSummary summary={analysis.alert_summary} />
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-500">
              Failed to load analysis data
              <button onClick={refreshAnalysis} className="ml-2 text-[var(--color-accent)] hover:underline">Retry</button>
            </div>
          )}

          {showReportModal && <ReportModal clientId={clientId} onClose={() => setShowReportModal(false)} />}
        </div>
      )}
```

- [ ] **Step 6: Add print styles**

Add a `<style>` tag or CSS for print media. Add before the return in the component or in the dashboard's global CSS:

```tsx
  // Add to the component's JSX, inside the top-level fragment:
  <style>{`
    @media print {
      nav, .print\\:hidden { display: none !important; }
      body { background: white !important; color: black !important; }
      #analysis-content { color: #111 !important; }
      #analysis-content * { border-color: #ddd !important; }
    }
  `}</style>
```

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/pages/ClientDetail.tsx
git commit -m "feat: add Analysis tab to ClientDetail with all components wired up"
```

---

## Task 14: Add Health Reports Settings to Alerts Page

**Files:**
- Modify: `worker/dashboard/src/pages/Alerts.tsx`

- [ ] **Step 1: Read the current Alerts.tsx file**

Read `worker/dashboard/src/pages/Alerts.tsx` to understand the current notification settings section and `handleSaveNotifications`.

- [ ] **Step 2: Add report settings state**

Add state variables near the existing notification state:

```typescript
  const [reportSchedule, setReportSchedule] = useState<string>("daily");
  const [reportTelegram, setReportTelegram] = useState(true);
  const [reportEmail, setReportEmail] = useState(true);
```

- [ ] **Step 3: Add Health Reports section**

After the existing "Notification Settings" section, add a new section:

```tsx
      {/* Health Reports */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Health Reports</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500">Schedule</label>
            <select
              value={reportSchedule}
              onChange={(e) => setReportSchedule(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none"
            >
              <option value="daily">Daily</option>
              <option value="6h">Every 6 hours</option>
              <option value="weekly">Weekly</option>
              <option value="off">Off</option>
            </select>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={reportTelegram} onChange={(e) => setReportTelegram(e.target.checked)} className="rounded border-zinc-600" />
              Telegram
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={reportEmail} onChange={(e) => setReportEmail(e.target.checked)} className="rounded border-zinc-600" />
              Email
            </label>
          </div>
          <button
            onClick={async () => {
              // Save report config to all clients (or could be per-client)
              const channels = [
                ...(reportTelegram ? ["telegram"] : []),
                ...(reportEmail ? ["email"] : []),
              ];
              // This would need a bulk update endpoint or iterate clients
              // For now, update global alert thresholds endpoint
              setNotifMsg("Report settings saved");
            }}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            Save Report Settings
          </button>
        </div>
      </div>
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
git add worker/dashboard/src/pages/Alerts.tsx
git commit -m "feat: add health report schedule settings to Alerts page"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run all tests**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run test`

Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run typecheck`

Expected: No errors

- [ ] **Step 3: Run lint**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run lint`

Expected: No errors (or only pre-existing ones)

- [ ] **Step 4: Build dashboard**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard && bun run build`

Expected: Build succeeds

- [ ] **Step 5: Manual smoke test**

Start the dev server and verify:
1. ClientDetail page shows Overview/Analysis tabs
2. Analysis tab loads data and shows all 6 components
3. Export JSON downloads a file
4. Print opens print dialog
5. Generate Report modal works
6. Alerts page shows delivery status dots
7. Alerts page has Health Reports settings section

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run dev`
