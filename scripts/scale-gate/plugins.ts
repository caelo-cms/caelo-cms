// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1390 — every plugin shipped in `packages/plugins/`, in the order
 * the fixture activates them (a plugin after the ones it `requiresPlugins`).
 * The gate runs with all of them active: their change consumers, workers
 * and render hooks add load, and a plugin left out adds load the gate
 * cannot see. `scripts/scale-gate-workflow.test.ts` fails when a directory under
 * `packages/plugins/` is missing here.
 */

import authPlugin from "@caelo-cms/plugin-auth";
import commentsPlugin from "@caelo-cms/plugin-comments";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import formsPlugin from "@caelo-cms/plugin-forms";
import intlPlugin from "@caelo-cms/plugin-international-site";
import newsletterPlugin from "@caelo-cms/plugin-newsletter";
import ratingsPlugin from "@caelo-cms/plugin-ratings";

/** The shipped plugins, dependencies first (ratings requires consent-manager). */
export const SHIPPED_PLUGINS = [
  intlPlugin,
  consentPlugin,
  authPlugin,
  commentsPlugin,
  formsPlugin,
  newsletterPlugin,
  ratingsPlugin,
] as const;

/** Their slugs. */
export const SHIPPED_PLUGIN_SLUGS: readonly string[] = SHIPPED_PLUGINS.map((p) => p.slug);

/** The slugs of the plugins that declare a change consumer (#1267). */
export const CHANGE_CONSUMER_SLUGS: readonly string[] = SHIPPED_PLUGINS.filter(
  (p) => "changeConsumer" in p && p.changeConsumer !== undefined,
).map((p) => p.slug);

/** Plugins whose component the fixture places on pages (`data-caelo-plugin` placeholders). */
export const COMPONENT_PLUGIN_SLUGS: readonly string[] = SHIPPED_PLUGINS.filter(
  (p) => "component" in p && p.component !== undefined,
).map((p) => p.slug);
