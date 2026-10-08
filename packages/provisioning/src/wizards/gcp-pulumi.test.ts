// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertStackRegion, deployedStackRegion, resolveSecretReplication } from "./gcp-pulumi.js";

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

describe("deployedStackRegion / assertStackRegion (#607)", () => {
  const provider = (region: string) => ({ type: "pulumi:providers:gcp", inputs: { region } });

  it("reads the region from the stack's GCP provider in state", () => {
    expect(deployedStackRegion([provider("europe-west1"), { type: SECRET }])).toBe("europe-west1");
  });

  it("is null for a stack with nothing deployed", () => {
    expect(deployedStackRegion([])).toBeNull();
    expect(deployedStackRegion([{ type: "pulumi:providers:gcp", inputs: {} }])).toBeNull();
  });

  it("refuses an ambiguous state", () => {
    expect(() => deployedStackRegion([provider("europe-west1"), provider("us-central1")])).toThrow(
      /several regions/,
    );
  });

  it("refuses to up a deployed stack into another region", () => {
    expect(() => assertStackRegion("europe-west1", "us-central1")).toThrow(/fixed after install/);
    expect(() => assertStackRegion("europe-west1", "europe-west1")).not.toThrow();
    expect(() => assertStackRegion(null, "us-central1")).not.toThrow();
  });
});

describe("stacks require the region (#607, no silent default)", () => {
  for (const provider of ["gcp", "gcp-firebase", "aws", "azure"]) {
    const dir = resolve(import.meta.dir, `../../stacks/${provider}`);
    it(`${provider} stack: cfg.require("region"), no fallback`, () => {
      const src = readFileSync(resolve(dir, "index.ts"), "utf8");
      expect(src).toContain('cfg.require("region")');
      expect(src).not.toMatch(/cfg\.get\("region"\)|\?\? "(us-central1|us-east-1|westeurope)"/);
    });
    if (provider === "azure") {
      it("azure stack: the pre-#607 `location` key is refused with the move, not mapped", () => {
        const src = readFileSync(resolve(dir, "index.ts"), "utf8");
        expect(src).toContain("caelo-azure:location was renamed to caelo-azure:region");
        expect(src).not.toMatch(/cfg\.get\("location"\) \?\?/);
      });
    }
    it(`${provider} Pulumi.yaml: region has no default`, () => {
      const yaml = readFileSync(resolve(dir, "Pulumi.yaml"), "utf8");
      const entry = yaml.match(new RegExp(`caelo-${provider}:region:\\n((?: {4}.*\\n)+)`))?.[1];
      expect(entry).toBeDefined();
      expect(entry).not.toContain("default:");
    });
  }
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
