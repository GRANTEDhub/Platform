import { describe, it, expect } from "vitest";
import { isBlockedAddress, hostResolvesPublic, type LookupFn } from "./ssrf-guard";

// The five-review-round IP-verdict cases, moved here verbatim from lib/grantbot/fetch.test.ts when
// the guard was extracted into the shared module. GrantBot's own integrated tests (fetch.test.ts)
// still exercise this core through fetchGrantSource; these test it directly.

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, CGNAT, and cloud metadata (v4)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks the IANA special-use v4 ranges (the SSRF gap Codex flagged)", () => {
    for (const ip of ["198.18.0.1", "198.19.255.255", "192.0.0.1", "192.0.2.5", "192.88.99.1", "198.51.100.7", "203.0.113.10", "240.0.0.1", "255.255.255.255"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks IPv6 loopback, ULA, link-local, multicast, and IPv4-mapped private", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks HEX-form IPv4-mapped v6 (the same address the dotted form catches)", () => {
    // ::ffff:a9fe:a9fe == ::ffff:169.254.169.254 (metadata); ::ffff:a00:1 == ::ffff:10.0.0.1
    for (const ip of ["::ffff:a9fe:a9fe", "::ffff:a00:1", "::ffff:7f00:1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks the whole fe80::/10 link-local range, not just fe80::", () => {
    for (const ip of ["fe80::1", "fe81::1", "fe8f::1", "fe90::1", "fea0::1", "febf::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("decodes 6to4 to its embedded v4 and blocks metadata/private targets", () => {
    // 2002:WWXX:YYZZ:: embeds a v4 in the middle two hextets.
    for (const ip of ["2002:a9fe:a9fe::", "2002:0a00:0001::", "2002:7f00:0001::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks the other non-global IPv6 ranges (v4/v6 parity)", () => {
    for (const ip of ["100::1", "2001::1", "2001:2::1", "2001:db8::1", "3fff::1", "5f00::1", "64:ff9b:1::1", "fec0::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("decodes the NAT64 well-known prefix and blocks metadata/private targets", () => {
    // 64:ff9b::WWXX:YYZZ embeds a v4 in the last 32 bits (RFC 6052).
    for (const ip of ["64:ff9b::a9fe:a9fe", "64:ff9b::a00:1", "64:ff9b::7f00:1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks reserved/unallocated v6 outside 2000::/3 (whitelist tail, fail-closed)", () => {
    for (const ip of ["9999::1", "8000::1", "4000::1", "c000::1", "1::1", "::5:6:7"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("allows routable public addresses", () => {
    // Public v6 is global unicast (2000::/3); these must survive the whitelist tail.
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "198.20.0.1", "199.0.0.1", "2606:2800:220:1::1", "2001:4860:4860::8888", "2a00:1450:4001::1", "3000::1"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
  it("blocks anything that is not an IP literal", () => {
    expect(isBlockedAddress("grants.gov")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("hostResolvesPublic", () => {
  const lookupTo = (...addrs: string[]): LookupFn => async () => addrs.map((address) => ({ address }));

  it("is true only when every resolved address is public", async () => {
    expect(await hostResolvesPublic("h", lookupTo("8.8.8.8"))).toBe(true);
    expect(await hostResolvesPublic("h", lookupTo("8.8.8.8", "1.1.1.1"))).toBe(true);
  });
  it("blocks if ANY resolved address is non-public (the DNS-rebinding case)", async () => {
    expect(await hostResolvesPublic("h", lookupTo("8.8.8.8", "169.254.169.254"))).toBe(false);
    expect(await hostResolvesPublic("h", lookupTo("10.0.0.1"))).toBe(false);
  });
  it("blocks on zero addresses and on a lookup that throws (fail closed)", async () => {
    expect(await hostResolvesPublic("h", async () => [])).toBe(false);
    expect(
      await hostResolvesPublic("h", async () => {
        throw new Error("dns fail");
      }),
    ).toBe(false);
  });
});
