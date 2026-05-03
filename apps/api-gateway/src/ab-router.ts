// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — client-side A/B variant routing.
 *
 * Two endpoints:
 *   GET  /api/variant.js                 — small inline script the static
 *                                           page loads. Reads the
 *                                           `caelo_visitor_id` cookie,
 *                                           computes a stable hash, picks
 *                                           a variant, posts an
 *                                           assignment, swaps the body.
 *   POST /api/variant/assign             — records the assignment via
 *                                           experiments.record_assignment.
 *
 * Self-hosted Caddy / Nginx serves plain files; client-side routing
 * keeps the static stack vendor-neutral. P15 cloud adapters add
 * provider-specific edge rules that bypass the client-side hop.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";
import { execute } from "@caelo/query-api";

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
  const cookie = document.cookie
    .split(/;\\s*/)
    .map((s) => s.split("="))
    .reduce((a, [k, v]) => ((a[k] = decodeURIComponent(v ?? "")), a), {});
  const signedVisitor = cookie["caelo_visitor_id"] ?? "";
  const visitorId = signedVisitor.split(".")[0];
  if (!visitorId) return;
  fetch(\`/api/variant/assign?exp=\${encodeURIComponent(exp)}\`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorId, page }),
  })
    .then((r) => r.json())
    .then((env) => {
      if (!env.ok || !env.data || !env.data.variant) return;
      const variant = env.data.variant;
      const url = \`/_variants/\${exp}__\${variant}\${page}\`;
      return fetch(url, { credentials: "same-origin" });
    })
    .then((res) => (res ? res.text() : null))
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

interface AssignmentBody {
  visitorId: string;
  page: string;
}

interface ExperimentRow {
  id: string;
  variants: Array<{ label: string; weight: number }>;
  status: string;
}

export async function handleVariantAssign(args: {
  adapter: DatabaseAdapter;
  registry: OperationRegistry;
  expSlug: string;
  body: AssignmentBody;
  visitorIdHash: string;
}): Promise<{ ok: true; variant: string | null } | { ok: false; reason: string }> {
  if (typeof args.body.visitorId !== "string" || !args.body.visitorId) {
    return { ok: false, reason: "visitorId required" };
  }
  // Fetch the experiment via the list op + filter (cheap; few experiments).
  const r = await execute(args.registry, args.adapter, SYSTEM_CTX, "experiments.list", {
    status: "active",
  });
  if (!r.ok) return { ok: false, reason: "could not load experiments" };
  const list = (r.value as { experiments: Array<ExperimentRow & { slug: string }> }).experiments;
  const exp = list.find((e) => e.slug === args.expSlug);
  if (!exp) return { ok: false, reason: "no active experiment" };
  const variant = pickVariant(args.body.visitorId, args.expSlug, exp.variants);
  if (!variant) return { ok: false, reason: "no variant resolved" };
  // Best-effort assignment record.
  try {
    await execute(args.registry, args.adapter, SYSTEM_CTX, "experiments.record_assignment", {
      experimentId: exp.id,
      variantLabel: variant,
      visitorIdHash: args.visitorIdHash,
    });
  } catch {
    // best-effort
  }
  return { ok: true, variant };
}
