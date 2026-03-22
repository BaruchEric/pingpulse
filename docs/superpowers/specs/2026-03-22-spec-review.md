# Design Spec Review: Deep Analysis, Alert Delivery Fix & Health Reports

**Reviewer:** Code Review Agent
**Date:** 2026-03-22
**Spec:** `docs/superpowers/specs/2026-03-22-deep-analysis-alerts-reports-design.md`

---

## Overall Assessment

The spec is well-structured, covers three tightly scoped features, and demonstrates strong understanding of the existing codebase. The file change summary is thorough and the shared query module (`analysis-queries.ts`) is a good architectural choice. Below are the issues found, categorized by severity.

---

## Critical Issues (Must Fix)

### 1. Charting library mismatch — Recharts does not exist in this project

The spec states: *"Charts use existing Recharts"* and names `HourlyHeatmap.tsx` as using *"Recharts, already a project dep."*

**This is incorrect.** The dashboard uses **uPlot** (`uplot@^1.6.32`) via a custom `useUPlotChart` hook. Recharts is not installed and has never been a dependency. All existing charts (`LatencyChart`, `ThroughputChart`, `WanQualityChart`, `ConnectionStateChart`) use the `useUPlotChart` pattern with imperative `uPlot.AlignedData` arrays.

**Impact:** If an implementer follows the spec literally, they will either install a conflicting charting library or produce components that break the established pattern.

**Recommendation:** Rewrite the charting section to use uPlot via `useUPlotChart`, or explicitly call out that `HourlyHeatmap` and `DirectionAsymmetry` will use a different rendering approach (e.g., plain SVG/Canvas or HTML tables with CSS bars) and justify why.

### 2. `useAnalysis` polling interval not specified — analysis queries are expensive

The spec says the new `useAnalysis` hook should follow *"the same pattern as existing `useMetrics` hook."* The existing `useMetrics` polls every 10 seconds. Running 8 aggregation SQL queries against D1 every 10 seconds is excessive for an analysis dashboard that shows historical data.

**Recommendation:** Set the `useAnalysis` polling interval to `0` (fetch once, no polling) or a long interval like 300,000ms (5 minutes). Add a manual `refresh` button instead. The data is historical aggregations; it does not need real-time polling.

### 3. Spec says `dashboard/src/components/...` but actual path is `worker/dashboard/src/components/...`

The spec's file paths omit the `worker/` prefix. The actual project structure nests the dashboard inside the worker:
- Spec says: `dashboard/src/components/AnalysisSummaryCard.tsx`
- Actual path: `worker/dashboard/src/components/AnalysisSummaryCard.tsx`

Similarly for `dashboard/src/lib/hooks.ts`, `dashboard/src/lib/api.ts`, etc.

**Impact:** An implementer creating files at the spec paths would put them in the wrong location. The existing `@/` path alias resolves from `worker/dashboard/src/`.

**Recommendation:** Update all dashboard file paths in the spec to include the `worker/` prefix.

---

## Important Issues (Should Fix)

### 4. Alert `INSERT` does not set `delivered_email` / `delivered_telegram` columns

The current `triggerAlert()` code inserts alerts with only 7 columns:
```sql
INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)
```

The `delivered_email` and `delivered_telegram` columns exist in the schema with `DEFAULT 0`, so they get set to 0 implicitly. This is fine for the initial insert. However, the spec proposes using `-1` for "failed" — this tri-state (`0` = not attempted, `1` = success, `-1` = failed) should be explicitly documented as a contract in the types, and the `Alert` interface in `worker/dashboard/src/lib/types.ts` needs to be updated to include `delivered_email` and `delivered_telegram` fields. The spec does not mention updating the dashboard `Alert` type.

**Recommendation:** Add `delivered_email: number; delivered_telegram: number;` to the dashboard `Alert` interface in `worker/dashboard/src/lib/types.ts`, and add a comment documenting the tri-state values.

### 5. `setTimeout` for retry in Durable Object — verify compatibility with hibernation

The spec proposes: *"retry once after 5s using `setTimeout` within the DO's event loop."* Durable Objects using the Hibernatable WebSockets API (which this project uses — `webSocketMessage`, `webSocketClose` handlers are present) can be evicted between events. A `setTimeout` is not guaranteed to fire if the DO hibernates in the interim.

**Recommendation:** Use `this.state.storage.setAlarm(Date.now() + 5000)` instead, and track the pending retry in durable storage. The `alarm()` handler already exists and can be extended with a retry check. Alternatively, accept that the retry is best-effort and document this limitation.

### 6. Cron schedule logic uses UTC but user instructions say "timestamps are local midnight"

The user's CLAUDE.md says *"Timestamps are local midnight, not UTC midnight."* The spec says reports run at *"00:00 UTC"* for daily and weekly schedules. This is a direct conflict with the user's stated preference.

**Recommendation:** Clarify whether report scheduling should use the user's local timezone or UTC. If local, the cron handler needs to determine the client's timezone (which is not currently stored) or use a global timezone config.

### 7. `handleSaveNotifications` on Alerts page is a no-op

The existing Alerts page `handleSaveNotifications` handler just shows "Saved" for 2 seconds without actually persisting anything:
```js
const handleSaveNotifications = () => {
    setNotifMsg("Saved");
    setTimeout(() => setNotifMsg(""), 2000);
};
```

The spec proposes adding a "Health Reports" section to this page that *"Saves via existing config update mechanism."* But the existing notification settings save mechanism is broken/stubbed. Adding health report config alongside it without fixing the existing save would be confusing.

**Recommendation:** Either fix the existing notification save handler as part of this work, or note it as a known limitation and ensure the new Health Reports section has its own working save handler.

### 8. Analysis endpoint `GET /api/metrics/:id/analysis` conflicts with existing metrics route pattern

The existing `metricsRoutes` are mounted at `app.route("/api/metrics", metricsRoutes)` and already define `GET /:id` and `GET /:id/logs` and `GET /:clientId/probes`. The spec proposes adding the analysis endpoint in a new file `worker/src/api/analysis.ts`. If this is mounted as a separate route group, the path needs to be `GET /:id/analysis` within the metrics routes, or it needs its own mount point.

**Recommendation:** Either add the analysis route directly to `metrics.ts` as `metricsRoutes.get("/:id/analysis", ...)` (simpler, follows existing pattern), or clearly specify the mount point in `router.ts` if using a separate file. The report endpoint (`POST /api/metrics/:id/report`) has the same consideration.

---

## Suggestions (Nice to Have)

### 9. Export CSV format is ambiguous

The spec says *"Flattens each section into labeled CSV sections, downloads as `.csv`."* Multi-section CSV files (with headers interspersed between data sections) are not standard CSV and will not import cleanly into spreadsheet tools. Consider either:
- Generating a ZIP file with one CSV per section, or
- Using a single flat CSV with a "section" column

### 10. The `AnalysisResponse` interface should live in the shared types

The spec says to add `AnalysisResponse` to `dashboard/src/lib/types.ts`. Consider also exporting the same interface from the worker side (e.g., in `worker/src/types.ts` or `worker/src/services/analysis-queries.ts`) so the API handler and health report generator can reference a typed return value rather than ad-hoc objects.

### 11. `recent_errors` limit is not specified

The `recent_errors` field in `AnalysisResponse` has no specified limit. For clients with high error rates over a 30-day window, this could return thousands of rows. Add a `LIMIT 100` (or configurable) to the underlying query.

### 12. No loading/error states described for new dashboard components

The spec describes 6 new components but does not specify loading states, error boundaries, or empty states. The existing components handle these inconsistently. Consider defining a pattern (e.g., skeleton loaders, error messages) and applying it uniformly.

### 13. Print styles scope

The spec says *"`@media print` styles: white bg, no nav, clean layout."* Consider whether these should be global (affecting all pages when printed) or scoped specifically to the Analysis tab. Global print styles could affect other pages unexpectedly.

---

## What Was Done Well

- The shared `analysis-queries.ts` module avoids duplicating SQL between the API endpoint and the health report generator — good separation of concerns.
- The tri-state delivery tracking (`0`/`1`/`-1`) is a pragmatic solution that works within the existing schema without migrations.
- The "No New Dependencies" constraint is well-reasoned (though the Recharts reference contradicts it).
- The manual report trigger (`POST /api/metrics/:id/report`) with optional `?send=` parameter is a clean API design that supports both preview and send in one endpoint.
- Config additions (`report_schedule`, `report_channels`) follow the existing `ClientConfig` pattern cleanly.

---

## Summary

| Category | Count |
|----------|-------|
| Critical | 3 |
| Important | 5 |
| Suggestions | 5 |

The three critical issues (Recharts vs uPlot mismatch, aggressive polling interval, wrong file paths) should be resolved before implementation begins. The important issues should be addressed during implementation. The suggestions can be handled at the implementer's discretion.
