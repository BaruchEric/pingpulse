import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { runAnalysis } from "@/services/analysis-queries";
import { formatTelegramReport, formatEmailReport } from "@/services/health-report";
import { sendTelegramMessage, sendResendEmail } from "@/services/notify";
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
  const send = c.req.query("send");

  const from = new Date(Date.now() - 86400_000).toISOString();
  const to = new Date().toISOString();

  const raw = await runAnalysis(c.env.DB, id, from, to);

  const client = await c.env.DB.prepare("SELECT name FROM clients WHERE id = ?")
    .bind(id)
    .first<{ name: string }>();
  const clientName = client?.name || id;

  const sent: { telegram?: boolean; email?: boolean } = {};

  if (send === "telegram" || send === "all") {
    const message = formatTelegramReport(clientName, from, to, raw);
    sent.telegram = await sendTelegramMessage(c.env, message);
  }

  if (send === "email" || send === "all") {
    const html = formatEmailReport(clientName, from, to, raw);
    sent.email = await sendResendEmail(c.env, `[PingPulse] Health Report — ${clientName}`, { html });
  }

  return c.json({ report: raw, sent });
});
