// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ReleaseManifest } from "@caelo-cms/shared";
import { updateNotificationHtml, updateNotificationText } from "./notification-text.js";
import { type ManifestReader, readReleaseFacts } from "./release-facts.js";

const manifest = (over: Partial<ReleaseManifest> & { version: string }): ReleaseManifest => ({
  manifestVersion: 1,
  channel: "stable",
  digests: {
    admin: `sha256:${"a".repeat(64)}`,
    gateway: `sha256:${"b".repeat(64)}`,
    ops: `sha256:${"c".repeat(64)}`,
  },
  minFromVersion: "0.1.0",
  infraContractVersion: 2,
  migrations: { contract: false, lastContractVersion: null, head: "0271_platform_auto_updates" },
  security: false,
  advisories: [],
  ...over,
});

function reader(manifests: ReleaseManifest[]): ManifestReader {
  return async (version) => {
    const m = manifests.find((x) => x.version === version);
    return m ? { ok: true, manifest: m } : { ok: false, message: `no manifest for v${version}` };
  };
}

const input = { installedVersion: "0.10.47", targetVersion: "0.10.48", provider: "gcp" };

describe("readReleaseFacts", () => {
  it("compares the infrastructure contract with the installed release's", async () => {
    const same = await readReleaseFacts(
      input,
      reader([manifest({ version: "0.10.47" }), manifest({ version: "0.10.48" })]),
    );
    expect(same).toEqual({
      security: false,
      advisories: [],
      contractMigrations: false,
      infraChange: false,
    });
    const raised = await readReleaseFacts(
      input,
      reader([
        manifest({ version: "0.10.47" }),
        manifest({ version: "0.10.48", infraContractVersion: 3 }),
      ]),
    );
    expect(raised).toMatchObject({ infraChange: true });
  });

  it("leaves the infra question to the upgrader when the installed release has no manifest", async () => {
    const facts = await readReleaseFacts(input, reader([manifest({ version: "0.10.48" })]));
    expect(facts).toMatchObject({ infraChange: null });
  });

  it("self-hosted installs have no separate cloud setup", async () => {
    const facts = await readReleaseFacts(
      { ...input, provider: "self-hosted" },
      reader([manifest({ version: "0.10.48", infraContractVersion: 9 })]),
    );
    expect(facts).toMatchObject({ infraChange: false });
  });

  it("counts a skipped contract release and needs an advisory for security", async () => {
    const facts = await readReleaseFacts(
      input,
      reader([
        manifest({ version: "0.10.47" }),
        manifest({
          version: "0.10.48",
          security: true,
          migrations: { contract: false, lastContractVersion: "0.10.48", head: "x" },
        }),
      ]),
    );
    expect(facts).toMatchObject({ contractMigrations: true, security: false });
  });

  it("says why when the target's manifest cannot be read", async () => {
    expect(await readReleaseFacts(input, reader([]))).toEqual({
      unavailable: "no manifest for v0.10.48",
    });
  });
});

describe("update emails", () => {
  it("name the version, the page and what happens", () => {
    const t = updateNotificationText({
      kind: "scheduled",
      version: "0.10.48",
      installedVersion: "0.10.47",
      reason: null,
      at: new Date("2026-10-15T02:00:00Z"),
    });
    expect(t.subject).toBe("Caelo v0.10.48 will install automatically");
    expect(t.body).toContain("at about 2026-10-15 02:00 UTC");
    expect(t.body).toContain("/settings/updates");
    expect(t.body).toContain("pause automatic updates");
  });

  it("render as escaped HTML paragraphs", () => {
    expect(updateNotificationHtml('a <b> & "c"\n\nnext\nline')).toBe(
      "<p>a &lt;b&gt; &amp; &quot;c&quot;</p>\n<p>next<br>line</p>",
    );
  });
});
