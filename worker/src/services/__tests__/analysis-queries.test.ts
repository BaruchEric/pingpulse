import { describe, it, expect } from "vitest";
import { buildAnalysisQueries } from "@/services/analysis-queries";

describe("buildAnalysisQueries", () => {
  it("returns 11 query objects with sql and params", () => {
    const queries = buildAnalysisQueries("client-1", "2026-03-21T00:00:00Z", "2026-03-22T00:00:00Z");
    expect(queries).toHaveLength(11);
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
      "latency_distribution",
      "outage_events",
      "full_speed_tests",
    ]);
  });
});
