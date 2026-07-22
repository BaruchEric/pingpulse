#!/usr/bin/env bun
// PingPulse path-trace CLI viewer — renders the newest stored trace for a client
// as an enriched, mtr-style terminal table (ASN / country / reverse-DNS per hop,
// color-coded loss, and ECMP multipath flows). Reads D1 directly via wrangler,
// so it needs Wrangler authenticated and is run from the worker/ directory.
//
// Note: ASN / country / reverse-DNS are backfilled lazily by the Worker the first
// time a trace is opened in the dashboard. A trace never viewed there (e.g. a
// fresh trace-on-alert capture) renders with raw IPs and no network column.
//
//   cd worker && bun run trace [ClientName] [--multipath]
//
// Examples:
//   bun run trace                 # newest trace for M3Max
//   bun run trace Win11Insider    # newest trace for another client
//   bun run trace M3Max --multipath   # newest multipath (ECMP) trace
import { $ } from "bun";

// First non-flag arg is the client name (order-independent vs --multipath).
const client = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "M3Max";
const wantMulti = process.argv.includes("--multipath");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[97m", gray: "\x1b[90m",
};
const dash = `${c.gray}—${c.reset}`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => { const len = strip(s).length; return len >= n ? s : s + " ".repeat(n - len); };
// Truncate a raw (un-colored) string to n visible chars so wide hostnames don't
// break column alignment. Color is applied after fitting, never truncated.
const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// Escape single quotes for a SQLite string literal (wrangler d1 has no CLI bind).
const sqlStr = (s) => s.replace(/'/g, "''");

async function d1(sql) {
  const res = await $`bunx wrangler d1 execute pingpulse-db --remote --json --command ${sql}`.quiet().nothrow();
  if (res.exitCode !== 0) {
    console.error(`${c.red}wrangler d1 execute failed (exit ${res.exitCode}).${c.reset} Run from worker/ with wrangler authenticated.`);
    const err = res.stderr.toString().trim();
    if (err) console.error(`${c.dim}${err}${c.reset}`);
    process.exit(1);
  }
  const out = res.stdout.toString();
  try {
    return JSON.parse(out)[0].results;
  } catch {
    console.error(`${c.red}Could not parse wrangler output as JSON.${c.reset}`);
    console.error(`${c.dim}${out.slice(0, 500)}${c.reset}`);
    process.exit(1);
  }
}

const ms = (v) => v == null ? dash : v.toFixed(1);
// Color from the raw value (any nonzero loss stays flagged), but never render a
// nonzero loss as "0%" — sub-1% shows "<1%" so label and color agree.
const lossCell = (p) => {
  if (p == null) return dash;
  const col = p >= 50 ? c.red : p > 0 ? c.yellow : c.green;
  const label = p > 0 && p < 1 ? "<1" : String(Math.round(p));
  return `${col}${label}%${c.reset}`;
};

const multiPredicate = wantMulti
  ? "AND (SELECT COUNT(DISTINCT flow_id) FROM trace_hops WHERE trace_id = t.id) > 1"
  : "";
const traceSql =
  `SELECT t.id, t.target, t.protocol, t.trigger, t.started_at
     FROM traces t JOIN clients cl ON cl.id = t.client_id
    WHERE cl.name = '${sqlStr(client)}' ${multiPredicate}
    ORDER BY t.started_at DESC LIMIT 1`;
const trace = (await d1(traceSql))[0];
if (!trace) { console.log(`No ${wantMulti ? "multipath " : ""}traces found for ${client}.`); process.exit(0); }

const hops = await d1(
  `SELECT flow_id, ttl, addr, hostname, asn, asn_name, geo, loss_pct, avg_ms, best_ms
     FROM trace_hops WHERE trace_id = '${trace.id}' ORDER BY flow_id ASC, ttl ASC`
);
// Group hops into ECMP flows once, rather than re-scanning per flow.
const byFlow = new Map();
for (const h of hops) {
  const k = h.flow_id ?? 0;
  let arr = byFlow.get(k);
  if (!arr) byFlow.set(k, (arr = []));
  arr.push(h);
}
const flows = [...byFlow.keys()].sort((a, b) => a - b);

const when = new Date(trace.started_at).toLocaleString();
const badge = trace.trigger === "alert" ? ` ${c.yellow}[auto: alert]${c.reset}` : "";
console.log("");
console.log(`${c.bold}${c.magenta}PingPulse path trace${c.reset}  ${c.dim}·${c.reset}  ${c.bold}${client}${c.reset} ${c.cyan}→${c.reset} ${c.bold}${trace.target}${c.reset}  ${c.dim}·${c.reset}  ${c.blue}${trace.protocol.toUpperCase()}${c.reset}  ${c.dim}·${c.reset}  ${c.gray}${when}${c.reset}${badge}`);
if (flows.length > 1) console.log(`${c.magenta}${flows.length} ECMP paths discovered${c.reset}`);

for (const f of flows) {
  if (flows.length > 1) console.log(`\n${c.bold}${c.magenta}Path ${f + 1}${c.reset}`);
  console.log(`${c.dim}${pad("TTL", 4)}${pad("HOST", 44)}${pad("LOSS", 7)}${pad("AVG", 8)}${pad("BEST", 8)}NETWORK${c.reset}`);
  for (const h of byFlow.get(f)) {
    const host = fit(h.hostname || h.addr || "*", 43);
    const net = h.asn_name && h.asn != null
      ? `${c.cyan}AS${h.asn}${c.reset} ${h.asn_name}${h.geo ? ` ${c.dim}· ${h.geo}${c.reset}` : ""}`
      : dash;
    console.log(
      `${c.gray}${pad(String(h.ttl), 4)}${c.reset}` +
      `${pad(`${c.white}${host}${c.reset}`, 44)}` +
      `${pad(lossCell(h.loss_pct), 7)}` +
      `${pad(ms(h.avg_ms), 8)}${pad(ms(h.best_ms), 8)}${net}`
    );
  }
}
console.log("");
