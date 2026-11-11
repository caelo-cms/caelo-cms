// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BillingAccount } from "../gcloud.js";
import {
  chooseBillingAccount,
  linkedBillingProblem,
  parseBillingAccountId,
  requestedBillingProblem,
  sameBillingAccount,
} from "./gcp-billing.js";

const AGENCY: BillingAccount = { id: "0A1B2C-3D4E5F-60718A", displayName: "Agency", open: true };
const CLIENT: BillingAccount = { id: "111111-222222-333333", displayName: "Client", open: true };
const CLOSED: BillingAccount = { id: "999999-888888-777777", displayName: "Old card", open: false };

describe("parseBillingAccountId", () => {
  it("takes the id gcloud prints, its resource name and either letter case", () => {
    expect(parseBillingAccountId("0A1B2C-3D4E5F-60718A")).toBe("0A1B2C-3D4E5F-60718A");
    expect(parseBillingAccountId("billingAccounts/0a1b2c-3d4e5f-60718a")).toBe(
      "0A1B2C-3D4E5F-60718A",
    );
    expect(parseBillingAccountId("  111111-222222-333333 ")).toBe("111111-222222-333333");
  });

  for (const bad of [
    "",
    "--non-interactive",
    "0A1B2C3D4E5F60718A",
    "0A1B2C-3D4E5F",
    "XYZXYZ-3D4E5F-60718A",
  ]) {
    it(`refuses ${JSON.stringify(bad)} and names the flag`, () => {
      expect(() => parseBillingAccountId(bad)).toThrow("--billing-account");
    });
  }
});

describe("chooseBillingAccount", () => {
  it("links the account the flag names among several open ones, also without a terminal", () => {
    const choice = chooseBillingAccount({
      accounts: [AGENCY, CLIENT, CLOSED],
      requested: "111111-222222-333333",
      nonInteractive: true,
    });
    expect(choice).toEqual({ kind: "use", account: CLIENT });
  });

  it("matches the flag whatever its letter case", () => {
    const choice = chooseBillingAccount({
      accounts: [AGENCY, CLIENT],
      requested: "0a1b2c-3d4e5f-60718a",
      nonInteractive: true,
    });
    expect(choice).toEqual({ kind: "use", account: AGENCY });
  });

  it("refuses a closed account and names the open ones", () => {
    const choice = chooseBillingAccount({
      accounts: [AGENCY, CLIENT, CLOSED],
      requested: CLOSED.id,
      nonInteractive: true,
    });
    expect(choice.kind).toBe("refuse");
    const message = choice.kind === "refuse" ? choice.message : "";
    expect(message).toContain(`${CLOSED.id} is closed`);
    expect(message).toContain("0A1B2C-3D4E5F-60718A (Agency)");
    expect(message).toContain("111111-222222-333333 (Client)");
    expect(message).not.toContain("Old card");
  });

  it("refuses an account the signed-in account cannot see, also when it is the only open one", () => {
    const choice = chooseBillingAccount({
      accounts: [AGENCY],
      requested: "123456-123456-123456",
      nonInteractive: false,
    });
    expect(choice.kind).toBe("refuse");
    const message = choice.kind === "refuse" ? choice.message : "";
    expect(message).toContain("123456-123456-123456 is not among");
    expect(message).toContain("0A1B2C-3D4E5F-60718A (Agency)");
  });

  it("without the flag uses the only open account", () => {
    expect(
      chooseBillingAccount({
        accounts: [CLOSED, AGENCY],
        requested: undefined,
        nonInteractive: true,
      }),
    ).toEqual({ kind: "use", account: AGENCY });
  });

  it("without the flag asks between several open accounts in a terminal", () => {
    expect(
      chooseBillingAccount({
        accounts: [AGENCY, CLIENT, CLOSED],
        requested: undefined,
        nonInteractive: false,
      }),
    ).toEqual({ kind: "ask", open: [AGENCY, CLIENT] });
  });

  it("without the flag stops a --non-interactive run with several open accounts and names the flag as it parses", () => {
    const choice = chooseBillingAccount({
      accounts: [AGENCY, CLIENT],
      requested: undefined,
      nonInteractive: true,
    });
    expect(choice.kind).toBe("refuse");
    const message = choice.kind === "refuse" ? choice.message : "";
    // `--billing-account=<id>` (the old hint) is not a form the CLI reads.
    expect(message).toContain("--billing-account <id>");
    expect(message).not.toContain("--billing-account=");
    expect(message).toContain("0A1B2C-3D4E5F-60718A (Agency)");
  });

  it("refuses when no account is open, flag or not", () => {
    for (const requested of [undefined, CLOSED.id]) {
      const choice = chooseBillingAccount({ accounts: [CLOSED], requested, nonInteractive: true });
      expect(choice.kind).toBe("refuse");
      expect(choice.kind === "refuse" ? choice.message : "").toContain("No open billing account");
    }
  });
});

describe("sameBillingAccount", () => {
  it("ignores letter case and the resource-name prefix", () => {
    expect(sameBillingAccount("billingAccounts/0a1b2c-3d4e5f-60718a", AGENCY.id)).toBe(true);
    expect(sameBillingAccount(AGENCY.id, CLIENT.id)).toBe(false);
  });
});

describe("linkedBillingProblem", () => {
  const base = { projectId: "caelo-site", linked: AGENCY.id };

  it("lets the run go on without the flag, without a link yet, or with the linked account", () => {
    expect(linkedBillingProblem({ ...base, requested: undefined })).toBeNull();
    expect(linkedBillingProblem({ ...base, linked: null, requested: CLIENT.id })).toBeNull();
    expect(linkedBillingProblem({ ...base, requested: "0a1b2c-3d4e5f-60718a" })).toBeNull();
  });

  it("refuses another account and says how to change the link", () => {
    const message = linkedBillingProblem({ ...base, requested: CLIENT.id }) ?? "";
    expect(message).toContain(`caelo-site is already linked to billing account ${AGENCY.id}`);
    expect(message).toContain(`--billing-account ${CLIENT.id} would not change that`);
    expect(message).toContain("console.cloud.google.com/billing/linkedaccount?project=caelo-site");
  });
});

describe("requestedBillingProblem", () => {
  it("asks Google Cloud nothing without the flag", async () => {
    let asked = 0;
    const describe = async () => {
      asked += 1;
      return { ok: true as const, accountId: AGENCY.id };
    };
    expect(await requestedBillingProblem("caelo-site", undefined, describe)).toBeNull();
    expect(asked).toBe(0);
  });

  it("compares the flag with the link Google Cloud records", async () => {
    const describe = async () => ({ ok: true as const, accountId: AGENCY.id });
    expect(await requestedBillingProblem("caelo-site", AGENCY.id, describe)).toBeNull();
    expect(await requestedBillingProblem("caelo-site", CLIENT.id, describe)).toContain(
      "is already linked to billing account",
    );
  });

  it("stops with gcloud's error when the link cannot be read", async () => {
    const error = "gcloud billing projects describe caelo-site: PERMISSION_DENIED";
    const describe = async () => ({ ok: false as const, error });
    expect(await requestedBillingProblem("caelo-site", CLIENT.id, describe)).toBe(error);
  });
});

describe("job mode (#1580 review)", () => {
  it("checks the flag before it follows or shows an install job", () => {
    // Following a running job and showing a finished one return before the
    // wizard's billing step, so the check has to come first there.
    const source = readFileSync(join(import.meta.dir, "gcp-install-job.ts"), "utf8");
    const prep = source.slice(source.indexOf("export async function prepareJobModeInstall("));
    const check = prep.indexOf("requestedBillingProblem(projectId, opts.billingAccountId)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(prep.indexOf("await followToTheEnd("));
    expect(check).toBeLessThan(prep.indexOf("await showResult("));
  });

  it("hands the flag to the job-mode preparation", () => {
    const wizard = readFileSync(join(import.meta.dir, "..", "wizard.ts"), "utf8");
    const call = wizard.slice(wizard.indexOf("await prepareJobModeInstall({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("billingAccountId: opts.billingAccountId");
  });
});

describe("the GCP wizard", () => {
  it("settles the billing account before it creates the project", () => {
    // A wrong --billing-account must stop the run with nothing created.
    const source = readFileSync(join(import.meta.dir, "gcp.ts"), "utf8");
    const flow = source.slice(source.indexOf("export async function runGcpWizard("));
    const choice = flow.indexOf("await stepBillingChoice(");
    const create = flow.indexOf("await stepProjectCreate(");
    const link = flow.indexOf("await stepBillingLink(");
    expect(choice).toBeGreaterThan(-1);
    expect(choice).toBeLessThan(create);
    expect(create).toBeLessThan(link);
  });
});

describe("cms-provision --billing-account", () => {
  const CLI = resolve(import.meta.dir, "..", "cli.ts");
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "caelo-billing-flag-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** The `~/.caelo-<install-id>` folders a started wizard would create (bun itself adds `Library/`). */
  const installFolders = () => readdirSync(home).filter((name) => name.startsWith(".caelo"));

  function wizard(...args: string[]) {
    return Bun.spawnSync(
      [
        process.execPath,
        CLI,
        "--provider",
        "gcp",
        "--domain",
        "example.com",
        "--owner-email",
        "owner@example.com",
        "--region",
        "europe-west1",
        "--non-interactive",
        "--local",
        ...args,
      ],
      // No gcloud on PATH and a scratch HOME: a regression that let the run
      // past the flag check could reach neither a cloud account nor an
      // install folder.
      { env: { HOME: home, PATH: "" }, stdout: "pipe", stderr: "pipe" },
    );
  }

  it("refuses a malformed id before the wizard starts", () => {
    const r = wizard("--billing-account", "my-agency-account");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--billing-account needs a billing account id like");
    expect(installFolders()).toEqual([]);
  });

  it("refuses the flag without a value", () => {
    const r = wizard("--billing-account");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--billing-account needs a billing account id");
    expect(installFolders()).toEqual([]);
  });
});
