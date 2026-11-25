// SPDX-License-Identifier: MPL-2.0

/**
 * `bun apps/api-gateway/dist/image-self-check.js` — the gateway image's
 * self-check (issue #1327), run by the image's CI smoke.
 *
 * Needs no database and no network:
 *
 *   - it verifies the signature of every plugin manifest the image ships
 *     against its trust root (`checkShippedManifests`, plugin-host). #1340 —
 *     the image runs no plugin code, so there is no sandbox to probe;
 *   - #1650 — every catalog model embeds a probe query on the bundled
 *     WebAssembly runtime, which loads its build from CAELO_ORT_WASM_DIR and
 *     the model from CAELO_MODELS_DIR, as a semantic search does
 *     (`checkEmbedders`, @caelo-cms/models).
 *
 * Prints the report as one JSON line and exits non-zero when anything
 * failed, so a gateway image whose plugins would not attach, or whose
 * semantic search could not embed a query, never reaches a registry.
 */

import { checkEmbedders } from "@caelo-cms/models/self-check";
import { createWasmEmbedder } from "@caelo-cms/models/wasm";
import { checkShippedManifests } from "@caelo-cms/plugin-host/gateway";
import { GATEWAY_PLUGINS_ROOT } from "./plugins-root.js";

if (import.meta.main) {
  const plugins = await checkShippedManifests(GATEWAY_PLUGINS_ROOT);
  const embedders = await checkEmbedders({ wasm: (model) => createWasmEmbedder(model) });
  console.log(JSON.stringify({ plugins, embedders }));
  process.exit(plugins.ok && embedders.ok ? 0 : 1);
}
