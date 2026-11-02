// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor's address per deployment topology (client-ip.ts). Each case
 * builds X-Forwarded-For the way the provider's proxies do: whatever the
 * client sent, then the entries the infrastructure appends.
 */

import { describe, expect, it } from "bun:test";
import {
  ClientAddressError,
  clientAddress,
  forwardedClientIp,
  hashClientAddress,
  rateLimitAddress,
  TRUSTED_PROXY_HOPS_ENV,
  trustedProxyHopsFromEnv,
} from "./client-ip.js";

const VISITOR = "198.51.100.7";
const FORGED = "6.6.6.6";

describe("rateLimitAddress (#1326: IPv6 per /64)", () => {
  it("keeps an IPv4 address", () => {
    expect(rateLimitAddress("198.51.100.7")).toBe("198.51.100.7");
  });

  it("puts every address of one IPv6 /64 into one bucket", () => {
    const a = rateLimitAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    for (const other of ["2001:db8:1:2::1", "2001:0DB8:0001:0002:ffff::", "2001:db8:1:2::7%eth0"]) {
      expect(rateLimitAddress(other)).toBe(a);
    }
    expect(rateLimitAddress("2001:db8:1:3::1")).not.toBe(a);
  });

  it("expands '::' anywhere", () => {
    expect(rateLimitAddress("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("reads IPv4-mapped IPv6 as the IPv4 address it carries", () => {
    expect(rateLimitAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitAddress("::ffff:c633:6407")).toBe("198.51.100.7");
  });

  it("leaves a value that is no IP address as it is", () => {
    expect(rateLimitAddress("not:an:ip:::")).toBe("not:an:ip:::");
  });
});

describe("hashClientAddress (#1338: keyed)", () => {
  const key = new Uint8Array(32).fill(7);
  const other = new Uint8Array(32).fill(8);

  it("is an HMAC: the key changes the hash, and it is not the unkeyed SHA-256", () => {
    const h = hashClientAddress(VISITOR, key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClientAddress(VISITOR, other)).not.toBe(h);
    expect(h).not.toBe(new Bun.CryptoHasher("sha256").update(VISITOR).digest("hex"));
  });

  it("hashes one IPv6 /64 alike", () => {
    expect(hashClientAddress("2001:db8:1:2::1", key)).toBe(
      hashClientAddress("2001:db8:1:2:9:9:9:9", key),
    );
  });
});

function req(xff?: string): Request {
  return new Request("http://gateway.internal/api/plugin/x/y", {
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });
}

describe("trustedProxyHopsFromEnv", () => {
  it("reads a non-negative integer", () => {
    expect(trustedProxyHopsFromEnv({ [TRUSTED_PROXY_HOPS_ENV]: "2" })).toBe(2);
    expect(trustedProxyHopsFromEnv({ [TRUSTED_PROXY_HOPS_ENV]: "0" })).toBe(0);
  });

  it("refuses a missing value instead of picking one, naming the fix", () => {
    expect(() => trustedProxyHopsFromEnv({})).toThrow(ClientAddressError);
    expect(() => trustedProxyHopsFromEnv({})).toThrow(/cms-provision upgrade/);
    expect(() => trustedProxyHopsFromEnv({ [TRUSTED_PROXY_HOPS_ENV]: " " })).toThrow(
      ClientAddressError,
    );
  });

  it("refuses anything but a non-negative integer", () => {
    for (const bad of ["-1", "1.5", "two", "2x"]) {
      expect(() => trustedProxyHopsFromEnv({ [TRUSTED_PROXY_HOPS_ENV]: bad })).toThrow(
        /not a non-negative integer/,
      );
    }
  });
});

describe("forwardedClientIp", () => {
  it("counts from the end and trims", () => {
    expect(forwardedClientIp(`${FORGED} , ${VISITOR},34.1.2.3`, 2)).toBe(VISITOR);
    expect(forwardedClientIp(VISITOR, 1)).toBe(VISITOR);
  });

  it("is null when the header is shorter than the hop count, or absent", () => {
    expect(forwardedClientIp(VISITOR, 2)).toBeNull();
    expect(forwardedClientIp(null, 1)).toBeNull();
    expect(forwardedClientIp("", 1)).toBeNull();
    expect(forwardedClientIp(VISITOR, 0)).toBeNull();
  });
});

describe("clientAddress per topology", () => {
  it("gcp — the LB appends <client>,<LB IP>: the visitor, never the LB, never a forged entry", () => {
    const lb = "34.120.0.1";
    expect(clientAddress(req(`${VISITOR}, ${lb}`), 2, null)).toBe(VISITOR);
    // A client-sent header stays in front of what the LB appends.
    expect(clientAddress(req(`${FORGED}, ${VISITOR}, ${lb}`), 2, null)).toBe(VISITOR);
    // Two visitors behind the same LB stay apart (the last-hop rule pooled them).
    expect(clientAddress(req(`203.0.113.9, ${lb}`), 2, null)).not.toBe(
      clientAddress(req(`${VISITOR}, ${lb}`), 2, null),
    );
  });

  it("gcp-firebase / self-hosted / azure — one appended entry: forged prefixes are ignored", () => {
    expect(clientAddress(req(VISITOR), 1, null)).toBe(VISITOR);
    expect(clientAddress(req(`${FORGED}, ${VISITOR}`), 1, null)).toBe(VISITOR);
  });

  it("no proxy (local dev) — the TCP peer, whatever the header says", () => {
    expect(clientAddress(req(FORGED), 0, VISITOR)).toBe(VISITOR);
    expect(() => clientAddress(req(), 0, null)).toThrow(ClientAddressError);
  });

  it("fails loudly when a request lacks what the topology always appends", () => {
    expect(() => clientAddress(req(VISITOR), 2, null)).toThrow(/fewer than 2 X-Forwarded-For/);
    expect(() => clientAddress(req(), 1, VISITOR)).toThrow(ClientAddressError);
  });
});
