// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — gateway-side honeypot evict.
 *
 * Component-kit injects a hidden `hp_address` field. Bots fill it; real
 * users don't. The forms plugin already handles this at the op level
 * (marks status='spam'); here we evict at the EDGE so spam bursts don't
 * touch the DB or the rate-limit bucket — saves a tx + an audit row per
 * trapped request.
 *
 * The response is a 200 OK with `{ok: true}` so the bot doesn't notice
 * and doesn't retry. No secret is leaked: an honest client never trips
 * this branch because the field is `position: -9999px` + autocomplete=off
 * + no real label.
 */

export const HONEYPOT_FIELD = "hp_address";

export interface HoneypotResult {
  readonly tripped: boolean;
}

export function checkHoneypot(body: unknown): HoneypotResult {
  if (!body || typeof body !== "object") return { tripped: false };
  const v = (body as Record<string, unknown>)[HONEYPOT_FIELD];
  if (typeof v !== "string") return { tripped: false };
  return { tripped: v.trim() !== "" };
}
