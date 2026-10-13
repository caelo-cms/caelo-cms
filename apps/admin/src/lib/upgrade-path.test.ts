// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { cloudShellUpgrade, releaseNotesExcerpt, resolveUpgradePath } from "./upgrade-path.js";

const gcp = {
  CAELO_PROVIDER: "gcp",
  CAELO_SITE_URL: "https://example.com",
  NODE_ENV: "production",
};

describe("resolveUpgradePath", () => {
  it("builds the pinned command for a Google Cloud install, named by its domain", () => {
    const p = resolveUpgradePath(gcp, "0.10.44");
    expect(p).toEqual({
      kind: "cli",
      provider: "gcp",
      install: "example.com",
      command:
        "bunx @caelo-cms/provisioning@0.10.44 upgrade --version 0.10.44 --install example.com",
      docsUrl: "https://caelo-cms.com/install-gcp",
    });
  });

  it("covers gcp-firebase like gcp", () => {
    const p = resolveUpgradePath({ ...gcp, CAELO_PROVIDER: "gcp-firebase" }, "0.10.44");
    expect(p.kind).toBe("cli");
  });

  it("offers no command where `upgrade` is not implemented", () => {
    expect(resolveUpgradePath({ ...gcp, CAELO_PROVIDER: "aws" }, "0.10.44")).toEqual({
      kind: "unsupported",
      providerLabel: "AWS",
      docsUrl: "https://caelo-cms.com/install-aws",
    });
    // Compose sets no CAELO_PROVIDER: a self-hosted install.
    expect(resolveUpgradePath({ CAELO_SITE_URL: "https://example.com" }, "0.10.44")).toEqual({
      kind: "unsupported",
      providerLabel: "self-hosted",
      docsUrl: "https://caelo-cms.com/install-self-hosted",
    });
  });

  it("says what is missing instead of guessing the install", () => {
    const missing = resolveUpgradePath({ CAELO_PROVIDER: "gcp" }, "0.10.44");
    expect(missing.kind).toBe("misconfigured");
    const bad = resolveUpgradePath({ ...gcp, CAELO_SITE_URL: "not a url" }, "0.10.44");
    expect(bad.kind).toBe("misconfigured");
  });

  it("honours the e2e provider stand-in outside production only", () => {
    const env = { CAELO_SITE_URL: "https://example.com", CAELO_E2E_UPDATES_PROVIDER: "gcp" };
    expect(resolveUpgradePath({ ...env, NODE_ENV: "development" }, "0.10.44").kind).toBe("cli");
    expect(resolveUpgradePath({ ...env, NODE_ENV: "production" }, "0.10.44").kind).toBe(
      "unsupported",
    );
  });
});

describe("releaseNotesExcerpt", () => {
  it("returns short notes whole", () => {
    expect(releaseNotesExcerpt("## Fixes\n\n- one\r\n")).toEqual({
      text: "## Fixes\n\n- one",
      truncated: false,
    });
  });

  it("cuts long notes at a paragraph", () => {
    const notes = `${"a".repeat(50)}\n\n${"b".repeat(50)}\n\n${"c".repeat(50)}`;
    const r = releaseNotesExcerpt(notes, 120);
    expect(r).toEqual({ text: `${"a".repeat(50)}\n\n${"b".repeat(50)}\n…`, truncated: true });
  });

  it("cuts one long paragraph at a word", () => {
    const r = releaseNotesExcerpt("word ".repeat(100), 22);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("word word word word\n…");
  });
});

describe("cloudShellUpgrade", () => {
  it("opens Cloud Shell on the install's project with pinned commands", () => {
    const c = cloudShellUpgrade(
      {
        ...gcp,
        CAELO_UPGRADER_JOB:
          "projects/acme-prod/locations/europe-west1/jobs/caelo-production-upgrader",
      },
      "0.11.0",
    );
    expect(c?.consoleUrl).toBe(
      "https://console.cloud.google.com/home/dashboard?project=acme-prod&cloudshell=true",
    );
    expect(c?.commands.slice(1)).toEqual([
      "bunx @caelo-cms/provisioning@0.11.0 attach --project acme-prod",
      "bunx @caelo-cms/provisioning@0.11.0 upgrade --version 0.11.0 --install example.com",
    ]);
  });

  it("without the job's project: plain Cloud Shell and no attach step", () => {
    const c = cloudShellUpgrade(gcp, "0.11.0");
    expect(c?.projectId).toBeNull();
    expect(c?.commands).toHaveLength(2);
  });

  it("is null where the CLI cannot upgrade", () => {
    expect(cloudShellUpgrade({ CAELO_SITE_URL: "https://example.com" }, "0.11.0")).toBeNull();
  });
});
