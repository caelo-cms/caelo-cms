// SPDX-License-Identifier: MPL-2.0

/**
 * The `visitorProjection` declarations of the plugins this image ships,
 * read from their signed `manifest.json` files on disk (issue #635).
 *
 * The migration job runs inside the admin image but loads no plugin code;
 * it still has to publish every declared plugin projection, so a gateway
 * rolled right after the migrations finds what it reads. The manifests are
 * the image's own build artefacts (signed at image build, verified by the
 * plugin loader at boot); only the declaration is taken from them, and
 * {@link assertVisitorProjection} checks every identifier before it can
 * reach SQL. A plugin without a manifest on disk (a fresh dev checkout
 * that has not booted the admin yet) simply has no declaration; the
 * admin publishes it from the verified definition at boot.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  assertVisitorProjection,
  type VisitorProjection,
  type VisitorProjectionDeclarations,
} from "./public-projection.js";

const manifestDeclaration = z.object({
  slug: z.string(),
  visitorProjection: z.record(z.string(), z.array(z.string())).optional(),
});

/**
 * Read every `<pluginsRoot>/<dir>/manifest.json`: its projection, or `null`
 * when the shipped version declares none (so an earlier version's
 * published rows are withdrawn). A plugin without a manifest here is not
 * in the map at all, and the publisher leaves its section alone.
 */
export function readShippedVisitorProjections(pluginsRoot: string): VisitorProjectionDeclarations {
  const out = new Map<string, VisitorProjection | null>();
  if (!existsSync(pluginsRoot)) return out;
  for (const dir of readdirSync(pluginsRoot)) {
    const path = resolve(pluginsRoot, dir, "manifest.json");
    if (!existsSync(path)) continue;
    const parsed = manifestDeclaration.parse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.visitorProjection) {
      out.set(parsed.slug, null);
      continue;
    }
    assertVisitorProjection(parsed.slug, parsed.visitorProjection);
    out.set(parsed.slug, parsed.visitorProjection);
  }
  return out;
}
