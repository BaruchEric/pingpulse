# Plan Review: Deep Analysis, Alert Delivery Fix & Health Reports

**Reviewer:** Code Review Agent
**Date:** 2026-03-22
**Plan:** `docs/superpowers/plans/2026-03-22-deep-analysis-alerts-reports.md`
**Spec:** `docs/superpowers/specs/2026-03-22-deep-analysis-alerts-reports-design.md`

---

## Overall Assessment

The plan is well-structured with 14 tasks, proper dependency ordering, and consistent test/typecheck/commit steps. It closely follows the spec and respects existing codebase patterns. Below are issues found, categorized by severity.

---

## Critical Issues (Must Fix)

### C1. Spec/Plan Route Path Mismatch

The spec defines the analysis endpoint as `GET /api/metrics/:id/analysis` and `POST /api/metrics/:id/report`. The plan (Task 6) creates a separate `analysisRoutes` Hono group mounted at `/api/analysis`, making the actual paths `GET /api/analysis/:id` and `POST /api/analysis/:id/report`.

The dashboard API helpers in Task 9 use `/api/analysis/${id}` which matches the plan, but **contradicts the spec**.

**Recommendation:** Decide which path convention to use and make spec + plan + dashboard API helpers consistent. Mounting at `/api/analysis` is cleaner (avoids overloading the metrics namespace), but the spec should be updated if that is the chosen path.

### C2. Task 1 Test Uses `vi.stubGlobal("fetch")` -- Incompatible with Cloudflare Workers Vitest Pool

The project uses `@cloudflare/vitest-pool-workers` with a `wrangler.toml`-backed config and `setupFiles: ["./test/apply-migrations.ts"]`. Tests run inside a Workers runtime, where `fetch` is a global but `vi.stubGlobal("fetch")` may not work as expected -- the Workers runtime binds `fetch` differently than Node.

The existing test suite (visible in `worker/src/`) does not appear to have any tests currently in `worker/src/services/__tests__/`. The plan creates tests there but the approach of mocking global `fetch` may fail in the Workers pool environment.

**Recommendation:** Either:
- (a) Use `vi.fn()` to mock the module-level functions (`sendEmail`, `sendTelegram`) instead of global `fetch`, or
- (b) Add a note that these specific tests might need `pool: 'forks'` in vitest config, or
- (c) Restructure the test to use the Miniflare/Workers test bindings pattern used elsewhere in the project.

### C3. Task 2 Alarm Conflict Risk Undocumented

The plan has `triggerAlert` setting a DO alarm for retry (`Date.now() + 5000`) and checks for existing alarms. However, the existing `client-monitor.ts` already uses alarms for ping scheduling. The plan says "won't clobber ping alarm" with a check `if (!currentAlarm || currentAlarm > Date.now() + 5000)`, but Cloudflare DOs only support **one alarm at a time**. Setting a retry alarm at `now + 5s` WILL overwrite any pending ping alarm.

The plan's `alarm()` handler addition checks for `pendingRetry` in storage and handles it before falling through to existing alarm logic, which is correct. But overwriting the alarm timestamp is still destructive -- if a ping was scheduled for 2s from now and we set the alarm to 5s, we delay the ping by 3s.

**Recommendation:** Add explicit documentation that the retry alarm intentionally takes priority and the ping alarm will be rescheduled after the retry runs. Alternatively, process retries inline during the next natural alarm tick instead of forcing a new alarm.

---

## Important Issues (Should Fix)

### I1. Task 14 "Save Report Settings" Handler is a No-Op Stub

The plan's Task 14, Step 3 shows a Save button `onClick` handler that sets `setNotifMsg("Report settings saved")` but includes comments like "This would need a bulk update endpoint or iterate clients" and "For now, update global alert thresholds endpoint." It never actually saves the config.

The spec says these settings should save via the existing `PUT /api/clients/:id` config update mechanism. The plan for Task 8, Step 3 adds `report_schedule` and `report_channels` to the allowed config keys in the DO command handler, but Task 14 does not wire up the actual save call.

**Recommendation:** Add an actual API call in the save handler, similar to the existing notification settings pattern. The Alerts page likely iterates clients or targets a specific client.

### I2. Task 5 `buildAnalysisQueries` vs `runAnalysis` Naming Inconsistency

Task 5 Step 1 (test) imports `buildAnalysisQueries` and tests that it returns query objects. Task 5 Step 3 (implementation) exports `buildAnalysisQueries` (returns query definitions) and `runAnalysis` (executes them). But Task 6 and Task 8 import only `runAnalysis`. The test only validates `buildAnalysisQueries` (that it produces 8 queries with correct keys), not `runAnalysis`.

This is fine architecturally, but the test provides limited coverage -- it only checks query structure, not that `runAnalysis` correctly assembles results from D1. Consider adding an integration test for `runAnalysis` using the Workers test pool (which provides real D1).

### I3. Missing `ALERT_FROM_EMAIL` and `ALERT_TO_EMAIL` in Task 1 Test

The second test case (`"returns email:false when Resend fails"`) includes `RESEND_API_KEY` but omits `ALERT_FROM_EMAIL` and `ALERT_TO_EMAIL` from the env mock. The current `sendEmail` implementation uses fallback defaults (`"PingPulse <alerts@ping.beric.ca>"` and `"admin@beric.ca"`), so this works, but it is inconsistent with the first test case that includes them. Minor but worth keeping tests consistent.

### I4. Task 6 Imports `dispatchAlert` But Never Uses It

In Task 6, Step 1, the `analysis.ts` file imports `dispatchAlert` from `@/services/alert-dispatch`, but the report endpoint sends emails/Telegram directly via inline `fetch` calls rather than using the dispatch service. This is an unused import that will trigger linting warnings.

**Recommendation:** Either use `dispatchAlert` for sending (with appropriate payload adaptation), or remove the import.

### I5. `useAnalysis` Returns `AnalysisResponse` But Plan Types It as `Record<string, unknown[]>`

In Task 9, the `useAnalysis` hook fetches from `getAnalysis` which returns `AnalysisResponse` (strongly typed). However, the `generateReport` and `sendReport` API methods in the same task return `{ report: Record<string, unknown[]>; sent: Record<string, boolean> }` -- losing type safety on the report payload. Consider using `AnalysisResponse` for the report field too.

---

## Suggestions (Nice to Have)

### S1. Spec Mentions Export CSV Format Should Match Existing `/api/export` Endpoint

The spec says "same format as existing `/api/export` endpoint." The plan's export implementation (Tasks 10-12) uses a client-side `Blob` approach with section headers. Worth verifying the actual export format matches what `/api/export` produces.

### S2. No Tests for Dashboard Components

Tasks 10-14 create 7 new React components and modify 3 existing ones with no component tests. This matches the current project pattern (no component tests visible in the repo), so it is not a deviation, but worth noting for future consideration.

### S3. Print Styles Added in Task 13 via Inline `<style>` Tag

Task 13 adds `@media print` styles via a `<style>` tag rendered inside the React component. This works but is unconventional -- consider moving print styles to the global CSS or a dedicated print stylesheet for maintainability.

### S4. Task 8 Cron Query for Active Clients Uses 7-Day Window

The `generateHealthReports` function queries clients with `last_seen > ?` using a 7-day window. The existing cron in `index.ts` uses a 1-day window. The 7-day window is intentional (weekly reports need clients seen within a week), but this difference should be commented in the code.

---

## What Was Done Well

- **Correct use of existing patterns:** `usePolling` with `intervalMs=0` for analysis (no auto-poll), `useUPlotChart` hook for charts, `request<T>` helper for API calls, and Hono route groups with `authGuard` all match established conventions.
- **Shared query module:** Extracting analysis queries into `analysis-queries.ts` for reuse between the API and cron report generator is clean architecture.
- **Tri-state delivery tracking (`1`/`0`/`-1`)** is well-designed and the plan correctly documents the semantics.
- **Test-first approach:** Tasks 1, 5, and 7 follow TDD with write-test/fail/implement/pass steps.
- **Proper commit granularity:** Each task has its own commit with descriptive messages.
- **DO alarm retry for critical alerts** is a clever use of Durable Objects' built-in alarm mechanism for reliable retry without external queues.
- **Dependency ordering is correct:** Types (Task 4) before queries (Task 5) before API (Task 6) before formatter (Task 7) before cron (Task 8) before dashboard (Tasks 9-14).

---

## Spec Coverage Checklist

| Spec Requirement | Plan Coverage | Notes |
|---|---|---|
| Fix alert delivery tracking | Tasks 1-3 | Fully covered |
| `delivered_email`/`delivered_telegram` tri-state | Task 2 (worker), Task 3 (dashboard) | Correct |
| Critical alert retry via DO alarm | Task 2 | Covered (see C3 alarm conflict note) |
| Delivery status UI indicators | Task 3 | Covered |
| `AnalysisResponse` type definition | Task 4 | Matches spec exactly |
| 8 analysis SQL queries | Task 5 | Covered via `buildAnalysisQueries` |
| `GET /api/metrics/:id/analysis` | Task 6 | Path differs from spec (see C1) |
| `POST /api/metrics/:id/report` | Task 6 | Path differs from spec (see C1) |
| Dashboard Analysis tab | Tasks 10-13 | All 6 components + tab wiring |
| Export JSON/CSV/Print | Tasks 10, 12-13 | Covered |
| `useAnalysis` hook (no auto-poll) | Task 9 | Correct pattern |
| Health report Telegram format | Task 7 | Covered |
| Health report email HTML format | Task 7 | Covered |
| `report_schedule` / `report_channels` config | Tasks 4, 8 | Defined + used in cron |
| Cron integration | Task 8 | Covered |
| Manual report trigger API | Task 6 | Covered |
| Report modal in dashboard | Task 12 | Covered |
| Health Reports settings UI | Task 14 | Covered (but save is no-op, see I1) |
| Allowed config keys updated | Task 8 Step 3 | Covered |
| Summary card on Overview tab | Task 13 | Not explicitly shown in plan steps |

---

## Summary

**3 Critical**, **5 Important**, **4 Suggestions**

The plan is comprehensive and well-ordered. The critical issues are: (C1) route path mismatch between spec and plan, (C2) test mocking strategy incompatible with the Workers vitest pool, and (C3) DO alarm overwrite risk needs explicit handling. The most impactful important issue is (I1) the report settings save handler being a no-op stub. All spec requirements are addressed, though the route paths need alignment.
