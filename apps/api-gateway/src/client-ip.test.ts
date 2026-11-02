// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway's own part of the client address (client-ip.ts): the
 * rate-limit unit per address (IPv6 per /64) and the keyed bucket hash. The
 * rule that picks the address is shared (@caelo-cms/shared
 * client-address.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { hashClientAddress, rateLimitAddress } from "./client-ip.js";

const VISITOR = "198.51.100.7";

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
