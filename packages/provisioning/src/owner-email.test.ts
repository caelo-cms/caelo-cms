// SPDX-License-Identifier: MPL-2.0

/**
 * owner-email.ts: a resumed install corrects its Owner email. The decision
 * against fake prompts, then a resumed local install and a bucket-backed one
 * (job mode's store) on real install-state files, as the wizard settles it
 * before the install's converge pass reads install.json.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decideOwnerEmail,
  type OwnerEmailPrompts,
  ownerEmailChangeLines,
  ownerEmailProblem,
  sameOwnerEmail,
} from "./owner-email.js";

/** Prompts that answer `answer` / `confirmed` and record what they were asked. */
function fakePrompts(answer: string | null = null, confirmed: boolean | null = true) {
  const asked: string[] = [];
  const confirms: string[] = [];
  const notes: string[][] = [];
  const prompts: OwnerEmailPrompts = {
    ask: async (recorded) => {
      asked.push(recorded);
      return answer;
    },
    confirm: async (message) => {
      confirms.push(message);
      return confirmed;
    },
    note: (lines) => notes.push([...lines]),
  };
  return { prompts, asked, confirms, notes };
}

const WRONG = "owner@acme.exmaple";
const RIGHT = "owner@acme.example";

describe("decideOwnerEmail — an install not provisioned yet", () => {
  const unfinished = { recorded: WRONG, provisioned: false };

  it("takes --owner-email as a plain correction: no prompt, no confirmation", async () => {
    const f = fakePrompts();
    const d = await decideOwnerEmail(
      { ...unfinished, requested: ` ${RIGHT} `, nonInteractive: false },
      f.prompts,
    );
    expect(d).toEqual({ kind: "change", from: WRONG, to: RIGHT });
    expect([f.asked, f.confirms, f.notes]).toEqual([[], [], []]);
  });

  it("asks with the recorded address prefilled, and takes the corrected answer", async () => {
    const f = fakePrompts(RIGHT);
    const d = await decideOwnerEmail({ ...unfinished, nonInteractive: false }, f.prompts);
    expect(f.asked).toEqual([WRONG]);
    expect(d).toEqual({ kind: "change", from: WRONG, to: RIGHT });
  });

  it("keeps the address when the answer is the recorded one, in any case", async () => {
    const f = fakePrompts("OWNER@acme.EXMAPLE");
    expect(await decideOwnerEmail({ ...unfinished, nonInteractive: false }, f.prompts)).toEqual({
      kind: "keep",
    });
  });

  it("keeps the recorded address non-interactively without --owner-email, without asking", async () => {
    const f = fakePrompts(RIGHT);
    expect(await decideOwnerEmail({ ...unfinished, nonInteractive: true }, f.prompts)).toEqual({
      kind: "keep",
    });
    expect(f.asked).toEqual([]);
  });

  it("refuses a malformed --owner-email and a cancelled prompt", async () => {
    expect(
      await decideOwnerEmail(
        { ...unfinished, requested: "owner-at-acme", nonInteractive: true },
        fakePrompts().prompts,
      ),
    ).toEqual({
      kind: "refuse",
      error: "--owner-email owner-at-acme: Looks like an invalid email.",
    });
    expect(
      await decideOwnerEmail({ ...unfinished, nonInteractive: false }, fakePrompts(null).prompts),
    ).toEqual({ kind: "cancelled" });
  });
});

describe("decideOwnerEmail — a provisioned install, which may have an Owner", () => {
  const provisioned = { recorded: WRONG, provisioned: true };

  it("says what the change does and leaves alone, then asks to confirm", async () => {
    const f = fakePrompts(RIGHT, true);
    const d = await decideOwnerEmail({ ...provisioned, nonInteractive: false }, f.prompts);
    expect(d).toEqual({ kind: "change", from: WRONG, to: RIGHT });
    expect(f.notes).toEqual([ownerEmailChangeLines(WRONG, RIGHT)]);
    expect(f.notes[0]?.join("\n")).toContain("Settings → Users");
    expect(f.confirms).toEqual([`Change the Owner email to ${RIGHT}?`]);
  });

  it("keeps the recorded address when the change is declined, and stops on a cancel", async () => {
    const declined = fakePrompts(RIGHT, false);
    expect(
      await decideOwnerEmail({ ...provisioned, nonInteractive: false }, declined.prompts),
    ).toEqual({ kind: "keep" });
    const cancelled = fakePrompts(RIGHT, null);
    expect(
      await decideOwnerEmail({ ...provisioned, nonInteractive: false }, cancelled.prompts),
    ).toEqual({ kind: "cancelled" });
  });

  it("takes --owner-email non-interactively as the decision, and still says what it does", async () => {
    const f = fakePrompts();
    const d = await decideOwnerEmail(
      { ...provisioned, requested: RIGHT, nonInteractive: true },
      f.prompts,
    );
    expect(d).toEqual({ kind: "change", from: WRONG, to: RIGHT });
    expect(f.notes).toHaveLength(1);
    expect(f.confirms).toEqual([]);
  });
});

describe("ownerEmailProblem / sameOwnerEmail", () => {
  it("validates like the first prompt and compares like IAP", () => {
    expect(ownerEmailProblem("")).toBe("Email is required");
    expect(ownerEmailProblem("a@b")).toBe("Looks like an invalid email");
    expect(ownerEmailProblem(" a@b.c ")).toBeUndefined();
    expect(sameOwnerEmail(" A@B.c", "a@b.C ")).toBe(true);
    expect(sameOwnerEmail("a@b.c", "a@b.d")).toBe(false);
  });
});

/**
 * A resumed install on real install-state files. installRoot() resolves ~
 * through os.homedir(), which reads HOME once at process start, so each case
 * runs in a child bun process with its own HOME (as install-version.test.ts
 * does); a bucket-backed install's ops bucket is a directory there.
 */
describe("settleResumedOwnerEmail — what the resumed install's pass reads", () => {
  const PROJECT = "acme-site";
  const INSTALL_ID = "gcp-firebase-acme-site";
  const meta = {
    installId: INSTALL_ID,
    provider: "gcp-firebase",
    projectId: PROJECT,
    domain: "acme.example",
    ownerEmail: WRONG,
    region: "europe-west1",
    createdAt: "2026-11-26T00:00:00.000Z",
  };
  const bucketBacked = {
    ...meta,
    stateBackend: {
      kind: "gcs",
      bucket: `${PROJECT}-caelo-ops`,
      kmsKey: `projects/${PROJECT}/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state`,
    },
  };
  const unfinished = { lastCompletedStep: "apis", steps: { apis: {} } };
  const provisioned = {
    lastCompletedStep: `pulumi-up-${PROJECT}`,
    steps: { [`pulumi-up-${PROJECT}`]: {} },
  };

  /**
   * Settle the Owner email of the install in a child process (prompt answer
   * `answer`, confirmation `confirmed`, `--owner-email` `requested`), then
   * read what the converge pass reads: install.json and the IAP members it
   * derives (the stacks' iapAllowlist, the operator-access job's static
   * members).
   */
  function resume(start: {
    readonly install: Record<string, unknown>;
    readonly progress: unknown;
    readonly answer?: string | null;
    readonly confirmed?: boolean;
    readonly requested?: string;
    readonly nonInteractive?: boolean;
  }) {
    const home = mkdtempSync(join(tmpdir(), "caelo-owner-email-"));
    try {
      const mirror = join(home, `.caelo-${INSTALL_ID}`);
      const objects = join(home, "bucket");
      const gcs = start.install.stateBackend !== undefined;
      mkdirSync(mirror, { recursive: true });
      mkdirSync(objects);
      writeFileSync(join(mirror, "install.json"), JSON.stringify(start.install));
      writeFileSync(join(gcs ? objects : mirror, "progress.json"), JSON.stringify(start.progress));
      if (gcs) writeFileSync(join(objects, "install.json"), JSON.stringify(start.install));
      const script = `
        const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
        const m = await import(${JSON.stringify(resolve(import.meta.dir, "install-state.ts"))});
        const o = await import(${JSON.stringify(resolve(import.meta.dir, "owner-email.ts"))});
        const a = await import(${JSON.stringify(resolve(import.meta.dir, "operator-access.ts"))});
        const objects = ${JSON.stringify(objects)};
        const at = (url) => objects + "/" + url.split("/").pop();
        m.setStateStoreGcloud((args, input) => {
          const [, verb, x, y] = args;
          if (verb === "cat") {
            return existsSync(at(x))
              ? { ok: true, stdout: readFileSync(at(x), "utf8"), stderr: "", exitCode: 0 }
              : { ok: false, stdout: "", stderr: "One or more URLs matched no objects.", exitCode: 1 };
          }
          if (verb === "cp" && x === "-") {
            writeFileSync(at(y), input ?? "");
            return { ok: true, stdout: "", stderr: "", exitCode: 0 };
          }
          throw new Error("unexpected gcloud " + args.join(" "));
        });
        const asked = [];
        const confirms = [];
        const prompts = {
          ask: async (recorded) => { asked.push(recorded); return ${JSON.stringify(start.answer ?? null)}; },
          confirm: async (message) => { confirms.push(message); return ${JSON.stringify(start.confirmed ?? true)}; },
          note: () => {},
        };
        const recorded = m.currentMetadata(m.readLocalMetadata(${JSON.stringify(INSTALL_ID)}));
        const ownerEmail = await o.settleResumedOwnerEmail(
          recorded,
          { ${start.requested ? `requested: ${JSON.stringify(start.requested)}, ` : ""}nonInteractive: ${start.nonInteractive === true} },
          prompts,
        );
        const now = m.readMetadata(${JSON.stringify(INSTALL_ID)});
        writeFileSync(${JSON.stringify(join(home, "out.json"))}, JSON.stringify({
          ownerEmail,
          recorded: now.ownerEmail,
          iapAllowlist: a.installIapAllowlist(now.ownerEmail),
          asked,
          confirms,
        }));`;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      const read = (path: string) =>
        existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
          : null;
      return {
        out: read(join(home, "out.json")) as Record<string, unknown>,
        mirror: read(join(mirror, "install.json")),
        bucket: read(join(objects, "install.json")),
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("local mode, an unfinished install: the corrected answer is recorded and the pass applies it", () => {
    const r = resume({ install: meta, progress: unfinished, answer: RIGHT });
    expect(r.out).toEqual({
      ownerEmail: RIGHT,
      recorded: RIGHT,
      iapAllowlist: [`user:${RIGHT}`],
      asked: [WRONG],
      confirms: [],
    });
    expect(r.mirror).toEqual({ ...meta, ownerEmail: RIGHT });
  });

  it("local mode, a provisioned install: the change is confirmed, then recorded", () => {
    const r = resume({ install: meta, progress: provisioned, answer: RIGHT });
    expect(r.out.recorded).toBe(RIGHT);
    expect(r.out.confirms).toEqual([`Change the Owner email to ${RIGHT}?`]);
  });

  it("local mode, a provisioned install: a declined change keeps install.json as it was", () => {
    const r = resume({ install: meta, progress: provisioned, answer: RIGHT, confirmed: false });
    expect(r.out.recorded).toBe(WRONG);
    expect(r.mirror).toEqual(meta);
  });

  it("job mode's store: --owner-email lands in the ops bucket's install.json, which the job reads", () => {
    const r = resume({
      install: bucketBacked,
      progress: unfinished,
      requested: RIGHT,
      nonInteractive: true,
    });
    expect(r.out.recorded).toBe(RIGHT);
    expect(r.out.asked).toEqual([]);
    expect(r.bucket).toEqual({ ...bucketBacked, ownerEmail: RIGHT });
    expect(r.mirror?.ownerEmail).toBe(RIGHT);
  });

  it("an unchanged address writes nothing", () => {
    const r = resume({ install: bucketBacked, progress: provisioned, answer: WRONG });
    expect(r.out.recorded).toBe(WRONG);
    expect(r.out.confirms).toEqual([]);
    expect(r.bucket).toEqual(bucketBacked);
  });
});
