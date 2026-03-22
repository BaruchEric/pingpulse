# PingPulse: Deep Analysis, Alert Delivery Fix & Health Reports

**Date:** 2026-03-22
**Scope:** 3 features — alert delivery fix, deep analysis dashboard, automated health reports

---

## 1. Alert Delivery Fix

### Problem

The `triggerAlert()` method in `ClientMonitor` DO inserts alerts with `delivered_email: 0, delivered_telegram: 0` and calls `dispatchAlert()`, but:
- Never updates the delivery columns after dispatch
- Silently swallows all errors (`catch { // Best effort }`)
- No visibility into delivery failures

### Changes

#### `worker/src/services/alert-dispatch.ts`

- `sendEmail()` returns `{ success: boolean; error?: string }` instead of `void`
- `sendTelegram()` returns `{ success: boolean; error?: string }` instead of `void`
- `dispatchAlert()` returns `{ email: boolean; telegram: boolean }` with delivery status
- Failed deliveries log to `console.error()` (visible in Workers dashboard logs)

#### `worker/src/durable-objects/client-monitor.ts` (`triggerAlert()`)

- After `dispatchAlert()` resolves, update the alert row:
  ```sql
  UPDATE alerts SET delivered_email = ?, delivered_telegram = ? WHERE id = ?
  ```
- Values: `1` for success, `0` for not attempted, `-1` for failed (document these tri-state semantics in both worker and dashboard type definitions)
- **Critical alerts only:** if a channel fails, schedule a retry via `this.state.storage.setAlarm(Date.now() + 5000)` with retry metadata stored in DO storage. The `alarm()` handler checks for pending retries and re-dispatches. This is safe across hibernation.
- Non-critical alerts: fire once, track result, no retry

#### `worker/dashboard/src/components/AlertRow.tsx`

- Add delivery status indicators next to each alert:
  - Green dot + icon: delivered successfully
  - Red dot + icon: delivery failed
  - Grey dot + icon: not attempted (channel not configured)
- Icons: mail icon for email, paper-plane icon for Telegram (inline SVG, no new deps)

---

## 2. Deep Analysis API + Dashboard

### New API Endpoint

**`GET /api/metrics/:id/analysis?from=ISO&to=ISO`**

Defaults to last 24h. Returns:

```typescript
interface AnalysisResponse {
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
  }[];  // capped at 50 rows, ordered by timestamp DESC
}
```

### New File: `worker/src/api/analysis.ts`

- Single route handler with `Promise.all` for all 8 D1 queries
- Queries are the same aggregation SQLs validated in the manual analysis session
- Registered in `router.ts` under the existing auth guard

### Shared Query Module: `worker/src/services/analysis-queries.ts`

- Extracts the 8 analysis SQL queries into reusable functions
- Used by both the API endpoint and the health report generator
- Each function takes `(db: D1Database, clientId: string, from: string, to: string)`

### Dashboard Changes

#### ClientDetail page (`ClientDetail.tsx`)

- Add tab bar: **Overview** (current view) | **Analysis**
- Summary card on Overview tab: latency asymmetry ratio, error rate %, alert count — links to Analysis tab
- Tab state managed via URL hash (`#analysis`) for direct linking

#### New Components (in `worker/dashboard/src/components/`)

| Component | Purpose |
|-----------|---------|
| `AnalysisSummaryCard.tsx` | Top-level stats grid: record counts, uptime %, error rate, avg latency by direction |
| `ProbeStatsTable.tsx` | Per-target/per-type breakdown table with color-coded status cells |
| `HourlyHeatmap.tsx` | Hourly avg RTT + error count bar chart (uPlot, via existing `useUPlotChart` hook) |
| `DirectionAsymmetry.tsx` | Side-by-side CF→Client vs Client→CF line chart (uPlot) |
| `AlertStormSummary.tsx` | Alert clustering, frequency, top spike values |
| `SpeedTestStats.tsx` | Full vs probe comparison table |

#### New Hook: `useAnalysis(clientId, from, to)` in `worker/dashboard/src/lib/hooks.ts`

- Fetches `GET /api/metrics/:id/analysis?from=&to=`
- **Does NOT auto-poll.** Unlike `useMetrics` (10s interval), analysis data is historical/aggregated — fetch once on mount and on time range change. Provide a manual "Refresh" button.
- Loading and error states: show skeleton placeholders on first load, inline error banner on failure with retry button

#### Print/Export (buttons in Analysis tab header)

| Button | Action |
|--------|--------|
| Export JSON | Downloads raw analysis API response as `.json` file |
| Export CSV | Flattens each section into labeled CSV sections, downloads as `.csv` |
| Print Report | `window.print()` with `@media print` styles: white bg, no nav, clean layout |

---

## 3. Automated Health Reports

### New File: `worker/src/services/health-report.ts`

Generates health reports using the shared analysis queries module.

#### Two output formats:

**Telegram (condensed text):**
```
📊 PingPulse Daily Report — ClientName
⏱ Period: Mar 21 00:00 UTC → Mar 22 00:00 UTC

🟢 Uptime: 99.1% (1 outage, 43m total)
📡 Latency: 47ms (CF→) / 119ms (→CF)
⚡ Speed: 167 Mbps ↓ / 45 Mbps ↑
⚠️ Alerts: 43 (high_latency: 43)
❌ Errors: 52 probes failed (0.1%)
```

**Email (Resend HTML):**
- Inline-styled HTML tables covering all analysis sections
- Summary header, probe stats table, hourly pattern, alert storm, speed test comparison
- Compatible with major email clients (inline CSS only)

### Config Additions

Add to `ClientConfig` interface in `types.ts`:

```typescript
report_schedule: "daily" | "6h" | "weekly" | "off";  // default: "daily"
report_channels: string[];                             // default: ["telegram", "email"]
```

Add to `DEFAULT_CLIENT_CONFIG`:

```typescript
report_schedule: "daily",
report_channels: ["telegram", "email"],
```

Add `report_schedule` and `report_channels` to the `allowed` config keys in `client-monitor.ts` command handler.

### Cron Integration (`index.ts`)

New function `generateHealthReports(env: Env)` added to the existing `Promise.allSettled` block in `scheduled()`:

- Queries all active clients with their configs
- For each client, checks `report_schedule` against current UTC hour:
  - `"daily"` — runs at the 00:00 UTC cron tick only (hour 0, 6, 12, 18 — pick hour 0)
  - `"6h"` — runs every cron tick
  - `"weekly"` — runs at 00:00 UTC on Mondays only
  - `"off"` — skip
- Calls `generateAndSendReport(env, clientId, config)` for matching clients
- Uses `Promise.allSettled` so one client's failure doesn't block others

### Manual Trigger

**New API endpoint: `POST /api/metrics/:id/report`**

- Auth: admin JWT (same as other endpoints)
- Query params:
  - `?send=telegram` — generate and send via Telegram
  - `?send=email` — generate and send via email
  - `?send=all` — send via all configured channels
  - No `send` param — returns the report data as JSON (preview)
- Returns: `{ report: AnalysisResponse, sent: { telegram?: boolean, email?: boolean } }`

**Dashboard — Analysis tab:**

- "Generate Report" button in the Analysis tab header
- Click → `POST /api/metrics/:id/report` → shows report preview in a modal
- Modal actions:
  - "Send via Telegram" — `POST /api/metrics/:id/report?send=telegram`
  - "Send via Email" — `POST /api/metrics/:id/report?send=email`
  - "Print" — `window.print()` on modal content
  - "Download JSON" — saves report payload as file

**Settings UI (Alerts page):**

- New "Health Reports" section below existing Notification Settings
- Schedule dropdown: Daily / Every 6h / Weekly / Off
- Channel checkboxes: Telegram / Email
- Saves via existing config update mechanism (`PUT /api/clients/:id` → DO command)

---

## File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `worker/src/services/analysis-queries.ts` | Shared analysis SQL query functions |
| `worker/src/services/health-report.ts` | Report generation + formatting (Telegram text, email HTML) |
| `worker/src/api/analysis.ts` | `GET /api/metrics/:id/analysis` endpoint |
| `worker/dashboard/src/components/AnalysisSummaryCard.tsx` | Stats grid component |
| `worker/dashboard/src/components/ProbeStatsTable.tsx` | Per-target probe breakdown |
| `worker/dashboard/src/components/HourlyHeatmap.tsx` | Hourly RTT + errors chart |
| `worker/dashboard/src/components/DirectionAsymmetry.tsx` | CF↔Client latency comparison |
| `worker/dashboard/src/components/AlertStormSummary.tsx` | Alert clustering display |
| `worker/dashboard/src/components/SpeedTestStats.tsx` | Speed test comparison table |
| `worker/dashboard/src/components/ReportModal.tsx` | Report preview + send modal |

### Modified Files

| File | Change |
|------|--------|
| `worker/src/services/alert-dispatch.ts` | Return delivery status, log errors |
| `worker/src/durable-objects/client-monitor.ts` | Update delivery columns, retry critical alerts |
| `worker/src/api/router.ts` | Register analysis + report routes |
| `worker/src/index.ts` | Add `generateHealthReports()` to cron handler |
| `worker/src/types.ts` | Add `report_schedule`, `report_channels` to ClientConfig |
| `worker/dashboard/src/pages/ClientDetail.tsx` | Add tab bar (Overview/Analysis), summary card |
| `worker/dashboard/src/pages/Alerts.tsx` | Add Health Reports settings section (also fix `handleSaveNotifications` no-op stub) |
| `worker/dashboard/src/components/AlertRow.tsx` | Add delivery status indicators |
| `worker/dashboard/src/lib/hooks.ts` | Add `useAnalysis()` hook |
| `worker/dashboard/src/lib/api.ts` | Add `generateReport()`, `sendReport()` API calls |
| `worker/dashboard/src/lib/types.ts` | Add `AnalysisResponse` type, add `delivered_email`/`delivered_telegram` to `Alert` type |

### No New Dependencies

- Charts use existing uPlot (via `useUPlotChart` hook)
- Icons are inline SVG
- Print uses native `window.print()` + CSS `@media print` (scoped to analysis tab via class selector)
- Export uses native `Blob` + `URL.createObjectURL`
- CSV export: each section prefixed with `# Section Name` header row, then column headers, then data rows (same format as existing `/api/export` endpoint)

### Shared Types

- `AnalysisResponse` interface defined in `worker/src/types.ts` (server-side, source of truth)
- Re-exported in `worker/dashboard/src/lib/types.ts` for the dashboard (duplicated to avoid cross-boundary import, marked with `// Keep in sync with worker/src/types.ts AnalysisResponse`)

### Route Registration

- Analysis and report endpoints registered as a new `analysisRoutes` Hono group in `worker/src/api/analysis.ts`
- Mounted in `router.ts` as `app.route("/api/metrics", analysisRoutes)` — colocated with existing metrics routes but in a separate file

### Report Scheduling and Timezones

- Cron runs at UTC hours 0, 6, 12, 18. Daily reports trigger at hour 0 UTC.
- Report period always covers the previous 24h/6h/7d window ending at the cron tick time.
- No local timezone conversion — all times in UTC (consistent with existing cron and data storage).
