// ASN / GeoIP / reverse-DNS enrichment for path-trace hops.
//
// Uses Cloudflare DNS-over-HTTPS (application/dns-json) against Team Cymru's
// IP-to-ASN DNS service — no API key and no MaxMind database shipped in the
// Worker. Enrichment is best-effort: any lookup that fails or times out simply
// yields nulls, and the trace is still shown.

export interface HopEnrichment {
  hostname: string | null;
  asn: number | null;
  asn_name: string | null;
  geo: string | null; // ISO 3166-1 alpha-2 country code
}

export const EMPTY_ENRICHMENT: HopEnrichment = {
  hostname: null,
  asn: null,
  asn_name: null,
  geo: null,
};

const DOH = "https://cloudflare-dns.com/dns-query";
const LOOKUP_TIMEOUT_MS = 3000;

/** True only for globally-routable IPv4 (skips RFC1918/loopback/link-local/CGNAT/multicast). */
export function isPublicIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast + reserved
  return true;
}

async function dohJson(name: string, type: "TXT" | "PTR"): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const r = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface DohAnswer {
  type: number;
  data: string;
}
function answers(j: unknown): DohAnswer[] {
  const a = (j as { Answer?: unknown })?.Answer;
  return Array.isArray(a) ? (a as DohAnswer[]) : [];
}
function firstTxt(j: unknown): string | null {
  const ans = answers(j).find((a) => a.type === 16);
  if (!ans) return null;
  // dns-json wraps TXT in quotes and escapes inner quotes.
  return String(ans.data).replace(/^"|"$/g, "").replace(/\\"/g, '"');
}

// Team Cymru origin record: "13335 | 1.1.1.0/24 | US | arin | 2011-01-14"
// (ASN | BGP prefix | country | registry | allocated). Multi-origin ASNs are
// space-separated in the first field; take the first.
export function parseOriginTxt(txt: string): { asn: number | null; geo: string | null } {
  const parts = txt.split("|").map((s) => s.trim());
  const firstAsn = parts[0]?.split(/\s+/)[0];
  const asn = firstAsn ? Number.parseInt(firstAsn, 10) : Number.NaN;
  const cc = parts[2];
  const geo = cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null;
  return { asn: Number.isFinite(asn) ? asn : null, geo };
}

// Team Cymru AS record: "13335 | US | arin | 2010-07-14 | CLOUDFLARENET, US"
// (ASN | country | registry | allocated | AS name).
export function parseAsnTxt(txt: string): string | null {
  const parts = txt.split("|").map((s) => s.trim());
  return parts[4] || null;
}

function reverseV4(ip: string): string {
  return ip.split(".").reverse().join(".");
}

/** Enrich a single IPv4 address. Returns nulls for private/unresolvable addresses. */
export async function enrichAddr(addr: string): Promise<HopEnrichment> {
  if (!isPublicIpv4(addr)) return EMPTY_ENRICHMENT;
  const rev = reverseV4(addr);
  const [originJ, ptrJ] = await Promise.all([
    dohJson(`${rev}.origin.asn.cymru.com`, "TXT"),
    dohJson(`${rev}.in-addr.arpa`, "PTR"),
  ]);

  const originTxt = firstTxt(originJ);
  const { asn, geo } = originTxt ? parseOriginTxt(originTxt) : { asn: null, geo: null };

  let asn_name: string | null = null;
  if (asn != null) {
    asn_name = parseAsnTxt(firstTxt(await dohJson(`AS${asn}.asn.cymru.com`, "TXT")) ?? "");
  }

  const ptrAns = answers(ptrJ).find((a) => a.type === 12);
  const hostname = ptrAns ? String(ptrAns.data).replace(/\.$/, "") : null;

  return { hostname, asn, asn_name, geo };
}

/** Enrich a set of addresses concurrently, returning a map keyed by address. */
export async function enrichAddrs(addrs: string[]): Promise<Map<string, HopEnrichment>> {
  const uniq = [...new Set(addrs)];
  const entries = await Promise.all(
    uniq.map(async (a) => [a, await enrichAddr(a)] as const)
  );
  return new Map(entries);
}

export function hasEnrichment(e: HopEnrichment): boolean {
  return e.hostname != null || e.asn != null || e.asn_name != null || e.geo != null;
}
