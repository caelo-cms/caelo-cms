// SPDX-License-Identifier: MPL-2.0

/**
 * `status --project` (#822): everything comes from the project, the setup
 * link goes to a terminal only and never once it is used, and a failed read
 * says what to do.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_BOOTSTRAP_TOKEN_SECRET } from "@caelo-cms/shared";
import { readOwnerSetupState } from "./admin-internal-google.js";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  INSTALL_SETUP_LINK_SECRET,
  type InstallJobStatus,
  readInstallJobStatus,
  writeInstallJobStatus,
} from "./install-job.js";
import {
  adminUrlFromOutputs,
  dnsRecordsToSet,
  type ProjectStatusDeps,
  projectStatusFailure,
  projectStatusLines,
  readProjectStatus,
  setupLinkLines,
  setupLinkRefusal,
} from "./project-status.js";
import { selfCommand } from "./self-command.js";
import type { SyncGcloud } from "./state-store.js";
import { handoffLines } from "./wizards/gcp-install-job.js";

const PROJECT = "acme-site";
const BUCKET = "gs://acme-site-caelo-ops/install";
const LINK = "https://admin.acme.test/setup?token=abc123";
const INSTALL = {
  installId: "gcp-acme-site",
  provider: "gcp",
  projectId: PROJECT,
  domain: "acme.test",
  ownerEmail: "owner@acme.test",
  region: "europe-west1",
  stateBackend: {
    kind: "gcs",
    bucket: "acme-site-caelo-ops",
    kmsKey: "projects/acme-site/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state",
  },
};
const RECORDS = [
  { hostname: "admin.acme.test", type: "A", value: "203.0.113.7" },
  { hostname: "acme.test", type: "A", value: "203.0.113.7" },
];
const PROGRESS = {
  steps: {
    [`pulumi-up-${PROJECT}`]: {
      outputs: {
        adminDomainOut: "admin.acme.test",
        adminCloudRunUrlOut: "https://x.run.app",
        dnsRecordsRequiredOut: RECORDS,
      },
    },
  },
};

function job(patch: Partial<InstallJobStatus>): InstallJobStatus {
  return {
    statusVersion: 1,
    installId: INSTALL.installId,
    execution: "caelo-install-abc",
    state: "succeeded",
    phase: "Done",
    caeloVersion: "0.12.0",
    startedAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:30:00.000Z",
    ...patch,
  };
}

/** "Now" of every test, and a token's expiry either side of it. */
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const VALID_UNTIL = "2026-11-06T10:30:00.000Z";
const EXPIRED_ON = "2026-11-05T11:00:00.000Z";

const ok = (stdout: string): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

interface World {
  objects?: Record<string, unknown>;
  /** Stderr of a refused `storage cat`. */
  denied?: string;
  setupLink?: string | null;
  /** The stored token's expiry; null: no token stored. */
  tokenExpiresAt?: string | null;
  linkDenied?: string;
  execution?: "running" | "gone";
  ownerSetup?: "open" | "done" | "unknown";
  isTerminal?: boolean;
  resolving?: readonly string[];
}

/** {@link ProjectStatusDeps} over a fake project; records every gcloud call. */
function project(world: World): { deps: ProjectStatusDeps; calls: string[][]; probes: string[] } {
  const calls: string[][] = [];
  const probes: string[] = [];
  const objects = world.objects ?? {
    [`${BUCKET}/install.json`]: INSTALL,
    [`${BUCKET}/progress.json`]: PROGRESS,
  };
  const syncRun: SyncGcloud = (args) => {
    calls.push(args);
    if (world.denied) return fail(world.denied);
    const url = args[2] ?? "";
    if (args[1] !== "cat") throw new Error(`a read-only command ran: ${args.join(" ")}`);
    const value = objects[url];
    return value === undefined
      ? fail("ERROR: The following URLs matched no objects or files")
      : ok(typeof value === "string" ? value : JSON.stringify(value));
  };
  const run: GcloudRunner = async (args) => {
    calls.push(args);
    if (args[0] === "secrets") {
      if (world.linkDenied) return fail(world.linkDenied);
      if (args.includes(`--secret=${OWNER_BOOTSTRAP_TOKEN_SECRET}`)) {
        const expiresAt = world.tokenExpiresAt === undefined ? VALID_UNTIL : world.tokenExpiresAt;
        return expiresAt
          ? ok(JSON.stringify({ token: "a".repeat(64), expiresAt }))
          : fail("NOT_FOUND: Secret not found");
      }
      expect(args).toContain(`--secret=${INSTALL_SETUP_LINK_SECRET}`);
      return world.setupLink ? ok(world.setupLink) : fail("NOT_FOUND: Secret not found");
    }
    if (args[0] === "run") {
      return world.execution === "gone"
        ? ok(JSON.stringify({ status: { completionTime: "t", failedCount: 1 } }))
        : ok(JSON.stringify({ status: {} }));
    }
    throw new Error(`unexpected gcloud call: ${args.join(" ")}`);
  };
  return {
    calls,
    probes,
    deps: {
      run,
      syncRun,
      resolves: async (r) => (world.resolving ?? []).includes(r.hostname),
      ownerSetupState: async (target) => {
        probes.push(target.provider);
        if (world.ownerSetup === "unknown") return { ok: false, error: "the admin is asleep" };
        return { ok: true, value: world.ownerSetup ?? "open" };
      },
      isTerminal: world.isTerminal ?? true,
      now: () => NOW,
    },
  };
}

const text = async (w: World) =>
  projectStatusLines(await readProjectStatus(PROJECT, project(w).deps)).join("\n");

describe("status --project: phase", () => {
  it("shows a running job with the command that follows it", async () => {
    const out = await text({
      objects: {
        [`${BUCKET}/install.json`]: INSTALL,
        [`${BUCKET}/progress.json`]: PROGRESS,
        [`${BUCKET}/install-job.json`]: job({
          state: "running",
          phase: "Waiting for DNS",
          detail: "Set at your registrar: A admin.acme.test → 203.0.113.7",
        }),
      },
      execution: "running",
    });
    expect(out).toContain("Waiting for DNS");
    expect(out).toContain("Set at your registrar");
    expect(out).toContain(
      selfCommand("--provider", "gcp", "--install-job", "--project-id", PROJECT),
    );
    expect(out).toContain("the link appears here when the install has finished");
  });

  it("says when the job's execution died while the bucket still says running", async () => {
    const out = await text({
      objects: {
        [`${BUCKET}/install.json`]: INSTALL,
        [`${BUCKET}/progress.json`]: PROGRESS,
        [`${BUCKET}/install-job.json`]: job({ state: "running", phase: "Provisioning" }),
      },
      execution: "gone",
    });
    expect(out).toContain("Not finished");
    expect(out).toContain("Resume it where this run stopped");
    expect(out).not.toContain("Follow it live");
  });

  it("before the job's first write says how to start it, and knows no admin or records", async () => {
    const out = await text({ objects: { [`${BUCKET}/install.json`]: INSTALL } });
    expect(out).toContain("Install job: not started");
    expect(out).toContain("Admin:   not known yet");
    expect(out).toContain("DNS:     not known yet");
  });

  it("names a terminal install for what it is", async () => {
    const out = await text({});
    expect(out).toContain("ran from a terminal");
  });
});

describe("status --project: DNS", () => {
  it("lists what public DNS does not answer yet, in the install's two groups", async () => {
    const s = await dnsRecordsToSet(RECORDS, "acme.test", async () => false);
    expect(s.setNow.map((r) => r.hostname)).toEqual(["admin.acme.test"]);
    expect(s.atGoLive.map((r) => r.hostname)).toEqual(["acme.test"]);
    expect(s.total).toBe(2);
  });

  it("drops a record that already resolves", async () => {
    const out = await text({ resolving: ["admin.acme.test"] });
    expect(out).toContain("DNS records still to set");
    expect(out).toContain("Only at go-live");
    expect(out).not.toContain("admin.acme.test  ");
    expect(out).not.toContain("Set now");
  });

  it("says so when every record is set", async () => {
    const out = await text({ resolving: ["admin.acme.test", "acme.test"] });
    expect(out).toContain("all set (2 of 2)");
  });

  it("includes the staging records the job stored, once", async () => {
    const staging = { hostname: "staging.acme.test", type: "A", value: "203.0.113.7" };
    const out = await text({
      objects: {
        [`${BUCKET}/install.json`]: INSTALL,
        [`${BUCKET}/progress.json`]: PROGRESS,
        [`${BUCKET}/install-job.json`]: job({ dnsRecords: [staging, staging] }),
      },
    });
    expect(out.match(/staging\.acme\.test/g)).toHaveLength(1);
    expect(out).not.toContain("Settings → Updates");
  });
});

describe("status --project: admin URL", () => {
  it("is admin.<domain> on gcp and the Cloud Run URL on gcp-firebase, as the setup link", () => {
    const outputs = PROGRESS.steps[`pulumi-up-${PROJECT}`]?.outputs ?? {};
    expect(adminUrlFromOutputs("gcp", outputs)).toBe("https://admin.acme.test");
    expect(adminUrlFromOutputs("gcp-firebase", outputs)).toBe("https://x.run.app");
    expect(adminUrlFromOutputs("gcp", {})).toBeNull();
  });
});

describe("status --project: Owner setup link", () => {
  const finished = {
    objects: {
      [`${BUCKET}/install.json`]: INSTALL,
      [`${BUCKET}/progress.json`]: PROGRESS,
      [`${BUCKET}/install-job.json`]: job({}),
    },
    setupLink: LINK,
  };

  it("prints the link while setup is open", async () => {
    const out = await text(finished);
    expect(out).toContain(LINK);
    expect(out).toContain("owner@acme.test");
  });

  it("says setup is done instead of printing a used link", async () => {
    const out = await text({ ...finished, ownerSetup: "done" });
    expect(out).not.toContain(LINK);
    expect(out).not.toContain("token=");
    expect(out).toContain("done.");
    expect(out).toContain("https://admin.acme.test");
  });

  it("never prints the link when stdout is not a terminal", async () => {
    const out = await text({ ...finished, isTerminal: false });
    expect(out).not.toContain(LINK);
    expect(out).not.toContain("token=");
    expect(out).toContain("only goes to a terminal");
  });

  it("still prints it when the check fails, saying so", async () => {
    const out = await text({ ...finished, ownerSetup: "unknown" });
    expect(out).toContain(LINK);
    expect(out).toContain("the admin is asleep");
  });

  it("does not read the secret before the install finished", async () => {
    const p = project({
      ...finished,
      objects: {
        ...finished.objects,
        [`${BUCKET}/install-job.json`]: job({ state: "running", phase: "Provisioning" }),
      },
      execution: "running",
    });
    const s = await readProjectStatus(PROJECT, p.deps);
    expect(s.owner.kind).toBe("not-yet");
    expect(p.calls.some((c) => c[0] === "secrets")).toBe(false);
    expect(p.probes).toEqual([]);
  });

  it("with no stored link names the admin and the way to get one", async () => {
    const out = await text({ ...finished, setupLink: null });
    expect(out).toContain("no link is stored");
    expect(out).toContain("https://admin.acme.test");
    expect(out).toContain("setup-link --project acme-site");
  });

  it("says until when the link works", async () => {
    const out = await text(finished);
    expect(out).toContain(VALID_UNTIL);
    expect(out).toContain("setup-link --project acme-site");
  });

  it("does not show an expired link, and says what to run instead", async () => {
    const out = await text({ ...finished, tokenExpiresAt: EXPIRED_ON });
    expect(out).not.toContain(LINK);
    expect(out).not.toContain("token=");
    expect(out).toContain(`expired on ${EXPIRED_ON}`);
    expect(out).toContain("setup-link --project acme-site");
  });

  it("does not show a link the admin has no token for (an install from before #1476)", async () => {
    const out = await text({ ...finished, tokenExpiresAt: null });
    expect(out).not.toContain(LINK);
    expect(out).toContain("setup-link --project acme-site");
  });

  it("an install with an Owner is done whatever became of its token", async () => {
    const out = await text({ ...finished, tokenExpiresAt: EXPIRED_ON, ownerSetup: "done" });
    expect(out).toContain("done.");
    expect(out).not.toContain("expired");
  });

  it("reports a refused secret read with what the account needs", async () => {
    const out = await text({ ...finished, linkDenied: "PERMISSION_DENIED: nope" });
    expect(out).toContain("secretmanager.versions.access");
  });
});

describe("setup-link", () => {
  const finished = {
    objects: {
      [`${BUCKET}/install.json`]: INSTALL,
      [`${BUCKET}/progress.json`]: PROGRESS,
      [`${BUCKET}/install-job.json`]: job({}),
    },
    setupLink: LINK,
    tokenExpiresAt: EXPIRED_ON,
  };
  const refusal = async (world: World) =>
    setupLinkRefusal(await readProjectStatus(PROJECT, project(world).deps));

  it("goes on for an expired link and for no link", async () => {
    expect(await refusal(finished)).toBeNull();
    expect(await refusal({ ...finished, setupLink: null })).toBeNull();
  });

  it("issues nothing once an Owner exists", async () => {
    expect(await refusal({ ...finished, ownerSetup: "done" })).toContain("no link is needed");
  });

  it("issues nothing before the install finished", async () => {
    const running = {
      ...finished,
      objects: {
        ...finished.objects,
        [`${BUCKET}/install-job.json`]: job({ state: "running", phase: "Provisioning" }),
      },
      execution: "running" as const,
    };
    expect(await refusal(running)).toContain("has not finished");
  });

  it("does not take a refused read for a missing link", async () => {
    expect(await refusal({ ...finished, linkDenied: "PERMISSION_DENIED: nope" })).toContain(
      "secretmanager.versions.access",
    );
  });

  it("keeps the link off a pipe", () => {
    const issued = { link: LINK, expiresAt: VALID_UNTIL, minted: true };
    expect(setupLinkLines(issued, true).join("\n")).toContain(LINK);
    expect(setupLinkLines(issued, false).join("\n")).not.toContain("token=");
  });
});

describe("status --project: failed reads and this machine", () => {
  it("a project without an install says to check the id", async () => {
    await expect(readProjectStatus(PROJECT, project({ objects: {} }).deps)).rejects.toThrow(
      /holds no install\.json\. Check the project id/,
    );
  });

  it("a refused bucket read says which sign-in it needs", async () => {
    await expect(
      readProjectStatus(PROJECT, project({ denied: "AccessDeniedException: 403" }).deps),
    ).rejects.toThrow(/gcloud auth login/);
  });

  it("a refused status read says which sign-in it needs", () => {
    const run: SyncGcloud = () => fail("AccessDeniedException: 403");
    expect(() => readInstallJobStatus("b", run)).toThrow(/gcloud auth login/);
  });

  it("a malformed pulumi-up step is an error, not an unprovisioned install", async () => {
    const objects = {
      [`${BUCKET}/install.json`]: INSTALL,
      [`${BUCKET}/progress.json`]: { steps: { [`pulumi-up-${PROJECT}`]: "broken" } },
    };
    await expect(readProjectStatus(PROJECT, project({ objects }).deps)).rejects.toThrow(
      /pulumi-up step/,
    );
  });

  it("a missing gcloud says to install it", () => {
    const e = Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" });
    expect(projectStatusFailure(e)).toContain("Install the Google Cloud CLI");
  });

  describe("with an empty HOME", () => {
    let home: string | undefined;
    const realHome = process.env.HOME;
    afterEach(() => {
      process.env.HOME = realHome;
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it("needs no install directory and creates none", async () => {
      home = mkdtempSync(join(tmpdir(), "caelo-status-"));
      process.env.HOME = home;
      const out = await text({});
      expect(out).toContain("gcp-acme-site");
      expect(existsSync(home)).toBe(true);
      expect(readdirSync(home)).toEqual([]);
    });
  });
});

describe("the job's status document", () => {
  it("takes DNS records past the secrets guard, a verification TXT included", () => {
    const written: string[] = [];
    const run: SyncGcloud = (_args, input) => {
      if (input) written.push(input);
      return ok("");
    };
    const dnsRecords = [
      { hostname: "acme.test", type: "TXT", value: "hosting-site=caelo-production-site-19114e" },
    ];
    writeInstallJobStatus("b", job({ dnsRecords }), run);
    expect(JSON.parse(written[0] ?? "{}").dnsRecords).toEqual(dnsRecords);
  });
});

describe("the handoff message", () => {
  it("says the tab may close and gives the exact command", () => {
    const out = handoffLines(PROJECT).join("\n");
    expect(out).toContain("You may close this tab now.");
    expect(out).toContain(selfCommand("status", "--project", PROJECT));
  });
});

describe("readOwnerSetupState", () => {
  const target = { provider: "gcp", projectId: PROJECT, domain: "acme.test" } as const;
  const gcloudToken = async () => ok("access-token");
  const answering = (setup: () => Response) => {
    const urls: string[] = [];
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("iamcredentials")) return Response.json({ signedJwt: "jwt" });
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt");
      return setup();
    }) as typeof fetch;
    return { urls, doFetch };
  };
  const read = (setup: () => Response) =>
    readOwnerSetupState(target, { run: gcloudToken, fetch: answering(setup).doFetch });

  it("reads a rendered form as open", async () => {
    expect(await read(() => new Response("<form>"))).toEqual({ ok: true, value: "open" });
  });

  it("reads the redirect to /login as done", async () => {
    const r = await read(
      () => new Response(null, { status: 303, headers: { location: "/login" } }),
    );
    expect(r).toEqual({ ok: true, value: "done" });
  });

  it("does not take any other answer for an answer", async () => {
    const r = await read(() => new Response("boom", { status: 500 }));
    expect(r).toEqual({ ok: false, error: "the admin answered /setup with HTTP 500" });
    const elsewhere = await read(
      () => new Response(null, { status: 303, headers: { location: "/maintenance" } }),
    );
    expect(elsewhere.ok).toBe(false);
  });

  it("sends its token only to the admin the install's domain names", async () => {
    const { urls, doFetch } = answering(() => new Response("<form>"));
    await readOwnerSetupState(target, { run: gcloudToken, fetch: doFetch });
    expect(urls.filter((u) => !u.includes("iamcredentials"))).toEqual([
      "https://admin.acme.test/setup",
    ]);
  });

  it("takes the gcp-firebase address from Cloud Run, not from a checkpoint", async () => {
    const { urls, doFetch } = answering(() => new Response("<form>"));
    const run = async (args: string[]) => {
      if (args[1] === "services" && args[2] === "describe") return ok("https://real.run.app\n");
      if (args[1] === "services" && args[2] === "list") {
        return ok("caelo-production-admin-abc\n");
      }
      return ok("access-token");
    };
    await readOwnerSetupState(
      { provider: "gcp-firebase", projectId: PROJECT, region: "europe-west1" },
      { run, fetch: doFetch },
    );
    expect(urls.at(-1)).toBe("https://real.run.app/setup");
  });

  it("turns a failed signing call into an answer, so the status still prints", async () => {
    const doFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await readOwnerSetupState(target, { run: gcloudToken, fetch: doFetch });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("network down");
  });

  it("reports IAP's own refusal", async () => {
    const r = await read(
      () =>
        new Response("denied", {
          status: 403,
          headers: { "x-goog-iap-generated-response": "true" },
        }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("Google IAP refused");
  });
});
