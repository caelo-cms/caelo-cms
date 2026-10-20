// SPDX-License-Identifier: MPL-2.0

/**
 * Per-client-address throttling of the remote-MCP routes (issue #806
 * follow-up, CLAUDE.md §7: public writes are rate limited).
 *
 * Why in-process token buckets instead of the gateway's Postgres buckets
 * (middleware/rate-limit.ts): the MCP router deliberately runs before, and
 * without, the database (routes.ts) — remote MCP must answer when the
 * gateway's settings are unavailable, and a proxied MCP session would
 * otherwise cost a database round trip per JSON-RPC message. The trade-off
 * is that each gateway instance counts on its own, so the effective limit
 * is the per-instance limit times the instance count; Cloud Run's maximum
 * instance count bounds that. The limits exist to stop one address from
 * hammering Google's token endpoint, the CIMD hosts or the admin through
 * this gateway — which matters most on gcp-firebase, where the gateway is
 * reachable directly on *.run.app with no WAF in front (§11.B Tier 3) —
 * not to meter fair use, so per-instance precision is enough.
 *
 * The address comes from the gateway's one client-address rule
 * (client-ip.ts), the same one every other rate limit uses.
 */

/** One bucket class: `capacity` requests at once, refilled to full over `windowSeconds`. */
export interface BucketSpec {
  readonly capacity: number;
  readonly windowSeconds: number;
}

/** The route classes and their per-address limits. */
export const MCP_RATE_LIMITS = {
  /** The consent page and its Approve/Deny: a person clicks through a few times. */
  authorize: { capacity: 30, windowSeconds: 60 },
  /** Google's redirect back; one per sign-in. */
  callback: { capacity: 30, windowSeconds: 60 },
  /** Code exchange and refresh: each one is a call to Google. */
  token: { capacity: 30, windowSeconds: 60 },
  /** Stateless DCR: a client registers once per connection. */
  register: { capacity: 10, windowSeconds: 60 },
  /** Discovery documents and the setup self-check: cheap, probed per connection. */
  metadata: { capacity: 120, windowSeconds: 60 },
  /** MCP JSON-RPC messages: an agent runs many tool calls in a row. */
  proxy: { capacity: 600, windowSeconds: 60 },
} as const satisfies Record<string, BucketSpec>;

export type McpRateClass = keyof typeof MCP_RATE_LIMITS;

/** Buckets kept before idle ones are swept (bounds memory under an address-rotating flood). */
const MAX_BUCKETS = 50_000;

interface Bucket {
  tokens: number;
  at: number;
}

/** Outcome of one take. */
export type TakeResult = { readonly ok: true } | { readonly ok: false; retryAfterSeconds: number };

/** Token buckets keyed by (route class, client address). One per router. */
export class McpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly nowMs: () => number,
    private readonly limits: Record<McpRateClass, BucketSpec> = MCP_RATE_LIMITS,
  ) {}

  /** Spend one request of `cls` for `address`. */
  take(cls: McpRateClass, address: string): TakeResult {
    const spec = this.limits[cls];
    const refillPerMs = spec.capacity / (spec.windowSeconds * 1000);
    const now = this.nowMs();
    const key = `${cls}\u0000${address}`;
    const b = this.buckets.get(key);
    const tokens = b
      ? Math.min(spec.capacity, b.tokens + (now - b.at) * refillPerMs)
      : spec.capacity;
    if (tokens < 1) {
      if (b) {
        b.tokens = tokens;
        b.at = now;
      }
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)),
      };
    }
    if (!b && this.buckets.size >= MAX_BUCKETS) this.sweep(now);
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return { ok: true };
  }

  /** Drop buckets that have refilled completely (they carry no state). */
  private sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      const cls = key.slice(0, key.indexOf("\u0000")) as McpRateClass;
      const spec = this.limits[cls];
      if (
        b.tokens + (now - b.at) * (spec.capacity / (spec.windowSeconds * 1000)) >=
        spec.capacity
      ) {
        this.buckets.delete(key);
      }
    }
    // Still full: every bucket is mid-window. Forget the oldest half rather
    // than grow without bound; those addresses start over with a full bucket.
    if (this.buckets.size >= MAX_BUCKETS) {
      let n = Math.floor(this.buckets.size / 2);
      for (const key of this.buckets.keys()) {
        if (n-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }
}
