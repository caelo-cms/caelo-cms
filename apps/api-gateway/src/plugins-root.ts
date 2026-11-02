// SPDX-License-Identifier: MPL-2.0

import { resolve } from "node:path";

/**
 * Absolute path to the `packages/plugins` directory the gateway loads
 * release-signed plugins from.
 *
 * Resolved from this module's own directory, so it holds both for the
 * TypeScript source (`apps/api-gateway/src/`) and for the image's bundle
 * (`apps/api-gateway/dist/`, issue #1327): the two sit at the same depth,
 * and the image keeps the plugins at `packages/plugins` under the same root.
 */
export const GATEWAY_PLUGINS_ROOT = resolve(import.meta.dir, "../../../packages/plugins");
