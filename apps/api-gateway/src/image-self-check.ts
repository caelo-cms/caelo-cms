// SPDX-License-Identifier: MPL-2.0

/**
 * `bun apps/api-gateway/dist/image-self-check.js` — the gateway image's
 * plugin-runtime self-check (issue #1327), run by the image's CI smoke.
 *
 * Needs no database and no network: it verifies every plugin the image
 * ships and runs one probe through the Deno sandbox
 * (`checkPluginRuntime`, plugin-host). Prints the report as one JSON line
 * and exits non-zero when anything failed, so a gateway image whose
 * plugins would not load never reaches a registry.
 */

import { checkPluginRuntime } from "@caelo-cms/plugin-host";
import { GATEWAY_PLUGINS_ROOT } from "./plugins-root.js";

if (import.meta.main) {
  const report = await checkPluginRuntime({ pluginsRoot: GATEWAY_PLUGINS_ROOT });
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
