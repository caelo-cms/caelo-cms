// SPDX-License-Identifier: MPL-2.0

/**
 * #1332 — the public surface of every shipped plugin, pinned.
 *
 * The snapshot holds what a visitor can reach: each public operation's
 * kind, captcha, rate limit, input JSON Schema and tables, each table's
 * kind and the privileges the visitor role gets from it, the host
 * services the plugin requires, and the mails it may queue (#1337). A change to any of it fails this test
 * until the snapshot is updated in the same PR (`bun test --update-snapshots`),
 * so a reviewer sees the new surface in the diff. Every such change is a
 * new manifest digest, which the Owner approves again (CLAUDE.md §2).
 *
 * The fuzz half feeds arbitrary bodies to every shipped public operation's
 * contract: the contract never throws, and whatever it accepts is exactly
 * what the operation's schema accepts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { VISITOR_TABLE_PRIVILEGES } from "@caelo-cms/plugin-sandbox";
import { manifestFromDefinition, type PluginDefinition } from "@caelo-cms/plugin-sdk";
import fc from "fast-check";
import { refusePublicCall } from "./public-contract.js";

const PLUGINS_ROOT = resolve(import.meta.dir, "../../plugins");

/** Every shipped plugin's built definition, by slug (the dists `tsc -b` builds). */
async function shippedDefinitions(): Promise<[string, PluginDefinition<never>][]> {
  const out: [string, PluginDefinition<never>][] = [];
  for (const entry of readdirSync(PLUGINS_ROOT).sort()) {
    const dir = resolve(PLUGINS_ROOT, entry);
    if (!statSync(dir).isDirectory() || !existsSync(resolve(dir, "package.json"))) continue;
    const dist = resolve(dir, "dist", "index.js");
    // A missing dist is a broken build, not a skippable plugin (no fallbacks).
    expect(existsSync(dist)).toBe(true);
    const mod = (await import(`file://${dist}`)) as { default: PluginDefinition<never> };
    out.push([entry, mod.default]);
  }
  return out;
}

const defs = await shippedDefinitions();

describe("shipped plugins' public surface (#1332)", () => {
  it("covers every shipped plugin", () => {
    expect(defs.map(([slug]) => slug)).toEqual([
      "auth",
      "comments",
      "consent-manager",
      "forms",
      "international-site",
      "newsletter",
      "ratings",
    ]);
  });

  for (const [slug, def] of defs) {
    it(`${slug}: matches the reviewed surface`, () => {
      const m = manifestFromDefinition(def);
      const surface = {
        publicOperations: m.publicOperations ?? [],
        tables: Object.fromEntries(
          Object.entries(m.tableKinds ?? {}).map(([table, kind]) => [
            table,
            { kind, visitorPrivileges: VISITOR_TABLE_PRIVILEGES[kind] },
          ]),
        ),
        requires: m.requires ?? [],
        // #1337 — what a visitor's mail can say and link to.
        mailTemplates: m.mailTemplates ?? {},
        // #1432 — an operation one-click reaches without a proof-of-work.
        mailUnsubscribe: m.mailUnsubscribe ?? null,
      };
      expect(surface).toMatchSnapshot();
    });
  }
});

describe("shipped public operations under arbitrary input (#1332, fuzz)", () => {
  const verdict = { enforced: true, proofVerified: true };
  for (const [slug, def] of defs) {
    for (const op of def.publicOperations ?? []) {
      it(`${slug}.${op.name}: refuses with a structured error or passes exactly what its schema accepts`, () => {
        fc.assert(
          fc.property(fc.oneof(fc.anything(), fc.object(), fc.jsonValue()), (body) => {
            const r = refusePublicCall(op, verdict, body);
            if (r.ok) {
              expect(op.input.safeParse(r.args).success).toBe(true);
            } else {
              expect(r.error.kind).toBe("InvalidInput");
              expect(r.error.message).not.toMatch(/TypeError|undefined is not|Cannot read/);
            }
          }),
          { numRuns: 300 },
        );
      });
    }
  }
});
