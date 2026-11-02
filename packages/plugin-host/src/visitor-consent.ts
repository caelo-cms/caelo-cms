// SPDX-License-Identifier: MPL-2.0

/**
 * Whether a visitor has consented to a declared purpose — today the one
 * core acts on: being recognised by a visitor id in the gateway's
 * `__session` cookie (#677).
 *
 * A persistent identifier that is not strictly necessary needs prior
 * consent (TTDSG §25(1) / ePrivacy Art. 5(3)). Core itself needs no
 * visitor id — rate limits are keyed by client address and a captcha
 * proof by its single use — so the gateway sets the id only for a
 * plugin that declares the `visitor_id` purpose in its manifest
 * (`consentPurposes`), and only when the visitor granted the category
 * that declaration names.
 *
 * ## Who answers
 *
 * Core never asks visitors anything itself. The consent-manager plugin
 * does, and it is the only source of the answer. Its runtime keeps the
 * decision in its own first-party cookie (the banner reads it back), and
 * sends it to the gateway in the {@link VISITOR_CONSENT_HEADER} request
 * header, as do the component kit's gateway calls (#1343): the gateway
 * reads no consent cookie, because behind Firebase Hosting none reaches
 * it. Its `visitor_consent_rule` operation tells core which policy
 * version is current and which of its categories covers each purpose. It
 * builds that purpose map from the declarations of the active plugins,
 * which it reads through `ctx.consentPurposes` (capability
 * `consent_provider`). A decision counts only under the current policy
 * version — the same rule its runtime applies before it re-asks the
 * visitor.
 *
 * The header is no weaker than the cookie it replaces: both are written
 * by the page's own script, and neither is more than the visitor's say-so.
 * A cross-site page cannot set the header at all (a custom header needs a
 * CORS preflight the gateway never grants), where it could make the
 * browser send the cookie.
 *
 * FIXME(issue #676): epic #676 PR-D replaces the fixed provider slug
 * below with the declared `visitorConsent` composition point, so any
 * plugin can be the site's consent provider.
 *
 * ## Privacy by default
 *
 * Everything that is not an unambiguous yes is a no: no provider running,
 * no decision header, a garbled one, one from an older policy, or one that
 * does not grant the category. A provider that is running but cannot
 * answer is an error (thrown), never a yes.
 */

import { VISITOR_CONSENT_HEADER, VISITOR_ID_PURPOSE_KEY } from "@caelo-cms/plugin-sdk";
import { z } from "zod";
import {
  hostSystemActorId,
  isPluginDisabled,
  loadedPlugins,
  runPluginOperation,
} from "./dispatch.js";

export { VISITOR_CONSENT_HEADER };

/** The plugin that governs visitor consent until PR-D (#676) makes the provider declarable. */
export const VISITOR_CONSENT_PROVIDER_SLUG = "consent-manager";

/** The provider operation core reads the rule from. Not visitor-facing. */
export const VISITOR_CONSENT_RULE_OPERATION = "visitor_consent_rule";

/** The purpose key for the gateway's visitor id. */
export const VISITOR_ID_PURPOSE = VISITOR_ID_PURPOSE_KEY;

const categoryKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, "a category key");

/** What the provider's `visitor_consent_rule` operation returns. */
export const visitorConsentRule = z
  .object({
    /** A decision counts only when it carries this version. */
    policyVersion: z.number().int().positive(),
    /** Purpose key → the provider's category that covers it, one entry per
     *  purpose an active plugin declares. */
    purposes: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/, "a purpose key"), categoryKey),
  })
  .strict();

export type VisitorConsentRule = z.infer<typeof visitorConsentRule>;

/** A decision as the {@link VISITOR_CONSENT_HEADER} carries it. */
export interface VisitorConsentDecision {
  readonly policyVersion: number;
  readonly granted: readonly string[];
}

const HEADER_RE = /^v=(\d{1,9});\s*granted=([a-z0-9_,-]{0,1024})$/;

/**
 * Parse a {@link VISITOR_CONSENT_HEADER} value (`v=3; granted=a,b`).
 *
 * @returns the decision, or null for anything else — the header is
 *   visitor-controlled, and a decision we cannot read is one we do not
 *   have.
 */
export function parseVisitorConsentHeader(value: string | null): VisitorConsentDecision | null {
  if (!value) return null;
  const m = HEADER_RE.exec(value.trim());
  if (!m?.[1] || m[2] === undefined) return null;
  const granted = m[2] === "" ? [] : m[2].split(",");
  if (granted.length > 32 || !granted.every((k) => categoryKey.safeParse(k).success)) return null;
  const policyVersion = Number(m[1]);
  if (policyVersion < 1) return null;
  return { policyVersion, granted };
}

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
 * Whether the visitor's decision grants `purpose` under `rule`.
 *
 * @param rule the provider's rule, or null when no provider runs.
 * @param purpose a purpose key, e.g. {@link VISITOR_ID_PURPOSE}.
 * @param decisionHeader the request's {@link VISITOR_CONSENT_HEADER}
 *   value, or null when the request carries none.
 * @throws when the provider's rule does not cover `purpose` — callers ask
 *   only about a purpose an active plugin declares, and the provider
 *   classifies every declaration, so a gap is a wiring error, not a
 *   silent no.
 */
export function visitorConsentGranted(
  rule: VisitorConsentRule | null,
  purpose: string,
  decisionHeader: string | null,
): boolean {
  if (!rule) return false;
  const category = rule.purposes[purpose];
  if (!category) {
    throw new Error(
      `visitor consent: ${VISITOR_CONSENT_PROVIDER_SLUG} does not classify the "${purpose}" purpose under any of its categories`,
    );
  }
  const decision = parseVisitorConsentHeader(decisionHeader);
  if (!decision || decision.policyVersion !== rule.policyVersion) return false;
  return decision.granted.includes(category);
}
