// SPDX-License-Identifier: MPL-2.0

/**
 * Whether a visitor has consented to being recognised by the
 * `caelo_visitor_id` cookie (#677).
 *
 * The API gateway used to mint that cookie on every visitor call — a form
 * submission, a comment, a captcha challenge, even consent-manager's own
 * `record_consent` after the visitor clicked "reject all". A persistent
 * identifier that is not strictly necessary needs prior consent (TTDSG
 * §25(1) / ePrivacy Art. 5(3)). Nothing a visitor asks for depends on it —
 * rate limiting falls back to the client-IP bucket, the captcha proof is a
 * one-time token, forms and comments do not need to know who came back —
 * so it is not strictly necessary, and the gateway may only set it when
 * the visitor granted the category that covers it.
 *
 * ## Who answers
 *
 * Core never asks visitors anything itself. The consent-manager plugin
 * does, and it is the only source of the answer: its runtime writes the
 * decision to the first-party `caelo_consent` cookie as URI-encoded JSON
 * `{granted: string[], policyVersion: number}`, and its
 * `visitor_consent_rule` operation tells core which cookie that is, which
 * policy version is current, and which of its categories covers the
 * visitor id. A decision counts only under the current policy version —
 * the same rule its runtime applies before it re-asks the visitor.
 *
 * FIXME(issue #676): epic #676 PR-D replaces the fixed provider slug
 * below with the declared `visitorConsent` composition point, so any
 * plugin can be the site's consent provider and consumer plugins declare
 * their own purposes. The rule shape here is the one PR-D formalises.
 *
 * ## Privacy by default
 *
 * Everything that is not an unambiguous yes is a no: no provider running,
 * no decision cookie, a garbled one, one from an older policy, or one that
 * does not grant the category. A provider that is running but cannot
 * answer is an error (thrown), never a yes.
 */

import { z } from "zod";
import {
  hostSystemActorId,
  isPluginDisabled,
  loadedPlugins,
  runPluginOperation,
} from "./dispatch.js";

/** The plugin that governs visitor consent until PR-D (#676) makes it declarable. */
export const VISITOR_CONSENT_PROVIDER_SLUG = "consent-manager";

/** The provider operation core reads the rule from. Not visitor-facing. */
export const VISITOR_CONSENT_RULE_OPERATION = "visitor_consent_rule";

/** The purpose key for the gateway's `caelo_visitor_id` cookie. */
export const VISITOR_ID_PURPOSE = "visitor_id";

/** What the provider's `visitor_consent_rule` operation returns. */
export const visitorConsentRule = z
  .object({
    /** Name of the first-party cookie that holds the visitor's decision. */
    cookie: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "a plain cookie name"),
    /** A decision counts only when it carries this version. */
    policyVersion: z.number().int().positive(),
    /** Purpose key → the provider's category that covers it. */
    purposes: z.record(
      z.string().regex(/^[a-z][a-z0-9_]*$/, "a purpose key"),
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_-]*$/, "a category key"),
    ),
  })
  .strict();

export type VisitorConsentRule = z.infer<typeof visitorConsentRule>;

/**
 * Ask the running consent provider for its rule.
 *
 * @returns the rule, or null when no consent provider is running — a site
 *   without one has no way to ask, so nobody has consented.
 * @throws when the provider is running but fails or answers ill-formed.
 */
export async function resolveVisitorConsentRule(): Promise<VisitorConsentRule | null> {
  const slug = VISITOR_CONSENT_PROVIDER_SLUG;
  if (!loadedPlugins.bySlug(slug) || isPluginDisabled(slug)) return null;
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: hostSystemActorId() },
    pluginSlug: slug,
    operationName: VISITOR_CONSENT_RULE_OPERATION,
    args: {},
  });
  if (!r.ok) {
    throw new Error(
      `visitor consent: ${slug}.${VISITOR_CONSENT_RULE_OPERATION} failed (${r.error.kind}): ${r.error.message}`,
    );
  }
  const parsed = visitorConsentRule.safeParse(r.value);
  if (!parsed.success) {
    throw new Error(
      `visitor consent: ${slug}.${VISITOR_CONSENT_RULE_OPERATION} returned an invalid rule: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Whether the visitor's recorded decision grants `purpose` under `rule`.
 *
 * @param rule the provider's rule, or null when no provider runs.
 * @param purpose a purpose key, e.g. {@link VISITOR_ID_PURPOSE}.
 * @param cookies the request's cookies, already decoded.
 * @throws when the provider's rule does not cover `purpose` — the provider
 *   governs consent for the site, so a purpose it never classified is a
 *   wiring error, not a silent no.
 */
export function visitorConsentGranted(
  rule: VisitorConsentRule | null,
  purpose: string,
  cookies: Readonly<Record<string, string>>,
): boolean {
  if (!rule) return false;
  const category = rule.purposes[purpose];
  if (!category) {
    throw new Error(
      `visitor consent: ${VISITOR_CONSENT_PROVIDER_SLUG} does not classify the "${purpose}" purpose under any of its categories`,
    );
  }
  const raw = cookies[rule.cookie];
  if (!raw) return false;
  let decision: unknown;
  try {
    decision = JSON.parse(raw);
  } catch {
    // A decision we cannot read is a decision we do not have.
    return false;
  }
  if (!decision || typeof decision !== "object") return false;
  const { granted, policyVersion } = decision as { granted?: unknown; policyVersion?: unknown };
  if (policyVersion !== rule.policyVersion) return false;
  return Array.isArray(granted) && granted.includes(category);
}
