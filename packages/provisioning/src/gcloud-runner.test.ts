// SPDX-License-Identifier: MPL-2.0

/**
 * The gcloud runners against a fake `gcloud` on PATH: they must never leave
 * gcloud able to wait on a prompt nobody sees (regression: `admin-domain
 * enable` hung on gcloud's hidden "install the beta component? (Y/n)").
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud, gcloudEnv } from "./gcloud.js";
import { runCli } from "./regions.js";

// Echoes the prompt switch, then waits for one line on stdin, like gcloud's
// "(Y/n)" prompt does. With an open, never-ended stdin this blocks forever.
const FAKE_GCLOUD = `#!/bin/sh
echo "prompts=$CLOUDSDK_CORE_DISABLE_PROMPTS"
read -r answer
echo "answer=$answer"
`;

let dir = "";
const originalPath = process.env.PATH;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "caelo-fake-gcloud-"));
  writeFileSync(join(dir, "gcloud"), FAKE_GCLOUD);
  chmodSync(join(dir, "gcloud"), 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("gcloud runners never block on a hidden prompt", () => {
  it("gcloud() disables prompts and closes stdin", async () => {
    const r = await gcloud(["beta", "run", "domain-mappings", "describe"]);
    expect(r.stdout).toBe("prompts=1\nanswer=\n");
  });

  it("gcloud() still feeds stdin when the caller passes it", async () => {
    const r = await gcloud(["secrets", "versions", "add"], { stdin: "payload\n" });
    expect(r.stdout).toBe("prompts=1\nanswer=payload\n");
  });

  it("runCli() disables gcloud prompts and closes stdin", async () => {
    const r = await runCli("gcloud", ["config", "get-value", "run/region"]);
    expect(r.stdout).toBe("prompts=1\nanswer=\n");
  });

  it("gcloudEnv() keeps the caller's environment", () => {
    expect(gcloudEnv({ HOME: "/home/x" })).toEqual({
      HOME: "/home/x",
      CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    });
  });
});
