// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the build's media pass over a few pages in one call (one batch,
 * `link` delivery: the files end up in `buildDir`, as on self-hosted), then
 * `cdn_manifest.json` written — what generate.ts does batch by batch.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { MediaPass } from "@caelo-cms/static-generator";

export async function runMediaPass(args: {
  tx: TransactionRunner;
  buildDir: string;
  pages: { html: string; pageSlug: string }[];
  mediaRoot: string;
  settings: { cdnEnabled: boolean; threshold: number };
}): Promise<MediaPass> {
  const pass = new MediaPass({ ...args, delivery: "link" });
  await pass.rewritePages(args.pages);
  await pass.finish();
  return pass;
}
