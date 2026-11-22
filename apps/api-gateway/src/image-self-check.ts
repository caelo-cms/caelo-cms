// SPDX-License-Identifier: MPL-2.0

/**
 * `bun apps/api-gateway/dist/image-self-check.js` — the gateway image's
 * plugin-runtime self-check (issue #1327), run by the image's CI smoke.
 *
 * Needs no database and no network: it verifies the signature of every
 * plugin manifest the image ships against its trust root
 * (`checkShippedManifests`, plugin-host). #1340 — the image runs no plugin
 * code, so there is no sandbox to probe. Prints the report as one JSON
 * line and exits non-zero when anything failed, so a gateway image whose
 * plugins would not attach never reaches a registry.
 */

import { checkShippedManifests } from "@caelo-cms/plugin-host/gateway";
import { GATEWAY_PLUGINS_ROOT } from "./plugins-root.js";

if (import.meta.main) {
  const report = await checkShippedManifests(GATEWAY_PLUGINS_ROOT);
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
