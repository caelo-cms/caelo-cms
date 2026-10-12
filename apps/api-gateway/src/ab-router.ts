// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — client-side A/B variant routing.
 *
 * Two endpoints:
 *   GET  /api/variant.js                 — small inline script the static
 *                                           page loads. Asks the gateway
 *                                           for this visitor's variant,
 *                                           then swaps the page's <main>.
 *   POST /api/variant/assign             — picks the variant from the
 *                                           gateway-verified visitor id
 *                                           and records the impression via
 *                                           experiments.record_assignment.
 *
 * ## The visitor id never reaches the script (#649)
 *
 * `caelo_visitor_id` is a signed, HttpOnly cookie: page script cannot
 * read it, by design, so a script that keyed on it could never run. The
 * browser sends it with the same-origin POST; the gateway verifies the
 * signature, buckets on the verified id, records the impression under
 * that same id's hash, and mints the cookie for a first-time visitor.
 * One id decides both the variant and the count, and no client-supplied
 * value can steer either.
 *
 * Self-hosted Caddy / Nginx serves plain files; client-side routing
 * keeps the static stack vendor-neutral. P15 cloud adapters add
 * provider-specific edge rules that bypass the client-side hop.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "ab-router",
};

/** Stable variant selection given a visitor id + experiment slug. */
export function pickVariant(
  visitorId: string,
  experimentSlug: string,
  variants: ReadonlyArray<{ label: string; weight: number }>,
): string | null {
  if (variants.length === 0) return null;
  // FNV-1a 32-bit over (visitor + slug) — cheap, deterministic, no deps.
  let h = 0x811c9dc5;
  const s = `${visitorId}:${experimentSlug}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const r = (h >>> 0) / 0xffffffff; // 0..1
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (r <= acc) return v.label;
  }
  return variants[variants.length - 1]?.label ?? null;
}

/**
 * Inline script served at /api/variant.js. The host page includes:
 *   <script src="/api/variant.js"
 *           data-experiment="hero-cta-test"
 *           data-page="/blog/spring-launch"></script>
 */
export const VARIANT_SCRIPT = `
(() => {
  const tag = document.currentScript;
  if (!tag) return;
  const exp = tag.getAttribute("data-experiment");
  const page = tag.getAttribute("data-page");
  if (!exp || !page) return;
  // No body: the gateway reads the visitor from the HttpOnly cookie the
  // browser attaches (and sets it on a first visit), so the variant is
  // stable across reloads without the script ever seeing the id.
  fetch(\`/api/variant/assign?exp=\${encodeURIComponent(exp)}\`, {
    method: "POST",
    credentials: "same-origin",
  })
    .then((r) => r.json())
    .then((env) => {
      if (!env.ok || !env.data || !env.data.variant) return;
      const variant = env.data.variant;
      const url = \`/_variants/\${exp}__\${variant}\${page}\`;
      return fetch(url, { credentials: "same-origin" });
    })
    .then((res) => (res && res.ok ? res.text() : null))
    .then((html) => {
      if (!html) return;
      // Swap the body's main element only — keep <head> + scripts.
      const next = new DOMParser().parseFromString(html, "text/html");
      const oldMain = document.querySelector("main") ?? document.body;
      const newMain = next.querySelector("main") ?? next.body;
      if (oldMain && newMain) oldMain.replaceWith(newMain);
    })
    .catch(() => undefined);
})();
`.trim();

interface AssignmentVariant {
  label: string;
  weight: number;
}

/**
 * Pick and record a visitor's variant for one active experiment. Runs the
 * gateway's own operations (plugin-host gateway-ops.ts) as the system
 * actor; `gateway_role` may read only active experiments' assignment
 * columns and append impressions (migration 0252).
 *
 * @param args.visitor the id the gateway verified from (or minted for)
 *   the signed `caelo_visitor_id` cookie, plus its hash. The id buckets,
 *   the hash keys the impression row — both from the same visitor.
 */
export async function handleVariantAssign(args: {
  adapter: DatabaseAdapter;
  registry: OperationRegistry;
  expSlug: string;
  visitor: { visitorId: string; visitorIdHash: string };
}): Promise<{ ok: true; variant: string | null } | { ok: false; reason: string }> {
  const r = await execute(args.registry, args.adapter, SYSTEM_CTX, "experiments.get_active", {
    slug: args.expSlug,
  });
  if (!r.ok) {
    // A malformed slug is the caller's mistake; anything else is ours.
    if (r.error.kind === "ValidationFailed") return { ok: false, reason: "invalid experiment" };
    console.error(`[api-gateway] experiments.get_active failed: ${r.error.kind}`);
    return { ok: false, reason: "could not load experiments" };
  }
  const exp = (r.value as { experiment: { id: string; variants: AssignmentVariant[] } | null })
    .experiment;
  if (!exp) return { ok: false, reason: "no active experiment" };
  const variant = pickVariant(args.visitor.visitorId, args.expSlug, exp.variants);
  if (!variant) return { ok: false, reason: "no variant resolved" };
  // The visitor still gets the variant when the impression cannot be
  // counted, but the lost count is logged, never swallowed.
  const recorded = await execute(
    args.registry,
    args.adapter,
    SYSTEM_CTX,
    "experiments.record_assignment",
    { experimentId: exp.id, variantLabel: variant, visitorIdHash: args.visitor.visitorIdHash },
  );
  if (!recorded.ok) {
    console.error(`[api-gateway] experiments.record_assignment failed: ${recorded.error.kind}`);
  }
  return { ok: true, variant };
}
