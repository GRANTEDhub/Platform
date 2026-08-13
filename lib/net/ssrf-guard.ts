// Shared SSRF address guard: the pure IP/host-verdict core, extracted verbatim from
// lib/grantbot/fetch.ts (Brick A) so more than one route can share the same proven logic. This
// module is the IP-RANGE VERDICT ONLY -- no allowlist, no scheme policy, no redirect handling. Those
// stay route-specific: GrantBot's fetch keeps its .gov allowlist + https-only + manual-redirect loop,
// and the enrich route keeps its own scheme/redirect policy. What both share is "given a host, does it
// resolve only to routable public addresses" -- which is the half that took five review rounds and the
// 2000::/3 whitelist-tail fix to get right, and the half enrich was missing.
//
// Everything here is pure and fail-closed: anything not positively recognised as a public unicast
// address is blocked, including a string that is not an IP literal at all.

import { isIP } from "node:net";

export type LookupFn = (host: string) => Promise<{ address: string }[]>;

// ── Pure guard: blocked address ─────────────────────────────────────────────────────────────────
//
// True when an IP literal is NOT a routable public unicast address. FAIL CLOSED: anything that is
// not positively recognised as public -- including a string that is not an IP literal at all -- is
// blocked.
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

// The IANA IPv4 Special-Purpose Address Registry (the non-global entries) plus multicast/reserved.
// Enumerated rather than "positively determine global", because the block set is finite and stable
// and a missed public range only costs a legitimate fetch, while a missed special range is an SSRF
// hole -- so the conservative direction is to over-block.
function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99/24 6to4 relay anycast (deprecated)
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return false;
}

// Parse an IPv6 literal into its eight 16-bit hextets, handling "::" compression, an optional zone
// id, and an embedded dotted-decimal IPv4 tail (::ffff:a.b.c.d). Returns null if it cannot be parsed
// -- and the caller treats null as blocked, so a parse failure fails closed.
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  // Fold an embedded dotted-decimal IPv4 tail into two hex groups, so ::ffff:169.254.169.254 and
  // ::ffff:a9fe:a9fe -- the SAME address in the two legal textual forms -- normalise identically.
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const oct = v4[1].split(".").map((n) => Number(n));
    if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((oct[0] << 8) | oct[1]).toString(16);
    const lo = ((oct[2] << 8) | oct[3]).toString(16);
    s = s.slice(0, s.length - v4[1].length) + `${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (g === "" ? NaN : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isBlockedV4Hextets(hi: number, lo: number): boolean {
  return isBlockedV4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
}

function isBlockedV6(ip: string): boolean {
  const h = parseV6(ip);
  if (!h) return true; // unparseable -> block (fail closed)

  const zeroPrefix6 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  // IPv4-mapped ::ffff:x:y -> judge the embedded v4.
  if (zeroPrefix6 && h[5] === 0xffff) return isBlockedV4Hextets(h[6], h[7]);
  // ::, ::1, and IPv4-compatible ::x:y (deprecated) -> all non-global; judge embedded v4 for the rest.
  if (zeroPrefix6 && h[5] === 0) {
    if ((h[6] === 0 && h[7] === 0) || (h[6] === 0 && h[7] === 1)) return true; // :: and ::1
    return isBlockedV4Hextets(h[6], h[7]);
  }
  // 6to4 (2002::/16): its middle two hextets ARE an embedded v4 (2002:WWXX:YYZZ::), the direct
  // analog of ::ffff: -- so 2002:a9fe:a9fe:: is 169.254.169.254. Decode and judge it.
  if (h[0] === 0x2002) return isBlockedV4Hextets(h[1], h[2]);

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the embedded v4 is the last 32 bits, so
  // 64:ff9b::a9fe:a9fe is 169.254.169.254. Decode and judge it (the /48 local-use form below has a
  // length-dependent embedding and is blocked wholesale instead).
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0)
    return isBlockedV4Hextets(h[6], h[7]);

  // Structural non-global ranges. Fail closed: a grant source is normal public unicast, never any of
  // these, so over-blocking only costs an illegitimate fetch. Kept at v4/v6 parity (see isBlockedV4).
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64 discard-only
  if (h[0] === 0x2001 && (h[1] & 0xfe00) === 0) return true; // 2001::/23 IETF protocol (incl. Teredo, benchmarking)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (h[0] === 0x5f00) return true; // 5f00::/16 SRv6
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return true; // 64:ff9b:1::/48 NAT64 local-use

  // WHITELIST TAIL. Unlike v4 (where the non-special space is exhaustively global unicast, so a
  // denylist is complete), most of the v6 space is reserved/unallocated -- an enumerate-bad list can
  // never be complete, which is why this guard took three rounds of "you missed range X". So after
  // the explicit carve-outs and embedded-v4 decodes above, an address is public ONLY if it falls in
  // 2000::/3, the one range actually assigned as global unicast (RFC 3587). Everything else
  // (9999::, 8000::, 1::, ...) is reserved and blocked -- fail closed BY CONSTRUCTION, which is what
  // the module's contract claims. The documentation/protocol carve-outs that live INSIDE 2000::/3
  // (2001:db8::/32, 2001::/23, 3fff::/20) are already returned above, so they stay blocked.
  return (h[0] & 0xe000) !== 0x2000;
}

// Every address a host resolves to must be public; if any is blocked, block the host. Resolving to
// zero addresses is also a block. Injectable for tests.
export async function hostResolvesPublic(host: string, lookup: LookupFn): Promise<boolean> {
  try {
    const addrs = await lookup(host);
    if (!addrs.length) return false;
    return addrs.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false;
  }
}
