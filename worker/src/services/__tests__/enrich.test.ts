import { describe, it, expect } from "vitest";
import { isPublicIpv4, parseOriginTxt, parseAsnTxt } from "@/services/enrich";

describe("isPublicIpv4", () => {
  it("accepts globally-routable addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.254.182.241", "172.32.0.1"]) {
      expect(isPublicIpv4(ip)).toBe(true);
    }
  });

  it("rejects private, reserved, and malformed addresses", () => {
    for (const ip of [
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "127.0.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "224.0.0.1",
      "0.0.0.0",
      "256.1.1.1",
      "not-an-ip",
      "1.2.3",
    ]) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
  });
});

describe("parseOriginTxt (Team Cymru origin record)", () => {
  it("extracts ASN and country", () => {
    expect(parseOriginTxt("13335 | 1.1.1.0/24 | US | arin | 2011-01-14")).toEqual({
      asn: 13335,
      geo: "US",
    });
  });

  it("takes the first ASN when multi-origin", () => {
    expect(parseOriginTxt("23028 394024 | 216.90.108.0/24 | US | arin | 1998-09-25").asn).toBe(23028);
  });

  it("returns nulls for a malformed record", () => {
    expect(parseOriginTxt("garbage")).toEqual({ asn: null, geo: null });
  });
});

describe("parseAsnTxt (Team Cymru AS record)", () => {
  it("extracts the AS name", () => {
    expect(parseAsnTxt("13335 | US | arin | 2010-07-14 | CLOUDFLARENET, US")).toBe(
      "CLOUDFLARENET, US"
    );
  });

  it("returns null when the name is absent", () => {
    expect(parseAsnTxt("13335 | US")).toBeNull();
  });
});
