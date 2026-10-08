// SPDX-License-Identifier: MPL-2.0

/**
 * The parent side of the audit child process: every way the child can
 * misbehave must end in a structured failure, never in a silent pass.
 * The child is replaced by small stub scripts; the real Lighthouse child is
 * exercised by scripts/lighthouse-smoke.ts (CI runs it inside the image).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditJob } from "../lighthouse-protocol.js";
import {
  auditTimeoutMs,
  lighthouseChildEnv,
  resolveLighthouseChild,
  runAuditJob,
} from "../lighthouse-runner.js";

const dir = mkdtempSync(join(tmpdir(), "caelo-lh-runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const job: AuditJob = {
  pages: [{ pageId: PAGE_ID, url: "http://127.0.0.1:1/" }],
  performanceRuns: 3,
};

function stub(name: string, body: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, body);
  return path;
}

const READ_STDIN = `const chunks = []; for await (const c of process.stdin) chunks.push(c);
const job = JSON.parse(Buffer.concat(chunks).toString());
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");`;

describe("runAuditJob", () => {
  it("collects page results and page errors from a well-behaved child", async () => {
    const path = stub(
      "ok",
      `${READ_STDIN}
out({ kind: "page", pageId: job.pages[0].pageId, url: job.pages[0].url,
  measurement: { scores: { performance: 98, accessibility: 100, "best-practices": 100, seo: 100 },
    failingAudits: [{ id: "image-alt", title: "alt", score: 0, categories: ["accessibility"] }] },
  performanceRuns: [97, 98, 99] });
out({ kind: "page-error", pageId: job.pages[0].pageId, url: "http://x/", code: "ERRORED_DOCUMENT_REQUEST", message: "404" });
out({ kind: "done" });`,
    );
    const r = await runAuditJob(job, { childPath: path });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]?.measurement.scores.performance).toBe(98);
    expect(r.pages[0]?.performanceRuns).toEqual([97, 98, 99]);
    expect(r.pageErrors).toEqual([
      { pageId: PAGE_ID, url: "http://x/", code: "ERRORED_DOCUMENT_REQUEST", message: "404" },
    ]);
  });

  it("reports a missing browser as browser-unavailable", async () => {
    const path = stub(
      "nobrowser",
      `${READ_STDIN}
out({ kind: "fatal", code: "browser-launch-failed", message: "Executable doesn't exist" });`,
    );
    const r = await runAuditJob(job, { childPath: path });
    expect(r).toEqual({
      ok: false,
      failure: { code: "browser-unavailable", message: "Executable doesn't exist" },
    });
  });

  it("reports a crash with the stderr tail", async () => {
    const path = stub(
      "crash",
      `${READ_STDIN}\nconsole.error("boom: out of memory"); process.exit(3);`,
    );
    const r = await runAuditJob(job, { childPath: path });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.code).toBe("child-failed");
    expect(r.failure.message).toMatch(/exited 3 before finishing: boom: out of memory/);
  });

  it("kills a hung child and reports a timeout", async () => {
    const path = stub(
      "hang",
      `${READ_STDIN}\nawait new Promise(() => setInterval(() => {}, 1000));`,
    );
    const r = await runAuditJob(job, { childPath: path, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.code).toBe("timeout");
  });

  it("rejects output that does not match the protocol", async () => {
    const path = stub(
      "garbage",
      `${READ_STDIN}
out({ kind: "page", pageId: "not-a-uuid" });
out({ kind: "done" });`,
    );
    const r = await runAuditJob(job, { childPath: path });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.code).toBe("protocol");
  });

  it("budgets time per page and run", () => {
    expect(auditTimeoutMs(job)).toBe(30_000 + 3 * 60_000);
  });
});

describe("lighthouseChildEnv — least privilege", () => {
  const SECRETS = {
    ADMIN_DATABASE_URL: "postgres://admin_role:pw@db/cms_admin",
    PUBLIC_DATABASE_URL: "postgres://public_role:pw@db/cms_public",
    PUBLIC_ADMIN_DATABASE_URL: "postgres://admin_role:pw@db/cms_public",
    CAELO_SECRET_KEK: "00".repeat(32),
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/secrets/sa.json",
  };

  it("forwards only the allowlisted runtime variables", () => {
    const env = lighthouseChildEnv({
      ...SECRETS,
      PATH: "/usr/bin",
      HOME: "/home/app",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      TMPDIR: "/tmp",
      NODE_ENV: "production",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/app",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      TMPDIR: "/tmp",
      NODE_ENV: "production",
    });
  });

  it("the spawned child does not see secret-bearing variables", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const path = stub(
        "envdump",
        `${READ_STDIN}
const leaked = Object.keys(process.env).filter((k) => /DATABASE|KEK|API_KEY|CREDENTIALS/.test(k));
out({ kind: "page-error", pageId: job.pages[0].pageId, url: "env", code: "ENV", message: JSON.stringify(leaked) });
out({ kind: "done" });`,
      );
      const r = await runAuditJob(job, { childPath: path });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(JSON.parse(r.pageErrors[0]?.message ?? "null")).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("resolveLighthouseChild", () => {
  it("honours CAELO_LIGHTHOUSE_CHILD", () => {
    const prev = process.env.CAELO_LIGHTHOUSE_CHILD;
    process.env.CAELO_LIGHTHOUSE_CHILD = "/opt/child.ts";
    try {
      expect(resolveLighthouseChild()).toBe("/opt/child.ts");
    } finally {
      if (prev === undefined) delete process.env.CAELO_LIGHTHOUSE_CHILD;
      else process.env.CAELO_LIGHTHOUSE_CHILD = prev;
    }
  });

  it("finds the child by walking up from the cwd", () => {
    const prev = process.env.CAELO_LIGHTHOUSE_CHILD;
    delete process.env.CAELO_LIGHTHOUSE_CHILD;
    try {
      expect(resolveLighthouseChild()).toMatch(
        /packages\/admin-core\/src\/quality\/lighthouse-child\.ts$/,
      );
    } finally {
      if (prev !== undefined) process.env.CAELO_LIGHTHOUSE_CHILD = prev;
    }
  });
});
