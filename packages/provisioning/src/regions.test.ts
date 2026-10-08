// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  assertRegionUnchanged,
  type CliResult,
  checkRegion,
  decideRegion,
  detectCliRegion,
  installableRegions,
  type RegionalProvider,
  regionCatalog,
  requireInstallRegion,
  suggestRegion,
} from "./regions.js";

const ok = (stdout = ""): CliResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string): CliResult => ({ ok: false, stdout: "", stderr });

/** Fake CLI answering by `cmd args` substring; records every call. */
function fakeCli(answers: Record<string, CliResult>) {
  const calls: string[] = [];
  const run = async (cmd: string, args: readonly string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.includes(k));
    return key ? (answers[key] as CliResult) : fail(`${cmd}: command not found`);
  };
  return { run, calls };
}

const ids = (p: RegionalProvider) => regionCatalog(p).regions.map((r) => r.id);
const PROVIDERS: RegionalProvider[] = ["gcp", "gcp-firebase", "aws", "azure"];

describe("region catalogs", () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: the EU default is installable, ids are unique`, () => {
      const catalog = regionCatalog(provider);
      expect(ids(provider)).toContain(catalog.euDefault);
      expect(new Set(ids(provider)).size).toBe(ids(provider).length);
    });
  }

  it("gcp needs every regional service in the region", () => {
    expect(ids("gcp")).toContain("europe-west1");
    expect(ids("gcp")).toContain("europe-west3");
    // No Cloud Scheduler (the operator-access sync schedule) in these.
    expect(ids("gcp")).not.toContain("europe-north1");
    expect(ids("gcp")).not.toContain("europe-west10");
    // No Cloud SQL.
    expect(ids("gcp")).not.toContain("europe-north2");
  });

  it("gcp-firebase additionally needs Cloud Run domain mapping (admin.<domain>)", () => {
    expect(ids("gcp-firebase")).toContain("europe-west1");
    expect(ids("gcp-firebase")).toContain("europe-west4");
    expect(ids("gcp-firebase")).not.toContain("europe-west3");
    expect(ids("gcp-firebase").every((id) => ids("gcp").includes(id))).toBe(true);
    expect(regionCatalog("gcp-firebase").services).toContain("Cloud Run domain mapping");
  });

  it("aws and azure exclude GovCloud / China partitions", () => {
    expect(ids("aws").some((id) => id.startsWith("us-gov") || id.startsWith("cn-"))).toBe(false);
    expect(ids("azure").some((id) => id.includes("gov") || id.startsWith("china"))).toBe(false);
  });
});

describe("installableRegions", () => {
  it("gcp is the static catalog — no CLI call", async () => {
    const { run, calls } = fakeCli({});
    const r = await installableRegions("gcp", run);
    expect(r.ok && r.regions.map((x) => x.id)).toEqual(ids("gcp"));
    expect(calls).toEqual([]);
  });

  it("azure narrows the static list to where Container Apps is offered", async () => {
    const { run } = fakeCli({
      "az provider show": ok(JSON.stringify(["West Europe", "Germany West Central", "Mars"])),
    });
    const r = await installableRegions("azure", run);
    expect(r.ok && r.regions.map((x) => x.id)).toEqual(["westeurope", "germanywestcentral"]);
  });

  it("azure fails loudly when the CLI can't answer (offline / not logged in)", async () => {
    const { run } = fakeCli({ "az provider show": fail("Please run 'az login'") });
    const r = await installableRegions("azure", run);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("az login");
      expect(r.error).toContain("Container Apps");
    }
  });
});

describe("checkRegion", () => {
  it("accepts an installable region", () => {
    expect(checkRegion("gcp", "europe-west1", regionCatalog("gcp").regions)).toEqual({ ok: true });
  });

  it("names the missing services and every valid region", () => {
    const r = checkRegion("gcp-firebase", "europe-west3", regionCatalog("gcp-firebase").regions);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Cloud Run domain mapping");
      expect(r.error).toContain("europe-west1 (Belgium)");
      expect(r.error).toContain("us-central1 (Iowa)");
    }
  });
});

describe("detectCliRegion", () => {
  it("gcp: run/region wins, compute/region next, (unset) is no default", async () => {
    const both = fakeCli({
      "run/region": ok("europe-west4\n"),
      "compute/region": ok("us-east1\n"),
    });
    expect(await detectCliRegion("gcp", both.run)).toBe("europe-west4");
    const computeOnly = fakeCli({
      "run/region": ok("(unset)\n"),
      "compute/region": ok("us-east1"),
    });
    expect(await detectCliRegion("gcp-firebase", computeOnly.run)).toBe("us-east1");
    expect(await detectCliRegion("gcp", fakeCli({}).run)).toBeNull();
  });

  it("aws: AWS_REGION, then AWS_DEFAULT_REGION, then the configured profile", async () => {
    const cli = fakeCli({ "aws configure get region": ok("eu-west-1\n") });
    expect(await detectCliRegion("aws", cli.run, { AWS_REGION: "eu-north-1" })).toBe("eu-north-1");
    expect(await detectCliRegion("aws", cli.run, { AWS_DEFAULT_REGION: "eu-west-3" })).toBe(
      "eu-west-3",
    );
    expect(await detectCliRegion("aws", cli.run, {})).toBe("eu-west-1");
  });

  it("azure: the az default location", async () => {
    const cli = fakeCli({ "az config get defaults.location": ok("northeurope\n") });
    expect(await detectCliRegion("azure", cli.run)).toBe("northeurope");
  });
});

describe("suggestRegion", () => {
  const regions = regionCatalog("gcp-firebase").regions;

  it("preselects the CLI default when it can host the install", () => {
    expect(suggestRegion("gcp-firebase", "us-east4", regions)).toEqual({
      region: "us-east4",
      source: "cli",
    });
  });

  it("falls back to the EU default, explaining a CLI default it can't use", () => {
    const s = suggestRegion("gcp-firebase", "europe-west3", regions);
    expect(s.region).toBe("europe-west1");
    expect(s.source).toBe("eu-default");
    expect(s.note).toContain("europe-west3");
    expect(suggestRegion("gcp-firebase", null, regions)).toEqual({
      region: "europe-west1",
      source: "eu-default",
    });
  });
});

describe("decideRegion", () => {
  const base = {
    provider: "gcp-firebase" as const,
    installId: "gcp-firebase-acme",
    recorded: null,
    deployed: null,
    requested: undefined,
    nonInteractive: false,
    regions: regionCatalog("gcp-firebase").regions,
  };

  it("keeps the recorded region (existing installs keep working unchanged)", () => {
    expect(decideRegion({ ...base, recorded: "europe-west1" })).toEqual({
      kind: "keep",
      region: "europe-west1",
      from: "install.json",
    });
    expect(
      decideRegion({ ...base, recorded: "europe-west1", requested: "europe-west1" }).kind,
    ).toBe("keep");
  });

  it("keeps a recorded region even if it is not in today's catalog", () => {
    expect(decideRegion({ ...base, recorded: "europe-west3", nonInteractive: true })).toEqual({
      kind: "keep",
      region: "europe-west3",
      from: "install.json",
    });
  });

  it("refuses a different --region on an existing install", () => {
    const d = decideRegion({ ...base, recorded: "europe-west1", requested: "us-central1" });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.error).toContain("runs in europe-west1");
      expect(d.error).toContain("fixed after install");
      expect(d.error).toContain("--region europe-west1");
    }
  });

  it("adopts the deployed region of an install that predates the record", () => {
    expect(decideRegion({ ...base, deployed: "us-east1" })).toEqual({
      kind: "keep",
      region: "us-east1",
      from: "deployed",
    });
    expect(decideRegion({ ...base, deployed: "us-east1", requested: "europe-west1" }).kind).toBe(
      "refuse",
    );
  });

  it("refuses when install.json and the deployed services disagree", () => {
    const d = decideRegion({ ...base, recorded: "europe-west1", deployed: "us-east1" });
    expect(d.kind).toBe("refuse");
  });

  it("new install: validates --region", () => {
    expect(decideRegion({ ...base, requested: "europe-west4" })).toEqual({
      kind: "use",
      region: "europe-west4",
    });
    const d = decideRegion({ ...base, requested: "europe-west3" });
    expect(d.kind).toBe("refuse");
  });

  it("new install: prompts when interactive, requires --region when not", () => {
    expect(decideRegion(base)).toEqual({ kind: "prompt" });
    const d = decideRegion({ ...base, nonInteractive: true });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.error).toContain("--region is required");
      expect(d.error).toContain("europe-west1 (Belgium)");
    }
  });
});

describe("lifecycle region guards", () => {
  const meta = { installId: "gcp-firebase-acme", region: "europe-west1" };

  it("requireInstallRegion returns the recorded region, never a default", () => {
    expect(requireInstallRegion(meta)).toBe("europe-west1");
    expect(() => requireInstallRegion({ ...meta, region: null })).toThrow(/no region recorded/);
  });

  it("upgrade: no --region or the same one passes, a different one is refused", () => {
    expect(assertRegionUnchanged(meta, undefined)).toBe("europe-west1");
    expect(assertRegionUnchanged(meta, "europe-west1")).toBe("europe-west1");
    expect(() => assertRegionUnchanged(meta, "us-central1")).toThrow(/fixed after install/);
  });
});
