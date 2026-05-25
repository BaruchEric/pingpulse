import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Down/up detection — replaces the Durable Object disconnect alarm.
crons.interval(
  "detect down clients",
  { seconds: 30 },
  internal.monitor.detectDownClients,
  {},
);

// Speed-test fan-out, retention, scheduled health reports, and cleanup —
// replaces the Cloudflare cron trigger ("0 */6 * * *").
crons.cron(
  "six hourly maintenance",
  "0 */6 * * *",
  internal.maintenance.sixHourly,
  {},
);

export default crons;
