// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the admin holds a file the generator streams once while the upload
 * takes it.
 *
 * The generator hands every served file to the admin as a base64 JSON line
 * (static-generator cli.ts). A few of them grow with the site: the sitemap,
 * the routing manifest and the render deps were 6.4 MB together at 10k pages.
 * While its upload ran, the admin held each of them about four and a half
 * times: the line (built by appending every chunk to one string, whose rest
 * kept the line alive), the event's base64 text, the decoded bytes and the
 * publisher's copy of them (static-publisher-firebase-promote.test.ts pins
 * that copy away). The Stage memory test read it at 10k pages when a sample
 * happened to land there.
 *
 * Here a stub generator streams one large file through `runGenerator`, and
 * the upload reads the admin's live heap while it holds the file: after the
 * line handler returned, as the upload's own awaits see it.
 */

import { heapStats } from "bun:jsc";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  type ExecutionContext,
} from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { runGenerator } from "../generator-subprocess.js";
import type { BuildUpload } from "../static-publisher.js";

/** Large next to everything else the intake allocates, small for a test. */
const FILE_BYTES = 24 * 1024 * 1024;

/**
 * The stub: reads the config line, streams one file of manifest-like text,
 * and reports done once the admin acknowledged it.
 */
const STUB = `
import { createInterface } from "node:readline";
const size = Number(process.env.CAELO_STUB_FILE_BYTES);
const done = JSON.parse(process.env.CAELO_STUB_DONE ?? "{}");
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let configured = false;
lines.on("line", (line) => {
  if (!configured) {
    configured = true;
    const body = Buffer.alloc(size, '{"pageId":"0d9c1c7e-53d4-4b5e-9a57-0f0e3c2b1a99","path":"/memory/page/"},');
    process.stdout.write(JSON.stringify({ kind: "file", id: 1, relPath: "routing-manifest.json", body: body.toString("base64") }) + "\\n");
    return;
  }
  const msg = JSON.parse(line);
  if (msg.kind === "file-ack") {
    if (!msg.ok) {
      process.stdout.write(JSON.stringify({ kind: "error", message: msg.message }) + "\\n", () => process.exit(1));
      return;
    }
    process.stdout.write(JSON.stringify(done) + "\\n", () => process.exit(0));
  }
});
`;

const CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "generator-stream-intake",
};

const TARGET: DeployTarget = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "staging",
  env: "staging",
  outDir: "output/staging",
  baseUrl: "https://example.com",
  robotsDefault: "noindex",
};

/** The env the generator run needs, set for this file only. */
const ENV = {
  // runGenerator hands them to the generator, which this stub never opens.
  ADMIN_DATABASE_URL: "postgres://stub@127.0.0.1:1/cms_admin",
  PUBLIC_ADMIN_DATABASE_URL: "postgres://stub@127.0.0.1:1/cms_public",
  CAELO_STUB_FILE_BYTES: String(FILE_BYTES),
  CAELO_STUB_DONE: JSON.stringify({
    kind: "done",
    pageCount: 0,
    fileCount: 1,
    durationMs: 1,
    phases: [],
    buildDir: "",
    peakRssMb: 0,
    unpublishedLinkTargets: [],
    crossVariantLinks: [],
    truncatedLists: [],
    securityHeaders: composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS),
  }),
};
const saved: Record<string, string | undefined> = {};
let dir = "";
let stub = "";

/** This process's live memory in bytes, after a full collection (see build-memory.integration.test.ts). */
function liveBytes(): number {
  Bun.gc(true);
  return heapStats().heapSize;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = await mkdtemp(join(tmpdir(), "caelo-stream-intake-"));
  stub = join(dir, "stub-generator.ts");
  await writeFile(stub, STUB);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("runGenerator — a streamed file in the admin (#1271)", () => {
  it("holds the file's bytes once while the upload takes them", async () => {
    let before = 0;
    let held = Number.NaN;
    let taken = 0;
    const upload: BuildUpload = {
      async put(file) {
        // As the upload's own awaits see the intake: its handler has returned.
        await Bun.sleep(20);
        held = liveBytes() - before;
        taken = file.body.byteLength;
      },
      async abort() {},
    };
    before = liveBytes();
    const outcome = await runGenerator(
      new OperationRegistry(),
      // No progress and no plugin calls: the stub never reaches the database.
      {} as unknown as DatabaseAdapter,
      CTX,
      {
        cliPath: stub,
        runId: "00000000-0000-0000-0000-0000000000aa",
        target: TARGET,
        repoRoot: dir,
        publishAt: new Date(0).toISOString(),
        mediaDelivery: "reference",
        upload,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(taken).toBe(FILE_BYTES);
    // The bytes and little else: the event's base64 text alone is another
    // 1.33 times them, and the intake held both (2.3 times) before.
    expect(held).toBeGreaterThan(FILE_BYTES * 0.9);
    expect(held).toBeLessThan(FILE_BYTES * 1.25);
  }, 60_000);
});
