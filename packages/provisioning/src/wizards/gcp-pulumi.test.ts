// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSecretReplication } from "./gcp-pulumi.js";

const SECRET = "gcp:secretmanager/secret:Secret";

describe("resolveSecretReplication", () => {
  it("new stack (empty state) gets regional secrets (regression: `auto` = location global, rejected by gcp.resourceLocations)", () => {
    expect(resolveSecretReplication(undefined, [])).toBe("regional");
  });

  it("a failed first run without any created secret still gets regional", () => {
    const partial = [
      { type: "gcp:storage/bucket:Bucket", outputs: {} },
      { type: SECRET, outputs: undefined },
    ];
    expect(resolveSecretReplication(undefined, partial)).toBe("regional");
  });

  it("stack whose secrets already exist with auto replication keeps auto (no secret replacement)", () => {
    const deployed = [{ type: SECRET, outputs: { replication: { auto: {} } } }];
    expect(resolveSecretReplication(undefined, deployed)).toBe("auto");
  });

  it("an explicit config value wins", () => {
    const deployed = [{ type: SECRET, outputs: { replication: { auto: {} } } }];
    expect(resolveSecretReplication("regional", deployed)).toBe("regional");
    expect(resolveSecretReplication("auto", [])).toBe("auto");
  });

  it("rejects an unknown config value", () => {
    expect(() => resolveSecretReplication("global", [])).toThrow(/secretReplication/);
  });
});

describe("GCP stacks", () => {
  for (const provider of ["gcp", "gcp-firebase"]) {
    it(`${provider} stack takes secret replication from config, not hard-coded auto`, () => {
      const src = readFileSync(
        resolve(import.meta.dir, `../../stacks/${provider}/index.ts`),
        "utf8",
      );
      expect(src).toContain('cfg.require("secretReplication")');
      expect(src).toContain("replication: secretReplication");
      expect(src).not.toContain("replication: { auto: {} }");
    });
  }
});
