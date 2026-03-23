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
