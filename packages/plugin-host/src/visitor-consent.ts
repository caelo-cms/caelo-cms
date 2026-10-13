// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor-consent composition point (#674).
 *
 * Some core features track visitors — A/B testing stores an identifier on
 * the visitor's device and counts what they were shown — and may only run
 * with the visitor's consent. Core does not ask visitors anything itself;
 * a plugin declaring `visitorConsent` does (the consent-manager ships
 * one). This module is the one place core learns, for a purpose, which
 * cookie holds the visitor's decision, which policy version counts and
 * which of the provider's categories covers the purpose.
 *
 * Callers: the API gateway before every A/B assignment, and the static
 * build for the edge routers' `ab-routing.json`. Both then apply the
 * same pure check (`@caelo-cms/edge-router` `consentGranted`).
 *
 * Loud, per CLAUDE.md §2: a failing provider operation, an ill-formed
 * rule, a provider that does not cover the purpose it claimed, and two
 * providers claiming one site all throw. "No provider" is the one
 * answer that is not an error here — it is returned as `null` so each
 * caller can refuse in its own words (the gateway refuses the request,
 * the build refuses to ship active experiments).
 */

import { type VisitorConsentPurpose, visitorConsentRule } from "@caelo-cms/plugin-sdk";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";

/**
 * The provider's rule for one purpose. Structurally the edge router's
 * `ConsentGate`, plus who answered.
 */
export interface ResolvedConsentGate {
  readonly pluginSlug: string;
  readonly cookie: string;
  readonly policyVersion: number;
  readonly category: string;
}

/** Slugs of the running plugins that govern `purpose`, sorted. */
export function visitorConsentProviders(purpose: VisitorConsentPurpose): string[] {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => lp.definition.visitorConsent?.purposes.includes(purpose) === true)
    .map((lp) => lp.slug)
    .sort();
}

/**
 * Ask the site's consent provider for `purpose`'s rule.
 *
 * @returns the rule, or null when no running plugin governs the purpose.
 * @throws when the provider fails, answers ill-formed, or two plugins
 *   claim the purpose.
 */
export async function resolveVisitorConsentGate(
  purpose: VisitorConsentPurpose,
  scope: RenderScope,
): Promise<ResolvedConsentGate | null> {
  const providers = visitorConsentProviders(purpose);
  if (providers.length === 0) return null;
  if (providers.length > 1) {
    // Honouring either would let the visitor satisfy one banner and be
    // tracked under a decision the other one never asked for.
    throw new Error(
      `visitor consent: ${providers.map((s) => `"${s}"`).join(" and ")} both govern "${purpose}". A site can have one consent provider — deactivate all but one.`,
    );
  }
  const pluginSlug = providers[0] as string;
  const plugin = loadedPlugins.bySlug(pluginSlug);
  const operationName = plugin?.definition.visitorConsent?.operation;
  if (!operationName) {
    throw new Error(`visitor consent: provider "${pluginSlug}" is no longer loaded`);
  }
  const r = await runPluginOperation({
    invocation: renderInvocation(scope),
    pluginSlug,
    operationName,
    args: {},
  });
  if (!r.ok) {
    throw new Error(
      `visitor consent: ${pluginSlug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
    );
  }
  const parsed = visitorConsentRule.safeParse(r.value);
  if (!parsed.success) {
    throw new Error(
      `visitor consent: ${pluginSlug}.${operationName} returned an invalid rule: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const category = parsed.data.purposes[purpose];
  if (!category) {
    throw new Error(
      `visitor consent: "${pluginSlug}" declares it governs "${purpose}" but its rule names no category for it`,
    );
  }
  return {
    pluginSlug,
    cookie: parsed.data.cookie,
    policyVersion: parsed.data.policyVersion,
    category,
  };
}
