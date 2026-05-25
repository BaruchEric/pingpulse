/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * Normally produced by `npx convex dev`. Committed here because this environment
 * cannot reach Convex's deployment host to run codegen. Regenerate with
 * `npx convex dev` once connected to a deployment.
 */
import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as alertDispatch from "../alertDispatch.js";
import type * as alerts from "../alerts.js";
import type * as analysis from "../analysis.js";
import type * as auth from "../auth.js";
import type * as botSettings from "../botSettings.js";
import type * as clients from "../clients.js";
import type * as commands from "../commands.js";
import type * as ingest from "../ingest.js";
import type * as maintenance from "../maintenance.js";
import type * as metrics from "../metrics.js";
import type * as monitor from "../monitor.js";
import type * as rateLimit from "../rateLimit.js";
import type * as reports from "../reports.js";
import type * as telegram from "../telegram.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  alertDispatch: typeof alertDispatch;
  alerts: typeof alerts;
  analysis: typeof analysis;
  auth: typeof auth;
  botSettings: typeof botSettings;
  clients: typeof clients;
  commands: typeof commands;
  ingest: typeof ingest;
  maintenance: typeof maintenance;
  metrics: typeof metrics;
  monitor: typeof monitor;
  rateLimit: typeof rateLimit;
  reports: typeof reports;
  telegram: typeof telegram;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
