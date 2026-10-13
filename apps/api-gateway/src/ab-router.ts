// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — client-side A/B variant routing.
 *
 * Three endpoints:
 *   GET  /api/variant.js                 — small inline script the static
 *                                           page loads. Once the visitor
 *                                           consented, asks the gateway
 *                                           for their variant, then swaps
 *                                           the page's <main>.
 *   POST /api/variant/assign             — checks consent (#674), picks
 *                                           the variant from the
 *                                           gateway-verified visitor id
 *                                           and records the impression via
 *                                           experiments.record_assignment.
 *   POST /api/variant/forget             — expires the visitor cookie
 *                                           when consent is withdrawn.
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

import { type ConsentGate, consentGranted } from "@caelo-cms/edge-router";
import {
  MAIN_RENDER,
  resolveVisitorConsentGate,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
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
 *
 * ## Consent first (#674)
 *
 * The script sends nothing until the site's consent provider says the
 * visitor agreed to A/B testing (`window.caeloConsent.allows("ab_testing")`,
 * which the consent manager's runtime answers from the visitor's
 * recorded decision). Until then the visitor sees the page as served —
 * the control — and no request, cookie or impression exists.
 *
 * Consent given on this page starts the test on this same page view
 * (`caelo:consent` event): the page that prompted the decision is the
 * one the experiment is about, and waiting for the next view would drop
 * every visitor who agrees and leaves, skewing the sample towards
 * visitors who browse on. Withdrawing consent asks the gateway to expire
 * the visitor cookie and reloads a swapped page back to the control.
 *
 * The gateway enforces the same rule on its own (it never trusts this
 * script): an assignment request without a current consent cookie is
 * refused and any visitor cookie it carries is expired.
 */
export const VARIANT_SCRIPT = `
(() => {
  const tag = document.currentScript;
  if (!tag) return;
  const exp = tag.getAttribute("data-experiment");
  const page = tag.getAttribute("data-page");
  if (!exp || !page) return;
  const PURPOSE = "ab_testing";
  let assigned = false;
  let swapped = false;

  function consentApi() {
    const api = window.caeloConsent;
    return api && typeof api.allows === "function" ? api : null;
  }

  function allowed() {
    const api = consentApi();
    return api !== null && api.allows(PURPOSE) === true;
  }

  function assign() {
    if (assigned) return;
    assigned = true;
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
        if (oldMain && newMain) {
          oldMain.replaceWith(newMain);
          swapped = true;
        }
      })
      .catch(() => undefined);
  }

  function forget() {
    assigned = false;
    // keepalive: the consent runtime may reload the page right after a
    // withdrawal, and the expiry must still reach the gateway.
    fetch("/api/variant/forget", { method: "POST", credentials: "same-origin", keepalive: true })
      .catch(() => undefined);
    if (swapped) location.reload();
  }

  function start() {
    if (consentApi() === null) {
      console.warn(
        \`[caelo-ab] experiment "\${exp}" is not running: A/B testing needs the visitor's consent and no consent manager runs on this page. Activate the consent manager plugin and place its banner in the site layout.\`,
      );
      return;
    }
    let wasAllowed = allowed();
    if (wasAllowed) assign();
    document.addEventListener("caelo:consent", () => {
      const now = allowed();
      if (now && !wasAllowed) assign();
      else if (!now && wasAllowed) forget();
      wasAllowed = now;
    });
  }

  // The consent runtime may load after this script (it is linked at the
  // end of the page), so decide once the document is parsed.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
`.trim();

/** The purpose core asks the consent provider about before bucketing. */
export const AB_TESTING_PURPOSE = "ab_testing" as const;

const CONSENT_GATE_TTL_MS = 5_000;
let cachedGate: { gate: ConsentGate | null; loadedAt: number } | null = null;

/** Tests: forget the cached consent rule. */
export function invalidateAbConsentGate(): void {
  cachedGate = null;
}

/**
 * The consent provider's rule for A/B testing as it stands now, or null
 * when no running plugin governs it. Cached for as long as the gateway
 * caches its other settings, so a policy bump or a provider switched off
 * reaches visitors within seconds.
 *
 * @throws when the provider fails or answers ill-formed (plugin-host
 *   `resolveVisitorConsentGate`) — the caller refuses the request.
 */
export async function abTestingConsentGate(): Promise<ConsentGate | null> {
  if (cachedGate && Date.now() - cachedGate.loadedAt < CONSENT_GATE_TTL_MS) {
    return cachedGate.gate;
  }
  // The provider's activation reaches the gateway through the registry
  // mirror; refresh it first so a just-activated consent manager counts.
  await syncDispatchPlugins();
  const resolved = await resolveVisitorConsentGate(AB_TESTING_PURPOSE, MAIN_RENDER);
  const gate = resolved
    ? { cookie: resolved.cookie, policyVersion: resolved.policyVersion, category: resolved.category }
    : null;
  cachedGate = { gate, loadedAt: Date.now() };
  return gate;
}

/**
 * Whether this request may be bucketed: `granted` with a current consent
 * cookie, `declined` without one, `no-provider` when nothing on the site
 * can ask the visitor.
 *
 * @param cookies the request's decoded cookies.
 */
export async function abConsentVerdict(
  cookies: Readonly<Record<string, string>>,
): Promise<"granted" | "declined" | "no-provider"> {
  const gate = await abTestingConsentGate();
  if (!gate) return "no-provider";
  return consentGranted(gate, cookies[gate.cookie] ?? null) ? "granted" : "declined";
}

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
