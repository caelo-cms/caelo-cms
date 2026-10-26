// SPDX-License-Identifier: MPL-2.0

/**
 * What the running plugins ask visitors to consent to.
 *
 * A plugin declares its purposes in its manifest (`consentPurposes`); this
 * module reads them off the plugins THIS host has loaded and not disabled,
 * so the answer is "what runs here", never "what is installed". The admin
 * host and the gateway's dispatch-only host each answer from their own
 * registry — the gateway's mirrors what the admin published as active
 * (gateway-attach.ts), so no declaration crosses from cms_public to the
 * admin or the other way (CLAUDE.md §2, #635).
 *
 * The pluginSlug on each entry is the host's: the slug the plugin was
 * loaded under. A plugin cannot put a declaration in another plugin's name.
 */

import type { DeclaredConsentPurpose, PluginConsentPurposes } from "@caelo-cms/plugin-sdk";
import { isPluginDisabled, loadedPlugins } from "./dispatch.js";

/**
 * The consent purposes every loaded, enabled plugin declares, ordered by
 * plugin slug then declaration order. Deep-frozen copies: a consumer
 * cannot change what the next one reads.
 */
export function declaredConsentPurposes(): ReadonlyArray<DeclaredConsentPurpose> {
  const out: DeclaredConsentPurpose[] = [];
  const plugins = [...loadedPlugins.all()].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const plugin of plugins) {
    if (isPluginDisabled(plugin.slug)) continue;
    for (const p of plugin.definition.consentPurposes ?? []) {
      out.push(
        Object.freeze({
          pluginSlug: plugin.slug,
          key: p.key,
          category: p.category,
          purpose: p.purpose,
          cookies: Object.freeze(
            p.cookies.map((c) =>
              Object.freeze({ name: c.name, lifetime: c.lifetime, purpose: c.purpose }),
            ),
          ),
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** Whether some loaded, enabled plugin declares the purpose `key`. */
export function consentPurposeDeclared(key: string): boolean {
  return declaredConsentPurposes().some((p) => p.key === key);
}

/** The `ctx.consentPurposes` handle (capability `consent_provider`). */
export function makePluginConsentPurposes(): PluginConsentPurposes {
  return Object.freeze({
    list: async () => declaredConsentPurposes(),
  });
}
