// SPDX-License-Identifier: MPL-2.0

/**
 * Image self-check for a service image that runs plugins (issue #1327).
 *
 * The gateway image is bundled: it no longer carries the monorepo, only the
 * server bundle plus what plugins need at run time — the signed plugin dists
 * with their trust root, the packages those dists and the sandbox bundler
 * resolve from disk, Deno and the oxc-parser validator binding. Each of those
 * fails only when it is used: a missing manifest.sig drops one plugin at
 * boot, a missing SDK file or Deno binary breaks the first visitor call of a
 * runtime-authored plugin. That is the "every plugin endpoint 404s in
 * production" class of #387, discovered by a visitor.
 *
 * This check runs every such path once, without a database, so the image's
 * CI smoke can refuse a broken image before it is published:
 *
 *   1. every plugin directory the image ships verifies against the trust
 *      root exactly as the boot path does ({@link verifyDiskPlugin}:
 *      signature, validator over every dist file, import of the definition);
 *   2. a probe plugin runs through the production sandbox path
 *      ({@link runSandbox}: validator → host-side bundler → Deno child).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { type PluginContext, type PluginManifest, pluginManifest } from "@caelo-cms/plugin-sdk";
import { resolveTrustRoot, verifyDiskPlugin } from "./loader.js";
import { runSandbox } from "./sandbox-runtime.js";

/** What {@link checkPluginRuntime} found. `ok` is false when anything failed. */
export interface PluginRuntimeReport {
  readonly ok: boolean;
  readonly verified: ReadonlyArray<{ readonly slug: string; readonly version: string }>;
  readonly failures: ReadonlyArray<{ readonly slug: string; readonly reason: string }>;
  /** `"ok"` or why the sandbox probe failed. */
  readonly sandbox: string;
}

const PROBE_MANIFEST: PluginManifest = pluginManifest.parse({
  slug: "image-self-check",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["echo"],
  hasStaticRender: false,
});

const PROBE_SOURCE = `import { definePlugin } from "@caelo-cms/plugin-sdk";
export default definePlugin({ slug: "image-self-check", version: "1.0.0", tier: 2, schema: {},
  operations: { echo: async (_ctx, args) => ({ echoed: args }) } });`;

function denied(): never {
  throw new Error("image self-check: the probe plugin must not call the SDK");
}

/** The probe never reaches the broker (`denySdkCalls`); every handle refuses. */
const PROBE_CONTEXT: PluginContext = {
  query: {
    insert: denied,
    list: denied,
    update: denied,
    updateMany: denied,
    delete: denied,
    compareAndSwap: denied,
  },
  api: { list: denied, get: denied },
  theme: { tokens: {} },
  visitor: { id: null, publicUserId: null, ipHash: "", sessionToken: null },
  captcha: { requireProof: denied },
  invocation: { origin: "system", actorId: "image-self-check" },
};

/**
 * Verify every shipped plugin and run one sandbox probe.
 *
 * @param opts.pluginsRoot Absolute path to the image's `packages/plugins`.
 *   Every directory in it with a `manifest.json` (what boot loads) or a
 *   `package.json` is a shipped plugin and must verify; one without
 *   `manifest.json` is a plugin whose signing step failed.
 */
export async function checkPluginRuntime(opts: {
  readonly pluginsRoot: string;
}): Promise<PluginRuntimeReport> {
  const verified: Array<{ slug: string; version: string }> = [];
  const failures: Array<{ slug: string; reason: string }> = [];
  const publicKeyHex = resolveTrustRoot({ pluginsRoot: opts.pluginsRoot });

  let entries: string[] = [];
  try {
    entries = readdirSync(opts.pluginsRoot).sort();
  } catch (e) {
    failures.push({ slug: "<root>", reason: (e as Error).message });
  }
  const pluginDirs = entries
    .map((entry) => ({ entry, dir: resolvePath(opts.pluginsRoot, entry) }))
    // A manifest is what the boot loader picks up (gateway-attach.ts); a
    // package.json without one is a plugin whose signing step failed.
    .filter(
      ({ dir }) =>
        statSync(dir).isDirectory() &&
        (existsSync(resolvePath(dir, "manifest.json")) ||
          existsSync(resolvePath(dir, "package.json"))),
    );
  if (failures.length === 0 && pluginDirs.length === 0) {
    failures.push({ slug: "<root>", reason: `no plugin directories under ${opts.pluginsRoot}` });
  }
  for (const { entry, dir } of pluginDirs) {
    const manifestPath = resolvePath(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      failures.push({ slug: entry, reason: "no manifest.json: the image build did not sign it" });
      continue;
    }
    try {
      const rawManifest: unknown = await Bun.file(manifestPath).json();
      const v = await verifyDiskPlugin({ slug: entry, pluginDir: dir, rawManifest, publicKeyHex });
      verified.push({ slug: v.definition.slug, version: v.definition.version });
    } catch (e) {
      failures.push({ slug: entry, reason: (e as Error).message });
    }
  }

  let sandbox = "ok";
  const nonce = crypto.randomUUID();
  try {
    const result = await runSandbox({
      source: PROBE_SOURCE,
      manifest: PROBE_MANIFEST,
      operation: "echo",
      args: { nonce },
      context: PROBE_CONTEXT,
      authorize: async () => {},
      denySdkCalls: true,
      timeoutMs: 20_000,
    });
    const echoed = (result as { echoed?: { nonce?: unknown } } | null)?.echoed?.nonce;
    if (echoed !== nonce) sandbox = `probe returned ${JSON.stringify(result)}`;
  } catch (e) {
    sandbox = (e as Error).message;
  }

  return { ok: failures.length === 0 && sandbox === "ok", verified, failures, sandbox };
}
