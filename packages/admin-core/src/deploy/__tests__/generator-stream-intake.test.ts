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
 * A stub generator streams one large file through `runGenerator`. The live
 * heap is read in a process of its own (the probe below), never in this one:
 * the unit tier runs some 220 files in one `bun test --coverage` process,
 * which keeps every earlier file's code resident and frees parts of it at
 * moments no test controls. In main run 42906984053 that process's heap read
 * 3.5 MB lower half a second after the file started, so the 24 MiB file
 * seemed held 0.85 times. The probe loads the intake and nothing else; how it
 * reads the file's share is described at {@link PROBE}.
 */

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
/** What the stub's file repeats: text like a manifest's, not a run of one byte. */
const FILE_TEXT = '{"pageId":"0d9c1c7e-53d4-4b5e-9a57-0f0e3c2b1a99","path":"/memory/page/"},';
/** The intake under test, which the probe imports by path. */
const INTAKE = join(import.meta.dir, "..", "generator-subprocess.ts");

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
    const body = Buffer.alloc(size, ${JSON.stringify(FILE_TEXT)});
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

/** One stub build's arguments, the upload and the paths aside. */
const RUN = {
  runId: "00000000-0000-0000-0000-0000000000aa",
  target: TARGET,
  publishAt: new Date(0).toISOString(),
  mediaDelivery: "reference" as const,
};

/**
 * The probe: a process that loads the intake and nothing else, runs one stub
 * build through `runGenerator` and prints, as its last line, what the upload
 * saw. No progress and no plugin call reach the registry or the adapter, so
 * plain objects stand in for them.
 *
 * Loading the intake starts work that lands on later turns of the event loop:
 * plugin-host → font-service → fontverter instantiates wawoff2's two
 * WebAssembly modules, which adds ~64 MB of heap on the first turn after the
 * import, or during it. So the probe first lets the loop run until two
 * readings in a row agree. The file's share is then the heap while the upload
 * holds it minus the heap once the build is over and the file let go: neither
 * reading carries anything the process did before the build.
 */
const PROBE = `
import { heapStats } from "bun:jsc";
const [intake, stub, dir] = process.argv.slice(2);
const { runGenerator } = await import(intake);
function live() {
  Bun.gc(true);
  return heapStats().heapSize;
}
let settled = live();
for (let turn = 0; turn < 200; turn += 1) {
  await Bun.sleep(25);
  const now = live();
  const still = Math.abs(now - settled) < 64 * 1024;
  settled = now;
  if (still && turn > 0) break;
}
let whileHeld = -1;
let taken = 0;
const upload = {
  async put(file) {
    // As the upload's own awaits see the intake: its line handler has returned.
    await Bun.sleep(20);
    whileHeld = live();
    taken = file.body.byteLength;
  },
  async abort() {},
};
const outcome = await runGenerator({}, {}, ${JSON.stringify(CTX)}, {
  ...${JSON.stringify(RUN)},
  cliPath: stub,
  repoRoot: dir,
  upload,
});
const released = live();
console.log(JSON.stringify({
  ok: outcome.ok,
  message: outcome.ok ? null : outcome.message,
  held: whileHeld - released,
  drift: released - settled,
  taken,
}));
`;

/** The env a generator run needs, set for this file only. */
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
let probe = "";

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = await mkdtemp(join(tmpdir(), "caelo-stream-intake-"));
  stub = join(dir, "stub-generator.ts");
  probe = join(dir, "intake-probe.ts");
  await writeFile(stub, STUB);
  await writeFile(probe, PROBE);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("runGenerator — a streamed file in the admin (#1271)", () => {
  it("hands the upload the file's bytes as the generator wrote them", async () => {
    let taken = Buffer.alloc(0);
    const upload: BuildUpload = {
      async put(file) {
        taken = Buffer.from(file.body);
      },
      async abort() {},
    };
    const outcome = await runGenerator(
      new OperationRegistry(),
      // No progress and no plugin calls: the stub never reaches the database.
      {} as unknown as DatabaseAdapter,
      CTX,
      { ...RUN, cliPath: stub, repoRoot: dir, upload },
    );
    expect(outcome.ok).toBe(true);
    expect(Buffer.compare(taken, Buffer.alloc(FILE_BYTES, FILE_TEXT))).toBe(0);
  }, 60_000);

  it("holds the file's bytes once while the upload takes them", async () => {
    const run = Bun.spawn(["bun", "run", probe, INTAKE, stub, dir], {
      cwd: dir,
      env: { ...process.env, ...ENV },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (code !== 0) throw new Error(`the probe exited ${code}: ${err.slice(-2000)}`);
    const seen = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
      ok: boolean;
      message: string | null;
      held: number;
      /** How far the heap moved across the build, file aside (≈0 in a settled probe). */
      drift: number;
      taken: number;
    };
    console.info(
      `[stream-intake] the admin held ${(seen.held / FILE_BYTES).toFixed(3)} times the file while the upload took it (heap drift across the build ${(seen.drift / 1048576).toFixed(2)} MB)`,
    );
    expect(seen.message).toBeNull();
    expect(seen.ok).toBe(true);
    expect(seen.taken).toBe(FILE_BYTES);
    // The bytes and little else: the event's base64 text alone is another
    // 1.33 times them, and the intake held 2.36 times them before #1571.
    expect(seen.held).toBeGreaterThan(FILE_BYTES * 0.9);
    expect(seen.held).toBeLessThan(FILE_BYTES * 1.25);
  }, 60_000);
});
