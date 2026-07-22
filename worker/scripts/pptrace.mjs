#!/usr/bin/env bun
// PingPulse path-trace CLI viewer — renders the newest stored trace for a client
// as an enriched, mtr-style terminal table (ASN / country / reverse-DNS per hop,
// color-coded loss, and ECMP multipath flows). Reads D1 directly via wrangler,
// so it needs Wrangler authenticated and is run from the worker/ directory.
//
//   cd worker && bun run trace [ClientName] [--multipath]
//
// Examples:
//   bun run trace                 # newest trace for M3Max
//   bun run trace Win11Insider    # newest trace for another client
//   bun run trace M3Max --multipath   # newest multipath (ECMP) trace
import { $ } from "bun";

const client = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "M3Max";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[97m", gray: "\x1b[90m",
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => { const len = strip(s).length; return len >= n ? s : s + " ".repeat(n - len); };

async function d1(sql) {
  const out = await $`bunx wrangler d1 execute pingpulse-db --remote --json --command ${sql}`.quiet().text();
  return JSON.parse(out)[0].results;
}

const lossColor = (p) => p == null ? c.gray : p >= 50 ? c.red : p > 0 ? c.yellow : c.green;
const ms = (v) => v == null ? `${c.gray}—${c.reset}` : v.toFixed(1);

const wantMulti = process.argv.includes("--multipath");
const traceSql = wantMulti
  ? `SELECT t.id, t.target, t.protocol, t.trigger, t.started_at
       FROM traces t JOIN clients cl ON cl.id = t.client_id
      WHERE cl.name = '${client}'
        AND (SELECT COUNT(DISTINCT flow_id) FROM trace_hops WHERE trace_id = t.id) > 1
      ORDER BY t.started_at DESC LIMIT 1`
  : `SELECT t.id, t.target, t.protocol, t.trigger, t.started_at
       FROM traces t JOIN clients cl ON cl.id = t.client_id
      WHERE cl.name = '${client}' ORDER BY t.started_at DESC LIMIT 1`;
const trace = (await d1(traceSql))[0];
if (!trace) { console.log(`No ${wantMulti ? "multipath " : ""}traces found for ${client}.`); process.exit(0); }

const hops = await d1(
  `SELECT flow_id, ttl, addr, hostname, asn, asn_name, geo,
          loss_pct, avg_ms, best_ms, worst_ms
     FROM trace_hops WHERE trace_id = '${trace.id}' ORDER BY flow_id ASC, ttl ASC`
);
const flows = [...new Set(hops.map((h) => h.flow_id ?? 0))].sort((a, b) => a - b);

const when = new Date(trace.started_at).toLocaleString();
const badge = trace.trigger === "alert" ? ` ${c.yellow}[auto: alert]${c.reset}` : "";
console.log("");
console.log(`${c.bold}${c.magenta}PingPulse path trace${c.reset}  ${c.dim}·${c.reset}  ${c.bold}${client}${c.reset} ${c.cyan}→${c.reset} ${c.bold}${trace.target}${c.reset}  ${c.dim}·${c.reset}  ${c.blue}${trace.protocol.toUpperCase()}${c.reset}  ${c.dim}·${c.reset}  ${c.gray}${when}${c.reset}${badge}`);
if (flows.length > 1) console.log(`${c.magenta}${flows.length} ECMP paths discovered${c.reset}`);

for (const f of flows) {
  if (flows.length > 1) console.log(`\n${c.bold}${c.magenta}Path ${f + 1}${c.reset}`);
  console.log(`${c.dim}${pad("TTL", 4)}${pad("HOST", 44)}${pad("LOSS", 7)}${pad("AVG", 8)}${pad("BEST", 8)}NETWORK${c.reset}`);
  for (const h of hops.filter((x) => (x.flow_id ?? 0) === f)) {
    const host = h.hostname || h.addr || "*";
    const net = h.asn_name ? `${c.cyan}AS${h.asn}${c.reset} ${h.asn_name}${h.geo ? ` ${c.dim}· ${h.geo}${c.reset}` : ""}` : `${c.gray}—${c.reset}`;
    const lossStr = h.loss_pct == null ? `${c.gray}—${c.reset}` : `${lossColor(h.loss_pct)}${Math.round(h.loss_pct)}%${c.reset}`;
    console.log(
      `${c.gray}${pad(String(h.ttl), 4)}${c.reset}` +
      `${pad(`${c.white}${host}${c.reset}`, 44)}` +
      `${pad(lossStr, 7)}` +
      `${pad(ms(h.avg_ms), 8)}${pad(ms(h.best_ms), 8)}${net}`
    );
  }
}
console.log("");
