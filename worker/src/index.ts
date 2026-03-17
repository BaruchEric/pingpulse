export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  METRICS: AnalyticsEngineDataset;
  CLIENT_MONITOR: DurableObjectNamespace;
  ADMIN_JWT_SECRET: string;
  RESEND_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return new Response("PingPulse API", { status: 200 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // TODO: cron handler
  },
};
