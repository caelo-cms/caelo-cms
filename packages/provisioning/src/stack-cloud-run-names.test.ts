// SPDX-License-Identifier: MPL-2.0

/**
 * Every Cloud Run service a GCP stack declares has its own Pulumi logical
 * name. Two resources with one URN fail the whole program, so every
 * `pulumi up` of that stack fails. That broke every fresh gcp-firebase
 * install from #1347 on: the data gateway took the default
 * `${namePrefix}-gateway`, which the MCP-Auth-Proxy keeps on purpose (E13 a
 * of #763). A fresh install of v0.11.14 on a scratch project showed it on
 * 2026-11-04.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stackSource = (provider: string): string =>
  readFileSync(resolve(import.meta.dir, "..", "stacks", provider, "index.ts"), "utf8");

/** The logical name of each `cloudRunService({ … })` call, as the stack's helper derives it. */
function cloudRunLogicalNames(source: string): string[] {
  const names: string[] = [];
  for (const call of source.matchAll(/cloudRunService\(\{([\s\S]*?)\n\}\);/g)) {
    const body = call[1] ?? "";
    const explicit = body.match(/resourceName:\s*`\$\{namePrefix\}-([a-z-]+)`/);
    const slug = body.match(/serviceName:\s*"([a-z-]+)"/);
    names.push(explicit ? (explicit[1] ?? "") : (slug?.[1] ?? ""));
  }
  return names;
}

describe("GCP stacks: one logical name per Cloud Run service", () => {
  for (const provider of ["gcp", "gcp-firebase"]) {
    it(`${provider} declares no two services under one name`, () => {
      const names = cloudRunLogicalNames(stackSource(provider));
      expect(names.length).toBeGreaterThan(1);
      expect(names.every((n) => n !== "")).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    });
  }

  it("gcp-firebase: the MCP-Auth-Proxy keeps the gateway's old name, the data gateway has its own", () => {
    const names = cloudRunLogicalNames(stackSource("gcp-firebase"));
    expect(names).toContain("gateway");
    expect(names).toContain("data-gateway");
  });
});
