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
  TRUSTED_PROXY_HOPS_ENV,
  trustedProxyHopsFromEnv,
} from "./client-ip.js";

const VISITOR = "198.51.100.7";
const FORGED = "6.6.6.6";

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
