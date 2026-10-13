// SPDX-License-Identifier: MPL-2.0

/**
 * install.json / progress.json stores (#696, state-store.ts) against a fake
 * `gcloud storage`: the bucket is authoritative, the local copy a mirror,
 * and both stores refuse secret material (#656 / #659) before anything is
 * written — locally or to the bucket.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GcloudResult } from "./gcloud.js";
import { GcsStateStore, LocalStateStore, type SyncGcloud } from "./state-store.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** A bucket as a Map, reached through `gcloud storage cat|cp -`. */
function fakeBucket() {
  const objects = new Map<string, string>();
  const calls: string[] = [];
  const run: SyncGcloud = (args, input) => {
    calls.push(args.join(" "));
    if (args[0] === "storage" && args[1] === "cat") {
      const v = objects.get(args[2] ?? "");
      return v === undefined ? fail("ERROR: One or more URLs matched no objects.") : ok(v);
    }
    if (args[0] === "storage" && args[1] === "cp" && args[2] === "-") {
      objects.set(args[3] ?? "", input ?? "");
      return ok();
    }
    return fail(`unexpected gcloud ${args.join(" ")}`);
  };
  return { objects, calls, run };
}

const PASSWORD_URL = "postgres://admin_role:hunter2hunter2@10.0.0.3:5432/cms_admin";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "caelo-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("LocalStateStore", () => {
  it("round-trips a document with mode 0600", () => {
    const s = new LocalStateStore(root);
    expect(s.read("install.json")).toBeNull();
    s.write("install.json", { installId: "gcp-acme" });
    expect(JSON.parse(s.read("install.json") ?? "")).toEqual({ installId: "gcp-acme" });
    expect(statSync(join(root, "install.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses secret material in either document", () => {
    const s = new LocalStateStore(root);
    expect(() => s.write("install.json", { db: PASSWORD_URL })).toThrow(/Refusing to write/);
    expect(() =>
      s.write("progress.json", { lastCompletedStep: null, steps: { up: { url: PASSWORD_URL } } }),
    ).toThrow(/Refusing to write/);
    expect(existsSync(join(root, "install.json"))).toBe(false);
  });
});

describe("GcsStateStore", () => {
  it("writes to the bucket first, then mirrors locally", () => {
    const b = fakeBucket();
    const s = new GcsStateStore("acme-caelo-ops", root, b.run);
    s.write("progress.json", { lastCompletedStep: "x", steps: { x: { done: true } } });
    const text = b.objects.get("gs://acme-caelo-ops/install/progress.json");
    expect(JSON.parse(text ?? "")).toMatchObject({ lastCompletedStep: "x" });
    expect(readFileSync(join(root, "progress.json"), "utf8")).toBe(text ?? "");
  });

  it("reads from the bucket, not the (possibly stale) local mirror, once per process", () => {
    const b = fakeBucket();
    b.objects.set("gs://acme-caelo-ops/install/install.json", '{"installId":"bucket"}\n');
    writeFileSync(join(root, "install.json"), '{"installId":"stale-mirror"}\n');
    const s = new GcsStateStore("acme-caelo-ops", root, b.run);
    expect(JSON.parse(s.read("install.json") ?? "")).toEqual({ installId: "bucket" });
    expect(JSON.parse(readFileSync(join(root, "install.json"), "utf8"))).toEqual({
      installId: "bucket",
    });
    s.read("install.json");
    expect(b.calls.filter((c) => c.startsWith("storage cat")).length).toBe(1);
  });

  it("peek reads the bucket without caching or touching the local mirror", () => {
    const b = fakeBucket();
    b.objects.set("gs://acme-caelo-ops/install/install.json", '{"installId":"someone-else"}\n');
    writeFileSync(join(root, "install.json"), '{"installId":"mine"}\n');
    const s = new GcsStateStore("acme-caelo-ops", root, b.run);
    expect(s.peek("install.json")).toContain("someone-else");
    expect(readFileSync(join(root, "install.json"), "utf8")).toContain("mine");
  });

  it("a missing object is null; any other bucket error throws (no silent local fallback)", () => {
    const b = fakeBucket();
    const s = new GcsStateStore("acme-caelo-ops", root, b.run);
    expect(s.read("progress.json")).toBeNull();
    const denied = new GcsStateStore("acme-caelo-ops", root, () =>
      fail("ERROR: 403 does not have storage.objects.get access"),
    );
    expect(() => denied.read("install.json")).toThrow(/Could not read gs:\/\/acme-caelo-ops/);
  });

  it("refuses secret material before anything reaches the bucket (#659 guard)", () => {
    const b = fakeBucket();
    const s = new GcsStateStore("acme-caelo-ops", root, b.run);
    expect(() =>
      s.write("progress.json", {
        lastCompletedStep: "pulumi-up-acme",
        steps: { "pulumi-up-acme": { outputs: { adminDatabaseUrlOut: PASSWORD_URL } } },
      }),
    ).toThrow(/Refusing to write secret material to progress.json/);
    expect(() => s.write("install.json", { installId: "x", password: "hunter2hunter2" })).toThrow(
      /Refusing/,
    );
    expect(b.calls).toEqual([]);
    expect(existsSync(join(root, "progress.json"))).toBe(false);
  });

  it("a failed upload changes nothing locally", () => {
    const s = new GcsStateStore("acme-caelo-ops", root, () => fail("ERROR: 503 backend error"));
    expect(() => s.write("install.json", { installId: "x" })).toThrow(/Could not write/);
    expect(existsSync(join(root, "install.json"))).toBe(false);
  });
});

describe("install-state through the stores (child process, own HOME)", () => {
  it("a gcs install reads/writes the bucket; leaving it updates the bucket's install.json", () => {
    // installRoot() resolves ~ via os.homedir(), read once at process start —
    // drive install-state in a child process with its own HOME, and a fake
    // `gcloud storage` that keeps objects in files under <home>/bucket.
    const home = mkdtempSync(join(tmpdir(), "caelo-store-home-"));
    try {
      const mod = resolve(import.meta.dir, "install-state.ts");
      const script = `
        const fs = await import("node:fs");
        const path = await import("node:path");
        const m = await import(${JSON.stringify(mod)});
        const home = ${JSON.stringify(home)};
        const obj = (url) => path.join(home, "bucket", url.replace("gs://", ""));
        const calls = [];
        m.setStateStoreGcloud((args, input) => {
          calls.push(args.slice(0, 2).join(" "));
          if (args[1] === "cat") {
            return fs.existsSync(obj(args[2]))
              ? { ok: true, stdout: fs.readFileSync(obj(args[2]), "utf8"), stderr: "", exitCode: 0 }
              : { ok: false, stdout: "", stderr: "matched no objects", exitCode: 1 };
          }
          fs.mkdirSync(path.dirname(obj(args[3])), { recursive: true });
          fs.writeFileSync(obj(args[3]), input);
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        });
        const id = "gcp-acme";
        m.ensureInstallDir(id);
        m.writeMetadata(id, { installId: id, provider: "gcp", projectId: "acme", domain: "acme.com",
          ownerEmail: "o@acme.com", region: "europe-west1", createdAt: "2026-01-01T00:00:00.000Z" });
        m.markStepDone(id, "project-acme", { created: true });
        const localCalls = calls.length;
        m.adoptStateBackend(id, { kind: "gcs", bucket: "acme-caelo-ops",
          kmsKey: "projects/acme/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state" });
        m.markStepDone(id, "pulumi-up-acme", { outputs: { providerOut: "gcp" } });
        const bucketProgress = JSON.parse(fs.readFileSync(obj("gs://acme-caelo-ops/install/progress.json"), "utf8"));
        const bucketMeta = JSON.parse(fs.readFileSync(obj("gs://acme-caelo-ops/install/install.json"), "utf8"));
        let refused = "";
        try { m.markStepDone(id, "bad", { url: ${JSON.stringify(PASSWORD_URL)} }); } catch (e) { refused = e.message; }
        // A caller holding pre-migration metadata can't switch the backend back.
        m.writeMetadata(id, { ...m.readMetadata(id), stateBackend: { kind: "local" } });
        const keptBackend = JSON.parse(fs.readFileSync(obj("gs://acme-caelo-ops/install/install.json"), "utf8")).stateBackend.kind;
        const stateDirAfterAdopt = fs.existsSync(path.join(home, ".caelo-" + id, "state"));
        m.adoptStateBackend(id, { kind: "local" });
        const bucketAfterLeave = JSON.parse(fs.readFileSync(obj("gs://acme-caelo-ops/install/install.json"), "utf8"));
        const callsBefore = calls.length;
        m.markStepDone(id, "after-leave", { x: 1 });
        console.log(JSON.stringify({
          localCalls, bucketSteps: Object.keys(bucketProgress.steps), bucketBackend: bucketMeta.stateBackend.kind,
          refused, stateDirAfterAdopt, keptBackend, bucketAfterLeave: bucketAfterLeave.stateBackend.kind,
          callsAfterLeave: calls.length - callsBefore, done: m.isStepDone(id, "after-leave"),
          listed: m.listInstalls().map((i) => i.installId),
        }));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      const r = JSON.parse(new TextDecoder().decode(child.stdout));
      expect(r.localCalls).toBe(0);
      expect(r.bucketSteps).toEqual(["project-acme", "pulumi-up-acme"]);
      expect(r.bucketBackend).toBe("gcs");
      expect(r.keptBackend).toBe("gcs");
      expect(r.refused).toContain("credential-url");
      expect(r.bucketAfterLeave).toBe("local");
      expect(r.callsAfterLeave).toBe(0);
      expect(r.done).toBe(true);
      expect(r.listed).toEqual(["gcp-acme"]);
      const bucketText = readFileSync(
        join(home, "bucket", "acme-caelo-ops", "install", "progress.json"),
        "utf8",
      );
      expect(bucketText).not.toContain("hunter2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
