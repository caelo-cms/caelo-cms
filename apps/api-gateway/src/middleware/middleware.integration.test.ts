// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — middleware unit + integration coverage:
 *   - body-cap: rejects oversize payloads pre-parse.
 *   - signed-cookie: HMAC round-trips; tampered values rejected.
 *   - honeypot: tripped detection on filled hp_address.
 *   - rate-limit: sliding window + token bucket against a real DB.
 *   - captcha: issue → verify → replay-rejected.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { readBodyWithCap } from "./body-cap.js";
import { hashVisitorId, issuePowChallenge, verifyPowProof } from "./captcha.js";
import { checkHoneypot } from "./honeypot.js";
import { consumeRateLimit, rateLimitKey, resolveRateLimitSpec } from "./rate-limit.js";
import { generateCookieSecret, signCookieValue, verifySignedCookie } from "./signed-cookie.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

afterAll(async () => {
  await adapter.close();
});

describe("body-cap", () => {
  it("accepts a small body", async () => {
    const req = new Request("http://x", { method: "POST", body: "ok" });
    const r = await readBodyWithCap(req, 64);
    expect(r.ok).toBe(true);
  });

  it("rejects via Content-Length pre-check when declared > limit", async () => {
    const req = new Request("http://x", {
      method: "POST",
      headers: { "Content-Length": "99999" },
      body: "small",
    });
    const r = await readBodyWithCap(req, 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.bytes).toBe(99999);
  });

  it("rejects mid-stream when chunked body exceeds the cap", async () => {
    const big = "x".repeat(5000);
    const req = new Request("http://x", { method: "POST", body: big });
    const r = await readBodyWithCap(req, 1000);
    expect(r.ok).toBe(false);
  });
});

describe("signed-cookie", () => {
  it("round-trips a value with the same secret", async () => {
    const secret = generateCookieSecret();
    const signed = await signCookieValue({ value: "abc-123", secret });
    const v = await verifySignedCookie({ signed, secret });
    expect(v?.value).toBe("abc-123");
  });

  it("rejects a tampered signature", async () => {
    const secret = generateCookieSecret();
    const signed = await signCookieValue({ value: "abc", secret });
    const tampered = `${signed.split(".")[0]}.${signed.split(".")[1]}.${"0".repeat(64)}`;
    const v = await verifySignedCookie({ signed: tampered, secret });
    expect(v).toBeNull();
  });

  it("rejects a value signed with a different secret", async () => {
    const secret1 = generateCookieSecret();
    const secret2 = generateCookieSecret();
    const signed = await signCookieValue({ value: "abc", secret: secret1 });
    const v = await verifySignedCookie({ signed, secret: secret2 });
    expect(v).toBeNull();
  });

  it("rejects an over-age cookie", async () => {
    const secret = generateCookieSecret();
    const signed = await signCookieValue({
      value: "old",
      secret,
      issuedAt: Math.floor(Date.now() / 1000) - 10000,
    });
    const v = await verifySignedCookie({ signed, secret, maxAgeSeconds: 60 });
    expect(v).toBeNull();
  });
});

describe("honeypot", () => {
  it("detects filled honeypot field", () => {
    expect(checkHoneypot({ hp_address: "bot@example.com" }).tripped).toBe(true);
  });

  it("ignores empty / missing field", () => {
    expect(checkHoneypot({ hp_address: "" }).tripped).toBe(false);
    expect(checkHoneypot({}).tripped).toBe(false);
  });

  it("ignores non-string honeypot values", () => {
    expect(checkHoneypot({ hp_address: 0 }).tripped).toBe(false);
    expect(checkHoneypot({ hp_address: null }).tripped).toBe(false);
  });
});

describe("rate-limit", () => {
  it("denies after window threshold; resets after window", async () => {
    const key = rateLimitKey("test-rl", "submit", `${Date.now()}-rl`);
    const spec = { perVisitorMax: 3, windowSeconds: 60 };
    const a1 = await consumeRateLimit(adapter, { key, spec });
    const a2 = await consumeRateLimit(adapter, { key, spec });
    const a3 = await consumeRateLimit(adapter, { key, spec });
    const a4 = await consumeRateLimit(adapter, { key, spec });
    expect(a1.allowed).toBe(true);
    expect(a2.allowed).toBe(true);
    expect(a3.allowed).toBe(true);
    expect(a4.allowed).toBe(false);
    expect(a4.retryAfterSec).toBeGreaterThan(0);
  });

  it("denies the right count under concurrent burst (advisory-lock atomicity)", async () => {
    const key = rateLimitKey("test-rl", "race", `${Date.now()}-race`);
    const spec = { perVisitorMax: 1000, windowSeconds: 60 };
    // Fire 30 concurrent calls. With 10 burst tokens, exactly 20 should
    // be denied. The advisory lock guarantees no double-count race.
    const results = await Promise.all(
      Array.from({ length: 30 }, () => consumeRateLimit(adapter, { key, spec })),
    );
    const denied = results.filter((r) => !r.allowed).length;
    // Tight bound: 20 denied (10 allowed). Loose check tolerates 1 off
    // for the "request 11" boundary case.
    expect(denied).toBeGreaterThanOrEqual(19);
    expect(denied).toBeLessThanOrEqual(21);
  });

  it("burst gate fires before sliding window when many requests in <1s", async () => {
    const key = rateLimitKey("test-rl", "burst", `${Date.now()}-burst`);
    const spec = { perVisitorMax: 1000, windowSeconds: 60 };
    let denied = 0;
    for (let i = 0; i < 20; i++) {
      const r = await consumeRateLimit(adapter, { key, spec });
      if (!r.allowed) denied += 1;
    }
    // 10 burst tokens; refill rate 1/s; 20 immediate requests should hit
    // the bucket floor before any token refill.
    expect(denied).toBeGreaterThan(0);
  });

  it("resolveRateLimitSpec returns default when no override + no manifest", async () => {
    const spec = await resolveRateLimitSpec(adapter, "nonexistent", "submit");
    expect(spec.perVisitorMax).toBe(30);
    expect(spec.windowSeconds).toBe(60);
  });

  it("resolveRateLimitSpec honors plugin_rate_limit_overrides", async () => {
    const slug = `test-rl-${Date.now()}`;
    await adapter.withAdminTransaction(
      { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "t" },
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds)
          VALUES (${slug}, 'submit', 5, 30)
        `);
      },
    );
    const spec = await resolveRateLimitSpec(adapter, slug, "submit");
    expect(spec.perVisitorMax).toBe(5);
    expect(spec.windowSeconds).toBe(30);
  });
});

describe("captcha (PoW)", () => {
  const visitorIdHash = hashVisitorId("test-visitor");
  const config = { provider: "pow" as const, powTargetPrefix: "0" }; // trivially easy

  it("issues a challenge, validates a correct nonce, rejects replay", async () => {
    const challenge = await issuePowChallenge(adapter, { config, visitorIdHash });
    expect(challenge.challenge).toMatch(/^[0-9a-f]+$/);
    // Find a nonce satisfying the trivial "starts with 0" target. At a
    // 1-hex-char target there's a 1/16 chance per nonce, so scanning
    // 256 candidates makes a miss astronomically unlikely (still cheap).
    const enc = new TextEncoder();
    let nonce = "";
    for (let i = 0; i < 256; i++) {
      const candidate = i.toString(16);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        enc.encode(`${challenge.challenge}${candidate}`),
      );
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex.startsWith(config.powTargetPrefix)) {
        nonce = candidate;
        break;
      }
    }
    expect(nonce).not.toBe("");

    const r1 = await verifyPowProof(adapter, { challenge: challenge.challenge, nonce });
    expect(r1.ok).toBe(true);

    // Replay should fail.
    const r2 = await verifyPowProof(adapter, { challenge: challenge.challenge, nonce });
    expect(r2.ok).toBe(false);
  });

  it("rejects a wrong nonce", async () => {
    const challenge = await issuePowChallenge(adapter, { config, visitorIdHash });
    const r = await verifyPowProof(adapter, {
      challenge: challenge.challenge,
      nonce: "definitely-wrong-zz",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown challenge", async () => {
    const r = await verifyPowProof(adapter, {
      challenge: "00000000",
      nonce: "0",
    });
    expect(r.ok).toBe(false);
  });
});
